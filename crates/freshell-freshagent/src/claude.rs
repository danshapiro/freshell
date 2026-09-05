//! # freshell-freshagent :: claude — the freshclaude WS fresh-agent slice (Phase 3.9)
//!
//! The additive wiring that lets the equivalence oracle drive a live claude/Haiku T2
//! turn THROUGH the Rust server exactly as it drives the original, and prove
//! `original≡rust` at T2. A faithful port of the claude path of `server/ws-handler.ts`
//! (`freshAgent.create` / `freshAgent.send`) + `server/fresh-agent/adapters/claude/adapter.ts`
//! + `server/sdk-bridge.ts` — but the SDK itself (`@anthropic-ai/claude-agent-sdk`, which
//!   has NO Rust equivalent) runs in the ONE sanctioned Node sidecar
//!   (`crates/freshell-claude-sidecar`, ADR Decision 2), spoken over newline-JSON stdio.
//!
//! ## Drive path (WS, not REST) — mirrors the codex slice
//!
//! | Client→server | Behaviour |
//! |---|---|
//! | `freshAgent.create {sessionType:'freshclaude'\|'kilroy',…}` | spawn the Node sidecar (ownership-tagged, isolated HOME inherited) → SDK `query()` → the SDK bridge's **BARE nanoid** placeholder id (NO placeholder→durable materialization — claude's send returns void), broadcast `freshAgent.created`, start the stdout consumer |
//! | `freshAgent.send {sessionId,text}` | push the user turn into the sidecar's SDK input stream, broadcast `freshAgent.send.accepted` (NO `submittedTurnId` — claude) |
//!
//! ## Events + the completion edge
//!
//! The sidecar emits the SAME `sdk.*` shapes `SdkBridge` broadcasts. The stdout consumer
//! normalizes each `sdk.* → freshAgent.*` (a port of `server/fresh-agent/sdk-events.ts`)
//! and wraps it in a `freshAgent.event` envelope: `sdk.session.init` → `freshAgent.session.init`
//! (durable Claude UUID via `cliSessionId`), `sdk.stream`/`sdk.assistant`/`sdk.result`, and —
//! ONLY when the SDK `result` carries `subtype==='success'` — the discrete
//! `freshAgent.turn.complete` chime. That status-guarded edge is the T2
//! `provider.emits-completion-signal` invariant. The `.jsonl` transcript the claude CLI
//! persists under the isolated `<CLAUDE_HOME>/projects/…` corroborates it.
//!
//! ## New failure mode (ADR Decision 2.1) — sidecar death is completion-safe
//!
//! A `freshAgent.turn.complete` is broadcast ONLY on an explicit `sdk.turn.complete` from
//! the sidecar. If the sidecar process dies mid-turn its stdout simply ends and the
//! consumer stops — so a death can NEVER produce a false completion. Verified by
//! [`tests::sidecar_death_never_yields_false_completion`].
//!
//! ## Safety
//!
//! The Node sidecar (and the `claude` CLI grandchild the SDK spawns) inherit the server's
//! isolated HOME (so they authenticate from + write ALL transcript data under
//! `<isolatedHOME>/.claude`, never the user's real store) and carry a
//! `FRESHELL_CLAUDE_SIDECAR_ID` ownership tag. [`FreshClaudeState::shutdown`] SIGTERMs the
//! sidecar (which cleanly kills its own claude CLI via the SDK), SIGKILLs any straggler,
//! and runs the `/proc` ownership sweep; the harness sentinel sweep is the backstop — no
//! orphans.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex as TokioMutex;

use freshell_protocol::{
    ErrorCode, ErrorMsg, FreshAgentApprovalRespond, FreshAgentAttach, FreshAgentCompact,
    FreshAgentCreate, FreshAgentCreateFailed, FreshAgentCreated, FreshAgentEvent,
    FreshAgentInterrupt, FreshAgentKill, FreshAgentKilled, FreshAgentQuestionRespond,
    FreshAgentSend, FreshAgentSendAccepted, FreshAgentSessionMaterialized, ServerMessage,
    SessionType,
};

use crate::{FreshAgentCreateDedup, FreshAgentCreateOutcome, SharedPaneIdentitySink};

/// The runtime provider (`AGENT_SESSION_TYPES.claude.provider`).
const PROVIDER: &str = "claude";
/// The ownership tag env the sidecar + its claude CLI grandchild carry (the codex analog
/// is `FRESHELL_CODEX_SIDECAR_ID`); the `/proc` reaper keys on it.
const CLAUDE_SIDECAR_OWNERSHIP_ENV: &str = "FRESHELL_CLAUDE_SIDECAR_ID";
/// Cold-boot budget for the sidecar to answer the `create` request (`created`).
const SIDECAR_CREATE_BUDGET: Duration = Duration::from_secs(45);
/// kata 1wxv task 4 review (C1): `handle_send`'s re-resolve cadence while a
/// rollback holds the session's teardown→respawn window open. The loop is
/// bounded by the rollback's own lifetime (`rollback_in_flight` membership
/// clears when the handler ends, on EVERY terminal path).
const MID_ROLLBACK_PARK_TICK: Duration = Duration::from_millis(10);

/// Shared, cheaply-cloneable freshclaude WS state (mergeable into the server app + WsState).
#[derive(Clone)]
pub struct FreshClaudeState {
    /// The shared WS broadcast bus (pre-serialized frames), fanned out by every
    /// `freshell-ws` connection so the oracle's capture socket records
    /// `freshAgent.created` / `freshAgent.send.accepted` / `freshAgent.event`.
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    /// placeholder-nanoid → live claude session (sidecar stdin + owned child + consumer).
    sessions: Arc<TokioMutex<HashMap<String, ClaudeSession>>>,
    /// durable Claude UUID (`cliSessionId` from `sdk.session.init`) -> sessions-map key.
    /// THE restart-parity index (plan §2.8 item 2): lets attach/snapshot find a live
    /// session by its durable identity instead of the process-ephemeral placeholder.
    /// pub(crate) so in-crate tests (and snapshot wiring) can inspect it.
    pub(crate) cli_index: Arc<TokioMutex<HashMap<String, String>>>,
    /// `freshAgent.create` requestId dedup (parity gap fix -- see the module doc on
    /// [`crate::FreshAgentCreateDedup`]): single-flight + replay cache so a client
    /// resending the SAME `requestId` on every reconnect while a pane is
    /// `status==creating` reattaches to the ONE session it already created instead of
    /// spawning a fresh claude sidecar per resend. Cleared for a session's entries only
    /// on an explicit `freshAgent.kill` ([`Self::handle_kill`]); an unrequested sidecar
    /// exit does NOT evict from THIS dedup cache (mirrors legacy, see the type doc) --
    /// it DOES evict the dead entry from the `sessions` map (consumer-exit eviction).
    create_dedup: Arc<FreshAgentCreateDedup<ClaudeCreateRecord>>,
    /// Single-flight guard for resume-on-attach, keyed by DURABLE id (codex's
    /// `resuming` analog, simplified: contenders return immediately instead of
    /// waiting -- the winner's frames broadcast to every client anyway).
    resuming: Arc<TokioMutex<std::collections::HashSet<String>>>,
    /// P1.13 identity-event sink (the pane-ledger bridge,
    /// [`crate::identity_sink`]). Clone-shared + set-once: the state is cloned
    /// into consumer tasks, so the `OnceLock` sits behind an `Arc`. Wired
    /// post-construction by `freshell-server` (precedent:
    /// `TerminalRegistry::set_activity_observer`).
    identity_sink: Arc<std::sync::OnceLock<SharedPaneIdentitySink>>,
    /// The per-sessionRef create/resume lease (D8 for fresh agents, Task 12) —
    /// ALWAYS ON at this runtime seam (never capability-gated: the two-writers JSONL
    /// corruption it prevents is real regardless of client generation). `main.rs`
    /// replaces the default with the ONE server-wide shared map via
    /// [`Self::set_session_leases`]; keys are provider-namespaced either way.
    leases: Arc<crate::session_lease::FreshAgentSessionLeases>,
    /// Task 13b: cross-kind liveness -- true when a live terminal PTY owns
    /// `(provider, session_id)`. Wired by `main.rs`; defaults to always-false.
    terminal_liveness: crate::TerminalLivenessProbe,
    /// Rollback-vs-rollback single-flight (kata 1wxv Task 4), keyed by the
    /// CURRENT durable id. [`Self::handle_rollback`] acquires it BEFORE the
    /// session's `turn_lock` (lock order: rollback_in_flight FIRST, then the
    /// turn lock — never the reverse); `handle_send` never ACQUIRES it but
    /// polls its membership (task 4 review C1) to PARK a send that resolves
    /// inside the rollback's teardown→respawn window rather than refuse it.
    rollback_in_flight: crate::InFlightRegistry,
}

/// The cached result of a completed claude/kilroy `freshAgent.create`, keyed by
/// `requestId` in [`FreshClaudeState::create_dedup`]. Claude's `create()` returns only a
/// bare nanoid placeholder (no `sessionRef` -- `adapter.ts` returns `{ sessionId }` only),
/// so only `session_id` need be cached; the replay branch mirrors the live path's own
/// broadcast (NO `sessionRef`).
#[derive(Clone)]
struct ClaudeCreateRecord {
    session_id: String,
}

/// The per-session pending approval/question set folded from the sidecar's stdout
/// stream (Task 2). Feeds the respond handlers' membership check and the Task 3
/// snapshot overlay. Lives behind a shared handle (the `broadcast_id` precedent): the
/// detached stdout consumer folds into it while the respond handlers read/mutate it.
/// Session eviction on EOF/exit drops the Arc with the record — no extra handling.
#[derive(Default)]
struct ClaudePending {
    permissions: Vec<PendingApprovalEntry>,
    questions: Vec<PendingQuestionEntry>,
}

/// One pending claude approval (an `sdk.permission.request` not yet answered/cancelled),
/// capturing the contract fields the Task 3 snapshot overlay serializes.
struct PendingApprovalEntry {
    request_id: String,
    tool_name: Option<String>,
    tool_use_id: Option<String>,
    blocked_path: Option<String>,
    decision_reason: Option<String>,
    input: Option<Value>,
}

impl PendingApprovalEntry {
    /// The `.strict()` contract shape the Task 3 snapshot overlay serializes
    /// (`{requestId, toolName?, toolUseID?, blockedPath?, decisionReason?, input?}` —
    /// keys omitted when absent, never null).
    fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("requestId".to_string(), json!(self.request_id));
        if let Some(tool_name) = &self.tool_name {
            obj.insert("toolName".to_string(), json!(tool_name));
        }
        if let Some(tool_use_id) = &self.tool_use_id {
            obj.insert("toolUseID".to_string(), json!(tool_use_id));
        }
        if let Some(blocked_path) = &self.blocked_path {
            obj.insert("blockedPath".to_string(), json!(blocked_path));
        }
        if let Some(decision_reason) = &self.decision_reason {
            obj.insert("decisionReason".to_string(), json!(decision_reason));
        }
        if let Some(input) = &self.input {
            obj.insert("input".to_string(), input.clone());
        }
        Value::Object(obj)
    }
}

/// One pending provider question (`sdk.question.request`, the AskUserQuestion tool).
/// `questions` is the CONTRACT-NORMALIZED copy ([`normalize_question_definitions`]) —
/// the pending set feeds the `.strict()` snapshot overlay, while the WS broadcast of
/// the same frame stays verbatim.
struct PendingQuestionEntry {
    request_id: String,
    questions: Value,
}

/// kata 1wxv Task 4: the rollback-fork adoption wiring handed to the stdout
/// consumer. The handler PREREAD the respawned sidecar's `sdk.session.init`
/// line (the `--resume-drops-turn` refusal watch lives in that pre-read, before
/// any durable state moves); the consumer runs the adoption for it EXACTLY like
/// an in-stream init (cli_index insert + AWAITED binding carrying
/// `supersedes` = the pre-rollback durable id + the rollback-row re-key old→new
/// inside the SAME awaited batch), then resolves `adopted_tx` so the parked
/// rollback handler proceeds with the new durable id.
struct RollbackAdoption {
    /// The pre-rollback durable id this create supersedes.
    supersedes: String,
    /// The preread `sdk.session.init` line (consumed by the handler's pre-read).
    preseeded_init: Value,
    adopted_tx: tokio::sync::oneshot::Sender<Option<String>>,
}

/// One live freshclaude session: the Node sidecar it drives + its stdout consumer.
struct ClaudeSession {
    configuration: ClaudeConfiguration,
    /// stdin of the Node sidecar (write `create`/`send`/`shutdown` requests).
    stdin: ChildStdin,
    /// The owned Node sidecar child (SIGKILL backstop; `kill_on_drop`).
    child: Child,
    /// The `/proc` reaper tag for this session's sidecar + its claude CLI grandchild.
    ownership_id: String,
    /// The stdout-consumer task (aborted on shutdown).
    consumer: tokio::task::JoinHandle<()>,
    /// The id the SIDECAR keys this session by (`created.sessionId`). Equal to the
    /// sessions-map key for created sessions; DIFFERENT for resumed-on-attach sessions
    /// (Task 6), where the map key is the CLIENT's original id. `handle_send`/
    /// `handle_interrupt` MUST address the sidecar with this id, never the map key.
    sidecar_session_id: String,
    /// Best-effort copy of the durable Claude UUID, recorded from `sdk.session.init`
    /// by the stdout consumer. Nothing in production reads it: attach/eviction resolve
    /// durable ids through [`FreshClaudeState::cli_index`], and the snapshot adapter
    /// is disk-only. Currently read only by in-crate tests; kept as a diagnostic/
    /// forward slot.
    #[allow(dead_code)]
    cli_session_id: Option<String>,
    /// The envelope-stamp id the stdout consumer reads PER EVENT (Task 10b). Starts as
    /// the sessions-map key; an attach-by-durable REBIND flips it to the durable id so
    /// the pane keyed on the durable receives events. A shared mutable handle because
    /// the consumer task runs detached from this record.
    broadcast_id: Arc<std::sync::Mutex<String>>,
    /// The folded pending approval/question set (Task 2) — see [`ClaudePending`].
    pending: Arc<std::sync::Mutex<ClaudePending>>,
    /// kata 1wxv Task 4: the busy truth for the rollback `BUSY_TURN` gate — set by
    /// `handle_send` UNDER `turn_lock` BEFORE the sidecar write (the check-then-set
    /// window against `handle_rollback`'s busy check is closed); cleared on EXACTLY
    /// the four contract edges (`sdk.result` ANY subtype, `sdk.status` idle, sidecar
    /// EOF/death, a completed `handle_interrupt`) — fail-closed otherwise (a missing
    /// arm wedges BUSY_TURN refusals forever). Carried across the rollback's
    /// kill+respawn into the replacing record (the fork continues the same logical
    /// session lifetime).
    in_turn: Arc<std::sync::atomic::AtomicBool>,
    /// Focused-review ep1-r1 F1 / ep1-r2 F2 / ep2-r2: the per-session FIFO
    /// turn tracker — the EXPLICIT, order-expressive replacement for the
    /// counter quartet (op counts could not encode queue order; the ep2-r2
    /// interleaving review repro had a wholesale-extinguish defect that a
    /// `VecDeque<TrackedOp>` makes structurally impossible). A `/compact`
    /// written to the sidecar WHILE a turn is active queues BEHIND it
    /// ([`arm_turn_op`]); only EACH op's OWN terminal edge retires its entry
    /// ([`fold_terminal_edge`]) — so the busy gate reads `in_turn`, recomputed
    /// from [`TurnTracker::busy`] inside every mutation's critical section,
    /// and stays closed through every OTHER op's edges. Arms happen UNDER the
    /// session turn lock BEFORE the sidecar write await (ep1-r3 F3: the
    /// consumer's terminal-edge fold never takes that lock, so a post-await
    /// arm races it); a no-write failure SYNCHRONOUSLY undoes exactly the
    /// arm's own entry ([`undo_turn_op_arm`]). Disarm set (the sidecar input
    /// queue is FIFO; a later send queues BEHIND a compact and
    /// `query.interrupt()` does not drain it, so NEITHER is a disarm):
    ///   (a) the terminal edge of a compact whose run was CONFIRMED manual
    ///       (promoted to `running` by [`confirm_compact_candidate`]) — retires
    ///       that ONE op and holds busy while anything remains outstanding
    ///       (ep1-r3 F1);
    ///   (b) the FIFO-drop peel — a terminal edge with NO running op whose
    ///       oldest queued op is an UNPROMOTED compact: the compact provably
    ///       dropped, evidenced by a queued Turn that follows it (peel
    ///       leading unpromoted compacts up to that Turn; a compact queued
    ///       BEHIND the send needs no evidence handling — it genuinely
    ///       remains queued, ep2-r2 F1);
    ///   (c) any in-stream `sdk.error` frame, or sidecar EOF/death (the queue
    ///       is gone).
    /// Carried across the rollback's kill+respawn exactly like `in_turn`.
    turn_tracker: Arc<std::sync::Mutex<TurnTracker>>,
    /// Focused-review ep2-r1 F1: the paired-terminal-frames mark. The
    /// supported protocol closes EVERY turn with `sdk.result` AND a trailing
    /// `sdk.status:idle` (both provider fixtures emit exactly that pair; the
    /// real sidecar's consumeStream finally emits the trailing idle). The
    /// idle is the SAME turn's closing punctuation, never a new op's edge —
    /// set by the consumer after folding ANY `sdk.result`, consumed by the
    /// NEXT `sdk.status:idle` which skips the fold (a second edge's
    /// attribution would double-count the turn — the reviewer's exact repro:
    /// A's trailing idle misattributed to a queued garlanded send fired the
    /// FIFO-drop branch and released the busy gate over still-queued work).
    /// Arms/sends NEVER reset it (a fresh op submitted between a turn's
    /// result and its trailing idle must not let that idle fold); an
    /// in-stream `sdk.error` DOES reset it (the fail-closed `in_turn` needs a
    /// LIVE terminal edge after the error — the trailing idle must fold
    /// there), and sidecar EOF zeroes it with the tracker set. Carried across
    /// the rollback's kill+respawn exactly like `in_turn`.
    result_idle_pair_pending: Arc<std::sync::atomic::AtomicBool>,
    /// kata 1wxv Task 4 (r2 serialization discipline): ONE per-session async turn
    /// lock. `handle_rollback` holds it across the WHOLE handler (busy-check →
    /// reads → record pre-write → pending-cancel → kill+spawn+adoption → reply);
    /// `handle_send` waits on it, then proceeds and destroys redo — and never
    /// ACQUIRES `rollback_in_flight` (task 4 review C1: it only polls membership
    /// to park through the teardown→respawn window — no circular wait exists).
    /// Carried across the rollback's kill+respawn so a send that resolved its
    /// handle (or parked through the window) serializes identically.
    turn_lock: Arc<TokioMutex<()>>,
    /// Focused ep4-r2/ep4-r3 (probe protocol): rollback's pre-teardown quiesce
    /// probe registers its probeId + a oneshot here before writing the
    /// `rollback.quiesce` request; the consumer's `sdk.rollback.quiesced` fold
    /// fires it ONLY on a probeId match (ep4-r3 F2: a stale receipt from an
    /// ordinary interrupt or an earlier timed-out probe can never close a
    /// live probe). Because the consumer folds lines IN STREAM ORDER, the
    /// quiesced frame provably lands after every already-emitted piece of
    /// evidence — and because the sidecar answers from its OWN input queue, it
    /// reports cancellation of never-handed compacts and in-flight/handed
    /// truth rollback cannot observe from wire frames alone.
    #[allow(clippy::type_complexity)]
    rollback_probe_slot:
        Arc<std::sync::Mutex<Option<(String, tokio::sync::oneshot::Sender<QuiesceVerdict>)>>>,
    /// The session's tracked status (the stdout consumer's fold: the reference
    /// bridge's turn lifecycle — `running` on `sdk.assistant`, `idle` on every
    /// `sdk.result` — plus the raw `sdk.status` wire values folded on top).
    /// Read by the attach-ack sites so a reconnect ack tells the truth instead of
    /// the hardcoded "idle" that used to wedge stale-busy/stale-idle panes.
    /// Starts "idle" — a fresh/just-resumed session has announced nothing else.
    last_status: Arc<std::sync::Mutex<String>>,
}

/// The sidecar's signed answer to a `rollback.quiesce` probe (ep4-r3). All
/// three fields are sidecar-owned truth the wire frames alone cannot carry:
/// `cancelled_queue` — compacts dropped from the SDK-input queue (they
/// provably never start); `in_flight_turn` — an SDK turn is mid-flight;
/// `handed_compact_likely` — a compact already crossed the un-cancellable
/// same-tick handoff to an awaiting SDK consumer. Either busy signal fails
/// the probe closed (BUSY_TURN + compensating ledger rewrite).
#[derive(Debug, Clone, Copy)]
struct QuiesceVerdict {
    cancelled_queue: u64,
    in_flight_turn: bool,
    handed_compact_likely: bool,
}

#[derive(Default)]
struct ClaudeConfiguration {
    settings: crate::identity_sink::FreshAgentSettings,
    pending: Option<(String, tokio::sync::oneshot::Sender<Result<(), String>>)>,
    commands: Option<Vec<Value>>,
    needs_configure: bool,
    runtime_cwd: Option<String>,
}

impl ClaudeSession {
    /// The session's tracked status (the stdout consumer's turn-lifecycle +
    /// `sdk.status` fold) — the truth the attach acks speak.
    fn current_status(&self) -> String {
        self.last_status.lock().expect("last status lock").clone()
    }
}

impl FreshClaudeState {
    /// Build the state around the shared broadcast bus.
    pub fn new(broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>) -> Self {
        Self {
            broadcast_tx,
            sessions: Arc::new(TokioMutex::new(HashMap::new())),
            cli_index: Arc::new(TokioMutex::new(HashMap::new())),
            create_dedup: Arc::new(FreshAgentCreateDedup::new()),
            resuming: Arc::new(TokioMutex::new(std::collections::HashSet::new())),
            identity_sink: Arc::new(std::sync::OnceLock::new()),
            leases: Arc::new(crate::session_lease::FreshAgentSessionLeases::new()),
            terminal_liveness: Arc::new(|_, _| false),
            rollback_in_flight: crate::InFlightRegistry::new(),
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

    /// Broadcast a `freshAgent.error` alarm/degradation frame (P1.13; Task 10
    /// consumes this too). Same envelope contract as codex's helper (`codex.rs`):
    /// top-level `sessionType`/`provider` are REQUIRED (locator resolution) and
    /// `message` is user-facing (the banner shows the message, never the code) —
    /// but unlike codex this one cannot hardcode the session type: provider
    /// `claude` covers BOTH `freshclaude` and `kilroy`, so the flavour is a param.
    fn emit_fresh_agent_error(
        &self,
        session_id: &str,
        session_type: &str,
        code: &str,
        message: &str,
    ) {
        self.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: json!({
                "type": "freshAgent.error",
                "sessionId": session_id,
                "code": code,
                "message": message,
            }),
            provider: PROVIDER.to_string(),
            session_id: session_id.to_string(),
            session_type: session_type.to_string(),
        }));
    }

    /// Reap every owned claude sidecar: SIGTERM the Node process (so it cleanly kills its
    /// own `claude` CLI via the SDK abort), SIGKILL any straggler, abort the consumer, and
    /// run the `/proc` ownership sweep for the grandchild. Called on server shutdown.
    pub async fn shutdown(&self) {
        let drained: Vec<ClaudeSession> = {
            let mut guard = self.sessions.lock().await;
            guard.drain().map(|(_, s)| s).collect()
        };
        for session in drained {
            session.consumer.abort();
            // Graceful: ask the sidecar to shut down (it aborts the SDK query, which kills
            // the claude CLI), then hard-stop the Node process, then sweep the grandchild.
            let mut stdin = session.stdin;
            let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n").await;
            let _ = stdin.flush().await;
            if let Some(pid) = session.child.id() {
                terminate_pid(pid as i32);
            }
            let mut child = session.child;
            let _ = child.start_kill();
            reap_owned_claude_sidecars(&session.ownership_id);
        }
        self.cli_index.lock().await.clear();
    }

    fn broadcast(&self, msg: &ServerMessage) {
        if let Ok(frame) = serde_json::to_string(msg) {
            let _ = self.broadcast_tx.send(frame);
        }
    }

    // ── freshAgent.create (WS) ───────────────────────────────────────────────────────

    /// Handle a `freshAgent.create` for claude/kilroy: spawn the Node sidecar, drive the
    /// SDK `create` to get the BARE nanoid placeholder, register the session + its stdout
    /// consumer, and broadcast `freshAgent.created` (or `freshAgent.create.failed`).
    /// Long-running (cold sidecar spawn), so the WS loop dispatches this as a detached task.
    pub async fn handle_create(&self, msg: FreshAgentCreate) {
        let request_id = msg.request_id.clone();
        let session_type = session_type_str(msg.session_type);

        // Dedup by requestId (parity gap fix -- see [`crate::FreshAgentCreateDedup`]'s
        // doc and [`Self::create_dedup`]'s field doc). Held for the whole creation
        // attempt below, so concurrent duplicate `create`s for the same requestId
        // serialize instead of each spawning their own sidecar.
        let _dedup_guard = match self.create_dedup.acquire_or_replay(&request_id).await {
            FreshAgentCreateOutcome::Replay(cached) => {
                self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
                    provider: PROVIDER.to_string(),
                    request_id,
                    runtime_provider: PROVIDER.to_string(),
                    session_id: cached.session_id,
                    session_type: session_type.to_string(),
                    session_ref: None,
                }));
                return;
            }
            FreshAgentCreateOutcome::Proceed(guard) => guard,
        };

        // Task 12 (D8 for fresh agents): a create-with-resume claims the per-sessionRef
        // lease BEFORE any spawn -- exactly one in-flight resume (and one live writer)
        // per durable transcript. ALWAYS ON (never capability-gated).
        //
        // The resume id comes from the legacy `resumeSessionId` first, else the
        // provider-matched `sessionRef` (Node parity: `runtime-manager.ts:106-108`
        // promotes the sessionRef into the adapter's resume input the same way) --
        // the canonical carrier must work standalone so the client can drop the
        // legacy duplicate.
        let resume_sid = msg
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
        let mut lease_guard: Option<crate::FreshSessionLeaseGuard> = None;
        if let Some(sid) = resume_sid.as_deref() {
            // Task 13b (cross-kind liveness): a live terminal PTY owning `(claude, sid)`
            // is the one writer on that JSONL -- refuse the resume with the retryable
            // loser answer (the terminal may be closing); NO lease claim, NO spawn.
            if (self.terminal_liveness)(PROVIDER, sid) {
                tracing::warn!(target: "freshell_freshagent::claude", session_id = sid,
                    request_id = %request_id,
                    "fresh_agent_create_refused: a live terminal PTY owns this session (Task 13b cross-kind live-guard)");
                self.fail_create_session_reserved(&request_id);
                return;
            }
            // Fast-path ADOPT (V1: new server behavior): the durable id already has a
            // live session -- answer created against it, spawn nothing.
            if self.has_live_session(sid).await {
                self.adopt_live_create(&request_id, sid, session_type).await;
                return;
            }
            for round in 0..2u8 {
                match self.leases.claim(
                    PROVIDER,
                    sid,
                    &request_id,
                    crate::session_lease::now_epoch_ms(),
                ) {
                    crate::session_lease::FreshSessionClaim::Acquired => {
                        lease_guard = Some(crate::FreshSessionLeaseGuard::armed(
                            Arc::clone(&self.leases),
                            PROVIDER,
                            sid,
                            &request_id,
                        ));
                        break;
                    }
                    crate::session_lease::FreshSessionClaim::BoundLive { .. } => {
                        // Under-lock ADOPT: the winner completed between our pre-check
                        // and the claim (the V5 TOCTOU window).
                        self.adopt_live_create(&request_id, sid, session_type).await;
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
                                CLAUDE_SIDECAR_OWNERSHIP_ENV,
                                &ownership_id,
                            )
                            .await
                        {
                            self.leases
                                .force_release_after_confirmed_kill(PROVIDER, sid);
                            continue;
                        }
                        tracing::error!(target: "invariant", pid, session_id = sid,
                            "fresh_agent_lease_expired_kill_unconfirmed: holding closed");
                        self.fail_create_session_reserved(&request_id);
                        return;
                    }
                }
            }
        }

        let (mut child, mut stdin, stdout, ownership_id) = match spawn_sidecar().await {
            Ok(parts) => parts,
            Err(err) => {
                if let Some(mut g) = lease_guard.take() {
                    g.fail();
                }
                self.fail_create(&request_id, "CLAUDE_SIDECAR_START_FAILED", &err);
                return;
            }
        };
        // Arm the TTL tree-kill path now that the child + its ownership tag exist.
        if let Some(g) = lease_guard.as_mut() {
            if let Some(pid) = child.id() {
                g.set_kill_handle(pid, &ownership_id);
            }
        }

        // P1.13: FULL settings snapshot for the binding row the consumer writes at
        // `sdk.session.init` (claude has no sandbox concept — always `None`). Built
        // from the SAME values the create request below actually sends.
        let settings = crate::identity_sink::FreshAgentSettings {
            model: msg.model.clone(),
            sandbox: None,
            permission_mode: msg.permission_mode.clone(),
            effort: msg.effort.clone(),
            cwd: msg.cwd.clone(),
        };

        // Send the create request (faithful to createClaudeSdkOptions inputs).
        let create_req = json!({
            "type": "create",
            "requestId": request_id,
            "cwd": msg.cwd,
            "model": msg.model,
            "permissionMode": msg.permission_mode,
            "effort": msg.effort,
            "resumeSessionId": resume_sid,
        });
        if let Err(err) = write_line(&mut stdin, &create_req).await {
            let _ = child.start_kill();
            reap_owned_claude_sidecars(&ownership_id);
            // Own tree torn down above -- releasing the lease is safe (no orphan writer).
            if let Some(mut g) = lease_guard.take() {
                g.fail();
            }
            self.fail_create(&request_id, "CLAUDE_SIDECAR_WRITE_FAILED", &err);
            return;
        }

        // Read stdout until `created` / `create.failed` (bounded). Keep the reader to hand
        // to the consumer so no post-created event line is lost.
        let mut reader = BufReader::new(stdout).lines();
        let created = match read_created(&mut reader, SIDECAR_CREATE_BUDGET).await {
            Ok(session_id) => session_id,
            Err(err) => {
                let _ = child.start_kill();
                reap_owned_claude_sidecars(&ownership_id);
                // Own tree torn down above -- release so the loser can acquire.
                if let Some(mut g) = lease_guard.take() {
                    g.fail();
                }
                self.fail_create(&request_id, "CLAUDE_CREATE_FAILED", &err);
                return;
            }
        };

        // Start the stdout consumer (the completion edge normalization + the Task 2
        // pending-set fold live here). `Some(settings)` => the consumer records a
        // binding row at `sdk.session.init`.
        let broadcast_id = Arc::new(std::sync::Mutex::new(created.clone()));
        let pending = Arc::new(std::sync::Mutex::new(ClaudePending::default()));
        let in_turn = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let turn_tracker = Arc::new(std::sync::Mutex::new(TurnTracker::default()));
        let result_idle_pair_pending = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let turn_lock = Arc::new(TokioMutex::new(()));
        // Fresh session: nothing announced yet; the consumer's status fold owns it.
        let last_status = Arc::new(std::sync::Mutex::new("idle".to_string()));
        let consumer = self.spawn_consumer(
            reader,
            created.clone(),
            session_type.to_string(),
            created.clone(),
            Some(settings.clone()),
            Arc::clone(&broadcast_id),
            Arc::clone(&pending),
            Arc::clone(&last_status),
            Arc::clone(&in_turn),
            Arc::clone(&turn_tracker),
            Arc::clone(&result_idle_pair_pending),
            None,
        );

        // V5 interleaving 2 (Task 12): on the create-resume path, insert
        // `cli_index[durable] = map_key` SYNCHRONOUSLY at session registration
        // (mirroring the attach path) -- NOT lazily at `sdk.session.init`, which lands
        // hundreds of ms later and leaves `has_live_session` blind exactly when the 1s
        // loser retry arrives. The `sdk.session.init` write stays as a corrector.
        if let Some(sid) = resume_sid.as_deref() {
            self.cli_index
                .lock()
                .await
                .insert(sid.to_string(), created.clone());
        }
        self.sessions.lock().await.insert(
            created.clone(),
            ClaudeSession {
                configuration: ClaudeConfiguration {
                    settings,
                    ..ClaudeConfiguration::default()
                },
                stdin,
                child,
                ownership_id: ownership_id.clone(),
                consumer,
                sidecar_session_id: created.clone(),
                cli_session_id: resume_sid.clone(),
                broadcast_id,
                pending,
                in_turn,
                turn_tracker,
                result_idle_pair_pending,
                turn_lock,
                rollback_probe_slot: Arc::new(std::sync::Mutex::new(None)),
                last_status,
            },
        );

        // Task 12: bind the durable id to this live session + release the lease in ONE
        // lock scope. A revoked lease (expired handle-less holder) means we must NOT
        // keep the session -- tear down our own tree and answer failed.
        if let Some(mut g) = lease_guard.take() {
            if !g.complete(&created) {
                if let Some(session) = self.sessions.lock().await.remove(&created) {
                    session.consumer.abort();
                    let mut child = session.child;
                    let _ = child.start_kill();
                    reap_owned_claude_sidecars(&session.ownership_id);
                }
                if let Some(sid) = resume_sid.as_deref() {
                    self.cli_index
                        .lock()
                        .await
                        .retain(|_, mapped| mapped != &created);
                    let _ = sid;
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

        // Cache the completed create for requestId dedup BEFORE responding (mirrors
        // codex/opencode: a duplicate `create` arriving right after this point must see
        // the cache populated, never race past this guard's release and spawn a second
        // sidecar).
        self.create_dedup
            .record_success(
                &request_id,
                ClaudeCreateRecord {
                    session_id: created.clone(),
                },
            )
            .await;

        // Broadcast freshAgent.created (ws-handler.ts:3378). NO sessionRef for claude
        // (adapter.ts returns { sessionId } only); placeholder == the bare nanoid.
        self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: PROVIDER.to_string(),
            request_id,
            runtime_provider: PROVIDER.to_string(),
            session_id: created,
            session_type: session_type.to_string(),
            session_ref: None,
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

    /// The D8 loser answer (Task 12): reuses the existing create-failed frame with the
    /// fixed reservation code — NO new protocol fields (deliberate: avoids a C3 wire
    /// change; the client re-drive uses a fixed floor).
    fn fail_create_session_reserved(&self, request_id: &str) {
        self.broadcast(&ServerMessage::FreshAgentCreateFailed(
            FreshAgentCreateFailed {
                code: "SESSION_RESERVED".to_string(),
                message: "Another resume for this session is in flight".to_string(),
                request_id: request_id.to_string(),
                retryable: Some(true),
            },
        ));
    }

    /// The HAS-LIVE→ADOPT arm (Task 12, V1: new server behavior): answer a loser's
    /// create-with-resume with `freshAgent.created` naming the adopted DURABLE session
    /// (send/attach route to it via Task 10b's `cli_index` resolution) under the
    /// loser's own `requestId` — no spawn, no second writer.
    async fn adopt_live_create(&self, request_id: &str, durable: &str, session_type: &str) {
        self.create_dedup
            .record_success(
                request_id,
                ClaudeCreateRecord {
                    session_id: durable.to_string(),
                },
            )
            .await;
        self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: PROVIDER.to_string(),
            request_id: request_id.to_string(),
            runtime_provider: PROVIDER.to_string(),
            session_id: durable.to_string(),
            session_type: session_type.to_string(),
            session_ref: Some(freshell_protocol::SessionLocator {
                provider: PROVIDER.to_string(),
                session_id: durable.to_string(),
            }),
        }));
    }

    // ── freshAgent.kill (WS) ─────────────────────────────────────────────────

    /// Handle a `freshAgent.kill` for claude/kilroy: remove the session and tear down
    /// its owned sidecar (graceful `shutdown` request, SIGTERM so the SDK cleanly kills
    /// its own `claude` CLI, `kill_on_drop` backstop, `/proc` ownership sweep), evict this
    /// session's requestId dedup cache entries (mirrors
    /// `clearFreshAgentCreateCachesForSession`, `ws-handler.ts:1044-1050`, called from
    /// `ws-handler.ts:3673`), then broadcast `freshAgent.killed`. Idempotent for an
    /// unknown session id, matching the codex/opencode `success:true` pattern.
    pub async fn handle_kill(&self, msg: FreshAgentKill) {
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);

        // Task 10b: durable ids resolve through `cli_index` (alias, don't move) --
        // a kill addressed by the durable id must tear down the live aliased session.
        // Unresolvable ids keep today's idempotent success path.
        let map_key = self
            .resolve_session_key(&session_id)
            .await
            .unwrap_or_else(|| session_id.clone());
        let removed = self.sessions.lock().await.remove(&map_key);
        if let Some(session) = removed {
            session.consumer.abort();
            let mut stdin = session.stdin;
            let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n").await;
            let _ = stdin.flush().await;
            if let Some(pid) = session.child.id() {
                terminate_pid(pid as i32);
            }
            let mut child = session.child;
            let _ = child.start_kill();
            reap_owned_claude_sidecars(&session.ownership_id);
        }

        // Explicit kill evicts this session's requestId dedup cache entries (mirrors
        // `clearFreshAgentCreateCachesForSession`) -- a later duplicate `create` for the
        // same requestId must genuinely mint a fresh session, not replay the one just
        // killed.
        self.create_dedup
            .clear_for_session(|record| record.session_id == map_key)
            .await;

        // Evict the killed session's durable-id index entries (retain covers the case
        // where `sdk.session.init` raced in before the session-map insert).
        self.cli_index
            .lock()
            .await
            .retain(|_, mapped| mapped != &map_key);

        self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
            provider: PROVIDER.to_string(),
            session_id,
            session_type: session_type.to_string(),
            success: true,
        }));
    }

    // ── freshAgent.interrupt (WS) ────────────────────────────────────────────

    /// Handle a `freshAgent.interrupt` for claude/kilroy: forward an `interrupt`
    /// request to the owned sidecar, which calls the SDK's `query.interrupt()` --
    /// mirrors `server/fresh-agent/adapters/claude/adapter.ts:163-168`'s
    /// `interrupt(sessionId) { mapMissingResult(deps.sdkBridge.interrupt(sessionId), ...) }`
    /// -> `server/sdk-bridge.ts:785-793`'s `sp.query.interrupt().catch(warn)`. Fire-and-
    /// forget on success: legacy's `ws-handler.ts:3503-3517` sends NO confirmation frame
    /// when `manager.interrupt(locator)` resolves, only `sendError` on a throw -- so a
    /// successful interrupt here broadcasts nothing either. A missing session mirrors
    /// the `SESSION_NOT_FOUND` convention [`Self::handle_send`] already established for
    /// this provider (and codex/opencode's own `handle_interrupt`), rather than
    /// reproducing legacy's adapter-specific message text verbatim.
    pub async fn handle_interrupt(&self, msg: FreshAgentInterrupt) {
        let session_id = msg.session_id.clone();

        // Task 10b: durable ids resolve through `cli_index` (same aliasing as send).
        let Some(map_key) = self.resolve_session_key(&session_id).await else {
            self.send_error(&None, "SESSION_NOT_FOUND", "claude session not found");
            return;
        };
        let mut guard = self.sessions.lock().await;
        let Some(session) = guard.get_mut(&map_key) else {
            drop(guard);
            self.send_error(&None, "SESSION_NOT_FOUND", "claude session not found");
            return;
        };
        // Address the sidecar by ITS id for this session (== the map key for created
        // sessions; differs for resumed-on-attach sessions, Task 6).
        let interrupt_req = json!({ "type": "interrupt", "sessionId": session.sidecar_session_id });
        if let Err(err) = write_line(&mut session.stdin, &interrupt_req).await {
            drop(guard);
            self.send_error(&None, "CLAUDE_INTERRUPT_FAILED", &err);
        }
        // Focused ep4-r1/ep4-r2 F1: NOTHING retires here and NOTHING retires at
        // the settle ack either — per the SDK contract the control receipt (the
        // sidecar's `sdk.interrupt_settled`) provably lands BEFORE the
        // interrupted op's terminal `sdk.result`, so retiring at the receipt
        // would misattribute that trailing result to the NEXT queued op. The
        // interrupted op's own result owns its fold (rejected interrupts leave
        // everything untouched by construction). The settle frame's sole job
        // is closing rollback's quiesce probe (see handle_rollback). Success:
        // no broadcast (mirrors legacy's silent fire-and-forget interrupt).
    }

    // ── freshAgent.send (WS) ─────────────────────────────────────────────────────────

    /// Handle a `freshAgent.send` for claude: push the user turn into the sidecar's SDK
    /// input stream, then broadcast `freshAgent.send.accepted`. The stdout consumer surfaces
    /// the completion edge (`sdk.result subtype=success` → `freshAgent.turn.complete`).
    /// Claude's send returns void, so NO `submittedTurnId` and NO materialization.
    pub async fn handle_send(&self, msg: FreshAgentSend) {
        let request_id = msg.request_id.clone();
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);

        // Task 10b: a durable claude UUID resolves through `cli_index` to the live
        // session -- no more SESSION_NOT_FOUND for a durable id the index maps.
        //
        // kata 1wxv task 4 review (C1): a resolve/handles MISS while
        // `rollback_in_flight` names this id means the rollback's teardown→respawn
        // window swallowed the map entry (removed at teardown, re-inserted
        // post-spawn under the SAME key with the turn lock carried across). PARK
        // on the registry's membership and re-resolve instead of dying with
        // SESSION_NOT_FOUND — the send then serializes BEHIND the rollback on the
        // carried-over turn lock and lands on the POST-rollback (adopted) session
        // («send waits, rollback wins, then destroys»). `handle_send` still never
        // ACQUIRES `rollback_in_flight` (no circular wait exists): it only polls
        // membership. A miss persisting after the rollback exits means the session
        // is genuinely gone (a provably-rejected fork is torn down) — the honest
        // SESSION_NOT_FOUND leg.
        let (map_key, turn_lock, in_turn, turn_tracker) = loop {
            let handles = match self.resolve_session_key(&session_id).await {
                Some(key) => {
                    let guard = self.sessions.lock().await;
                    guard.get(&key).map(|s| {
                        (
                            key,
                            s.turn_lock.clone(),
                            s.in_turn.clone(),
                            s.turn_tracker.clone(),
                        )
                    })
                }
                None => None,
            };
            if let Some(handles) = handles {
                break handles;
            }
            if !self.rollback_in_flight.contains(&session_id) {
                self.send_error(&request_id, "SESSION_NOT_FOUND", "claude session not found");
                return;
            }
            tokio::time::sleep(MID_ROLLBACK_PARK_TICK).await;
        };
        // r2 serialization discipline: hold the session turn lock across the
        // busy-set AND the sidecar write — the check-then-set window vs
        // `handle_rollback`'s busy gate is closed (a rollback holding this lock
        // observes either no-send or a fully-marked in-flight turn). The lock
        // handle is carried across the rollback's kill+respawn, so a send that
        // resolved before the teardown window serializes identically to one that
        // parked through it.
        let _turn = turn_lock.lock().await;
        if let Some(settings) = msg.settings.as_ref() {
            if let Err(err) = self
                .configure_for_send(&map_key, settings, session_type)
                .await
            {
                self.send_error(&request_id, "CLAUDE_SETTINGS_FAILED", &err);
                return;
            }
        }
        // Task 4 review (C1b): the destroy target comes from POST-lock session
        // state — a rollback holding this lock may have RE-KEYED the durable id
        // (the rollback-row MOVE old→new) while we parked. Keying the destroy by
        // the pre-MOVE id would no-op `destroy_redo_on_submit` and leak redo
        // (decision 5): `destroy_redo_on_submit` keys the record by its CURRENT
        // durable id, i.e. the session record's `cli_session_id` after the
        // adoption re-key. A bare pre-init placeholder can have no rollback
        // record — the addressed canonical id is its only possible key then.
        let destroy_target = {
            let guard = self.sessions.lock().await;
            match guard.get(&map_key) {
                Some(s) => s.cli_session_id.clone().or_else(|| {
                    if is_canonical_claude_uuid(&session_id) {
                        Some(session_id.clone())
                    } else {
                        None
                    }
                }),
                None => {
                    drop(guard);
                    self.send_error(&request_id, "SESSION_NOT_FOUND", "claude session not found");
                    return;
                }
            }
        };
        if let Some(durable) = destroy_target.as_deref() {
            // Decision 5: any new submission permanently destroys redo (the
            // redo-capable chain state only — the marker union is never touched).
            // AWAITED before the turn goes out; a ledger failure is warn-only
            // (never blocks the send).
            if let Some(err) = crate::rollback_record::destroy_redo_on_submit(
                &self.identity_sink(),
                PROVIDER,
                durable,
                crate::rollback_record::now_ms(),
            )
            .await
            {
                tracing::warn!(error = %err, session = %durable, "freshagent.claude.destroy_redo_on_submit_failed");
            }
        }
        // Set the busy truth UNDER the lock, BEFORE the sidecar write — and now
        // ORDER-EXPLICITLY (ep2-r2): this send enqueues as a distinct tracked
        // op behind every outstanding op (or takes the running slot from
        // idle), so its OWN terminal edge — never the prior op's — retires it.
        // ep1-r2 F2: there is NO "belt" disarm of queued compacts here: the
        // sidecar's FIFO input queue merely queues this send BEHIND a pending
        // compact, so a send acceptance proves nothing about queue drainage
        // (the disarm set lives in the in-stream edge fold: observed-compacting
        // terminal edge, the drop peel, sdk.error/EOF).
        let send_was_busy = arm_turn_op(&in_turn, &turn_tracker, TrackedOp::Turn);
        let mut guard = self.sessions.lock().await;
        let Some(session) = guard.get_mut(&map_key) else {
            drop(guard);
            undo_turn_op_arm(&in_turn, &turn_tracker, send_was_busy);
            self.send_error(&request_id, "SESSION_NOT_FOUND", "claude session not found");
            return;
        };
        // Address the sidecar by ITS id for this session (== the map key for created
        // sessions; differs for resumed-on-attach sessions, Task 6).
        let mut send_req =
            json!({ "type": "send", "sessionId": session.sidecar_session_id, "text": msg.text });
        if let Some(images) = msg.images {
            send_req["images"] = json!(images);
        }
        if let Err(err) = write_line(&mut session.stdin, &send_req).await {
            drop(guard);
            // The write never went out — undo EXACTLY our own arm (ep2-r2:
            // recomputed from the surviving tracker, so a still-queued earlier
            // op keeps the busy truth instead of a blanket clear wedging or
            // falsely freeing the gate).
            undo_turn_op_arm(&in_turn, &turn_tracker, send_was_busy);
            self.send_error(&request_id, "CLAUDE_SEND_FAILED", &err);
            return;
        }
        drop(guard);

        self.broadcast(&ServerMessage::FreshAgentSendAccepted(
            FreshAgentSendAccepted {
                provider: PROVIDER.to_string(),
                request_id: request_id.unwrap_or_default(),
                session_id,
                session_type: session_type.to_string(),
                cwd: msg.cwd,
                submitted_turn_id: None,
            },
        ));
    }

    /// The caller owns the session turn lock. Apply changed settings before any
    /// send bookkeeping or text delivery, preserving an unsent prompt on failure.
    async fn configure_for_send(
        &self,
        map_key: &str,
        requested: &freshell_protocol::FreshAgentSendSettings,
        session_type: &str,
    ) -> Result<(), String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (response, next) = {
            let mut sessions = self.sessions.lock().await;
            let session = sessions
                .get_mut(map_key)
                .ok_or("Claude session is no longer available.")?;
            let mut next = session.configuration.settings.clone();
            if let Some(value) = &requested.model {
                if next.model.as_ref() != Some(value) && requested.effort.is_none() {
                    next.effort = None;
                }
                next.model = Some(value.clone());
            }
            if let Some(value) = &requested.effort {
                next.effort = Some(value.clone());
            }
            if let Some(value) = &requested.permission_mode {
                next.permission_mode = Some(value.clone());
            }
            if let Some(value) = &requested.cwd {
                if next.cwd.is_some() || session.configuration.runtime_cwd.as_ref() != Some(value) {
                    next.cwd = Some(value.clone());
                }
            }
            if next == session.configuration.settings && !session.configuration.needs_configure {
                return Ok(());
            }
            if session.in_turn.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(
                    "Wait for the current turn to finish before changing agent settings.".into(),
                );
            }
            let (tx, rx) = tokio::sync::oneshot::channel();
            session.configuration.pending = Some((request_id.clone(), tx));
            let frame = json!({
                "type": "configure", "sessionId": session.sidecar_session_id,
                "requestId": request_id, "settings": {
                    "model": next.model, "effort": next.effort,
                    "permissionMode": next.permission_mode, "cwd": next.cwd,
                },
            });
            if let Err(err) = write_line(&mut session.stdin, &frame).await {
                session.configuration.pending = None;
                return Err(err);
            }
            (rx, next)
        };
        let applied = match tokio::time::timeout(SIDECAR_CREATE_BUDGET, response).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                Err("Claude stopped while applying settings. Your message was not sent.".into())
            }
            Err(_) => Err(
                "Claude did not finish applying settings. Your message was not sent; try again."
                    .into(),
            ),
        };
        let (durable, effective) = {
            let mut sessions = self.sessions.lock().await;
            let session = sessions
                .get_mut(map_key)
                .ok_or("Claude session is no longer available.")?;
            session.configuration.pending = None;
            session.configuration.needs_configure = applied.is_err();
            if applied.is_ok() {
                session.configuration.settings = next;
            }
            // A setter can succeed before a later setter rejects. The receipt
            // reconciles that partial success; persist the actual runtime state
            // even though the user's prompt must remain unsent.
            (
                session.cli_session_id.clone(),
                session.configuration.settings.clone(),
            )
        };
        if let Some(durable) = durable {
            self.adopt_session_init(
                &durable,
                map_key,
                session_type,
                Some(&effective),
                None,
                self.identity_sink(),
            )
            .await;
        }
        applied
    }

    // ── freshAgent.approval.respond / question.respond / compact (WS, Task 2) ─────────

    /// The shared Task 2 handler prologue: resolve the client-addressed id to the
    /// sessions-map key (`resolve_session_key` discipline — map key OR durable UUID via
    /// `cli_index`) and take a session-scoped guard for the sidecar write. A miss at
    /// either step broadcasts the nested `INVALID_SESSION_ID` lost-session envelope
    /// (engaging the client's recovery) and yields `None`.
    async fn respond_session_guard(
        &self,
        session_id: &str,
        session_type: SessionType,
    ) -> Option<tokio::sync::MappedMutexGuard<'_, ClaudeSession>> {
        let Some(map_key) = self.resolve_session_key(session_id).await else {
            self.broadcast(&lost_session_frame(session_id, session_type));
            return None;
        };
        let guard = self.sessions.lock().await;
        if !guard.contains_key(&map_key) {
            drop(guard);
            self.broadcast(&lost_session_frame(session_id, session_type));
            return None;
        }
        Some(tokio::sync::MutexGuard::map(guard, |map| {
            map.get_mut(&map_key).expect("key checked above")
        }))
    }

    /// Handle a `freshAgent.approval.respond` for claude/kilroy: forward a
    /// `permission.respond` request to the owned sidecar with the decision payload
    /// VERBATIM (a defined `updatedInput` wholesale replaces tool input — never
    /// synthesize one), resolving the parked SDK promise (`permission-channel.mjs
    /// respondPermission`). Every failure answers on the NESTED
    /// `freshAgent.event{freshAgent.error}` envelope (the client only surfaces top-level
    /// errors correlated with a pending send, which these control frames never
    /// establish): unknown session → `INVALID_SESSION_ID` (engages the lost-session
    /// recovery); a requestId outside the pending set → `INTERNAL_ERROR` with the parity
    /// message (`adapter.ts:192`). WRITE-THEN-REMOVE (fresh-eyes F3): the pending entry
    /// is removed only after the sidecar write's flush succeeds, so a failed write
    /// leaves the card actionable (the user can retry) — never clear-then-fail.
    pub async fn handle_approval_respond(&self, msg: FreshAgentApprovalRespond) {
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);
        let request_id = request_id_string(&msg.request_id);

        let Some(mut session) = self
            .respond_session_guard(&session_id, msg.session_type)
            .await
        else {
            return;
        };
        if !session
            .pending
            .lock()
            .expect("pending lock")
            .permissions
            .iter()
            .any(|p| p.request_id == request_id)
        {
            drop(session);
            self.emit_fresh_agent_error(
                &session_id,
                session_type,
                "INTERNAL_ERROR",
                &format!("Claude approval {request_id} is not available"),
            );
            return;
        }
        // D2-M3 (delta-review round 2): the shared protocol requires the decision to
        // be a RECORD (`Record<string, unknown>`) and the sidecar resolves it VERBATIM
        // (`permission-channel.mjs` treats a null decision as a no-op), so forwarding
        // a null/array/scalar and removing the entry would hide the card while the
        // parked SDK promise stays unresolved forever (no retry, no resolve — the turn
        // wedges). Refuse LOUDLY and leave the entry pending: DO NOT forward, DO NOT
        // remove.
        if !msg.decision.is_object() {
            drop(session);
            self.emit_fresh_agent_error(
                &session_id,
                session_type,
                "INTERNAL_ERROR",
                &format!("Claude approval {request_id} requires a JSON object decision"),
            );
            return;
        }
        // Address the sidecar by ITS id for this session (== the map key for created
        // sessions; differs for resumed-on-attach sessions, Task 6).
        let respond_req = json!({
            "type": "permission.respond",
            "sessionId": session.sidecar_session_id,
            "requestId": request_id,
            "decision": msg.decision,
        });
        if let Err(err) = write_line(&mut session.stdin, &respond_req).await {
            drop(session);
            self.emit_fresh_agent_error(&session_id, session_type, "INTERNAL_ERROR", &err);
            return;
        }
        session
            .pending
            .lock()
            .expect("pending lock")
            .permissions
            .retain(|p| p.request_id != request_id);
    }

    /// Handle a `freshAgent.question.respond` for claude/kilroy: identical ordering
    /// discipline to [`Self::handle_approval_respond`]; the frame is
    /// `question.respond` with the answers as a JSON object (the sidecar wraps them
    /// into the SDK-shaped `updatedInput`, `permission-channel.mjs respondQuestion`).
    pub async fn handle_question_respond(&self, msg: FreshAgentQuestionRespond) {
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);
        let request_id = request_id_string(&msg.request_id);

        let Some(mut session) = self
            .respond_session_guard(&session_id, msg.session_type)
            .await
        else {
            return;
        };
        if !session
            .pending
            .lock()
            .expect("pending lock")
            .questions
            .iter()
            .any(|q| q.request_id == request_id)
        {
            drop(session);
            self.emit_fresh_agent_error(
                &session_id,
                session_type,
                "INTERNAL_ERROR",
                &format!("Claude question {request_id} is not available"),
            );
            return;
        }
        let answers: Map<String, Value> = msg
            .answers
            .into_iter()
            .map(|(k, v)| (k, Value::String(v)))
            .collect();
        let respond_req = json!({
            "type": "question.respond",
            "sessionId": session.sidecar_session_id,
            "requestId": request_id,
            "answers": Value::Object(answers),
        });
        if let Err(err) = write_line(&mut session.stdin, &respond_req).await {
            drop(session);
            self.emit_fresh_agent_error(&session_id, session_type, "INTERNAL_ERROR", &err);
            return;
        }
        session
            .pending
            .lock()
            .expect("pending lock")
            .questions
            .retain(|q| q.request_id != request_id);
    }

    /// Handle a `freshAgent.compact` for claude/kilroy: write the legacy adapter's plain
    /// user-turn shape (`adapter.ts:168-174`) — `/compact`, or `/compact <instructions
    /// trimmed>` when instructions are present. NO ack frame (compact does not reuse
    /// `handle_send`'s send.accepted broadcast; the turn is observable through the
    /// normal `sdk.*` stream).
    ///
    /// Delta-r1 F1 (busy discipline): a compact IS a turn — the handler mirrors
    /// [`Self::handle_send`] exactly: park through a mid-rollback teardown window
    /// (poll `rollback_in_flight` membership; never acquire it), take the session
    /// `turn_lock` (carried across the rollback kill+respawn, so the check-then-set
    /// window against the rollback busy gate is closed), and set the busy truth
    /// (`in_turn`) UNDER the lock BEFORE the sidecar write. A compact turn ends at
    /// the SDK's `sdk.result` frame (any subtype) — the existing four-edge clear
    /// set terminates it (plus `sdk.status:idle`, sidecar EOF, or a completed
    /// interrupt); a FAILED write clears what we set (nothing was submitted).
    ///
    /// Focused-review ep1-r1 F1 (queued-compact busy truth; ep1-r2 F2's
    /// FIFO-aware disarm; ep1-r3 F3's pre-await arm; ep2-r2's order-explicit
    /// re-model): a compact submitted WHILE a turn is active queues BEHIND it
    /// on the provider, so the handler arms the session's
    /// [`ClaudeSession::turn_tracker`] with a distinct queued entry UNDER the
    /// turn lock, BEFORE the sidecar write await — the consumer's
    /// terminal-edge fold never takes that lock, so only a pre-await arm
    /// closes the mid-window race. The pane stays busy until the compact's OWN
    /// terminal edge lands, or a disarm case (drop peel / sdk.error / EOF)
    /// proves the queue ended differently. A no-write failure SYNCHRONOUSLY
    /// undoes exactly the arm's own entry ([`undo_turn_op_arm`]) and recomputes
    /// `in_turn` from the surviving tracker — never a stale whole-set restore.
    pub async fn handle_compact(&self, msg: FreshAgentCompact) {
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);

        // The `handle_send` resolve discipline (task 4 review C1): a resolve/handles
        // MISS while `rollback_in_flight` names this id means the rollback's
        // teardown→respawn window swallowed the map entry — PARK on the registry's
        // membership and re-resolve (the compact then serializes BEHIND the rollback
        // on the carried-over turn lock). This handler never ACQUIRES
        // `rollback_in_flight` (no circular wait exists): it only polls membership.
        let (map_key, turn_lock, in_turn, turn_tracker) = loop {
            let handles = match self.resolve_session_key(&session_id).await {
                Some(key) => {
                    let guard = self.sessions.lock().await;
                    guard.get(&key).map(|s| {
                        (
                            key,
                            s.turn_lock.clone(),
                            s.in_turn.clone(),
                            s.turn_tracker.clone(),
                        )
                    })
                }
                None => None,
            };
            if let Some(handles) = handles {
                break handles;
            }
            if !self.rollback_in_flight.contains(&session_id) {
                self.broadcast(&lost_session_frame(&session_id, msg.session_type));
                return;
            }
            tokio::time::sleep(MID_ROLLBACK_PARK_TICK).await;
        };
        // Held across the busy-set AND the sidecar write (the handle_send r2
        // serialization discipline) — a rollback holding this lock observes either
        // no-compact or a fully-marked in-flight compact turn.
        let _turn = turn_lock.lock().await;
        // ep1-r3 F3 (the arm/await race): with a prior turn active this compact is
        // QUEUED — arm the tracker NOW, BEFORE the sidecar write await. The stdout
        // consumer's terminal-edge fold NEVER takes the turn lock, so an arm
        // landing only after the await lets the prior turn's terminal edge fold
        // past the unarmed tracker mid-write (busy dies with the compact still
        // owed). A no-write failure leg SYNCHRONOUSLY undoes exactly this arm's
        // own entry below ([`undo_turn_op_arm`]): a compact the blocked sidecar
        // never received must not hold the pane busy. ep2-r2: the arm is a
        // distinct FIFO entry — N queued compacts are N entries retiring at their
        // own observed terminal edges (ep1-r5 F1), and a compact queued BEHIND a
        // garlanded send survives that send's drop peel (ep2-r2 F1).
        let was_busy = arm_turn_op(&in_turn, &turn_tracker, TrackedOp::Compact);
        let mut guard = self.sessions.lock().await;
        let Some(session) = guard.get_mut(&map_key) else {
            drop(guard);
            // Nothing was submitted — undo ONLY what our arm edited (the busy
            // truth must never wedge; a prior turn's truth is not ours to
            // clear).
            undo_turn_op_arm(&in_turn, &turn_tracker, was_busy);
            self.broadcast(&lost_session_frame(&session_id, msg.session_type));
            return;
        };
        let text = match msg.instructions.as_deref().map(str::trim) {
            Some(instructions) if !instructions.is_empty() => {
                format!("/compact {instructions}")
            }
            _ => "/compact".to_string(),
        };
        // Address the sidecar by ITS id for this session (== the map key for created
        // sessions; differs for resumed-on-attach sessions, Task 6).
        let send_req =
            json!({ "type": "send", "sessionId": session.sidecar_session_id, "text": text });
        if let Err(err) = write_line(&mut session.stdin, &send_req).await {
            drop(guard);
            // The write never went out — no turn was submitted: SYNCHRONOUSLY
            // undo the arm's own entry (the handle_send fail-closed leg extended
            // to the tracker; the failure path never holds the blocked
            // sidecar's pane busy over a compact it never received).
            undo_turn_op_arm(&in_turn, &turn_tracker, was_busy);
            self.emit_fresh_agent_error(&session_id, session_type, "INTERNAL_ERROR", &err);
        }
        // The compact write was ACCEPTED; its tracker entry (armed pre-write
        // above) STAYS — only its own terminal edge (or a disarm case) retires it.
    }

    /// The session's live pending approvals + questions as overlay JSON (approvals,
    /// questions) — Task 3's snapshot route consumes this. Entry keys are exactly the
    /// `.strict()` contract shape (`{requestId, toolName?, toolUseID?, blockedPath?,
    /// decisionReason?, input?}` / `{requestId, questions}`, no extra keys, absent keys
    /// omitted). `any_id` resolves like every handler here: the map key OR the durable
    /// Claude UUID via `cli_index`. An untracked id yields two empty vecs.
    pub(crate) async fn snapshot_pending_overlay(&self, any_id: &str) -> (Vec<Value>, Vec<Value>) {
        let Some(map_key) = self.resolve_session_key(any_id).await else {
            return (Vec::new(), Vec::new());
        };
        let guard = self.sessions.lock().await;
        let Some(session) = guard.get(&map_key) else {
            return (Vec::new(), Vec::new());
        };
        let pending = session.pending.lock().expect("pending lock");
        let approvals = pending
            .permissions
            .iter()
            .map(PendingApprovalEntry::to_json)
            .collect();
        let questions = pending
            .questions
            .iter()
            .map(|q| json!({ "requestId": q.request_id, "questions": q.questions }))
            .collect();
        (approvals, questions)
    }

    pub(crate) async fn apply_snapshot_metadata(&self, any_id: &str, snapshot: &mut Value) {
        let Some(key) = self.resolve_session_key(any_id).await else {
            return;
        };
        let sessions = self.sessions.lock().await;
        let Some(session) = sessions.get(&key) else {
            return;
        };
        let status = session.current_status();
        snapshot["status"] = json!(if status == "idle"
            && session.in_turn.load(std::sync::atomic::Ordering::SeqCst)
        {
            "running".to_string()
        } else {
            status
        });
        snapshot["extensions"]["claude"]["statusFromLiveState"] = json!(true);
        let settings = &session.configuration.settings;
        let mut fields = Map::new();
        for (key, value) in [
            ("model", &settings.model),
            ("effort", &settings.effort),
            ("permissionMode", &settings.permission_mode),
        ] {
            if let Some(value) = value {
                fields.insert(key.into(), json!(value));
            }
        }
        if !fields.is_empty() {
            snapshot["settings"] = Value::Object(fields);
        }
        if let Some(commands) = &session.configuration.commands {
            snapshot["commands"] = json!(commands);
        }
    }

    /// Kata 1wxv Task 5: the DURABLE rollback record for the snapshot route.
    /// The Task 4 handler keys the ledger row by the CURRENT durable id and
    /// re-keys it old→new inside the adoption write batch, so the record always
    /// lives under the live durable id. `any_id` resolves like every handler
    /// here (map key or durable UUID via `cli_index`); an UNTRACKED id (e.g. a
    /// disk-only read after a server restart) falls back to the raw id so a
    /// rolled-back session keeps its marked bucket without a live session.
    pub(crate) async fn load_rollback_record(
        &self,
        any_id: &str,
    ) -> Option<crate::rollback_record::RollbackRecord> {
        let durable = match self.resolve_session_key(any_id).await {
            Some(map_key) => self
                .sessions
                .lock()
                .await
                .get(&map_key)
                .and_then(|s| s.cli_session_id.clone())
                .unwrap_or(map_key),
            None => any_id.to_string(),
        };
        self.identity_sink()
            .and_then(|s| s.load_rollback(PROVIDER, &durable))
    }

    /// Reconcile liveness probe (campaign §4.3, Task 13): resolve the DURABLE
    /// claude UUID through [`Self::cli_index`] to its sessions-map key, then
    /// check the map. The sessions map is read UNFILTERED — no session_type
    /// filter, so kilroy sessions count for free (V2 N-A17-1).
    pub async fn has_live_session(&self, session_id: &str) -> bool {
        let Some(key) = self.cli_index.lock().await.get(session_id).cloned() else {
            return false;
        };
        self.sessions.lock().await.contains_key(&key)
    }

    // ── freshAgent.undo / freshAgent.redo (kata 1wxv Task 4; fork-at-point) ────

    /// Decision 6: pending cards inside undone turns are CANCELLED, never silently
    /// resolved. Emits the exact `freshAgent.permission.cancelled` /
    /// `freshAgent.question.cancelled` frames the fold consumes, one per parked
    /// entry, then clears the pending map. Invoked BEFORE the old sidecar is
    /// torn down.
    async fn emit_pending_cancellations(
        &self,
        map_key: &str,
        session_id: &str,
        session_type: &str,
    ) {
        let pending = {
            let guard = self.sessions.lock().await;
            guard.get(map_key).map(|s| Arc::clone(&s.pending))
        };
        let Some(pending) = pending else { return };
        let (permissions, questions) = {
            let mut p = pending.lock().expect("pending lock");
            (
                std::mem::take(&mut p.permissions),
                std::mem::take(&mut p.questions),
            )
        };
        for entry in permissions {
            self.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
                event: json!({
                    "type": "freshAgent.permission.cancelled",
                    "sessionId": session_id,
                    "requestId": entry.request_id,
                }),
                provider: PROVIDER.to_string(),
                session_id: session_id.to_string(),
                session_type: session_type.to_string(),
            }));
        }
        for entry in questions {
            self.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
                event: json!({
                    "type": "freshAgent.question.cancelled",
                    "sessionId": session_id,
                    "requestId": entry.request_id,
                }),
                provider: PROVIDER.to_string(),
                session_id: session_id.to_string(),
                session_type: session_type.to_string(),
            }));
        }
    }

    /// Task-4 compensation: a fork/create failure AFTER the rollback record's
    /// successful pre-write UNDOES that pre-write before the refusal is
    /// answered — fork-at-point provably never mutates the ORIGINAL's history
    /// (the Stage-2 hash-identical invariant), so the ledger must not describe a
    /// rollback that never took effect. The provider-mutation triad (codex's
    /// Rpc-vs-transport split) has no claude analog: EVERY claude failure leg is
    /// provably-unmoved by construction. Task 4 review (Minor-3): when the
    /// pre-op record was ABSENT, the faithful restore of "nothing was here" is
    /// a DELETE of the just-created row — never a fabricated empty record.
    async fn compensate_rollback_record(
        &self,
        durable_id: &str,
        existing: Option<crate::rollback_record::RollbackRecord>,
    ) {
        let Some(sink) = self.identity_sink() else {
            return;
        };
        let result = match existing {
            Some(restore) => sink.record_rollback(PROVIDER, durable_id, restore).await,
            None => sink.delete_rollback(PROVIDER, durable_id).await,
        };
        if let Err(e) = result {
            tracing::warn!(error = %e, session = %durable_id, "freshagent.claude.rollback_compensate_failed");
        }
    }

    /// The pane re-key ride (kata 1wxv Task 4): the existing
    /// `freshAgent.session.materialized` broadcast shape (codex's mint-new respawn
    /// precedent), old client-facing id → new adopted durable id.
    fn broadcast_materialized(&self, old_id: &str, new_id: &str, session_type: &str) {
        self.broadcast(&ServerMessage::FreshAgentSessionMaterialized(
            FreshAgentSessionMaterialized {
                previous_session_id: old_id.to_string(),
                provider: PROVIDER.to_string(),
                session_id: new_id.to_string(),
                session_type: session_type.to_string(),
                session_ref: Some(freshell_protocol::SessionLocator {
                    provider: PROVIDER.to_string(),
                    session_id: new_id.to_string(),
                }),
            },
        ));
    }

    /// Handle a `freshAgent.undo` / `freshAgent.redo` for claude/kilroy (kata 1wxv
    /// Task 4) — conversation rollback emulated by FORK-AT-POINT through the
    /// sidecar: pre-write the durable record, cancel parked cards, kill the old
    /// sidecar, and recreate it with the SDK `query()` options lane (`{resume,
    /// resumeSessionAt, forkSession: true, resumeDropsTurn: <guard>}` — the
    /// standalone `forkSession()` fn is FORBIDDEN, it remaps every uuid), then
    /// adopt the minted durable id through the existing sdk.session.init machinery
    /// (cli_index insert + AWAITED binding WITH supersedes + rollback-row re-key
    /// old→new inside the same awaited batch).
    ///
    /// Redo re-forks at a LATER point from the retained ORIGINAL session (the
    /// chain root), gated by the tip+LCP validity contract: the original's raw
    /// chain tip must still equal the recorded `original_tip_uuid` AND the current
    /// chain must still be a strict prefix of it — else `REDO_UNAVAILABLE` +
    /// `REDO_REMOVED_HISTORY_COPY` (compaction/snips legitimately move things).
    ///
    /// First-turn rollback is LEGAL (r2): `resume_at_uuid: None` means "before the
    /// first message" — the handler creates a FRESH conversation (NO resume keys;
    /// the empty fresh transcript IS the rollback target) and records the
    /// discarded session as the redo source.
    ///
    /// Ordering (durable-BEFORE-mutation + r2 lock discipline): toTurn validation
    /// → rollback_in_flight single-flight (FIRST) → per-session turn lock (held
    /// across the WHOLE handler) → busy gate (`in_turn` — the FIFO tracker's
    /// DERIVED busy cache — ⇒ BUSY_TURN, the SOLE mid-turn protection; no
    /// sidecar traffic at all on a refused attempt, ep2-r2) →
    /// create-resume lease claim on the OLD durable id (so a concurrent attach
    /// cannot bind the pre-rollback id mid-fork) → transcript reads + resume math
    /// → AWAITED record pre-write (a pre-write failure REFUSES with
    /// `LEDGER_WRITE_REFUSAL_COPY`, provider never touched) → pending-cancel
    /// frames → kill+recreate (one `resumeDropsTurn` guard retry: the refusal
    /// prefix maps to the plain-resume recovery, never surfaced raw) → adoption
    /// → `materialized` OLD→NEW broadcast + envelope-stamp flip → rolledBack
    /// broadcast → requesting-sink ack. A fork/create/adoption failure AFTER the
    /// successful pre-write COMPENSATES the record (rewrites the pre-op record)
    /// before the refusal is answered — the ledger never describes a rollback
    /// the provider provably rejected. A rollback NEVER chimes.
    pub async fn handle_rollback(
        &self,
        op: crate::rollback_record::RollbackRequest,
        reply_sink: freshell_terminal::FrameSink,
    ) {
        use crate::claude_snapshot as snap;
        use crate::rollback_record::*;

        let Some(map_key) = self.resolve_session_key(&op.session_id).await else {
            reply_sink(rollback_error_frame(
                &op,
                "INVALID_SESSION_ID",
                "claude session not found",
            ));
            return;
        };
        // `turnId` absent on a toTurn frame is a SERVER-side validation error
        // (never a zod refinement — the frozen contract keeps bare objects).
        if op.mode == RollbackModeReq::ToTurn && op.turn_id.is_none() {
            reply_sink(rollback_error_frame(
                &op,
                "INVALID_ROLLBACK_TARGET",
                "rollback toTurn requires a turnId",
            ));
            return;
        }
        let (durable_id, in_turn, turn_tracker, result_idle_pair_pending, turn_lock, session_type) = {
            let guard = self.sessions.lock().await;
            match guard.get(&map_key) {
                Some(s) => (
                    s.cli_session_id.clone().unwrap_or_else(|| map_key.clone()),
                    s.in_turn.clone(),
                    s.turn_tracker.clone(),
                    s.result_idle_pair_pending.clone(),
                    s.turn_lock.clone(),
                    session_type_str(op.session_type),
                ),
                None => {
                    reply_sink(rollback_error_frame(
                        &op,
                        "INVALID_SESSION_ID",
                        "claude session not found",
                    ));
                    return;
                }
            }
        };
        // Rollback-vs-rollback single-flight (lock order: FIRST, before the turn
        // lock — never the reverse). handle_send never acquires this registry —
        // it only POLLS membership to park through the teardown→respawn window
        // (task 4 review C1).
        let Some(_guard) = self.rollback_in_flight.try_acquire(&durable_id) else {
            reply_sink(rollback_error_frame(
                &op,
                "INTERNAL_ERROR",
                &format!("rollback already in progress for {durable_id}"),
            ));
            return;
        };
        // Held for the REST of this handler. in_turn is set by handle_send UNDER
        // this same lock BEFORE the sidecar write (the check-then-set window is
        // closed): observed false here means no op is in flight. Focused ep1-r1
        // F1 through ep2-r2: `in_turn` is the FIFO tracker's DERIVED busy truth
        // — recomputed from `TurnTracker::busy()` inside every mutation's
        // critical section — so the gate stays closed through every op that is
        // queued or mid-compaction, whether its turn ended technically (the
        // interrupted active turn included, ep2-r2 F2: the queue survives it)
        // or only structurally (every queued op owes its own terminal edge).
        let _turn = turn_lock.lock().await;
        if in_turn.load(std::sync::atomic::Ordering::SeqCst) {
            // ep3-r3 F1: owed debt broken down — queue entries that are ONLY
            // unpromoted compacts (nothing running, no candidate pending, no
            // Turn owed) are provably quiescent and absorb (see
            // [`absorb_unstarted_compact_debt`]). Everything else is genuinely
            // mid-execution risk and refuses.
            if !absorb_unstarted_compact_debt(&in_turn, &turn_tracker) {
                reply_sink(rollback_error_frame(
                    &op,
                    "BUSY_TURN",
                    ROLLBACK_BUSY_MESSAGE,
                ));
                return;
            }
        }

        // Lease discipline: claim the OLD durable id exactly like the
        // create-resume path so a concurrent attach cannot bind the pre-rollback
        // id mid-fork. A REFUSAL LEG — before any record write or teardown.
        let rollback_lease_id = format!("rollback-{}", uuid::Uuid::new_v4());
        let mut lease_guard: Option<crate::FreshSessionLeaseGuard> = None;
        for round in 0..2u8 {
            match self.leases.claim(
                PROVIDER,
                &durable_id,
                &rollback_lease_id,
                crate::session_lease::now_epoch_ms(),
            ) {
                crate::session_lease::FreshSessionClaim::Acquired => {
                    lease_guard = Some(crate::FreshSessionLeaseGuard::armed(
                        Arc::clone(&self.leases),
                        PROVIDER,
                        &durable_id,
                        &rollback_lease_id,
                    ));
                    break;
                }
                crate::session_lease::FreshSessionClaim::BoundLive { live_session_key } => {
                    if live_session_key == map_key {
                        // We ARE the bound live owner of this exact id — proceed
                        // WITHOUT a lease (the binding already names this map key,
                        // which the fork keeps).
                        break;
                    }
                    reply_sink(rollback_error_frame(
                        &op,
                        "SESSION_RESERVED",
                        "Another resume for this session is in flight",
                    ));
                    return;
                }
                crate::session_lease::FreshSessionClaim::Held { .. } => {
                    reply_sink(rollback_error_frame(
                        &op,
                        "SESSION_RESERVED",
                        "Another resume for this session is in flight",
                    ));
                    return;
                }
                crate::session_lease::FreshSessionClaim::ExpiredNeedsKill { pid, ownership_id } => {
                    if round == 0
                        && crate::session_lease::kill_and_confirm_tree_dead(
                            pid,
                            CLAUDE_SIDECAR_OWNERSHIP_ENV,
                            &ownership_id,
                        )
                        .await
                    {
                        self.leases
                            .force_release_after_confirmed_kill(PROVIDER, &durable_id);
                        continue;
                    }
                    tracing::error!(target: "invariant", pid, session_id = %durable_id,
                        "fresh_agent_lease_expired_kill_unconfirmed: holding closed");
                    reply_sink(rollback_error_frame(
                        &op,
                        "SESSION_RESERVED",
                        "Another resume for this session is in flight",
                    ));
                    return;
                }
            }
        }

        let now = now_ms();
        let existing = self
            .identity_sink()
            .and_then(|s| s.load_rollback(PROVIDER, &durable_id));

        let (
            resume_from,
            resume_at_uuid,
            removed_turns,
            prompt_text,
            chain_root,
            original_tip_uuid,
            can_redo_after,
            guard_uuid,
        ) = match op.direction {
            RollbackDirection::Undo => {
                let Some(path) = snap::locate_transcript(&durable_id) else {
                    reply_sink(rollback_error_frame(
                        &op,
                        "NOTHING_TO_UNDO",
                        UNDO_EMPTY_MESSAGE,
                    ));
                    return;
                };
                let text = match std::fs::read_to_string(&path) {
                    Ok(t) => t,
                    Err(e) => {
                        reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &e.to_string()));
                        return;
                    }
                };
                let target = match op.mode {
                    RollbackModeReq::Step => snap::ResumeTarget::Step,
                    RollbackModeReq::ToTurn => {
                        snap::ResumeTarget::ToTurn(op.turn_id.clone().expect("validated"))
                    }
                };
                let point = match snap::resolve_resume_point(&text, &durable_id, target) {
                    Ok(p) => p, // resume_at_uuid None = "before the first message" — LEGAL (r2)
                    Err(snap::ResumeResolveError::Empty) => {
                        reply_sink(rollback_error_frame(
                            &op,
                            "NOTHING_TO_UNDO",
                            UNDO_EMPTY_MESSAGE,
                        ));
                        return;
                    }
                    Err(_) => {
                        reply_sink(rollback_error_frame(
                            &op,
                            "INVALID_ROLLBACK_TARGET",
                            &format!("turn {:?} is not in this conversation", op.turn_id),
                        ));
                        return;
                    }
                };
                // Epoch rule (r2/r3): an undo landing while redo_destroyed is set
                // re-roots the chain to the CURRENT durable id — the retained old
                // original describes a branch a resend already permanently
                // replaced; O's redo stays permanently dead.
                let chain_root = existing
                    .as_ref()
                    .filter(|r| !r.redo_destroyed)
                    .and_then(|r| r.original_session_id.clone())
                    .unwrap_or_else(|| durable_id.clone());
                // Tip anchor at UNDO time = the last raw-chain uuid of the
                // CHAIN-ROOT transcript (at the first undo the current file IS the root).
                let root_text = if chain_root == durable_id {
                    text.clone()
                } else {
                    match snap::locate_transcript(&chain_root)
                        .and_then(|p| std::fs::read_to_string(p).ok())
                    {
                        Some(t) => t,
                        None => {
                            reply_sink(rollback_error_frame(
                                &op,
                                "INTERNAL_ERROR",
                                "chain-root transcript unreadable",
                            ));
                            return;
                        }
                    }
                };
                let tip = snap::raw_chain_tip(&root_text);
                // The resumeDropsTurn guard uuid = the RAW chain entry at the
                // removed step's first position (task 4 review nit 4 — SDK-exact
                // + cheaper than the display projection; brief/SDK semantics:
                // the guard declares the discarded turn's prompt).
                let guard = point.guard_uuid.clone();
                // can_redo after the undo: the removed content provably exists in
                // the original beyond the resume point (on the r2 first-turn leg
                // the fresh conversation's tip is NONE — strictly beyond holds
                // whenever a tip exists).
                (
                    durable_id.clone(),
                    point.resume_at_uuid,
                    point.removed_turns,
                    point.prompt_text,
                    chain_root,
                    tip,
                    true,
                    guard,
                )
            }
            RollbackDirection::Redo => {
                let Some(record) = existing.clone() else {
                    reply_sink(rollback_error_frame(
                        &op,
                        "REDO_UNAVAILABLE",
                        REDO_EMPTY_MESSAGE,
                    ));
                    return;
                };
                if record.redo_destroyed {
                    reply_sink(rollback_error_frame(
                        &op,
                        "REDO_UNAVAILABLE",
                        REDO_DESTROYED_MESSAGE,
                    ));
                    return;
                }
                let Some(original) = record.original_session_id.clone() else {
                    reply_sink(rollback_error_frame(
                        &op,
                        "REDO_UNAVAILABLE",
                        REDO_EMPTY_MESSAGE,
                    ));
                    return;
                };
                let Some(original_path) = snap::locate_transcript(&original) else {
                    reply_sink(rollback_error_frame(
                        &op,
                        "REDO_UNAVAILABLE",
                        REDO_REMOVED_HISTORY_COPY,
                    ));
                    return;
                };
                let original_text = match std::fs::read_to_string(&original_path) {
                    Ok(t) => t,
                    Err(e) => {
                        reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &e.to_string()));
                        return;
                    }
                };
                let Some(current_path) = snap::locate_transcript(&durable_id) else {
                    reply_sink(rollback_error_frame(
                        &op,
                        "INTERNAL_ERROR",
                        "current transcript missing",
                    ));
                    return;
                };
                // Task 4 review (Minor-2): classify the read OUTCOME — a missing
                // file (or a raced deletion) is the DELIBERATE vacuous-empty leg
                // (the post-first-turn-undo empty transcript; LCP admits the
                // first group end), but any REAL read error on this
                // existing-expected path is a loud INTERNAL_ERROR, exactly like
                // the original's read leg above — never a silent empty-chain
                // degradation yielding a false `redone` ack plus a pointless fork.
                let current_text = match std::fs::read_to_string(&current_path) {
                    Ok(t) => t,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                    Err(e) => {
                        reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &e.to_string()));
                        return;
                    }
                };
                // Redo validity contract (wire design; LBC-9): the original must
                // BE the history the undo observed — raw-chain tip == the
                // recorded tip — AND the current chain must still be a strict
                // prefix of it (the LCP resolves PAST the current tip). Any
                // miss => loud REDO_UNAVAILABLE + REDO_REMOVED_HISTORY_COPY;
                // never silently re-fork over moved history.
                let original_tip = snap::raw_chain_tip(&original_text);
                if original_tip != record.original_tip_uuid {
                    reply_sink(rollback_error_frame(
                        &op,
                        "REDO_UNAVAILABLE",
                        REDO_REMOVED_HISTORY_COPY,
                    ));
                    return;
                }
                if snap::raw_lcp_end(&current_text, &original_text)
                    != snap::raw_chain_tip(&current_text)
                {
                    reply_sink(rollback_error_frame(
                        &op,
                        "REDO_UNAVAILABLE",
                        REDO_REMOVED_HISTORY_COPY,
                    ));
                    return;
                }
                // The resume point = the LAST raw-chain uuid of the restored
                // step's group — its assistant tail (r3 boundary rule).
                let resume_at = match snap::redo_resume_target(&original_text, &current_text, &op) {
                    Ok(Some(uuid)) => uuid,
                    Ok(None) => {
                        reply_sink(rollback_error_frame(
                            &op,
                            "REDO_UNAVAILABLE",
                            REDO_EMPTY_MESSAGE,
                        ));
                        return;
                    }
                    Err(msg) => {
                        reply_sink(rollback_error_frame(&op, "INVALID_ROLLBACK_TARGET", &msg));
                        return;
                    }
                };
                // The ack payload for a redo = the RESTORED slice (display
                // projection of the original's range just-after-the-prefix
                // through the resume point).
                let restored =
                    snap::restored_slice_turns(&original_text, &current_text, &resume_at);
                let can_redo_after_redo = original_tip.as_deref() != Some(resume_at.as_str());
                // The guard = the first ORIGINAL chain entry strictly AFTER the
                // resume point (`None` — redoing TO the tip — omits it: the
                // discard range is vacuous, never fabricated).
                let guard = snap::raw_chain_successor(&original_text, &resume_at);
                (
                    original,
                    Some(resume_at),
                    restored.turns,
                    restored.prompt_text,
                    record.original_session_id.clone().expect("checked above"),
                    record.original_tip_uuid.clone(),
                    can_redo_after_redo,
                    guard,
                )
            }
        };

        // Durable record FIRST (durable-BEFORE-mutation): computed from the
        // pre-mutation reads, keyed by the CURRENT durable id, AWAITED before
        // anything is torn down. The sdk.session.init adoption leg re-keys the
        // row old→new inside its awaited binding batch — exactly one
        // rollback-record-specific write, always pre-mutation. r3 UNION rule:
        // `entries` accumulates; a NEW epoch freezes every prior entry (they stay
        // first) and NEVER clears the bucket.
        let mut record = existing
            .clone()
            .unwrap_or_else(|| RollbackRecord::empty(now));
        match op.direction {
            RollbackDirection::Undo => {
                // Epoch rule (r3 + delta-r1 F8's literal bookkeeping): an undo
                // landing while redo_destroyed was set (or whose chain root
                // re-roots away from the prior record's) is a NEW epoch — bump
                // `current_epoch` (every existing entry freezes with its own
                // epoch), the destroyed bit clears so the record's redo fields
                // describe the NEW chain (the prior chain's redo stays
                // permanently dead), `entries` is NEVER cleared. Same-epoch
                // undos splice the new (earlier-in-conversation) entry BEFORE
                // the existing current-epoch block — positions never read
                // timestamps.
                let new_epoch = record.redo_destroyed
                    || (existing
                        .as_ref()
                        .is_some_and(|r| r.original_session_id.is_some())
                        && existing
                            .as_ref()
                            .and_then(|r| r.original_session_id.clone())
                            .as_deref()
                            != Some(chain_root.as_str()));
                if new_epoch {
                    record.redo_destroyed = false;
                    record.begin_new_epoch();
                }
                record.splice_undo_entry(
                    RollbackEntry {
                        removed_turns: removed_turns.clone(),
                        prompt_text: prompt_text.clone(),
                        at_ms: now,
                        epoch: record.current_epoch,
                    },
                    now,
                );
            }
            RollbackDirection::Redo => {
                // The restored turns leave the CURRENT-epoch marker portion (they
                // are live again); frozen prior-epoch markers can never match a
                // restorable id (the redo contract's LCP/tip validation can only
                // restore from the current chain root).
                let restored_id_set: std::collections::HashSet<&str> = removed_turns
                    .iter()
                    .filter_map(|t| {
                        t.get("turnId")
                            .or_else(|| t.get("id"))
                            .and_then(Value::as_str)
                    })
                    .collect();
                record.entries.retain_mut(|e| {
                    e.removed_turns.retain(|t| {
                        !t.get("turnId")
                            .or_else(|| t.get("id"))
                            .and_then(Value::as_str)
                            .is_some_and(|id| restored_id_set.contains(id))
                    });
                    !e.removed_turns.is_empty()
                });
            }
        }
        record.original_session_id = Some(chain_root.clone());
        record.original_tip_uuid = original_tip_uuid.clone();
        record.last_op_at_ms = now;
        record.set_can_redo(can_redo_after, now);
        if let Some(sink) = self.identity_sink() {
            if let Err(e) = sink
                .record_rollback(PROVIDER, &durable_id, record.clone())
                .await
            {
                tracing::warn!(error = %e, session = %durable_id, "freshagent.claude.rollback_pre_write_failed");
                reply_sink(rollback_error_frame(
                    &op,
                    "INTERNAL_ERROR",
                    LEDGER_WRITE_REFUSAL_COPY,
                ));
                return;
            }
        }

        // ep3-r5 F1 (the admit→teardown window): the gate's quiescence-proof is
        // consumed ONCE at admission — a compact can arm and start (status
        // folded, candidate set, gate re-boosted by ep3-r4 F1) while this
        // already-admitted handler is doing transcript I/O. The quiesce probe
        // above makes all provably-written evidence folded-visible; the
        // recheck here (at the point of no return, immediately before
        // teardown) aborts the rollback with BUSY_TURN plus a compensating
        // ledger rewrite whenever that truth revived (the durable pre-write
        // provably matches the provider: nothing was mutated).
        if let Ok(ms) = std::env::var("FRESHELL_TEST_CLAUDE_ROLLBACK_PRE_TEARDOWN_MS") {
            // Test-only knob: parks this handler in the admit→teardown window so
            // the recheck choreography is deterministic (never in production).
            if let Ok(ms) = ms.parse::<u64>() {
                tokio::time::sleep(Duration::from_millis(ms)).await;
            }
        }

        // Focused ep4-r2/ep4-r3 (the post-admission evidence race, repaired
        // for real): absorbed compact debt can STILL start in the sidecar
        // after admission — the dispatch lifecycle is: sidecar input queue →
        // SAME-TICK handoff when the SDK consumer is awaiting → SDK turn
        // start (its `compacting` status folds the candidate here). The
        // quiesce probe closes every leg of that lifecycle atomically: the
        // sidecar (1) DROPS never-handed compacts from its own input queue
        // (cancellation the SDK surface cannot provide for queue items), (2)
        // reports in-flight/handed truth, and (3) answers on its stdout
        // stream AFTER every already-emitted piece of evidence has been folded
        // (stream order), correlated by probeId so a stale receipt can never
        // close the probe. The verdict gates below plus the recheck cover the
        // whole shape: all-clear → proceed; any busy signal or no answer →
        // BUSY_TURN + compensating ledger rewrite. Skip when no live evidence
        // path exists: write failure (sidecar already dead), or a FINISHED
        // consumer (its EOF reaped the busy truth; nothing fresh can arrive).
        let mut probe_armed = false;
        let mut probe_rx = None;
        let mut probe_id = String::new();
        {
            let mut guard = self.sessions.lock().await;
            if let Some(session) = guard.get_mut(&map_key) {
                if session.consumer.is_finished() {
                    // EOF already zeroed the tracker — the recheck sees it.
                } else {
                    let (tx, rx) = tokio::sync::oneshot::channel::<QuiesceVerdict>();
                    probe_id = uuid::Uuid::new_v4().to_string();
                    *session
                        .rollback_probe_slot
                        .lock()
                        .expect("rollback probe slot lock") = Some((probe_id.clone(), tx));
                    // ep4-r3: the quiesce is its own request type — the sidecar
                    // drains never-handed queued compacts and answers with its
                    // own queue truth (the SDK's queued inputs cannot be
                    // cancelled once handed).
                    let probe_req = json!({
                        "type": "rollback.quiesce",
                        "sessionId": session.sidecar_session_id,
                        "probeId": probe_id,
                    });
                    match write_line(&mut session.stdin, &probe_req).await {
                        Ok(()) => {
                            probe_armed = true;
                            probe_rx = Some(rx);
                        }
                        Err(_) => {
                            let _ = session
                                .rollback_probe_slot
                                .lock()
                                .expect("rollback probe slot lock")
                                .take();
                        }
                    }
                }
            }
        }
        if probe_armed {
            let timeout_ms = std::env::var("FRESHELL_TEST_CLAUDE_ROLLBACK_PROBE_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(3000);
            let verdict =
                tokio::time::timeout(Duration::from_millis(timeout_ms), probe_rx.unwrap()).await;
            match verdict {
                Ok(Ok(QuiesceVerdict {
                    cancelled_queue,
                    in_flight_turn: false,
                    handed_compact_likely: false,
                })) => {
                    if cancelled_queue > 0 {
                        tracing::info!(
                            session = %map_key,
                            cancelled = cancelled_queue,
                            "freshagent.claude.rollback_quiesce_cancelled_queue"
                        );
                    }
                }
                Ok(Ok(verdict)) => {
                    // ep4-r3 F1: provider work crossed the un-cancellable
                    // handoff (a turn mid-flight, or a compact already handed
                    // to an awaiting SDK consumer) — refuse.
                    tracing::info!(session = %map_key, ?verdict, "freshagent.claude.rollback_quiesce_busy");
                    // ep4-r6 F5: never fabricate an empty row for a rollback
                    // that never happened — the shared helper DELETES the
                    // pre-write when the pre-op record was absent.
                    self.compensate_rollback_record(&durable_id, existing.clone())
                        .await;
                    reply_sink(rollback_error_frame(
                        &op,
                        "BUSY_TURN",
                        ROLLBACK_BUSY_MESSAGE,
                    ));
                    return;
                }
                _ => {
                    // Timeout (or a dropped sender — impossible in practice
                    // since the slot outlives this handler): the absorb premise
                    // is unproven — refuse rather than tear a live provider
                    // flow down blind. Clear OUR slot (a stale receipt must
                    // never fire a later probe — ep4-r3 F2 defense in depth
                    // on top of probeId correlation).
                    if let Some(session) = self.sessions.lock().await.get(&map_key) {
                        let mut slot = session
                            .rollback_probe_slot
                            .lock()
                            .expect("rollback probe slot lock");
                        if slot.as_ref().is_some_and(|(id, _)| *id == probe_id) {
                            slot.take();
                        }
                    }
                    // ep4-r6 F5: never fabricate an empty row for a rollback
                    // that never happened — the shared helper DELETES the
                    // pre-write when the pre-op record was absent.
                    self.compensate_rollback_record(&durable_id, existing.clone())
                        .await;
                    reply_sink(rollback_error_frame(
                        &op,
                        "BUSY_TURN",
                        ROLLBACK_BUSY_MESSAGE,
                    ));
                    return;
                }
            }
        }

        let revived = {
            let tracker = turn_tracker.lock().expect("turn tracker lock");
            tracker.running.is_some()
                || tracker.compact_candidate
                || tracker.queued.iter().any(|op| *op == TrackedOp::Turn)
        };
        if revived {
            // Compensate the pre-op durable record: the provider was never
            // touched, so the ledger must describe nothing happening —
            // restore the pre-op record, and DELETE the just-written row when
            // there was none (never fabricate, ep4-r6 F5).
            self.compensate_rollback_record(&durable_id, existing.clone())
                .await;
            reply_sink(rollback_error_frame(
                &op,
                "BUSY_TURN",
                ROLLBACK_BUSY_MESSAGE,
            ));
            return;
        }

        // Cancel pending cards BEFORE teardown (decision 6) — both spawn legs.
        self.emit_pending_cancellations(&map_key, &op.session_id, session_type)
            .await;

        // Pre-compute the create-drive inputs: recovered settings + the resume
        // value/cwd (ledger A15 slug scoping; the transcript-PATH escape hatch
        // when the original cwd is gone). The fork READS: undo ⇒ the CURRENT
        // session's file; redo ⇒ the chain-root ORIGINAL's file (`resume_from`).
        let recovered = self
            .identity_sink()
            .and_then(|s| s.load_settings(PROVIDER, &durable_id));
        let source_path = snap::locate_transcript(&resume_from);
        let original_cwd = source_path
            .as_deref()
            .and_then(snap::transcript_cwd)
            .filter(|c| std::path::Path::new(c).is_dir());
        // resume value (the fork leg): the durable id under its ORIGINAL cwd's
        // slug scope when that cwd survives; else the transcript PATH (the
        // verified cli.js escape hatch bypassing slug scoping).
        let resume_value = match &original_cwd {
            Some(_) => resume_from.clone(),
            None => source_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| resume_from.clone()),
        };
        let spawn_cwd = original_cwd
            .clone()
            .or_else(|| op.cwd.clone())
            .or_else(|| recovered.as_ref().and_then(|r| r.cwd.clone()));
        // Tear down the old sidecar (handle_kill discipline): remove the record
        // FIRST so its consumer's exit arm stays silent (evicted=false), then the
        // graceful shutdown → SIGTERM → kill backstop → ownership sweep, and the
        // create-dedup eviction so a replayed requestId genuinely re-spawns.
        let old = self.sessions.lock().await.remove(&map_key);
        self.create_dedup
            .clear_for_session(|record| record.session_id == map_key)
            .await;
        if let Some(session) = old {
            session.consumer.abort();
            let mut stdin = session.stdin;
            let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n").await;
            let _ = stdin.flush().await;
            if let Some(pid) = session.child.id() {
                terminate_pid(pid as i32);
            }
            let mut child = session.child;
            let _ = child.start_kill();
            reap_owned_claude_sidecars(&session.ownership_id);
        }

        // Kill + recreate via `spawn_sidecar` with the computed options. The
        // create payload is selected by `resume_at_uuid`:
        //   * Some(uuid) — fork-at-point (resume + resumeSessionAt + forkSession);
        //   * None (r2 first-turn rollback) — a FRESH conversation with NO resume
        //     keys at all (the empty fresh transcript IS the rollback target).
        // ONE guard retry: a create whose early output carries the
        // `Resume rejected by --resume-drops-turn:` prefix is retried ONCE with
        // resumeDropsTurn omitted (the plain-resume recovery per the SDK docs —
        // the raw guard text is never surfaced).
        let mut guard_retried = guard_uuid.is_none(); // no guard => nothing to retry
        let spawned = loop {
            let mut create_req = Map::new();
            create_req.insert("type".to_string(), json!("create"));
            create_req.insert(
                "requestId".to_string(),
                json!(format!("rollback-{}", uuid::Uuid::new_v4())),
            );
            if let Some(cwd) = &spawn_cwd {
                create_req.insert("cwd".to_string(), json!(cwd));
            }
            if let Some(rec) = &recovered {
                if let Some(model) = &rec.model {
                    create_req.insert("model".to_string(), json!(model));
                }
                if let Some(permission_mode) = &rec.permission_mode {
                    create_req.insert("permissionMode".to_string(), json!(permission_mode));
                }
                if let Some(effort) = &rec.effort {
                    create_req.insert("effort".to_string(), json!(effort));
                }
            }
            if let Some(resume_at) = &resume_at_uuid {
                create_req.insert("resumeSessionId".to_string(), json!(resume_value));
                create_req.insert("resumeSessionAt".to_string(), json!(resume_at));
                create_req.insert("forkSession".to_string(), json!(true));
                if let Some(guard) = &guard_uuid {
                    // attempt 1 arms the guard; the retried recovery omits it.
                    if !guard_retried {
                        create_req.insert("resumeDropsTurn".to_string(), json!(guard));
                    }
                }
            }
            let create_req = Value::Object(create_req);
            match self
                .rollback_spawn_create(&create_req, lease_guard.as_mut())
                .await
            {
                Ok(ok) => break Ok(ok),
                Err(RollbackSpawnError::GuardRefusal) if !guard_retried => {
                    tracing::warn!(session = %durable_id,
                        "freshagent.claude.rollback_guard_refused_retrying_plain");
                    guard_retried = true;
                    continue;
                }
                Err(RollbackSpawnError::GuardRefusal) => {
                    break Err("the --resume-drops-turn guard refusal persisted after the plain-resume recovery retry".to_string())
                }
                Err(RollbackSpawnError::Other(message)) => break Err(message),
            }
        };
        let spawned = match spawned {
            Ok(ok) => ok,
            Err(err) => {
                self.compensate_rollback_record(&durable_id, existing.clone())
                    .await;
                if let Some(mut g) = lease_guard.take() {
                    g.fail();
                }
                reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &err));
                return;
            }
        };
        let RollbackSpawned {
            child,
            stdin,
            reader,
            ownership_id,
            sidecar_session_id,
            preseeded_init,
            cli_id,
        } = spawned;

        // Register the replacement session under the SAME map key, INHERITING
        // the turn lock + busy truth handles (a mid-rollback send serializes on
        // the SAME lock regardless of when it resolved its handle).
        let (adopted_tx, adopted_rx) = tokio::sync::oneshot::channel();
        let broadcast_id = Arc::new(std::sync::Mutex::new(op.session_id.clone()));
        let pending = Arc::new(std::sync::Mutex::new(ClaudePending::default()));
        // The respawn is fresh: nothing announced yet; the consumer's status
        // fold owns the tracked status from here.
        let last_status = Arc::new(std::sync::Mutex::new("idle".to_string()));
        let consumer = self.spawn_consumer(
            reader,
            map_key.clone(),
            session_type.to_string(),
            sidecar_session_id.clone(),
            recovered.clone(),
            Arc::clone(&broadcast_id),
            Arc::clone(&pending),
            Arc::clone(&last_status),
            in_turn.clone(),
            turn_tracker.clone(),
            result_idle_pair_pending.clone(),
            Some(RollbackAdoption {
                supersedes: durable_id.clone(),
                preseeded_init,
                adopted_tx,
            }),
        );
        self.sessions.lock().await.insert(
            map_key.clone(),
            ClaudeSession {
                configuration: ClaudeConfiguration {
                    settings: recovered.clone().unwrap_or_default(),
                    ..ClaudeConfiguration::default()
                },
                stdin,
                child,
                ownership_id,
                consumer,
                sidecar_session_id,
                cli_session_id: Some(cli_id.clone()),
                broadcast_id: Arc::clone(&broadcast_id),
                pending,
                in_turn: in_turn.clone(),
                turn_tracker: turn_tracker.clone(),
                result_idle_pair_pending: result_idle_pair_pending.clone(),
                turn_lock: turn_lock.clone(),
                rollback_probe_slot: Arc::new(std::sync::Mutex::new(None)),
                last_status,
            },
        );

        // Adoption rides the EXISTING sdk.session.init consumer (preseeded):
        // cli_index insert + AWAITED binding WITH supersedes + rollback-row
        // re-key old→new inside the same awaited batch — then resolves this
        // channel with the adopted durable id.
        let adopted_id = match tokio::time::timeout(SIDECAR_CREATE_BUDGET, adopted_rx).await {
            Ok(Ok(Some(id))) if !id.is_empty() => id,
            _ => {
                tracing::error!(target: "invariant", session = %durable_id,
                    "freshagent.claude.rollback_adoption_failed: the consumer never resolved the init adoption");
                self.compensate_rollback_record(&durable_id, existing.clone())
                    .await;
                // Tear the fork down — an unadopted fork must never answer sends.
                self.teardown_rollback_fork(&map_key).await;
                if let Some(mut g) = lease_guard.take() {
                    g.fail();
                }
                reply_sink(rollback_error_frame(
                    &op,
                    "INTERNAL_ERROR",
                    "rollback adoption failed on the forked sidecar",
                ));
                return;
            }
        };

        // Lease completion: bind the OLD durable id to the live map key and
        // release the lease in one lock scope. A revoked lease means we must NOT
        // keep the fork — tear down, compensate, refuse.
        if let Some(mut g) = lease_guard.take() {
            if !g.complete(&map_key) {
                self.compensate_rollback_record(&durable_id, existing.clone())
                    .await;
                self.teardown_rollback_fork(&map_key).await;
                g.fail(); // own tree torn down — reopen the key
                reply_sink(rollback_error_frame(
                    &op,
                    "INTERNAL_ERROR",
                    "session lease revoked during rollback; torn down",
                ));
                return;
            }
        }

        // Pane re-key: the existing materialized broadcast (old → new) goes out
        // BEFORE any frame stamped with the new id; the envelope-stamp flip
        // follows it so the re-key never outruns the pane.
        self.broadcast_materialized(&op.session_id, &adopted_id, session_type);
        *broadcast_id.lock().expect("broadcast id lock") = adopted_id.clone();

        let removed_ids: Vec<String> = removed_turns
            .iter()
            .filter_map(|t| {
                t.get("turnId")
                    .or_else(|| t.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        // Re-stamp the op for the NEW live id so every outbound frame names the
        // adopted session.
        let switch = RollbackRequest {
            session_id: adopted_id.clone(),
            ..op
        };
        self.broadcast(&rollback_broadcast_frame(
            &switch,
            &adopted_id,
            &removed_ids,
            record.can_redo(),
        ));
        reply_sink(rollback_ack_frame(
            &switch,
            &adopted_id,
            Some(&prompt_text),
            &removed_ids,
            record.can_redo(),
            Some(&adopted_id),
        ));
    }

    /// Resolve a client-addressed session id to the sessions-map key (Task 10b): the id
    /// itself when tracked, else through [`Self::cli_index`] (durable UUID -> map key).
    /// The map is never re-keyed (in-flight consumers hold the placeholder key);
    /// `cli_index` IS the alias table, so every map consumer works under BOTH keys.
    async fn resolve_session_key(&self, session_id: &str) -> Option<String> {
        if self.sessions.lock().await.contains_key(session_id) {
            return Some(session_id.to_string());
        }
        let mapped = self.cli_index.lock().await.get(session_id).cloned()?;
        self.sessions
            .lock()
            .await
            .contains_key(&mapped)
            .then_some(mapped)
    }

    // ── freshAgent.attach (restart parity: resume untracked sessions in place) ──────────

    /// Handle a `freshAgent.attach` for claude/kilroy. Decision table (restart parity):
    ///
    /// | State | Action |
    /// |---|---|
    /// | tracked under `msg.session_id` | no-op -- NO frame (wire-shape parity, unchanged). Safe against dead sidecars ONLY because the consumer-exit eviction removes dead entries (ledger A9) |
    /// | untracked, no canonical durable id on the message | `lost_session_frame` (`INVALID_SESSION_ID`) -- unchanged fallback (also covers the verified A2 edge: a pane that never learned its UUID pre-kill attaches bare; lost -> client re-create is the designed, non-destructive outcome) |
    /// | untracked, durable id already in `cli_index`, aliased session LIVE | REBIND + ACK (Task 10b): flip the live session's envelope stamp to the durable id and answer with the `freshAgent.session.snapshot` stamped with the durable and the session's TRACKED status (the consumer's turn-lifecycle + sdk.status fold, never a hardcoded idle) -- the attaching client must observe success, never silence. The map is never re-keyed (alias, don't move) |
    /// | untracked, durable id in `cli_index` but aliased session GONE (stale row, eviction in flight) | fall through to the resume path below (the session is dead; resuming converges the client) |
    /// | untracked, transcript EXISTS (in ANY candidate root) | spawn sidecar and resume with the session's ORIGINAL cwd from `transcript_cwd` (ledger A15: the CLI's resume lookup is cwd-slug-scoped); if that cwd no longer exists, resume by the transcript's `.jsonl` PATH (verified cli.js escape hatch that bypasses slug scoping) with the attach cwd. Register under the CLIENT's `msg.session_id`, emit a `freshAgent.session.snapshot` whose `timelineSessionId` is the durable UUID -- NEVER a nanoid (the frozen client persists it unvalidated, ledger A14/N3) -- carrying the session's tracked status ("idle" for a fresh resume, by construction) |
    /// | untracked, transcript ABSENT in EVERY candidate root | `lost_session_frame` -- positive denial: the store is the authority (honest even under the 30-day GC, ledger A4) |
    /// | untracked, spawn/pipe/created failure (incl. no store root resolvable) | top-level `error` `CLAUDE_ATTACH_RESUME_FAILED` -- NEVER the lost frame |
    pub async fn handle_attach(&self, msg: FreshAgentAttach) {
        if self.sessions.lock().await.contains_key(&msg.session_id) {
            return; // tracked-and-alive: no frame (wire-shape parity with codex)
        }
        let Some(durable) = attach_durable_id(&msg) else {
            // No durable identity to resume from: the pre-parity fallback (PR #529).
            self.broadcast(&lost_session_frame(&msg.session_id, msg.session_type));
            return;
        };
        if self
            .try_rebind_to_live(&durable, session_type_str(msg.session_type))
            .await
        {
            // Task 10b: durable-in-cli_index on a LIVE session is a REBIND + ACK, not a
            // silent no-op. A stale index row (the aliased session died; consumer
            // eviction in flight) falls through to the resume path below instead --
            // resuming converges the client.
            return;
        }
        {
            let mut resuming = self.resuming.lock().await;
            if !resuming.insert(durable.clone()) {
                return; // a concurrent attach is resuming this exact durable id
            }
        }
        // Task 13: the attach-resume path SPAWNS, so it claims the D8 lease first (the
        // in-process `resuming` single-flight above stays -- it is cheap and covers the
        // attach-vs-attach window; the lease serializes against CREATE-path holders).
        // Losers get `freshAgent.error { code: "SESSION_RESERVED" }` -- the established
        // non-lost error channel (never INVALID_SESSION_ID, which would kill the pane).
        //
        // Task 13b (cross-kind liveness): a live terminal PTY owning `(claude, durable)`
        // is the one writer on that JSONL -- refuse the attach-resume the same way.
        if (self.terminal_liveness)(PROVIDER, &durable) {
            tracing::warn!(target: "freshell_freshagent::claude", session_id = %durable,
                "fresh_agent_attach_refused: a live terminal PTY owns this session (Task 13b cross-kind live-guard)");
            self.resuming.lock().await.remove(&durable);
            self.emit_fresh_agent_error(
                &msg.session_id,
                session_type_str(msg.session_type),
                "SESSION_RESERVED",
                "Another resume for this session is in flight",
            );
            return;
        }
        let attach_request_id = format!("attach-{}", uuid::Uuid::new_v4());
        let mut lease_guard: Option<crate::FreshSessionLeaseGuard> = None;
        for round in 0..2u8 {
            match self.leases.claim(
                PROVIDER,
                &durable,
                &attach_request_id,
                crate::session_lease::now_epoch_ms(),
            ) {
                crate::session_lease::FreshSessionClaim::Acquired => {
                    lease_guard = Some(crate::FreshSessionLeaseGuard::armed(
                        Arc::clone(&self.leases),
                        PROVIDER,
                        &durable,
                        &attach_request_id,
                    ));
                    break;
                }
                crate::session_lease::FreshSessionClaim::BoundLive { .. } => {
                    // The winner completed while we contended: converge via the same
                    // rebind + ack the cli_index arm performs; if the binding is stale
                    // (session just died), answer RESERVED -- the client re-drive
                    // converges on the reopened key.
                    self.resuming.lock().await.remove(&durable);
                    if !self
                        .try_rebind_to_live(&durable, session_type_str(msg.session_type))
                        .await
                    {
                        self.emit_fresh_agent_error(
                            &msg.session_id,
                            session_type_str(msg.session_type),
                            "SESSION_RESERVED",
                            "Another resume for this session is in flight",
                        );
                    }
                    return;
                }
                crate::session_lease::FreshSessionClaim::Held { .. } => {
                    self.resuming.lock().await.remove(&durable);
                    self.emit_fresh_agent_error(
                        &msg.session_id,
                        session_type_str(msg.session_type),
                        "SESSION_RESERVED",
                        "Another resume for this session is in flight",
                    );
                    return;
                }
                crate::session_lease::FreshSessionClaim::ExpiredNeedsKill { pid, ownership_id } => {
                    if round == 0
                        && crate::session_lease::kill_and_confirm_tree_dead(
                            pid,
                            CLAUDE_SIDECAR_OWNERSHIP_ENV,
                            &ownership_id,
                        )
                        .await
                    {
                        self.leases
                            .force_release_after_confirmed_kill(PROVIDER, &durable);
                        continue;
                    }
                    tracing::error!(target: "invariant", pid, session_id = %durable,
                        "fresh_agent_lease_expired_kill_unconfirmed: holding closed");
                    self.resuming.lock().await.remove(&durable);
                    self.emit_fresh_agent_error(
                        &msg.session_id,
                        session_type_str(msg.session_type),
                        "SESSION_RESERVED",
                        "Another resume for this session is in flight",
                    );
                    return;
                }
            }
        }
        let outcome = self
            .resume_for_attach(&msg, &durable, &mut lease_guard)
            .await;
        self.resuming.lock().await.remove(&durable);
        // Any leftover armed guard means the resume ended WITHOUT registering a session
        // (its own teardown already ran on every error path) -- release the key.
        if let Some(mut g) = lease_guard.take() {
            g.fail();
        }
        match outcome {
            Ok(()) => {}
            Err(ResumeClaudeError::NotFound) => {
                self.broadcast(&lost_session_frame(&msg.session_id, msg.session_type));
            }
            Err(ResumeClaudeError::Transient(err)) => {
                self.send_error(&None, "CLAUDE_ATTACH_RESUME_FAILED", &err);
            }
        }
    }

    /// Task 10b's REBIND + ACK: if `durable` is in `cli_index` and its aliased session
    /// is LIVE, flip the session's envelope stamp to the durable id and broadcast the
    /// snapshot ack (stamped with the durable) announcing the session's REAL tracked
    /// status — never a hardcoded "idle" (which flipped panes idle mid-turn and left
    /// dead-window completions stale-busy forever). Returns `false` when the index has
    /// no row or the row is stale (aliased session gone). The sessions map is never
    /// re-keyed (alias, don't move -- in-flight consumers hold the placeholder key;
    /// sends and kills resolve through `cli_index`).
    async fn try_rebind_to_live(&self, durable: &str, session_type: &str) -> bool {
        let Some(map_key) = self.cli_index.lock().await.get(durable).cloned() else {
            return false;
        };
        let rebound_status = {
            let guard = self.sessions.lock().await;
            match guard.get(&map_key) {
                Some(session) => {
                    // Alias, don't move: flip only the envelope stamp. The status the
                    // ack speaks is the consumer's tracked-status fold — truth at
                    // ack time (a completed turn settles it; a live compaction or
                    // in-flight turn announces truthfully).
                    *session.broadcast_id.lock().expect("broadcast id lock") = durable.to_string();
                    Some(session.current_status())
                }
                None => None,
            }
        };
        let Some(status) = rebound_status else {
            return false;
        };
        self.broadcast(&status_snapshot_frame(
            durable,
            durable,
            &status,
            session_type,
        ));
        true
    }

    /// The not-tracked resume (codex `ensure_session_resumable` analog, file-store
    /// flavored): transcript-present gate -> spawn sidecar with `resumeSessionId` ->
    /// register under the CLIENT's id -> idle snapshot. `lease_guard` (Task 13): the
    /// attach-path D8 lease -- the kill handle is armed after the spawn and the lease
    /// completed (bound to the map key) at registration; error paths tear down their
    /// own sidecar and leave the guard for the caller to `fail()`.
    async fn resume_for_attach(
        &self,
        msg: &FreshAgentAttach,
        durable: &str,
        lease_guard: &mut Option<crate::FreshSessionLeaseGuard>,
    ) -> Result<(), ResumeClaudeError> {
        if crate::claude_snapshot::claude_home_candidates().is_empty() {
            // No store root resolvable at all: we cannot CHECK, so we must not DENY.
            return Err(ResumeClaudeError::Transient(
                "no claude store root resolvable (CLAUDE_CONFIG_DIR/CLAUDE_HOME/HOME unset)"
                    .to_string(),
            ));
        }
        // Positive denial only when the transcript is absent in EVERY candidate
        // root (CLAUDE_CONFIG_DIR > CLAUDE_HOME > $HOME/.claude -- ledger A3).
        let Some(transcript) = crate::claude_snapshot::locate_transcript(durable) else {
            return Err(ResumeClaudeError::NotFound);
        };
        // P1.13 (Task 10): recover the pane's recorded settings from the ledger so a
        // resume-in-place does not silently revert model/permissionMode/effort. V7/A10
        // alarm gate: alarm ONLY when the ledger PROVES prior recording yet no snapshot
        // is recoverable. Never-recorded transcripts (the entire pre-existing
        // ~/.claude/projects population — resume_for_attach exists FOR them) stay silent.
        let sink = self.identity_sink();
        let recovered = sink
            .as_ref()
            .and_then(|s| s.load_settings("claude", durable));
        if recovered.is_none()
            && sink
                .as_ref()
                .is_some_and(|s| s.was_recorded("claude", durable))
        {
            // Recorded before, unrecoverable now — the genuine anomaly.
            tracing::warn!(session = %durable, "freshagent.claude.settings_record_unrecoverable");
            self.emit_fresh_agent_error(
                durable,
                session_type_str(msg.session_type), // preserves freshclaude vs kilroy in the frame
                "SETTINGS_RESET",
                "Session settings could not be recovered after restart - the agent is running with default model and permissions. Reconfirm your settings.",
            );
        }
        let rec = recovered.clone().unwrap_or_default();
        // The CLI's resume lookup is scoped to the ORIGINAL cwd's project slug
        // (ledger A15) -- resume with the cwd recorded in the transcript itself.
        // If that directory is gone, fall back to path-based resume
        // (`--resume <path>.jsonl` bypasses slug scoping -- verified cli.js 2.1.220),
        // keeping the attach cwd for the process itself.
        let original_cwd = crate::claude_snapshot::transcript_cwd(&transcript)
            .filter(|c| std::path::Path::new(c).is_dir());
        let (resume_value, resume_cwd) = match original_cwd {
            Some(cwd) => (json!(durable), json!(cwd)),
            // Attach cwd stays primary; the ledger record's cwd is a FINAL
            // fallback only when both existing sources are absent (Task 10).
            None => (
                json!(transcript.to_string_lossy()),
                json!(msg.cwd.clone().or_else(|| rec.cwd.clone())),
            ),
        };

        let (mut child, mut stdin, stdout, ownership_id) = spawn_sidecar()
            .await
            .map_err(ResumeClaudeError::Transient)?;
        // Task 13: arm the lease's TTL tree-kill path now that the child + tag exist.
        if let Some(g) = lease_guard.as_mut() {
            if let Some(pid) = child.id() {
                g.set_kill_handle(pid, &ownership_id);
            }
        }
        let request_id = format!("attach-resume-{}", uuid::Uuid::new_v4());
        let create_req = json!({
            "type": "create",
            "requestId": request_id,
            "cwd": resume_cwd,
            // Recovered from the ledger record (Task 10); `json!` serializes `None`
            // as `null`, preserving today's fallback wire shape exactly on a miss.
            "model": rec.model,
            "permissionMode": rec.permission_mode,
            "effort": rec.effort,
            "resumeSessionId": resume_value,
        });
        if let Err(err) = write_line(&mut stdin, &create_req).await {
            let _ = child.start_kill();
            reap_owned_claude_sidecars(&ownership_id);
            return Err(ResumeClaudeError::Transient(err));
        }
        let mut reader = BufReader::new(stdout).lines();
        let sidecar_session_id = match read_created(&mut reader, SIDECAR_CREATE_BUDGET).await {
            Ok(id) => id,
            Err(err) => {
                let _ = child.start_kill();
                reap_owned_claude_sidecars(&ownership_id);
                return Err(ResumeClaudeError::Transient(err));
            }
        };

        let session_type = session_type_str(msg.session_type).to_string();
        // Register under the CLIENT's id: the consumer stamps the map key on every
        // envelope and the frozen client routes by envelope sessionId
        // (fresh-agent-ws.ts:180-183) -- a fresh key would strand the pane.
        // The sidecar's created id is the eviction identity guard for this consumer.
        // `settings` (P1.13, Task 10): `Some(rec)` re-records the row under any new
        // cliSessionId (the old durable's row keeps serving `load_settings`, so later
        // attaches with the old id still resolve — no repeat-fire, V7 §4); `None`
        // records nothing (no laundered blank row under the new id, V7/A10).
        let broadcast_id = Arc::new(std::sync::Mutex::new(msg.session_id.clone()));
        let pending = Arc::new(std::sync::Mutex::new(ClaudePending::default()));
        let in_turn = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let turn_tracker = Arc::new(std::sync::Mutex::new(TurnTracker::default()));
        let result_idle_pair_pending = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let turn_lock = Arc::new(TokioMutex::new(()));
        // Freshly resumed session: the tracked status starts "idle" (truthful — no
        // turn can be in flight before the client sends).
        let last_status = Arc::new(std::sync::Mutex::new("idle".to_string()));
        let consumer = self.spawn_consumer(
            reader,
            msg.session_id.clone(),
            session_type.clone(),
            sidecar_session_id.clone(),
            recovered.clone(),
            Arc::clone(&broadcast_id),
            Arc::clone(&pending),
            Arc::clone(&last_status),
            Arc::clone(&in_turn),
            Arc::clone(&turn_tracker),
            Arc::clone(&result_idle_pair_pending),
            None,
        );
        self.sessions.lock().await.insert(
            msg.session_id.clone(),
            ClaudeSession {
                configuration: ClaudeConfiguration {
                    settings: recovered.unwrap_or_default(),
                    ..ClaudeConfiguration::default()
                },
                stdin,
                child,
                ownership_id,
                consumer,
                sidecar_session_id,
                cli_session_id: Some(durable.to_string()),
                broadcast_id,
                pending,
                in_turn,
                turn_tracker,
                result_idle_pair_pending,
                turn_lock,
                rollback_probe_slot: Arc::new(std::sync::Mutex::new(None)),
                last_status,
            },
        );
        self.cli_index
            .lock()
            .await
            .insert(durable.to_string(), msg.session_id.clone());

        // Task 13: bind the durable id to this live session + release the lease. A
        // revoked lease means we must NOT keep the session -- tear down and fail.
        if let Some(mut g) = lease_guard.take() {
            if !g.complete(&msg.session_id) {
                if let Some(session) = self.sessions.lock().await.remove(&msg.session_id) {
                    session.consumer.abort();
                    let mut child = session.child;
                    let _ = child.start_kill();
                    reap_owned_claude_sidecars(&session.ownership_id);
                }
                self.cli_index
                    .lock()
                    .await
                    .retain(|_, mapped| mapped != &msg.session_id);
                g.fail(); // own tree torn down -- reopen the key
                return Err(ResumeClaudeError::Transient(
                    "session lease revoked during attach-resume; torn down".to_string(),
                ));
            }
        }

        // Read the tracked status through the same `current_status()` helper the
        // rebind arm uses (the session was registered above; the lease-revocation
        // teardown already returned). Identical to the hardcoded "idle" it replaces
        // for a fresh resume — truthful by construction. The None fallback covers a
        // sidecar that died before this read (already EOF-evicted by its consumer):
        // nothing was ever announced, so "idle" stays the truthful default.
        let last_announced = self
            .sessions
            .lock()
            .await
            .get(&msg.session_id)
            .map(ClaudeSession::current_status)
            .unwrap_or_else(|| "idle".to_string());
        self.broadcast(&status_snapshot_frame(
            &msg.session_id,
            durable,
            &last_announced,
            &session_type,
        ));
        Ok(())
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

    /// The sdk.session.init adoption block (the consumer's in-stream arm AND the
    /// rollback-fork preseeded lane share it): record the durable Claude UUID in
    /// cli_index + the session record, then AWAIT-write the identity binding row
    /// (V8/A11). On the rollback lane the row carries `supersedes: old durable
    /// id`, and the rollback-row re-key old→new rides the SAME awaited batch
    /// (server-side sink). A failed write is surfaced user-visibly, never
    /// warn-and-drop, then the identity event proceeds. No-laundering guard
    /// (V7/A10): never persist an all-blank snapshot UNLESS a supersession edge
    /// is being written (a supersession write always goes through — it is the
    /// only record of the old→new linkage, G3).
    async fn adopt_session_init(
        &self,
        cli_id: &str,
        session_id: &str,
        session_type: &str,
        settings: Option<&crate::identity_sink::FreshAgentSettings>,
        supersedes: Option<&str>,
        identity_sink: Option<SharedPaneIdentitySink>,
    ) {
        self.cli_index
            .lock()
            .await
            .insert(cli_id.to_string(), session_id.to_string());
        if let Some(session) = self.sessions.lock().await.get_mut(session_id) {
            session.cli_session_id = Some(cli_id.to_string());
        }
        let recordable = settings
            .filter(|s| **s != crate::identity_sink::FreshAgentSettings::default())
            .is_some()
            || supersedes.is_some();
        if !recordable {
            return;
        }
        let Some(sink) = identity_sink else { return };
        if let Err(e) = sink
            .record_binding(crate::identity_sink::FreshAgentBindingUpsert {
                provider: PROVIDER.into(),
                session_id: cli_id.to_string(),
                mode: session_type.to_string(),
                create_request_id: None,
                resolves_pending: None,
                supersedes: supersedes.map(str::to_string),
                settings: settings.cloned().unwrap_or_default(),
            })
            .await
        {
            tracing::warn!(error = %e, session = %cli_id, "freshagent.claude.binding_write_failed");
            self.emit_fresh_agent_error(
                cli_id,
                session_type,
                "LEDGER_WRITE_FAILED",
                "Failed to persist this session's resume record - settings may not survive a server restart.",
            );
        }
    }

    // ── stdout consumer (the completion edge normalization) ──────────────────────────

    /// Consume the sidecar's stdout event stream (one `sdk.*` JSON per line), normalize
    /// each `sdk.* → freshAgent.*` and broadcast it wrapped in a `freshAgent.event`. On EOF
    /// (a clean end OR a mid-turn death) the loop stops — never a false completion — and
    /// the dead session is evicted from both maps (identity-guarded, ledger A9).
    /// `sidecar_session_id` is the id THIS consumer's sidecar is keyed by; it guards the
    /// eviction so a stale consumer can never evict a newer session re-registered under
    /// the same map key (attach-resume, Task 6).
    ///
    /// `settings` (P1.13): `Some` = record a fresh-agent binding row at
    /// `sdk.session.init` (create path / resume-with-record); `None` = do NOT record
    /// (resume of a never-recorded session — writing would launder a blank row under
    /// the new cliSessionId, V7/A10). The row's `mode` is the `session_type` param
    /// (the `"freshclaude"` vs `"kilroy"` flavour; provider is always [`PROVIDER`]).
    /// `broadcast_id` (Task 10b): the shared envelope-stamp handle read PER EVENT --
    /// starts as the map key; an attach-by-durable rebind flips it to the durable id.
    /// `pending` (Task 2): the shared pending approval/question handle the consumer
    /// folds `sdk.permission.*`/`sdk.question.*` lines into BEFORE the normalize/
    /// broadcast step (so a respond racing the event never sees stale membership).
    /// `last_status`: the shared tracked-status handle the attach acks read; the
    /// consumer folds the turn lifecycle (`sdk.assistant` → "running", every
    /// `sdk.result` → "idle" — the reference bridge's semantics) and the raw
    /// `sdk.status` wire values on top into it BEFORE the broadcast step (so an
    /// ack racing a status event never understates the tracked status). The
    /// result-edge settle means a mid-turn "compacting" can never wedge the
    /// tracker past the turn's completion.
    #[allow(clippy::too_many_arguments)] // Session-scoped wiring handed to the detached consumer; four call sites.
    fn spawn_consumer(
        &self,
        mut reader: tokio::io::Lines<BufReader<ChildStdout>>,
        session_id: String,
        session_type: String,
        sidecar_session_id: String,
        settings: Option<crate::identity_sink::FreshAgentSettings>,
        broadcast_id: Arc<std::sync::Mutex<String>>,
        pending: Arc<std::sync::Mutex<ClaudePending>>,
        last_status: Arc<std::sync::Mutex<String>>,
        // kata 1wxv Task 4: the session's shared busy truth — cleared by the
        // EXACTLY-four contract edges (`sdk.result` any subtype, `sdk.status`
        // idle, EOF/death below, completed handle_interrupt at the write site).
        in_turn: Arc<std::sync::atomic::AtomicBool>,
        // Focused-review ep1-r1 F1 / ep1-r2 F2 / ep2-r2: the session's FIFO turn
        // tracker (handed over whole; the arms live in the handlers under the
        // turn lock, the promote/retire/disarm folds live here). `in_turn` is
        // its DERIVED busy cache — this task's folds recompute it from
        // [`TurnTracker::busy`] at every terminal edge:
        // (a) result/unpaired-idle while a compact was PROMOTED (manual-confirmed
        //     by its completion boundary, ep3-r1 F1) — the
        //     compact's own terminal edge: retire `running`, hold busy while
        //     anything remains outstanding (ep1-r3 F1);
        // (b) the FIFO-drop peel — result/unpaired-idle with NO running op and
        //     an UNPROMOTED compact at the queue head: the compact provably
        //     dropped, evidenced by the oldest queued Turn behind it (peel
        //     leading compacts up to that Turn; compacts queued BEHIND the send
        //     survive — ep2-r2 F1);
        // (c) `sdk.error` (the queued ops provably never arrive) clears the
        //     QUEUE (never `running`/`in_turn` — fail-closed; the running op's
        //     own terminal edge or EOF retires it), or EOF (the queue died
        //     with the sidecar) zeroes everything.
        turn_tracker: Arc<std::sync::Mutex<TurnTracker>>,
        // ep2-r1 F1: the paired-terminal-frames mark — see
        // [`ClaudeSession::result_idle_pair_pending`]. This consumer sets it
        // after folding ANY `sdk.result`, and the NEXT `sdk.status:idle`
        // consumes it to skip the fold (pair punctuation, never an edge).
        result_idle_pair_pending: Arc<std::sync::atomic::AtomicBool>,
        // kata 1wxv Task 4: Some ONLY on the rollback fork/fresh respawn — the
        // handler PREREAD the sdk.session.init line, so the consumer runs the
        // adoption for it FIRST (supersedes-aware), then resolves the parked
        // rollback handler with the adopted durable id.
        adoption: Option<RollbackAdoption>,
    ) -> tokio::task::JoinHandle<()> {
        let broadcast_tx = self.broadcast_tx.clone();
        let sessions = self.sessions.clone();
        let cli_index = self.cli_index.clone();
        let identity_sink = self.identity_sink();
        let state = self.clone();
        tokio::spawn(async move {
            // Rollback-fork preseed (kata 1wxv Task 4): adoption via the EXISTING
            // sdk.session.init adoption block (cli_index insert + AWAITED binding
            // WITH supersedes — the rollback-row re-key old→new rides the SAME
            // awaited batch server-side), then emit the mapped init frame, THEN
            // resolve the parked rollback handler with the adopted durable id.
            if let Some(adoption) = adoption {
                let cli_id = adoption
                    .preseeded_init
                    .get("cliSessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(cli_id) = cli_id.as_deref() {
                    state
                        .adopt_session_init(
                            cli_id,
                            &session_id,
                            &session_type,
                            settings.as_ref(),
                            Some(&adoption.supersedes),
                            identity_sink.clone(),
                        )
                        .await;
                    let stamp = broadcast_id.lock().expect("broadcast id lock").clone();
                    if let Some(frame) =
                        sdk_line_to_frame(&adoption.preseeded_init, &stamp, &session_type)
                    {
                        let _ = broadcast_tx.send(frame);
                    }
                }
                let _ = adoption.adopted_tx.send(cli_id);
            }
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                // kata 1wxv Task 4 busy-truth clear edges — IN-STREAM arms (a) and
                // (b): `sdk.result` with ANY subtype ends the turn (r2: the earlier
                // success-only wording is void), and `sdk.status:idle`. NO other
                // in-stream edge (sdk.error/compacting/assistant never clear —
                // fail-closed; a missing arm wedges BUSY_TURN refusals forever).
                // Focused ep1-r2 F2 + ep2-r2 (order-explicit FIFO attribution):
                // [`fold_terminal_edge`] retires the OLDEST outstanding tracked op
                // — the `running` slot first (an observed-promoted compaction or
                // the idle-armed op), else a queued send, peeling an unpromoted
                // compact ONLY when a following queued send evidences its silent
                // drop (a compact queued BEHIND the send survives, ep2-r2 F1);
                // an unexplained edge with only compacts outstanding holds
                // fail-closed. `in_turn` is stored as the recomputed
                // [`TurnTracker::busy`], so the gate releases at EXACTLY the last
                // outstanding op's own edge. Any `sdk.error` clears the QUEUE
                // outright (the queued ops provably never arrive) while leaving
                // the running op / `in_turn` fail-closed untouched.
                // ep2-r1 F1 (the paired terminal frames): EVERY turn closes with
                // `sdk.result` AND a trailing `sdk.status:idle` — the idle is
                // the SAME turn's punctuation, never a second edge; the fold
                // below skips the fold for exactly that paired idle.
                // ep4-r2 F2: the fold NEVER serializes behind rollback's
                // turn_lock (blocking it let rollback absorb compact debt and
                // then miss a compaction that started in the sidecar behind
                // its own recheck). Ordering is instead restored at the
                // SOURCE by rollback's quiesce probe (see handle_rollback).
                match value.get("type").and_then(Value::as_str) {
                    Some("sdk.session.changed") if value["reason"] == "session-commands" => {
                        if let Some(commands) = value["commands"].as_array() {
                            if let Some(session) = sessions.lock().await.get_mut(&session_id) {
                                session.configuration.commands = Some(commands.clone());
                            }
                        }
                    }
                    Some("sdk.configured") => {
                        if let Some(session) = sessions.lock().await.get_mut(&session_id) {
                            if session
                                .configuration
                                .pending
                                .as_ref()
                                .is_some_and(|(id, _)| {
                                    value["requestId"].as_str() == Some(id.as_str())
                                })
                            {
                                if let Some((_, tx)) = session.configuration.pending.take() {
                                    if let Some(settings) = value["settings"].as_object() {
                                        let current = &mut session.configuration.settings;
                                        current.model = settings
                                            .get("model")
                                            .and_then(Value::as_str)
                                            .map(str::to_owned);
                                        current.effort = settings
                                            .get("effort")
                                            .and_then(Value::as_str)
                                            .map(str::to_owned);
                                        current.permission_mode = settings
                                            .get("permissionMode")
                                            .and_then(Value::as_str)
                                            .map(str::to_owned);
                                        if let Some(cwd) =
                                            settings.get("cwd").and_then(Value::as_str)
                                        {
                                            current.cwd = Some(cwd.to_string());
                                        }
                                    }
                                    let result = if value["ok"].as_bool() == Some(true) {
                                        Ok(())
                                    } else {
                                        Err(value["message"].as_str().unwrap_or("Claude could not apply these settings. Your message was not sent.").to_string())
                                    };
                                    let _ = tx.send(result);
                                }
                            }
                        }
                    }
                    Some("sdk.result") => {
                        fold_terminal_edge(&in_turn, &turn_tracker);
                        // A result's trailing idle is its pair punctuation the
                        // idle arm below skips (ep2-r1 F1).
                        result_idle_pair_pending.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    Some("sdk.status")
                        if value.get("status").and_then(Value::as_str) == Some("idle") =>
                    {
                        // ep2-r1 F1: the idle trailing a result is the SAME
                        // turn's closing punctuation — NEVER a new op's edge
                        // (folding it would double-attribute the turn: the
                        // reviewer's exact repro fired the drop branch on
                        // A's trailing idle while C/S sat queued).
                        if !result_idle_pair_pending
                            .swap(false, std::sync::atomic::Ordering::SeqCst)
                        {
                            fold_terminal_edge(&in_turn, &turn_tracker);
                        }
                    }
                    Some("sdk.status")
                        if value.get("status").and_then(Value::as_str) == Some("compacting") =>
                    {
                        // A compaction is observably running NOW — trigger
                        // unknown (manual or automatic): mark the CANDIDATE
                        // only (ep3-r1 F1; promotion waits for the manual
                        // completion boundary).
                        mark_compact_candidate(&in_turn, &turn_tracker);
                    }
                    Some("sdk.compact_boundary") => {
                        // The compaction's completion boundary is the ONLY
                        // wire-level witness of its trigger
                        // (`compact_metadata.trigger`; the sidecar fails toward
                        // `auto`). A `manual` boundary promotes the OLDEST
                        // queued Compact into the `running` slot (its coming
                        // terminal edge then retires it there); `auto` promotes
                        // nothing.
                        confirm_compact_candidate(
                            &in_turn,
                            &turn_tracker,
                            value.get("trigger").and_then(Value::as_str) == Some("manual"),
                        );
                    }
                    Some("sdk.interrupt_settled") => {
                        // Focused ep4-r1 (repaired at ep4-r2): the settle is a
                        // QUIESCE ACK, never a retirement — per the SDK contract
                        // (the control receipt is written BEFORE the
                        // interrupted op's terminal `sdk.result`) the op's own
                        // result owns the fold. Its fold-time role here:
                        //   ok:true + a live compact candidate => the
                        //      in-flight compaction IS the interruption's
                        //      subject: PROMOTE the front queued compact into
                        //      `running` (the exact promotion the manual
                        //      boundary would have performed had the compact
                        //      completed) so the trailing result retires
                        //      exactly it and every op queued behind survives.
                        //      A rejected/absent settle (the turn provably
                        //      still running) never promotes and retires
                        //      nothing (warn-log only — fail-closed).
                        // ep4-r3 F2: it NEVER fires a rollback probe — only a
                        // probeId-correlated `sdk.rollback.quiesced` does (the
                        // arm below).
                        let ok = value.get("ok").and_then(Value::as_bool) == Some(true);
                        if !ok {
                            tracing::warn!(session = %session_id, "freshagent.claude.interrupt_rejected_or_unsettled");
                        } else {
                            let mut tracker = turn_tracker.lock().expect("turn tracker lock");
                            if tracker.compact_candidate
                                && tracker.running.is_none()
                                && matches!(tracker.queued.front(), Some(TrackedOp::Compact))
                            {
                                tracker.queued.pop_front();
                                tracker.running = Some(TrackedOp::Compact);
                                tracker.compact_candidate = false;
                            }
                            // An UNPROMOTABLE candidate (debt already absorbed —
                            // nothing left in the queue to promote — or a turn
                            // still in `running`) SURVIVES the settle as the
                            // recheck-visible revived evidence (ep4-r2 F2).
                            // in_turn is never re-stored here: promotion
                            // preserves busy; a live candidate's ep3-r4 re-boost
                            // must never be clobbered by a bare busy() write.
                        }
                    }
                    Some("sdk.rollback.quiesced") => {
                        // Focused ep4-r3 (probe protocol): the sidecar answered
                        // a rollback quiesce from its OWN queue truth. Fire the
                        // armed probe ONLY on a probeId match — stale receipts
                        // (an ordinary interrupt's settle, an earlier timed-out
                        // probe's late answer) never close a live probe, and a
                        // rejected-shape answer is fail-closed in the handler
                        // (busy signals abort; a timeout also aborts).
                        let frame_probe_id =
                            value.get("probeId").and_then(Value::as_str).unwrap_or("");
                        let verdict = QuiesceVerdict {
                            cancelled_queue: value
                                .get("cancelledQueue")
                                .and_then(Value::as_u64)
                                .unwrap_or(0),
                            in_flight_turn: value
                                .get("inFlightTurn")
                                .and_then(Value::as_bool)
                                .unwrap_or(true),
                            handed_compact_likely: value
                                .get("handedCompactLikely")
                                .and_then(Value::as_bool)
                                .unwrap_or(true),
                        };
                        if let Some(session) = sessions.lock().await.get(&session_id) {
                            let fired = {
                                let mut slot = session
                                    .rollback_probe_slot
                                    .lock()
                                    .expect("rollback probe slot lock");
                                match slot.as_ref() {
                                    Some((armed_id, _)) if armed_id == frame_probe_id => {
                                        slot.take()
                                    }
                                    _ => None,
                                }
                            };
                            if let Some((_, tx)) = fired {
                                let _ = tx.send(verdict);
                            } else {
                                tracing::debug!(session = %session_id, probe_id = %frame_probe_id, "freshagent.claude.quiesced_unmatched");
                            }
                        }
                    }
                    Some("sdk.error") if value["turnFailure"].as_bool() != Some(true) => {
                        // The queued ops provably never arrive as
                        // their own turns — clear the QUEUE outright (the running
                        // op and `in_turn` stay fail-closed for its own terminal
                        // edge or EOF to retire). ep2-r1 F1: the pair mark
                        // resets TOO — the fail-closed `in_turn` needs a LIVE
                        // terminal edge after the error; a result's trailing
                        // idle past an error must fold, never be skipped.
                        let session_dead =
                            value.get("sessionNotFound").and_then(Value::as_bool) == Some(true);
                        {
                            let mut tracker = turn_tracker.lock().expect("turn tracker lock");
                            tracker.queued.clear();
                            if session_dead {
                                // ep3-r2 F2: the provider-side session is DEAD —
                                // the sidecar (handleSend/handleInterrupt)
                                // answers `sdk.error` and keeps the long-lived
                                // stdout OPEN, so NO terminal edge or EOF will
                                // ever retire what remains. Every tracked op —
                                // including `running` — can never complete:
                                // retire the whole tracker and open the gate
                                // (else the pane wedges BUSY forever after an
                                // interrupted/deleted provider session).
                                tracker.running = None;
                                tracker.compact_candidate = false;
                                in_turn.store(false, std::sync::atomic::Ordering::SeqCst);
                            }
                        }
                        result_idle_pair_pending.store(false, std::sync::atomic::Ordering::SeqCst);
                    }
                    _ => {}
                }
                // Task 2: fold the pending approval/question state BEFORE the
                // normalize/broadcast step, so a respond racing the event never
                // observes a stale membership check.
                fold_pending_frame(&pending, &value);
                // Fold the session's tracked status BEFORE the broadcast step, so an
                // ack racing an event never understates it. Mirror the reference
                // bridge's lifecycle (server/sdk-bridge.ts): sdk.assistant marks the
                // turn "running" (:426), EVERY sdk.result settles it back to "idle"
                // (:445) — so a mid-turn "compacting" can never wedge the tracker
                // for the rest of the session's life — and the raw sdk.status wire
                // value folds on top (:351-352 compacting announces truthfully
                // mid-turn; the stream-end idle is a no-op after the last result).
                match value.get("type").and_then(Value::as_str) {
                    Some("sdk.assistant") => {
                        *last_status.lock().expect("last status lock") = "running".to_string();
                    }
                    Some("sdk.result") => {
                        *last_status.lock().expect("last status lock") = "idle".to_string();
                    }
                    Some("sdk.status") => {
                        if let Some(status) = value.get("status").and_then(Value::as_str) {
                            *last_status.lock().expect("last status lock") = status.to_string();
                        }
                    }
                    _ => {}
                }
                // Restart-parity (plan §2.8 item 2): record the durable Claude UUID
                // through the shared adoption block (cli_index insert is
                // load-bearing; the session-field copy is best-effort — the map
                // entry may not exist yet during create).
                if value.get("type").and_then(Value::as_str) == Some("sdk.session.init") {
                    if let Some(cli_id) = value.get("cliSessionId").and_then(Value::as_str) {
                        let current_settings = {
                            let mut guard = sessions.lock().await;
                            guard
                                .get_mut(&session_id)
                                .map(|session| {
                                    session.configuration.runtime_cwd =
                                        value["cwd"].as_str().map(str::to_string);
                                    session.configuration.settings.clone()
                                })
                                .or_else(|| settings.clone())
                        };
                        state
                            .adopt_session_init(
                                cli_id,
                                &session_id,
                                &session_type,
                                current_settings.as_ref(),
                                None,
                                identity_sink.clone(),
                            )
                            .await;
                    }
                }
                // Task 10b: stamp the envelope from the SHARED handle (not the captured
                // map key) so an attach-by-durable rebind flips live event routing.
                let stamp = broadcast_id.lock().expect("broadcast id lock").clone();
                if let Some(frame) = sdk_line_to_frame(&value, &stamp, &session_type) {
                    let _ = broadcast_tx.send(frame);
                }
            }
            // kata 1wxv Task 4 busy-truth clear edge (c): sidecar EOF/death clears
            // the busy truth BEFORE the eviction verdict below (an unrequested
            // death can never hold a rollback BUSY_TURN hostage). The dead
            // sidecar's whole input queue died with it — zero the entire FIFO
            // tracker. The fold never holds rollback's turn lock (ep4-r2 F2:
            // blocking evidence behind teardown's lock re-armed the exact race
            // the lock was meant to close; ordering is restored by
            // handle_rollback's quiesce probe instead).
            in_turn.store(false, std::sync::atomic::Ordering::SeqCst);
            {
                let mut tracker = turn_tracker.lock().expect("turn tracker lock");
                tracker.running = None;
                tracker.queued.clear();
                tracker.compact_candidate = false;
            }
            result_idle_pair_pending.store(false, std::sync::atomic::Ordering::SeqCst);
            // Consumer exit == this sidecar's stdout closed == sidecar death
            // (ledger A9). Evict the dead session and its cli_index entries,
            // identity-guarded: a newer session re-registered under the same
            // map key (attach-resume, Task 6) has a DIFFERENT
            // sidecar_session_id and must not be evicted by this stale consumer.
            let evicted = {
                let mut map = sessions.lock().await;
                match map.get(&session_id) {
                    Some(s) if s.sidecar_session_id == sidecar_session_id => {
                        map.remove(&session_id);
                        true
                    }
                    _ => false,
                }
            };
            if evicted {
                let mut removed_durables = Vec::new();
                cli_index.lock().await.retain(|durable, mapped| {
                    if mapped == &session_id {
                        removed_durables.push(durable.clone());
                        false
                    } else {
                        true
                    }
                });
                // Task 12: a dead BOUND session must reopen its durable id, or the
                // sessionRef stays adopt-only forever.
                for durable in &removed_durables {
                    state.leases.clear_binding(PROVIDER, durable);
                }
                // Adapter-asymmetry fix (bug-hunt pbh-20260807): an UNREQUESTED sidecar
                // death must never be TOTAL SILENCE. The codex sibling broadcasts its
                // crash self-heal `exited` status (`codex.rs spawn_exit_watcher`) and
                // opencode's turn task emits an unconditional `idle`
                // (`opencode_ws.rs run_turn`); the reference bridge broadcasts an
                // explicit idle for exactly this edge so the pane doesn't stay stuck
                // blue (`server/sdk-bridge.ts:344-353`). Claude alone dropped the pane
                // into a forever-"working" wedge. Broadcast the `freshAgent.error`
                // shape the client folds into a visible banner AND a
                // running/streaming->idle drop (`fresh-agent-ws.ts:333-342`,
                // `freshAgentSlice.sessionError`). This branch is UNREQUESTED-death
                // only: `handle_kill`/`shutdown`/attach-teardown all remove the map
                // entry (and abort this consumer) first, so `evicted` is false there
                // and stays silent -- and no completion chime is ever fabricated
                // (ADR Decision 2.1 holds).
                let stamp = broadcast_id.lock().expect("broadcast id lock").clone();
                tracing::warn!(session_id = %stamp, "freshagent.claude.sidecar_death_detected");
                state.emit_fresh_agent_error(
                    &stamp,
                    &session_type,
                    "SIDECAR_EXITED",
                    "Claude agent process exited unexpectedly - the in-flight turn was lost. Reopen the pane or create a new agent to continue.",
                );
            }
        })
    }
}

// ── FIFO turn tracker (ep2-r2) ───────────────────────────────────────────────────────────

/// Focused-review ep2-r2: the busy/attribution tracker is an EXPLICIT FIFO of
/// accepted ops. The counter approach it replaces could not encode QUEUE ORDER
/// — the reviewer's exact ep2-r2 repro: compact C1 → send S1 → compact C2 with
/// C1 silently provider-dropped, S1's terminal edge extinguished the WHOLE
/// compact count (C2 included) and released the rollback gate while C2 could
/// still run. Here every accepted op is a distinct queued entry retiring at its
/// OWN edge, so the gate's mid-turn protection (its SOLE protection per the
/// spec) is enumerable op-by-op.
///
/// Stream invariants the attribution leans on (provider FIFO discipline): the
/// sidecar processes its input queue strictly in acceptance order; at most one
/// op runs at a time; EVERY op ends with exactly one logical terminal edge —
/// a turn emits `sdk.result` (any subtype) followed by its trailing
/// `sdk.status:idle` PUNCTUATION (paired-skipped by the consumer before this
/// fold ever sees it, ep2-r1 F1), or a completed interrupt stands in for the
/// running op's edge at the write site (no result frame exists, Task 4 edge
/// (d)); and a compact's terminal edge is ALWAYS preceded by its
/// manual-confirmed completion boundary in-stream (an unpromoted compact can
/// never own a terminal edge — the drop proof's premise, ep1-r2 F2; the bare
/// compacting STATUS frame is trigger-blind, ep3-r1 F1, so promotion waits for
/// the boundary's `manual` witness).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TrackedOp {
    /// A user send's turn (a "garlanded send" is simply a Turn queued behind
    /// a compact — kind alone now, no separate count).
    Turn,
    /// A `/compact` op. Only a Compact ever carries (is promoted by) the
    /// manual-confirmed completion boundary; the promotion retires the queue
    /// entry into
    /// the `running` slot.
    Compact,
}

/// The per-session FIFO attribution state (ep2-r2). `running` holds the ONE op
/// the provider is working on (a fresh op armed from idle owns it immediately;
/// a queued Compact moves here when its `sdk.status:compacting` is CONFIRMED as
/// a manual `/compact` run by its completion boundary (ep3-r1 F1) —
/// queued Turns never visibly "start" and instead retire straight out of the
/// queue at their own terminal edge, which is fine: attribution always retires
/// the OLDEST outstanding op). `queued` is the acceptance-ordered remainder.
/// `compact_candidate` marks a compaction announced by the bare
/// `sdk.status:compacting` frame whose trigger is not yet known. Shares ONE
/// std Mutex with no awaits inside any critical section; every
/// mutation recomputes the derived `in_turn` busy cache (`busy()`) in the same
/// critical section, so the rollback gate never reads a torn pair.
#[derive(Default)]
struct TurnTracker {
    running: Option<TrackedOp>,
    queued: std::collections::VecDeque<TrackedOp>,
    compact_candidate: bool,
}

impl TurnTracker {
    /// The derived busy truth: the rollback gate's sole mid-turn input.
    fn busy(&self) -> bool {
        self.running.is_some() || !self.queued.is_empty()
    }
}

/// Arm one accepted op UNDER the session turn lock BEFORE the sidecar write:
/// an idle tracker takes the op as RUNNING, else it queues BEHIND every
/// outstanding op (FIFO). Either way the busy truth holds for the handler's
/// whole write window (the check-then-set window against `handle_rollback`'s
/// busy check stays closed). Returns `was_busy` for [`undo_turn_op_arm`]'s
/// exact undo (the arm site owns whether the op went to `running` vs
/// `queued`).
fn arm_turn_op(
    in_turn: &std::sync::atomic::AtomicBool,
    turn_tracker: &std::sync::Mutex<TurnTracker>,
    op: TrackedOp,
) -> bool {
    let mut tracker = turn_tracker.lock().expect("turn tracker lock");
    let was_busy = tracker.busy();
    if was_busy {
        tracker.queued.push_back(op);
    } else {
        tracker.running = Some(op);
    }
    in_turn.store(true, std::sync::atomic::Ordering::SeqCst);
    was_busy
}

/// SYNCHRONOUSLY undo EXACTLY the op this handler armed when the sidecar write
/// provably never happened (ep1-r3 F3's discipline, structural): pop our own
/// BACK entry (handler arms serialize on the session turn lock and the fold
/// only ever pops the FRONT, so ours is provably still last) — or clear
/// `running` when we were the idle-armed op. NEVER a stale whole-set restore:
/// the consumer's fold may have retired an EARLIER op mid-window, and the busy
/// truth is then recomputed from what genuinely survives (ep2-r2 F3: a reverted
/// arm with a send still queued behind an earlier op keeps the gate CLOSED —
/// the old spent-prior CAS cleared `in_turn` unconditionally right there).
fn undo_turn_op_arm(
    in_turn: &std::sync::atomic::AtomicBool,
    turn_tracker: &std::sync::Mutex<TurnTracker>,
    was_busy: bool,
) {
    let mut tracker = turn_tracker.lock().expect("turn tracker lock");
    if was_busy {
        tracker.queued.pop_back();
    } else {
        tracker.running = None;
    }
    in_turn.store(tracker.busy(), std::sync::atomic::Ordering::SeqCst);
}

/// One OBSERVED `sdk.status:compacting`: a compaction is running NOW — the
/// provider is provably in-flight (mid-turn auto or a `/compact` run), so the
/// gate CLOSES at this frame (ep3-r4 F1: after a SURVIVE-absorb opened the
/// gate, a revived compact's status must re-arm the busy truth at the status,
/// not at its later completion boundary, or the whole status→boundary
/// interval — and a status landing a beat after a probe's admission — admits
/// rollback while a compaction is provably executing). The frame carries NO
/// trigger, though, so it can NEVER promote a queued compact
/// (focused ep3-r1 F1): it marks a CANDIDATE; attribution waits for the
/// compaction's completion boundary, which consumes the candidate and
/// recomputes the gate.
fn mark_compact_candidate(
    in_turn: &std::sync::atomic::AtomicBool,
    turn_tracker: &std::sync::Mutex<TurnTracker>,
) {
    // ep3-r5 F2 (torn publication): the candidate bit AND the gate-visible
    // `in_turn` boost publish ATOMICALLY under the tracker mutex — any reader
    // seeing `candidate == true` also provably sees `in_turn == true` (the
    // gate reads `in_turn` first and must never slip a mark→boost pair).
    let mut tracker = turn_tracker.lock().expect("turn tracker lock");
    tracker.compact_candidate = true;
    in_turn.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// The compaction's completion boundary (`sdk.compact_boundary {trigger}` —
/// the sidecar relays the SDK `compact_boundary` whose
/// `compact_metadata.trigger` the SDK fills as `'manual' | 'auto'`; the
/// sidecar fails toward `auto` on anything unknown). A `manual` boundary is
/// the ONLY wire-level witness that the compaction now finishing was requested
/// by `/compact`: promote the OLDEST queued Compact into the `running` slot
/// (FIFO-strict, every op ahead of it already produced its terminal edge, so
/// the `running` slot is empty exactly when the tracker's ordering holds — an
/// occupied slot means a compact armed from idle owns it (never promoted) or
/// the stream's ordering provably hasn't advanced; never promote past an
/// occupied slot, and never promote anything past a queued Compact either:
/// the candidate's trigger may be manual while the queued ops ahead are still
/// genuinely owed). An `auto` boundary (or no boundary — a failed compaction
/// settles at its own terminal edge instead) promotes NOTHING, and the
/// candidate is consumed either way.
fn confirm_compact_candidate(
    in_turn: &std::sync::atomic::AtomicBool,
    turn_tracker: &std::sync::Mutex<TurnTracker>,
    boundary_manual: bool,
) {
    let mut tracker = turn_tracker.lock().expect("turn tracker lock");
    // The boundary confirms ONLY a LIVE candidate (ep3-r2 F1): a boundary
    // arriving with NO pending candidate is a leftover (e.g. an interrupted
    // compaction's late completion) and must never promote a LATER queued
    // compact it was never observed for.
    let had_candidate = tracker.compact_candidate;
    tracker.compact_candidate = false;
    if boundary_manual
        && had_candidate
        && tracker.running.is_none()
        && matches!(tracker.queued.front(), Some(TrackedOp::Compact))
    {
        tracker.running = tracker.queued.pop_front();
        // ep3-r3 F1: the promotion RE-ARMS the busy truth — a SURVIVE-absorbed
        // compact whose debt left the gate open re-closes it the moment its
        // run provably starts (revived compacts hold the mid-compaction gate).
        in_turn.store(true, std::sync::atomic::Ordering::SeqCst);
    } else {
        // No promotion (auto boundary, a leftover, or no front Compact): the
        // candidate is consumed and the gate recomputes from owed debt —
        // ep3-r4 F1's status-time boost never wedges the tracker: queued
        // compacts keep the gate closed (the absorb probe can still settle
        // them later), an empty tracker re-opens it here.
        in_turn.store(tracker.busy(), std::sync::atomic::Ordering::SeqCst);
    }
}

/// The rollback gate's provable-quiescence admission (ep3-r3 F1). A queued
/// TURN never visibly "starts" (its first observable evidence IS its terminal
/// edge), so owed turn debt must hold the gate — a turn may be mid-generation
/// right now. A queued COMPACT is different: its run is announced by the
/// compacting status (the candidate) BEFORE its completion boundary. With
/// nothing in `running`, no pending candidate, and NO Turn anywhere in the
/// queue, every outstanding Compact is provably NOT started — the provider is
/// quiescent. Absorbing that debt means opening the gate WITHOUT clearing the
/// entries (SURVIVE-absorb): if one of them does run later, its status marks
/// the candidate and its manual boundary re-promotes it, RE-ARMING the busy
/// truth (`confirm_compact_candidate` stores `in_turn` on promotion) — a
/// genuinely-revived compact re-closes the gate mid-run exactly as expected,
/// while a rollback that proceeds tears down the sidecar and discards the
/// unstarted inputs.
///
/// This is ALSO the sound resolution of the positionally-ambiguous boundary
/// promotion: the wire carries no compaction-op identity, so [C1 dropped,
/// C2 runs] is in-band indistinguishable from [C1 runs, C2 queued] — the
/// boundary promotes the FRONT compact either way, leaving the mislabeled
/// remnant as debt. Absorption at the gate is where that debt settles: the
/// provider is provably idle at that instant, so opening the gate is sound
/// (and never an early release of owed TURN work).
fn absorb_unstarted_compact_debt(
    in_turn: &std::sync::atomic::AtomicBool,
    turn_tracker: &std::sync::Mutex<TurnTracker>,
) -> bool {
    let tracker = turn_tracker.lock().expect("turn tracker lock");
    if tracker.running.is_none()
        && !tracker.compact_candidate
        && !tracker.queued.iter().any(|op| *op == TrackedOp::Turn)
    {
        in_turn.store(false, std::sync::atomic::Ordering::SeqCst);
        true
    } else {
        false
    }
}

/// The in-stream TERMINAL-edge fold (`sdk.result` any subtype; `sdk.status:idle`
/// only when the consumer's pair-skip let it through, ep2-r1 F1). Attribution
/// retires the OLDEST outstanding op:
///
///   (running) the edge belongs to the op in the `running` slot — the active
///     turn, or the promoted compaction whose manual-confirmed boundary put
///     it there. Retire it;
///   (drop peel) `running` empty and the OLDEST queued op is an UNPROMOTED
///     Compact: this edge cannot be its (a compact's terminal edge is ALWAYS
///     preceded by its own manual-confirmed boundary, and that promotion never
///     happened). The compact provably DROPPED — but ONLY because a following
///     queued Turn evidences it (this edge must belong to the oldest such
///     Turn: FIFO). Peel every leading unpromoted Compact up to that Turn —
///     compacts queued BEHIND the send need NO evidence handling: they remain
///     genuinely queued and survive (ep2-r2 F1). With NO Turn queued anywhere
///     behind, nothing can attribute the edge: fail-closed HOLD (`in_turn`
///     untouched — the gate stays closed, the old armed-with-neither-mark
///     wedge-avoiding discipline preserved);
///   (queued Turn) the edge retires the OLDEST queued Turn;
///   (nothing outstanding) the plain unarmed edge — clears the busy truth.
///
/// `in_turn` is then stored as the recomputed `busy()`: the gate releases at
/// EXACTLY the last outstanding op's own edge — never earlier (each prior op
/// leaves the queue non-empty), and never wedged by a stale count.
fn fold_terminal_edge(
    in_turn: &std::sync::atomic::AtomicBool,
    turn_tracker: &std::sync::Mutex<TurnTracker>,
) {
    let mut tracker = turn_tracker.lock().expect("turn tracker lock");
    // A terminal edge settles any compaction that never produced a completion
    // boundary (e.g. a failed compact run — no boundary is emitted) — drop the
    // unconsumed candidate; promotion happens only from `confirm_compact_candidate`.
    tracker.compact_candidate = false;
    if tracker.running.take().is_none() {
        loop {
            match tracker.queued.front().copied() {
                Some(TrackedOp::Compact) => {
                    if tracker.queued.iter().any(|op| *op == TrackedOp::Turn) {
                        // The silent provider drop, evidenced by a following
                        // send: peel it and attribute onward.
                        tracker.queued.pop_front();
                        continue;
                    }
                    // No following op can evidence attribution — fail-closed
                    // HOLD: leave `in_turn` exactly as it stands.
                    return;
                }
                Some(TrackedOp::Turn) => {
                    tracker.queued.pop_front();
                    break;
                }
                None => break,
            }
        }
    }
    in_turn.store(tracker.busy(), std::sync::atomic::Ordering::SeqCst);
}

// ── pending-set fold (Task 2) ────────────────────────────────────────────────────────────

/// Fold one sidecar line into the session's pending approval/question state:
/// `sdk.permission.request`/`sdk.question.request` PUSH (resend of the same requestId
/// REPLACES — de-dupe), `sdk.permission.cancelled`/`sdk.question.cancelled` REMOVE.
/// Every other line is a no-op here. The cancelled frames are additionally forwarded
/// to the client (see `normalize_sdk_type`) — the fold never suppresses a broadcast.
fn fold_pending_frame(pending: &std::sync::Mutex<ClaudePending>, value: &Value) {
    let Some(sdk_type) = value.get("type").and_then(Value::as_str) else {
        return;
    };
    match sdk_type {
        "sdk.permission.request" => {
            let Some(request_id) = value.get("requestId").and_then(frame_request_id) else {
                return;
            };
            let entry = PendingApprovalEntry {
                request_id,
                tool_name: value
                    .get("tool")
                    .and_then(|t| t.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                tool_use_id: value
                    .get("toolUseID")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                blocked_path: value
                    .get("blockedPath")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                decision_reason: value
                    .get("decisionReason")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                input: value.get("tool").and_then(|t| t.get("input")).cloned(),
            };
            let mut p = pending.lock().expect("pending lock");
            p.permissions.retain(|e| e.request_id != entry.request_id);
            p.permissions.push(entry);
        }
        "sdk.permission.cancelled" => {
            if let Some(request_id) = value.get("requestId").and_then(frame_request_id) {
                pending
                    .lock()
                    .expect("pending lock")
                    .permissions
                    .retain(|e| e.request_id != request_id);
            }
        }
        "sdk.question.request" => {
            let Some(request_id) = value.get("requestId").and_then(frame_request_id) else {
                return;
            };
            // Delta-review round 5 (AGENT-06): the pending set feeds ONLY the
            // respond-membership check and the snapshot overlay, so its question copy
            // is normalized to the strict wire contract on entry (see
            // [`normalize_question_definitions`]). The sibling WS broadcast
            // (`sdk_line_to_frame`) keeps the VERBATIM frame — an intentional
            // divergence: the event stream is schema-opaque and keeps
            // forwards-compat extras (e.g. `preview`), while the client parses the
            // REST snapshot against a `.strict()` schema that would reject them.
            let entry = PendingQuestionEntry {
                request_id,
                questions: normalize_question_definitions(value.get("questions")),
            };
            let mut p = pending.lock().expect("pending lock");
            p.questions.retain(|e| e.request_id != entry.request_id);
            p.questions.push(entry);
        }
        "sdk.question.cancelled" => {
            if let Some(request_id) = value.get("requestId").and_then(frame_request_id) {
                pending
                    .lock()
                    .expect("pending lock")
                    .questions
                    .retain(|e| e.request_id != request_id);
            }
        }
        _ => {}
    }
}

/// Normalize an `sdk.question.request`'s `questions` to the strict wire contract
/// (`shared/fresh-agent-contract.ts` `FreshAgentQuestionDefinitionSchema`): per
/// question exactly `{question, header?, options?, multiSelect?}` (keys omitted when
/// absent), per option exactly `{label, description}` — every other key is dropped at
/// those two levels. The Claude SDK's AskUserQuestion options may carry extras (e.g.
/// the documented `preview` field) and the sidecar preserves them verbatim
/// (`permission-channel.mjs`'s `...o`); relayed raw into the snapshot, the client's
/// `.strict()` parse rejects the whole snapshot response and the question card never
/// renders (delta review round 5, AGENT-06). Values are rewritten only by string
/// coercion of the known text fields (`frame_request_id`'s string|number tolerance)
/// and bool pass-through for `multiSelect`. Members that can never satisfy the
/// contract — a question without coercible `question` text, an option without
/// coercible `label`/`description` — are dropped so a malformed member cannot poison
/// the whole array. A missing/non-array `questions` yields an EMPTY array: the pending
/// entry itself stays (respond-membership semantics) with a contract-valid shape.
///
/// Intentional divergence: normalization applies ONLY to this snapshot-bound pending
/// copy. The WS broadcast of the same frame (`sdk_line_to_frame`) relays the sidecar
/// payload VERBATIM so the schema-opaque event stream keeps forwards-compat extras
/// for consumers that understand them.
fn normalize_question_definitions(questions: Option<&Value>) -> Value {
    let mut out = Vec::new();
    let Some(items) = questions.and_then(Value::as_array) else {
        return Value::Array(out);
    };
    for item in items {
        let Some(obj) = item.as_object() else {
            continue;
        };
        // `question` is contract-REQUIRED (z.string()) — drop a member without
        // coercible text; it could only ever break the snapshot parse.
        let Some(question) = obj.get("question").and_then(coerce_contract_string) else {
            continue;
        };
        let mut normalized = Map::new();
        normalized.insert("question".to_string(), Value::String(question));
        if let Some(header) = obj.get("header").and_then(coerce_contract_string) {
            normalized.insert("header".to_string(), Value::String(header));
        }
        if let Some(options) = obj.get("options").and_then(Value::as_array) {
            normalized.insert(
                "options".to_string(),
                Value::Array(
                    options
                        .iter()
                        .filter_map(normalize_question_option)
                        .collect(),
                ),
            );
        }
        if let Some(multi_select) = obj.get("multiSelect").and_then(Value::as_bool) {
            normalized.insert("multiSelect".to_string(), Value::Bool(multi_select));
        }
        out.push(Value::Object(normalized));
    }
    Value::Array(out)
}

/// One contract option: `label` + `description` are both REQUIRED strings — keep the
/// member only when both coerce, and then carry EXACTLY those two keys.
fn normalize_question_option(option: &Value) -> Option<Value> {
    let obj = option.as_object()?;
    let label = obj.get("label").and_then(coerce_contract_string)?;
    let description = obj.get("description").and_then(coerce_contract_string)?;
    let mut normalized = Map::new();
    normalized.insert("label".to_string(), Value::String(label));
    normalized.insert("description".to_string(), Value::String(description));
    Some(Value::Object(normalized))
}

/// String-coerce a contract text field (`frame_request_id`'s string|number tolerance):
/// a JSON string passes through, a number stringifies, anything else is absent.
fn coerce_contract_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_i64().map(|n| n.to_string()))
        .or_else(|| value.as_f64().map(|n| n.to_string()))
}

/// A sidecar frame's `requestId` as a string (the sidecar mints nanoid strings; tolerate
/// numeric ids so a non-string id can't wedge the fold).
fn frame_request_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_i64().map(|n| n.to_string()))
}

// ── sdk.* → freshAgent.event frame (port of sdk-events.ts normalizeFreshAgentProviderEvent) ─

/// Map an `sdk.*` event line from the sidecar to a `freshAgent.event` wire frame. Renames
/// the inner `type` `sdk.X → freshAgent.X` (only the known set — matching sdk-events.ts,
/// which passes unknown types through unchanged and thus never surfaces them as fresh-agent
/// events), preserving every other field, then wraps it in the envelope. Control lines
/// (`created` / `create.failed`) and unknown types return `None`.
fn sdk_line_to_frame(value: &Value, session_id: &str, session_type: &str) -> Option<String> {
    let sdk_type = value.get("type").and_then(Value::as_str)?;
    let fresh_type = normalize_sdk_type(sdk_type)?;

    // Clone the inner event, swapping only its `type` (structural parity with the TS
    // `{ ...providerEvent, type }` spread).
    let mut inner: Map<String, Value> = value.as_object()?.clone();
    inner.insert("type".to_string(), json!(fresh_type));

    let msg = ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: Value::Object(inner),
        provider: PROVIDER.to_string(),
        session_id: session_id.to_string(),
        session_type: session_type.to_string(),
    });
    serde_json::to_string(&msg).ok()
}

/// The `sdk.* → freshAgent.*` rename table (server/fresh-agent/sdk-events.ts:48-83). Returns
/// `None` for a non-`sdk.` or unrecognized type (which the reference leaves unmapped).
fn normalize_sdk_type(sdk_type: &str) -> Option<&'static str> {
    Some(match sdk_type {
        "sdk.session.snapshot" => "freshAgent.session.snapshot",
        "sdk.session.changed" => "freshAgent.session.changed",
        "sdk.session.init" => "freshAgent.session.init",
        "sdk.session.metadata" => "freshAgent.session.metadata",
        "sdk.assistant" => "freshAgent.assistant",
        "sdk.stream" => "freshAgent.stream",
        "sdk.result" => "freshAgent.result",
        "sdk.permission.request" => "freshAgent.permission.request",
        "sdk.permission.cancelled" => "freshAgent.permission.cancelled",
        "sdk.question.request" => "freshAgent.question.request",
        // Task 2 (fresh-eyes round-3 F3): forwarded, not dropped — the client folds
        // freshAgent.question.cancelled into removeQuestion (card clear on
        // provider-originated cancellation).
        "sdk.question.cancelled" => "freshAgent.question.cancelled",
        "sdk.status" => "freshAgent.status",
        "sdk.turn.complete" => "freshAgent.turn.complete",
        "sdk.turn.waiting" => "freshAgent.turn.waiting",
        "sdk.error" => "freshAgent.error",
        "sdk.exit" => "freshAgent.exit",
        "sdk.killed" => "freshAgent.killed",
        _ => return None,
    })
}

/// `SessionType → wire string` for the claude provider (`freshclaude` | `kilroy`; both map
/// to provider `claude`). Any non-claude session type defaults to `freshclaude` (this slice
/// is only ever dispatched for the claude provider).
fn session_type_str(session_type: SessionType) -> &'static str {
    match session_type {
        SessionType::Kilroy => "kilroy",
        _ => "freshclaude",
    }
}

/// The approval/question respond `requestId` as a string (the wire type is
/// `string | number`; the pending fold keys on the sidecar-minted nanoid string, so a
/// numeric respond id can still match its entry).
fn request_id_string(request_id: &freshell_protocol::StringOrNumber) -> String {
    match request_id {
        freshell_protocol::StringOrNumber::Str(s) => s.clone(),
        freshell_protocol::StringOrNumber::Num(n) => n.to_string(),
    }
}

/// The `freshAgent.error{code:'INVALID_SESSION_ID'}` shape (`sdk-events.ts:37`) the client
/// folds into `markSessionLost` (`fresh-agent-ws.ts:326-328`) instead of hanging on a stale
/// `freshAgent.attach` for a session this server has never heard of. Third copy after
/// `codex.rs`/`opencode_ws.rs` (both document the duplication) -- but unlike those two this
/// one cannot hardcode the session type: provider `claude` covers BOTH `freshclaude` and
/// `kilroy`, so the envelope's sessionType comes from the attach message.
/// The durable claude id an attach carries: `sessionRef.sessionId` first,
/// then the legacy `resumeSessionId` fallback — flipped from legacy-first
/// (kata ejh6 section 4b hygiene). After the wire-level reject on
/// `freshAgent.attach`, the legacy field is dead for external input; the
/// fallback remains only for internal/test constructions. Only canonical
/// UUIDs qualify (`shared/session-contract.ts:34`) — a nanoid here would
/// just miss the store.
fn attach_durable_id(msg: &FreshAgentAttach) -> Option<String> {
    let candidate = msg
        .session_ref
        .as_ref()
        .map(|r| r.session_id.clone())
        .or_else(|| msg.resume_session_id.clone())?;
    is_canonical_claude_uuid(&candidate).then_some(candidate)
}

fn is_canonical_claude_uuid(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// The codex-shape status snapshot (`freshAgent.session.snapshot`) claude emits as the
/// attach ack (rebind + resume-on-attach arms): provider-agnostic client-side
/// (`fresh-agent-ws.ts:196-206`), it settles the pane to the session's REAL tracked
/// status and hands the durable UUID over via `timelineSessionId`.
fn status_snapshot_frame(
    session_id: &str,
    timeline_session_id: &str,
    status: &str,
    session_type: &str,
) -> ServerMessage {
    ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: json!({
            "type": "freshAgent.session.snapshot",
            "sessionId": session_id,
            "latestTurnId": Value::Null,
            "status": status,
            "timelineSessionId": timeline_session_id,
        }),
        provider: PROVIDER.to_string(),
        session_id: session_id.to_string(),
        session_type: session_type.to_string(),
    })
}

/// Why a resume-on-attach could not produce a live session (codex's
/// `ResumeSessionError` analog).
#[derive(Debug)]
enum ResumeClaudeError {
    /// The transcript store positively has no file for this durable id.
    NotFound,
    /// Spawn/pipe/`created` failure -- the session may be perfectly resumable;
    /// NEVER declared lost (opencode_ws.rs discipline).
    Transient(String),
}

fn lost_session_frame(session_id: &str, session_type: SessionType) -> ServerMessage {
    ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: json!({
            "type": "freshAgent.error",
            "sessionId": session_id,
            "code": "INVALID_SESSION_ID",
            "message": format!("claude session {session_id} not found"),
        }),
        provider: PROVIDER.to_string(),
        session_id: session_id.to_string(),
        session_type: session_type_str(session_type).to_string(),
    })
}

/// The `resumeDropsTurn` refusal prefix (SDK-documented): an
/// `error_during_execution` result whose message begins with this. NEVER
/// surfaced raw — the consumer maps it to the plain-resume recovery (one retry
/// with the guard omitted; the refusal is deterministic, so it is never retried
/// twice).
const RESUME_DROPS_TURN_REFUSAL_PREFIX: &str = "Resume rejected by --resume-drops-turn:";

/// Why one rollback-respawn attempt failed.
enum RollbackSpawnError {
    /// The create's early output carried the `--resume-drops-turn` refusal
    /// prefix — retry ONCE with the guard omitted.
    GuardRefusal,
    Other(String),
}

/// The pieces of a successful rollback respawn, ready for registration + the
/// consumer's preseeded adoption.
struct RollbackSpawned {
    child: Child,
    stdin: ChildStdin,
    /// The stdout line reader, positioned AFTER the preread `sdk.session.init`.
    reader: tokio::io::Lines<BufReader<ChildStdout>>,
    ownership_id: String,
    /// The sidecar-keyed id (`created.sessionId`).
    sidecar_session_id: String,
    /// The preread `sdk.session.init` line (the consumer adopts it preseeded).
    preseeded_init: Value,
    /// The new durable id (parsed from the preread init).
    cli_id: String,
}

impl FreshClaudeState {
    /// Rollback post-spawn failure teardown (kata 1wxv Task 4): drop the
    /// freshly-registered fork's map record, kill its sidecar tree, and clear
    /// this map key's cli_index aliases — used identically by the acceptance-
    /// failure and lease-revoked legs (an unadopted/uncompleted fork must never
    /// answer sends).
    async fn teardown_rollback_fork(&self, map_key: &str) {
        if let Some(session) = self.sessions.lock().await.remove(map_key) {
            session.consumer.abort();
            let mut child = session.child;
            let _ = child.start_kill();
            reap_owned_claude_sidecars(&session.ownership_id);
        }
        self.cli_index
            .lock()
            .await
            .retain(|_, mapped| mapped != map_key);
    }

    /// One rollback-respawn attempt (kata 1wxv Task 4): spawn the sidecar, arm
    /// the lease kill handle, write the create request, and PREREAD its output
    /// until the `sdk.session.init` line — the `--resume-drops-turn` refusal
    /// watch lives in this pre-read, BEFORE any durable state moves (the refusal
    /// is retried by the caller with the guard omitted; the pre-read ordering is
    /// how a refused fork can never adopt).
    async fn rollback_spawn_create(
        &self,
        create_req: &Value,
        lease_guard: Option<&mut crate::FreshSessionLeaseGuard>,
    ) -> Result<RollbackSpawned, RollbackSpawnError> {
        let (mut child, mut stdin, stdout, ownership_id) =
            spawn_sidecar().await.map_err(RollbackSpawnError::Other)?;
        if let Some(g) = lease_guard {
            if let Some(pid) = child.id() {
                g.set_kill_handle(pid, &ownership_id);
            }
        }
        if let Err(err) = write_line(&mut stdin, create_req).await {
            let _ = child.start_kill();
            reap_owned_claude_sidecars(&ownership_id);
            return Err(RollbackSpawnError::Other(err));
        }
        let mut reader = BufReader::new(stdout).lines();
        let sidecar_session_id = match read_created(&mut reader, SIDECAR_CREATE_BUDGET).await {
            Ok(id) => id,
            Err(err) => {
                let _ = child.start_kill();
                reap_owned_claude_sidecars(&ownership_id);
                return Err(RollbackSpawnError::Other(err));
            }
        };
        match read_session_init(&mut reader, SIDECAR_CREATE_BUDGET).await {
            Ok(init) => {
                let cli_id = init
                    .get("cliSessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_default();
                Ok(RollbackSpawned {
                    child,
                    stdin,
                    reader,
                    ownership_id,
                    sidecar_session_id,
                    preseeded_init: init,
                    cli_id,
                })
            }
            Err(err) => {
                let _ = child.start_kill();
                reap_owned_claude_sidecars(&ownership_id);
                Err(err)
            }
        }
    }
}

/// Read the respawned sidecar's output until `sdk.session.init`, mapping each
/// line to its outcome: the init line (returned verbatim for preseeded
/// adoption), or — checked FIRST — any line carrying the
/// `--resume-drops-turn` refusal prefix (never surfaced raw). Other early lines
/// (e.g. a pre-init `sdk.status`) are dropped at this seam; the consumer resumes
/// at the NEXT line after init.
async fn read_session_init(
    reader: &mut tokio::io::Lines<BufReader<ChildStdout>>,
    budget: Duration,
) -> Result<Value, RollbackSpawnError> {
    let read = async {
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if trimmed.contains(RESUME_DROPS_TURN_REFUSAL_PREFIX) {
                        return Err(RollbackSpawnError::GuardRefusal);
                    }
                    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                        continue;
                    };
                    if value.get("type").and_then(Value::as_str) == Some("sdk.session.init") {
                        return Ok(value);
                    }
                    // pre-init non-init line: tolerated, dropped.
                }
                Ok(None) => {
                    return Err(RollbackSpawnError::Other(
                        "sidecar stdout closed before sdk.session.init".to_string(),
                    ))
                }
                Err(e) => {
                    return Err(RollbackSpawnError::Other(format!(
                        "sidecar stdout read error: {e}"
                    )))
                }
            }
        }
    };
    match tokio::time::timeout(budget, read).await {
        Ok(result) => result,
        Err(_) => Err(RollbackSpawnError::Other(format!(
            "sidecar did not answer sdk.session.init within {}s",
            budget.as_secs()
        ))),
    }
}

// ── Node sidecar spawn ──────────────────────────────────────────────────────────────────

/// Spawn `node <sidecar>/index.mjs`, ownership-tagged, inheriting the server's isolated HOME
/// (so the SDK's `claude` CLI authenticates from + writes under `<isolatedHOME>/.claude`).
/// Returns the owned child, its stdin, its stdout, and the ownership tag.
async fn spawn_sidecar() -> Result<(Child, ChildStdin, ChildStdout, String), String> {
    let entry = sidecar_entry_path();
    if !entry.exists() {
        return Err(format!(
            "claude sidecar entry not found at {}",
            entry.display()
        ));
    }
    let node = std::env::var("FRESHELL_CLAUDE_NODE").unwrap_or_else(|_| "node".to_string());
    let ownership_id = mint_ownership_id();

    let mut cmd = tokio::process::Command::new(&node);
    cmd.arg(&entry);
    // Inherit the parent env (HOME=<isolated>, CLAUDE_HOME=<isolated>/.claude) and layer the
    // ownership tag so the /proc reaper can find our sidecar AND the claude CLI grandchild
    // (the SDK's clean-env passes FRESHELL_CLAUDE_SIDECAR_ID through — it strips only
    // CLAUDECODE + ANTHROPIC_API_KEY).
    cmd.env(CLAUDE_SIDECAR_OWNERSHIP_ENV, &ownership_id);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "claude sidecar spawn failed ({node} {}): {e}",
            entry.display()
        )
    })?;
    let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    // Drain stderr so verbose SDK/CLI logs can never fill the pipe and stall the sidecar.
    if let Some(err) = child.stderr.take() {
        drain_reader(err);
    }
    Ok((child, stdin, stdout, ownership_id))
}

/// Read the sidecar's stdout until the `created` (→ the nanoid placeholder) or
/// `create.failed` control line, bounded by `budget`. EOF before either is a failure.
async fn read_created(
    reader: &mut tokio::io::Lines<BufReader<ChildStdout>>,
    budget: Duration,
) -> Result<String, String> {
    let read = async {
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                        continue;
                    };
                    match value.get("type").and_then(Value::as_str) {
                        Some("created") => {
                            let session_id = value
                                .get("sessionId")
                                .and_then(Value::as_str)
                                .ok_or("created carried no sessionId")?;
                            return Ok(session_id.to_string());
                        }
                        Some("create.failed") => {
                            let message = value
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown sidecar create failure");
                            return Err(message.to_string());
                        }
                        // sdk.* events before `created` are impossible (the sidecar emits
                        // `created` first), but tolerate + skip any stray line.
                        _ => continue,
                    }
                }
                // EOF before `created` → the sidecar died at startup (e.g. bad node/SDK).
                Ok(None) => return Err("sidecar stdout closed before `created`".to_string()),
                Err(e) => return Err(format!("sidecar stdout read error: {e}")),
            }
        }
    };
    match tokio::time::timeout(budget, read).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "sidecar did not answer `create` within {}s",
            budget.as_secs()
        )),
    }
}

/// Resolve the sidecar entry (`index.mjs`). `FRESHELL_CLAUDE_SIDECAR` overrides; otherwise
/// the vendored package sits beside this crate at `crates/freshell-claude-sidecar/index.mjs`
/// (baked from `CARGO_MANIFEST_DIR` so it is cwd-independent).
fn sidecar_entry_path() -> PathBuf {
    if let Ok(path) = std::env::var("FRESHELL_CLAUDE_SIDECAR") {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../freshell-claude-sidecar/index.mjs"
    ))
}

/// Write one newline-delimited JSON request to the sidecar's stdin.
async fn write_line(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

/// Drain an async child pipe to `/dev/null` so it never back-pressures the sidecar.
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

// ── ownership / reaping (Linux /proc, mirrors freshell-codex) ───────────────────────────

/// Mint a unique sidecar ownership id (`claude-sidecar-<uuid>`) — the codex analog is
/// `codex-sidecar-<uuid>` (`runtime.ts:924`).
fn mint_ownership_id() -> String {
    format!("claude-sidecar-{}", uuid::Uuid::new_v4())
}

/// SIGTERM one pid (best-effort; the target is our own sidecar).
#[cfg(target_os = "linux")]
fn terminate_pid(pid: i32) {
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
}
#[cfg(not(target_os = "linux"))]
fn terminate_pid(_pid: i32) {}

/// `killOwnedProcesses` analog for claude: SIGTERM any process whose `/proc/<pid>/environ`
/// carries our `FRESHELL_CLAUDE_SIDECAR_ID=<ownership_id>` tag — the Node sidecar AND the
/// `claude` CLI grandchild the SDK spawns (which inherits the tag through the SDK clean-env).
/// Linux `/proc`-based, best-effort; only processes carrying OUR unique tag are signaled.
#[cfg(target_os = "linux")]
fn reap_owned_claude_sidecars(ownership_id: &str) {
    let needle = format!("{CLAUDE_SIDECAR_OWNERSHIP_ENV}={ownership_id}");
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(pid) = name.parse::<i32>() else {
            continue;
        };
        let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else {
            continue;
        };
        let carries_tag = environ
            .split(|&b| b == 0)
            .any(|var| var == needle.as_bytes());
        if carries_tag {
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }
}
#[cfg(not(target_os = "linux"))]
fn reap_owned_claude_sidecars(_ownership_id: &str) {
    // Non-Linux: the direct child is reaped via kill_on_drop; the /proc environ scan is
    // Linux-only (matches the reference's platform guard).
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────

/// ISO-8601 / RFC-3339 millis-Z timestamp (`new Date().toISOString()`) for error frames.
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn state() -> FreshClaudeState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        FreshClaudeState::new(Arc::new(tx))
    }

    fn state_with_bus() -> (FreshClaudeState, tokio::sync::broadcast::Receiver<String>) {
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
        (FreshClaudeState::new(Arc::new(tx)), rx)
    }

    fn attach_msg(session_id: &str) -> FreshAgentAttach {
        FreshAgentAttach {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
            resume_session_id: None,
            session_ref: None,
        }
    }

    /// Insert a fake tracked session directly into the map, bypassing the sidecar spawn
    /// (the claude analog of codex.rs's `spawn_sleeper` + `insert_fake_session`). The
    /// `sleep 30` child stands in for the Node sidecar; `kill_on_drop` reaps it at test end.
    async fn insert_fake_claude_session(st: &FreshClaudeState, session_id: &str) {
        let mut child = tokio::process::Command::new("sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleeper");
        let stdin = child.stdin.take().expect("piped stdin");
        let consumer = tokio::spawn(async {});
        st.sessions.lock().await.insert(
            session_id.to_string(),
            ClaudeSession {
                configuration: ClaudeConfiguration::default(),
                stdin,
                child,
                ownership_id: format!("test-{session_id}"),
                consumer,
                sidecar_session_id: session_id.to_string(),
                cli_session_id: None,
                broadcast_id: Arc::new(std::sync::Mutex::new(session_id.to_string())),
                pending: Arc::new(std::sync::Mutex::new(ClaudePending::default())),
                in_turn: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                turn_tracker: Arc::new(std::sync::Mutex::new(TurnTracker::default())),
                result_idle_pair_pending: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                turn_lock: Arc::new(TokioMutex::new(())),
                rollback_probe_slot: Arc::new(std::sync::Mutex::new(None)),
                last_status: Arc::new(std::sync::Mutex::new("idle".to_string())),
            },
        );
    }

    /// Task 3: insert a fake session AND stage its pending set by folding raw `sdk.*`
    /// lines through the PRODUCTION fold ([`fold_pending_frame`]) — the snapshot.rs
    /// route tests address the overlay this way. `durable` (when `Some`) registers the
    /// `cli_index` alias so the route's durable-id resolution (`resolve_session_key`)
    /// finds the session, exactly as a live post-init session is reachable.
    pub(crate) async fn insert_fake_claude_session_with_pending(
        st: &FreshClaudeState,
        map_key: &str,
        durable: Option<&str>,
        frames: &[Value],
    ) {
        insert_fake_claude_session(st, map_key).await;
        if let Some(durable) = durable {
            st.cli_index
                .lock()
                .await
                .insert(durable.to_string(), map_key.to_string());
        }
        let pending = {
            let sessions = st.sessions.lock().await;
            Arc::clone(&sessions[map_key].pending)
        };
        for frame in frames {
            fold_pending_frame(&pending, frame);
        }
    }

    /// P0.2 slice 1 (restart-resilience §2.8): an attach for a session this process does
    /// not track (the always-true case after a server restart) must emit the
    /// `freshAgent.error{code:'INVALID_SESSION_ID'}` lost-session shape -- NOT be
    /// swallowed -- so the client marks the pane `.lost` and `triggerRecovery`
    /// re-creates with `resumeSessionId` (`fresh-agent-ws.ts:325-327`).
    #[tokio::test]
    async fn handle_attach_untracked_session_emits_lost_session_frame() {
        let (st, mut rx) = state_with_bus();

        st.handle_attach(attach_msg("does-not-exist")).await;

        let raw = rx.try_recv().expect("a lost-session frame was broadcast");
        let frame: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(frame["type"], "freshAgent.event");
        assert_eq!(frame["sessionId"], "does-not-exist");
        assert_eq!(frame["provider"], "claude");
        assert_eq!(frame["sessionType"], "freshclaude");
        assert_eq!(frame["event"]["type"], "freshAgent.error");
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    /// Kilroy panes send `provider: "claude"` with `sessionType: "kilroy"` -- the envelope
    /// must echo the message's session type or the client builds the wrong locator and the
    /// pane never goes `.lost`.
    #[tokio::test]
    async fn handle_attach_untracked_kilroy_session_keeps_kilroy_session_type() {
        let (st, mut rx) = state_with_bus();
        let mut msg = attach_msg("kilroy-gone");
        msg.session_type = SessionType::Kilroy;

        st.handle_attach(msg).await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["sessionType"], "kilroy");
        assert_eq!(frame["provider"], "claude");
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    /// Wire-shape parity with codex's tracked-and-alive row (codex.rs decision table /
    /// `handle_attach_known_alive_session_emits_no_frame_regardless_of_turn_state`):
    /// attaching to a session this process DOES track must broadcast nothing -- above all
    /// it must never declare a live session lost (which would make the client kill and
    /// re-create a healthy pane).
    #[tokio::test]
    async fn handle_attach_tracked_session_broadcasts_nothing() {
        let (st, mut rx) = state_with_bus();
        insert_fake_claude_session(&st, "still-alive").await;

        st.handle_attach(attach_msg("still-alive")).await;

        assert!(
            rx.try_recv().is_err(),
            "tracked attach must not broadcast any frame (wire-shape parity)"
        );
    }

    // ── freshAgent.attach: resume-on-attach (restart parity, Task 6) ──────────────

    fn attach_msg_with_resume(session_id: &str, durable: &str) -> FreshAgentAttach {
        let mut msg = attach_msg(session_id);
        msg.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "claude".to_string(),
            session_id: durable.to_string(),
        });
        msg
    }

    /// Delta review round-2 pin (kata ejh6 section 4b): `attach_durable_id` reads
    /// sessionRef-first after the Task-7 flip. A legacy-first ordering (pre-flip)
    /// returns the legacy id in the dual-carrier case — this test fails there.
    #[test]
    fn attach_durable_id_prefers_session_ref_over_legacy() {
        const REF_ID: &str = "11111111-2222-4333-8444-555555555555";
        const LEGACY_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

        // (i) both carriers set with different canonical UUIDs → sessionRef wins
        let mut both = attach_msg("s");
        both.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "claude".to_string(),
            session_id: REF_ID.to_string(),
        });
        both.resume_session_id = Some(LEGACY_ID.to_string());
        assert_eq!(attach_durable_id(&both), Some(REF_ID.to_string()));

        // (ii) sessionRef only → its id
        let ref_only = attach_msg_with_resume("s", REF_ID);
        assert_eq!(attach_durable_id(&ref_only), Some(REF_ID.to_string()));

        // (iii) legacy only → its id (internal/test-compat lane)
        let mut legacy_only = attach_msg("s");
        legacy_only.resume_session_id = Some(LEGACY_ID.to_string());
        assert_eq!(attach_durable_id(&legacy_only), Some(LEGACY_ID.to_string()));

        // (iv) neither → None
        assert_eq!(attach_durable_id(&attach_msg("s")), None);
    }

    fn write_fake_transcript(home: &std::path::Path, durable: &str) {
        let dir = home.join("projects").join("-t");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{durable}.jsonl")),
            // `cwd` present + existing (ledger A15): the resume request must carry
            // the transcript's ORIGINAL cwd, and resume by UUID (primary path).
            r#"{"type":"user","cwd":"/tmp","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        )
        .unwrap();
    }

    /// Bounded drain of the broadcast receiver until a `freshAgent.event` envelope with
    /// the given INNER type arrives (mirrors [`await_claude_created`]'s 15s shape).
    async fn await_frame_of_inner_type(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        inner_type: &str,
    ) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["type"] == "freshAgent.event" && frame["event"]["type"] == inner_type {
                    return frame;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("freshAgent.event with inner type {inner_type} within budget"))
    }

    /// Bounded drain until a `freshAgent.status` broadcast carrying `status` arrives.
    /// The consumer folds the tracked status BEFORE it broadcasts the matching
    /// wire frame, so observing this frame proves the fold the attach acks read
    /// has landed — the arrangement races nothing.
    async fn await_status_on_wire(rx: &mut tokio::sync::broadcast::Receiver<String>, status: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["type"] == "freshAgent.event"
                    && frame["event"]["type"] == "freshAgent.status"
                    && frame["event"]["status"] == status
                {
                    return;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("freshAgent.status{{status:{status}}} within budget"));
    }

    /// Bounded drain until a TOP-LEVEL `error` ServerMessage arrives; returns its message.
    async fn await_top_level_error(rx: &mut tokio::sync::broadcast::Receiver<String>) -> String {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["type"] == "error" {
                    return frame["message"].as_str().unwrap_or_default().to_string();
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("top-level error frame within budget"))
    }

    #[tokio::test]
    async fn attach_untracked_with_transcript_resumes_and_emits_idle_snapshot() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        let durable = "77777777-7777-4777-8777-777777777777";
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (st, mut rx) = state_with_bus();
        st.handle_attach(attach_msg_with_resume("client-nanoid-1", durable))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        // Registered under the CLIENT's id (envelope tagging + send routing depend on it).
        assert!(st.sessions.lock().await.contains_key("client-nanoid-1"));
        assert_eq!(
            st.cli_index.lock().await.get(durable),
            Some(&"client-nanoid-1".to_string())
        );
        // The fake received resumeSessionId (spawn log now records the create request).
        let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
        assert!(
            log.contains(durable),
            "sidecar create must carry resumeSessionId"
        );
        // Idle snapshot frame, tagged with the client's id + the durable timeline id.
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], "client-nanoid-1");
        assert_eq!(frame["event"]["status"], "idle");
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        drop(env);
    }

    #[tokio::test]
    async fn attach_untracked_with_missing_transcript_emits_lost_frame() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("projects")).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        let (st, mut rx) = state_with_bus();
        st.handle_attach(attach_msg_with_resume(
            "client-nanoid-2",
            "88888888-8888-4888-8888-888888888888",
        ))
        .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    #[tokio::test]
    async fn attach_transient_spawn_failure_is_not_a_lost_frame() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let home = tempfile::tempdir().unwrap();
        let durable = "99999999-9999-4999-8999-999999999999";
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        std::env::set_var("FRESHELL_CLAUDE_NODE", "/nonexistent-node-binary");
        let (st, mut rx) = state_with_bus();
        st.handle_attach(attach_msg_with_resume("client-nanoid-3", durable))
            .await;
        std::env::remove_var("FRESHELL_CLAUDE_NODE");
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        // Mirrors codex: transient => top-level error with the provider code,
        // explicitly NOT INVALID_SESSION_ID.
        let err = await_top_level_error(&mut rx).await;
        assert!(err.contains("CLAUDE_ATTACH_RESUME_FAILED"));
        assert!(st.sessions.lock().await.is_empty());
    }

    #[tokio::test]
    async fn attach_untracked_without_any_durable_id_still_emits_lost_frame() {
        // The pre-parity fallback (PR #529) is preserved verbatim.
        let (st, mut rx) = state_with_bus();
        st.handle_attach(attach_msg("no-resume-anywhere")).await;
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    #[tokio::test]
    async fn concurrent_attaches_for_the_same_durable_id_spawn_at_most_one_sidecar() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        let durable = "12121212-1212-4121-8121-121212121212";
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        let (st, _rx) = state_with_bus();
        let a = st.clone();
        let b = st.clone();
        let m1 = attach_msg_with_resume("nano-a", durable);
        let m2 = attach_msg_with_resume("nano-b", durable);
        tokio::join!(a.handle_attach(m1), b.handle_attach(m2));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(env.spawn_count(), 1, "single-flight per durable id");
        drop(env);
    }

    /// Decision-table row 3 (Task 10b pins the NEW contract): a durable id already in
    /// `cli_index` whose aliased session is LIVE is REBOUND -- the envelope stamp flips
    /// to the durable id and the idle snapshot ack (stamped with the durable) answers
    /// the attach. The sessions map is never re-keyed (alias, don't move).
    #[tokio::test]
    async fn attach_with_durable_id_already_indexed_rebinds_and_acks() {
        let (st, mut rx) = state_with_bus();
        let durable = "56565656-5656-4656-8656-565656565656";
        insert_fake_claude_session(&st, "earlier-winner").await;
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), "earlier-winner".to_string());
        st.handle_attach(attach_msg_with_resume("late-attacher", durable))
            .await;
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], durable);
        assert_eq!(frame["event"]["status"], "idle");
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        // Alias, don't move: the map still holds the placeholder key...
        let sessions = st.sessions.lock().await;
        let session = sessions
            .get("earlier-winner")
            .expect("map key never re-keyed");
        // ...and the live record's envelope stamp now reads the durable id.
        assert_eq!(
            session.broadcast_id.lock().unwrap().as_str(),
            durable,
            "rebind must flip the envelope stamp to the durable id"
        );
    }

    /// The rebind arm's ack must announce the session's REAL tracked status (the
    /// stdout consumer's status fold), not a hardcoded `"idle"`: attaching to a
    /// live session mid-compaction must keep the pane truthfully busy instead of
    /// flipping it to idle, and a completion that landed in the reconnect dead
    /// window must be told truthfully by the ack that rescues the pane. The
    /// arrangement drives a REAL wire value (`compacting` — one of the two
    /// statuses the production sidecar actually announces, index.mjs:151-153)
    /// through the REAL consumer fold (the fake sidecar's `__set_status__`
    /// hook), and the fold is observed on the WIRE (the `freshAgent.status`
    /// broadcast) before the attach, so the assertion races nothing.
    #[tokio::test]
    async fn attach_rebind_ack_stamps_the_tracked_live_status_not_hardcoded_idle() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();

        // A tracked live claude session (fake sidecar standing in for the Node one).
        st.handle_create(dedup_create_msg("req-rebind-status"))
            .await;
        let created = await_claude_created(&mut rx, "req-rebind-status").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Alias a durable id at it (live: the consumer's sdk.session.init fold writes
        // this row; here the test writes it directly).
        let durable = "9c9c9c9c-9c9c-49c9-8c9c-9c9c9c9c9c9c";
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), session_id.clone());

        // Drive sdk.status { status: "compacting" } through the REAL stdout consumer
        // fold, and wait until its broadcast is observable — the fold (which the ack
        // reads) lands before that broadcast, so the attach below sees "compacting".
        st.handle_send(send_msg(&session_id, "__set_status__:compacting"))
            .await;
        await_status_on_wire(&mut rx, "compacting").await;

        // The reconnect rescue: attach addressing the durable id → the REBIND arm.
        st.handle_attach(attach_msg_with_resume("late-attacher", durable))
            .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], durable);
        assert_eq!(
            frame["event"]["status"], "compacting",
            "the rebind ack must speak the session's tracked status, not a hardcoded idle: {frame}"
        );
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        drop(env);
    }

    /// A mid-turn `compacting` must NOT wedge the tracked status for the rest of
    /// the session's life. The tracker's fold mirrors the reference bridge's
    /// lifecycle (sdk-bridge.ts:445): EVERY `sdk.result` settles the status back
    /// to `"idle"`, so once the compacted turn completes, the close-and-reopen
    /// rescue ack announces `"idle"` — never a sticky `compacting` that leaves
    /// the revived pane blue with user input queueing forever (the client's
    /// flush gate runs only when `!isBusy`). Both transitions are driven through
    /// the REAL consumer fold (fake-sidecar hooks) in the REAL value space, and
    /// each fold is observed on the WIRE before the attach, so the assertion
    /// races nothing.
    #[tokio::test]
    async fn attach_rebind_ack_settles_to_idle_once_the_compacted_turn_completes() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();

        // A tracked live claude session (fake sidecar standing in for the Node one).
        st.handle_create(dedup_create_msg("req-settle-status"))
            .await;
        let created = await_claude_created(&mut rx, "req-settle-status").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Alias a durable id at it (as above: live the init fold writes this row).
        let durable = "8b8b8b8b-8b8b-48b8-8b8b-8b8b8b8b8b8b";
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), session_id.clone());

        // The wedge repro: a turn compacts mid-flight → tracked status "compacting".
        st.handle_send(send_msg(&session_id, "__set_status__:compacting"))
            .await;
        await_status_on_wire(&mut rx, "compacting").await;

        // The compacted turn completes: sdk.result is the settle edge. Observing
        // its broadcast proves the settle fold has landed.
        st.handle_send(send_msg(&session_id, "__emit_result__"))
            .await;
        let _ = await_frame_of_inner_type(&mut rx, "freshAgent.result").await;

        // The reconnect rescue AFTER the turn settled: the ack must speak "idle",
        // never the pre-completion "compacting".
        st.handle_attach(attach_msg_with_resume("late-attacher-settled", durable))
            .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], durable);
        assert_eq!(
            frame["event"]["status"], "idle",
            "a completed turn must settle the tracked status (no sticky compacting): {frame}"
        );
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        drop(env);
    }

    /// Attaching while a turn is genuinely in flight must ack `"running"` — the
    /// reference bridge's per-turn lifecycle edge (sdk-bridge.ts:426 — the real
    /// sidecar announces NO `sdk.status: running`, busy is derived from stream
    /// deltas, so this arm is the only way the tracker ever speaks "running").
    /// Drives a REAL `sdk.assistant` frame through the fold and observes its
    /// broadcast before the attach, so the assertion races nothing.
    #[tokio::test]
    async fn attach_rebind_ack_speaks_running_while_a_turn_is_in_flight() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();

        // A tracked live claude session (fake sidecar standing in for the Node one).
        st.handle_create(dedup_create_msg("req-running-status"))
            .await;
        let created = await_claude_created(&mut rx, "req-running-status").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Alias a durable id at it (as above: live the init fold writes this row).
        let durable = "7a7a7a7a-7a7a-47a7-8a7a-7a7a7a7a7a7a";
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), session_id.clone());

        // A turn starts: sdk.assistant is the running edge. Observing its
        // broadcast proves the running fold has landed.
        st.handle_send(send_msg(&session_id, "__emit_assistant__"))
            .await;
        let _ = await_frame_of_inner_type(&mut rx, "freshAgent.assistant").await;

        // The reconnect rescue mid-turn: the ack must speak "running".
        st.handle_attach(attach_msg_with_resume("late-attacher-midturn", durable))
            .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], durable);
        assert_eq!(
            frame["event"]["status"], "running",
            "the rebind ack must speak \"running\" while a turn is in flight: {frame}"
        );
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        drop(env);
    }

    /// Pins the DEFAULT: a freshly resumed session has folded no non-idle status, so
    /// its resume-for-attach ack must still announce `"idle"`. Truth by construction
    /// (the tracked status starts "idle"), not a hardcoded literal — a regression that
    /// keeps the resume ack truthful must not be confused with the pre-fix literal.
    #[tokio::test]
    async fn attach_ack_stays_idle_for_a_freshly_resumed_session() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        let durable = "abababab-abab-4bab-8bab-abababababab";
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (st, mut rx) = state_with_bus();
        st.handle_attach(attach_msg_with_resume("client-fresh-resume", durable))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], "client-fresh-resume");
        assert_eq!(
            frame["event"]["status"], "idle",
            "a freshly resumed session's ack must announce idle (the tracked default): {frame}"
        );
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        drop(env);
    }

    /// Ledger A15's failure case: the transcript's recorded cwd no longer exists on
    /// disk, so the resume request must carry the transcript's `.jsonl` PATH (the
    /// verified cli.js escape hatch bypassing slug scoping) instead of the bare UUID.
    #[tokio::test]
    async fn attach_resume_falls_back_to_transcript_path_when_original_cwd_is_gone() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        let durable = "34343434-3434-4343-8343-343434343434";
        let dir = home.path().join("projects").join("-t");
        std::fs::create_dir_all(&dir).unwrap();
        let transcript = dir.join(format!("{durable}.jsonl"));
        std::fs::write(
            &transcript,
            r#"{"type":"user","cwd":"/nonexistent-original-cwd-freshell-task6","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        )
        .unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        let (st, mut rx) = state_with_bus();
        st.handle_attach(attach_msg_with_resume("client-nanoid-4", durable))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
        assert!(
            log.contains(transcript.to_string_lossy().as_ref()),
            "cwd-gone resume must carry the transcript PATH, got: {log}"
        );
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        drop(env);
    }

    #[test]
    fn normalize_maps_the_known_sdk_set_and_ignores_others() {
        assert_eq!(
            normalize_sdk_type("sdk.session.init"),
            Some("freshAgent.session.init")
        );
        assert_eq!(
            normalize_sdk_type("sdk.assistant"),
            Some("freshAgent.assistant")
        );
        assert_eq!(normalize_sdk_type("sdk.stream"), Some("freshAgent.stream"));
        assert_eq!(normalize_sdk_type("sdk.result"), Some("freshAgent.result"));
        assert_eq!(
            normalize_sdk_type("sdk.turn.complete"),
            Some("freshAgent.turn.complete")
        );
        assert_eq!(
            normalize_sdk_type("sdk.turn.waiting"),
            Some("freshAgent.turn.waiting")
        );
        // Task 2 (g): the pending-state family is forwarded too — including
        // sdk.question.cancelled (fresh-eyes round-3 F3 REPLACED the earlier "keep it
        // dropped" plan: the client folds freshAgent.question.cancelled into
        // removeQuestion, so a provider-cancelled question must reach it to clear the card).
        assert_eq!(
            normalize_sdk_type("sdk.permission.request"),
            Some("freshAgent.permission.request")
        );
        assert_eq!(
            normalize_sdk_type("sdk.permission.cancelled"),
            Some("freshAgent.permission.cancelled")
        );
        assert_eq!(
            normalize_sdk_type("sdk.question.request"),
            Some("freshAgent.question.request")
        );
        assert_eq!(
            normalize_sdk_type("sdk.question.cancelled"),
            Some("freshAgent.question.cancelled")
        );
        // Control + unknown types are NOT surfaced as fresh-agent events.
        assert_eq!(normalize_sdk_type("created"), None);
        assert_eq!(normalize_sdk_type("create.failed"), None);
        assert_eq!(normalize_sdk_type("sdk.unknown"), None);
    }

    #[test]
    fn session_init_frame_carries_inner_type_and_durable_uuid() {
        // sdk.session.init → freshAgent.event { event.type: freshAgent.session.init, cliSessionId }.
        let line = json!({
            "type": "sdk.session.init",
            "sessionId": "nano_placeholder_1234567",
            "cliSessionId": "0199abcd-1234-7abc-8def-0123456789ab",
            "model": "haiku",
            "cwd": "/tmp/x",
            "tools": [{ "name": "Read" }],
        });
        let frame = sdk_line_to_frame(&line, "nano_placeholder_1234567", "freshclaude").unwrap();
        let wire: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(wire["type"], "freshAgent.event");
        assert_eq!(wire["provider"], "claude");
        assert_eq!(wire["sessionType"], "freshclaude");
        assert_eq!(wire["sessionId"], "nano_placeholder_1234567");
        assert_eq!(wire["event"]["type"], "freshAgent.session.init");
        assert_eq!(
            wire["event"]["cliSessionId"],
            "0199abcd-1234-7abc-8def-0123456789ab"
        );
        assert_eq!(wire["event"]["model"], "haiku");
    }

    #[test]
    fn turn_complete_frame_carries_the_success_edge() {
        // The status-guarded chime the sidecar emits ONLY on result subtype=success.
        let line = json!({ "type": "sdk.turn.complete", "sessionId": "s-1", "at": 42 });
        let frame = sdk_line_to_frame(&line, "s-1", "freshclaude").unwrap();
        let wire: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(wire["type"], "freshAgent.event");
        assert_eq!(wire["event"]["type"], "freshAgent.turn.complete");
        assert_eq!(wire["event"]["at"], 42);
    }

    /// Delta-review round 5 (AGENT-06): the `sdk.question.request` →
    /// `freshAgent.question.request` WS broadcast stays VERBATIM even though the
    /// snapshot-bound copy is normalized (see
    /// `fold_normalizes_question_definitions_to_the_strict_contract_shape`). The
    /// event-stream path is schema-opaque, so forwards-compat extras (e.g. the
    /// SDK-documented `preview` option field, preserved by
    /// `permission-channel.mjs`'s `...o`) must reach consumers that understand them.
    #[test]
    fn question_request_broadcast_keeps_the_verbatim_payload() {
        let line = json!({
            "type": "sdk.question.request",
            "sessionId": "s",
            "requestId": "q-prev",
            "questions": [{
                "question": "Pick one",
                "options": [{ "label": "Yes", "description": "go", "preview": "diff…" }],
                "extraTop": { "nested": "kept" }
            }]
        });
        let frame = sdk_line_to_frame(&line, "s", "freshclaude").unwrap();
        let wire: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(wire["event"]["type"], "freshAgent.question.request");
        assert_eq!(
            wire["event"]["questions"][0]["options"][0]["preview"], "diff…",
            "the WS event stream keeps the verbatim payload (forwards-compat)"
        );
        assert_eq!(
            wire["event"]["questions"][0]["extraTop"],
            json!({ "nested": "kept" })
        );
    }

    #[test]
    fn control_lines_are_not_forwarded_as_events() {
        // `created` / `create.failed` are handled in the create flow, never as events.
        assert!(sdk_line_to_frame(
            &json!({ "type": "created", "sessionId": "x" }),
            "x",
            "freshclaude"
        )
        .is_none());
        assert!(sdk_line_to_frame(
            &json!({ "type": "create.failed", "message": "boom" }),
            "x",
            "freshclaude"
        )
        .is_none());
    }

    #[test]
    fn sidecar_death_never_yields_false_completion() {
        // The ADR Decision 2.1 property: a mid-turn death (stdout ends after some events but
        // BEFORE any sdk.turn.complete) can NEVER produce a freshAgent.turn.complete. We
        // model the consumer's mapping over a death-truncated line stream and assert no
        // completion frame is produced.
        let death_stream = [
            json!({ "type": "sdk.session.init", "sessionId": "s", "cliSessionId": "0199abcd-1234-7abc-8def-0123456789ab" }),
            json!({ "type": "sdk.stream", "sessionId": "s", "event": { "type": "content_block_delta" } }),
            json!({ "type": "sdk.assistant", "sessionId": "s", "content": [{ "type": "text", "text": "part" }] }),
            // …process is SIGKILLed here — stdout ends. NO sdk.result, NO sdk.turn.complete.
        ];
        let frames: Vec<Value> = death_stream
            .iter()
            .filter_map(|l| sdk_line_to_frame(l, "s", "freshclaude"))
            .map(|f| serde_json::from_str(&f).unwrap())
            .collect();
        let inner_types: Vec<&str> = frames
            .iter()
            .map(|f| f["event"]["type"].as_str().unwrap())
            .collect();
        assert!(
            !inner_types.contains(&"freshAgent.turn.complete"),
            "a death-truncated stream must never yield a completion chime, got {inner_types:?}"
        );
        // And a subsequent success stream DOES complete — the edge is real, not disabled.
        let ok = sdk_line_to_frame(
            &json!({ "type": "sdk.turn.complete", "sessionId": "s", "at": 1 }),
            "s",
            "freshclaude",
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&ok).unwrap()["event"]["type"],
            "freshAgent.turn.complete"
        );
    }

    #[test]
    fn session_type_maps_claude_flavours() {
        assert_eq!(session_type_str(SessionType::Freshclaude), "freshclaude");
        assert_eq!(session_type_str(SessionType::Kilroy), "kilroy");
    }

    #[test]
    fn ownership_id_is_unique_and_tagged() {
        let a = mint_ownership_id();
        let b = mint_ownership_id();
        assert!(a.starts_with("claude-sidecar-"));
        assert_ne!(a, b);
    }

    #[test]
    fn sidecar_entry_resolves_to_the_vendored_package() {
        // Guard against the dedup tests' concurrent FRESHELL_CLAUDE_SIDECAR mutation
        // (see CLAUDE_ENV_LOCK below) -- this test reads the SAME process-global env var.
        let _guard = CLAUDE_ENV_LOCK.blocking_lock();
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        // The compile-time path points at the vendored Node package beside this crate.
        let entry = sidecar_entry_path();
        assert!(
            entry.ends_with("freshell-claude-sidecar/index.mjs"),
            "{}",
            entry.display()
        );
    }

    #[tokio::test]
    async fn shutdown_is_safe_with_no_sessions() {
        state().shutdown().await;
    }

    // ── freshAgent.create requestId dedup (parity gap fix) ──────────────────

    /// Serializes every test in this file that mutates process-global env vars
    /// (`FRESHELL_CLAUDE_SIDECAR` / `FRESHELL_CLAUDE_NODE`), mirroring codex's
    /// `ENV_LOCK` (`codex.rs`).
    // `pub(crate)` so snapshot.rs's claude-store tests share this ONE lock (mirroring
    // how snapshot.rs reuses `crate::codex::tests::ENV_LOCK`) -- two independent
    // per-file locks would NOT serialize against each other.
    pub(crate) static CLAUDE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// A minimal scripted fake claude sidecar (no real `@anthropic-ai/claude-agent-sdk`,
    /// no network, no cost): on `{"type":"create",...}` it appends a marker line to
    /// `FRESHELL_TEST_CLAUDE_SPAWN_LOG` (so tests can count spawns without a global
    /// tracing subscriber) and replies with a fresh `{"type":"created","sessionId":...}`;
    /// on `{"type":"interrupt",sessionId}` it appends `sessionId` to
    /// `FRESHELL_TEST_CLAUDE_INTERRUPT_LOG` (the observable proxy for "the sidecar's
    /// `query.interrupt()` was actually invoked", mirroring the real sidecar's
    /// `handleInterrupt`); on `{"type":"shutdown"}` it exits. Task 2 arms: a magic send
    /// of `__raise_permission__` emits a canned `sdk.permission.request` (the canUseTool
    /// stand-in — the fake parks nothing), a magic send of `__set_status__:<status>`
    /// emits a real `sdk.status` frame (the attach-ack status-arrangement hook),
    /// `__emit_assistant__` emits a real `sdk.assistant` frame (a turn's RUNNING edge)
    /// and `__emit_result__` a real `sdk.result` frame (a completed turn's SETTLE edge
    /// — the real sidecar emits it on every SDK result whatever the subtype), and
    /// `permission.respond`/`question.respond`/non-magic `send` frames append the full
    /// received line to `FRESHELL_TEST_CLAUDE_RESPOND_LOG` (the assertion surface for
    /// the respond/compact handlers' exact stdin frame shapes).
    const FAKE_CLAUDE_SIDECAR_SOURCE: &str = r#"
import fs from 'node:fs'
import readline from 'node:readline'

const spawnLog = process.env.FRESHELL_TEST_CLAUDE_SPAWN_LOG
const respondLog = process.env.FRESHELL_TEST_CLAUDE_RESPOND_LOG
// Task 4 review (C1) determinism knob: DEFER every create ANSWER by N ms. The
// create request is still logged IMMEDIATELY (the spawn-log gate observes the
// rollback parked inside its respawn), so a test can fire a send while the
// rollback deterministically waits on `created` — the mid-rollback send
// interleaving is guaranteed, never luck.
const deferCreateMs = parseInt(process.env.FRESHELL_TEST_CLAUDE_DEFER_CREATE_MS || '0', 10)
// Task 4 review (M3) provable-rejection knob: die on create like a spawn-time
// provider rejection (EOF before `created`).
const failCreate = process.env.FRESHELL_TEST_CLAUDE_FAIL_CREATE === '1'

let counter = 0
// Task 4c (ep3-r2 F2): live-session membership — the real sidecar DELETES its
// JS session when consumeStream's finally runs (stream end) while stdout stays
// open, so a later send is answered by a lone signed `sdk.error` (no terminal
// edge, no EOF). `__drop_session__` simulates that provider-side death.
const liveSessions = new Set(
  (process.env.FRESHELL_TEST_CLAUDE_PRESEED_SESSIONS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
) // ep4-r2: the live-fixture rig boots WITHOUT a `create` frame — preseed its durable ids here so its sends are not answered with session-not-found.
// ep4-r3: a minimal model of the SDK-input queue for compact intents — every
// `/compact` send sits in it until the quiesce DRAINS it (the drain-count IS
// the cancelledQueue the real sidecar reports), mirroring the real
// cancellation authority at the pre-handoff residence.
const compactQueue = []
const configuredSettings = new Map()
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  if (msg.type === 'create') {
    // Log the WHOLE create request (one line per create) so tests can both count
    // spawns AND assert what the sidecar received (e.g. resumeSessionId).
    if (spawnLog) {
      fs.appendFileSync(spawnLog, `${JSON.stringify(msg)}\n`)
    }
    if (failCreate) process.exit(1)
    const answer = () => {
      counter += 1
      const sessionId = `fake-claude-session-${process.pid}-${counter}`
      liveSessions.add(sessionId)
      configuredSettings.set(sessionId, { model: msg.model, effort: msg.effort, permissionMode: msg.permissionMode, cwd: msg.cwd })
      process.stdout.write(JSON.stringify({ type: 'created', sessionId }) + '\n')
      // Mirror the real sidecar's post-create init: echo resumeSessionId as the durable
      // id when present (resume continuity), else a fixed fake uuid.
      // Task 4 (kata 1wxv): a forkSession:true create mints a FRESH durable id,
      // never an echo — fork-at-point adoption depends on the id changing.
      const cliSessionId = msg.forkSession === true
        ? `fork-${process.pid}-${counter}-0000-4000-8000-000000000000`
        : (msg.resumeSessionId || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      console.log(JSON.stringify({ type: 'sdk.session.init', sessionId, cliSessionId, model: 'fake-model', cwd: '/tmp', tools: [] }))
      console.log(JSON.stringify({ type: 'sdk.status', sessionId, status: 'idle' }))
    }
    if (deferCreateMs > 0) setTimeout(answer, deferCreateMs)
    else answer()
  } else if (msg.type === 'configure') {
    if (respondLog) fs.appendFileSync(respondLog, `${JSON.stringify(msg)}\n`)
    console.log(JSON.stringify({ type: 'sdk.session.changed', sessionId: msg.sessionId, reason: 'session-commands', commands: [{ name: 'review', description: 'Review changes' }] }))
    const settings = configuredSettings.get(msg.sessionId) ?? {}
    const ok = msg.settings?.model !== 'unavailable' && msg.settings?.effort !== 'invalid'
    if (msg.settings?.model !== 'unavailable') settings.model = msg.settings.model
    if (ok) Object.assign(settings, msg.settings)
    console.log(JSON.stringify({ type: 'sdk.configured', sessionId: msg.sessionId, requestId: msg.requestId, ok, settings, message: 'Model or effort is unavailable' }))
  } else if (msg.type === 'send') {
    // Test hook: lets tests kill the sidecar THROUGH the public API to exercise
    // the consumer-exit eviction path (ledger A9).
    if (msg.text === '__exit__') process.exit(0)
    // Task 4 (kata 1wxv) in_turn edge hooks: each magic text emits ONE canned sdk.*
    // line so the four-edge/fail-closed busy contract can drive every edge.
    if (msg.text === '__emit_result_error__') {
      console.log(JSON.stringify({ type: 'sdk.result', sessionId: msg.sessionId, result: 'error_during_execution' }))
    } else if (msg.text === '__emit_idle__') {
      console.log(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: 'idle' }))
    } else if (msg.text === '__emit_error__') {
      console.log(JSON.stringify({ type: 'sdk.error', sessionId: msg.sessionId, message: 'boom' }))
    } else if (msg.text === '__emit_compacting__') {
      console.log(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: 'compacting' }))
    // Task 4b (kata 1wxv, ep3-r1 F1): the SDK's compact COMPLETION boundary
    // carries the manual/auto trigger the bare `compacting` status lacks — the
    // ONLY wire-level way to tell an explicit `/compact` run apart from the
    // SDK's automatic context compaction. The real sidecar relays it as
    // `sdk.compact_boundary {trigger}` (crates/freshell-claude-sidecar).
    } else if (msg.text === '__emit_compact_boundary_manual__') {
      console.log(JSON.stringify({ type: 'sdk.compact_boundary', sessionId: msg.sessionId, trigger: 'manual' }))
    } else if (msg.text === '__emit_compact_boundary_auto__') {
      console.log(JSON.stringify({ type: 'sdk.compact_boundary', sessionId: msg.sessionId, trigger: 'auto' }))
    } else if (msg.text === '__drop_session__') {
      liveSessions.delete(msg.sessionId)
    } else if (!liveSessions.has(msg.sessionId)) {
      // Task 4c (ep3-r2 F2): the provider-side session was DELETED (stream end)
      // while stdout stayed open — the real sidecar answers with this lone
      // signed frame and NOTHING after (no result, no idle, no EOF).
      console.log(JSON.stringify({ type: 'sdk.error', sessionId: msg.sessionId, message: 'session not found', sessionNotFound: true }))
    } else if (/^\s*\/compact(\s|$)/.test(String(msg.text ?? ''))) {
      // ep4-r3: track compact intents in the fake's queue (the quiesce arm
      // drains them) — then log like every other non-magic send.
      compactQueue.push(msg.text)
      if (respondLog) fs.appendFileSync(respondLog, `${JSON.stringify(msg)}\n`)
    } else if (msg.text === '__emit_assistant__') {
      console.log(JSON.stringify({ type: 'sdk.assistant', sessionId: msg.sessionId, content: [{ type: 'text', text: 'noise' }] }))
    // Task 2 test hook: raise a canned pending permission the approve/deny flow can
    // respond to. The fake parks nothing — Rust's pending fold is the state under test.
    } else if (msg.text === '__raise_permission__') {
      process.stdout.write(JSON.stringify({
        type: 'sdk.permission.request',
        sessionId: msg.sessionId,
        requestId: 'req-1',
        subtype: 'can_use_tool',
        tool: { name: 'Bash', input: { command: 'ls' } },
        toolUseID: 'toolu_fake_1',
        blockedPath: null,
        decisionReason: null,
      }) + '\n')
    } else if (msg.text.startsWith('__set_status__:')) {
      // Reconnect-revive hook: emit a real sdk.status frame so a test can arrange a
      // non-default tracked status through the REAL stdout consumer fold (the attach
      // ack under test speaks it back).
      process.stdout.write(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: msg.text.slice('__set_status__:'.length) }) + '\n')
    } else if (msg.text === '__emit_assistant__') {
      // Reconnect-revive hook: emit a real sdk.assistant frame (the real wire shape —
      // index.mjs:165) so a test can drive the tracker's turn-start ("running") fold.
      process.stdout.write(JSON.stringify({ type: 'sdk.assistant', sessionId: msg.sessionId, content: [{ type: 'text', text: 'part' }], model: 'fake-model' }) + '\n')
    } else if (msg.text === '__emit_result__') {
      // Reconnect-revive hook: emit a real sdk.result frame (the real wire shape —
      // index.mjs:177) so a test can drive the tracker's turn-complete settle fold.
      process.stdout.write(JSON.stringify({ type: 'sdk.result', sessionId: msg.sessionId, result: 'success', durationMs: 1, costUsd: 0, usage: {} }) + '\n')
    } else if (respondLog) {
      // Non-magic sends (e.g. `/compact …`) land in the respond log verbatim so
      // tests can assert the exact stdin frame shape the compact handler writes.
      fs.appendFileSync(respondLog, `${JSON.stringify(msg)}\n`)
    }
  } else if (msg.type === 'permission.respond' || msg.type === 'question.respond') {
    if (respondLog) fs.appendFileSync(respondLog, `${JSON.stringify(msg)}\n`)
  } else if (msg.type === 'interrupt') {
    const interruptLog = process.env.FRESHELL_TEST_CLAUDE_INTERRUPT_LOG
    if (interruptLog) fs.appendFileSync(interruptLog, `${msg.sessionId}\n`)
    // Task 4c (kata 1wxv focused ep4-r1/ep4-r2 F1): the interrupt SETTLES
    // asynchronously, and per the SDK contract (`sdk.d.ts:3760`) the control
    // receipt is written BEFORE the interrupted turn's terminal `sdk.result`
    // — so the fake mirrors: settle frame first, then (accepted case) the
    // interrupted turn's own result + paired idle, IN THAT ORDER. The
    // rollback gate opens at the RESULTS, never at the receipt. A knocked-out
    // settle (probe on an idle sidecar) still stands alone: with no in-flight
    // op the result folds harmlessly on an empty tracker.
    //
    // Knobs: FRESHELL_TEST_CLAUDE_INTERRUPT_REJECT=1 — the provider REJECTED
    // the interrupt (ok:false, NO trailing result/idle: the turn still runs
    // and its own later edge owns it — the gate stays closed);
    // FRESHELL_TEST_CLAUDE_INTERRUPT_SETTLE_MS — defer the whole settle→result
    // →idle chain (the request↔settle window is the provider-work window the
    // gate must hold);
    // FRESHELL_TEST_CLAUDE_PROBE_COMPACT_BEFORE_SETTLE=1 — BEFORE the settle,
    // emit `sdk.status:compacting` (the absorbed compact debt started in the
    // sidecar before consuming the probe request: rollback's recheck must see
    // the revived candidate via the probe's in-order stream position and
    // ABORT the teardown) — and NO trailing result/idle for the compact: its
    // own terminal edge has not yet landed (the hazard window).
    const settleMs = parseInt(process.env.FRESHELL_TEST_CLAUDE_INTERRUPT_SETTLE_MS || '0', 10)
    const reject = process.env.FRESHELL_TEST_CLAUDE_INTERRUPT_REJECT === '1'
    const compactBeforeSettle = process.env.FRESHELL_TEST_CLAUDE_PROBE_COMPACT_BEFORE_SETTLE === '1'
    const settle = () => {
      if (compactBeforeSettle) {
        console.log(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: 'compacting' }))
      }
      console.log(JSON.stringify({ type: 'sdk.interrupt_settled', sessionId: msg.sessionId, ok: !reject }))
      if (!reject && !compactBeforeSettle) {
        console.log(JSON.stringify({ type: 'sdk.result', sessionId: msg.sessionId, subtype: 'error', errors: ['interrupted'] }))
        console.log(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: 'idle' }))
      }
    }
    if (settleMs > 0) setTimeout(settle, settleMs)
    else settle()
  } else if (msg.type === 'rollback.quiesce') {
    // Task 4c (kata 1wxv ep4-r3): rollback's pre-teardown quiesce probe. The
    // fake drains its tracked compact queue and answers with a
    // probeId-correlated verdict, echoing the real sidecar's stream order and
    // fields. Knob FRESHELL_TEST_CLAUDE_PROBE_COMPACT_BEFORE_SETTLE=1 models
    // the un-cancellable race: an absorbed compact was HANDED to an idle SDK
    // consumer before the probe — its compacting STATUS lands first (in-order
    // evidence) and the answer reports handedCompactLikely (BUSY verdict); no
    // trailing terminal frames (its run never completed in the hazard window).
    const compactBeforeSettle = process.env.FRESHELL_TEST_CLAUDE_PROBE_COMPACT_BEFORE_SETTLE === '1'
    // FRESHELL_TEST_CLAUDE_PROBE_WRONG_ID=1 — answer with a FOREIGN probe id
    // (a stale receipt): the probe must stay open and time out, never close on
    // it (ep4-r3 F2 correlation).
    const wrongId = process.env.FRESHELL_TEST_CLAUDE_PROBE_WRONG_ID === '1'
    const echoId = wrongId ? 'stale-receipt-not-this-probe' : (msg.probeId ?? null)
    if (compactBeforeSettle) {
      console.log(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: 'compacting' }))
      console.log(JSON.stringify({ type: 'sdk.rollback.quiesced', sessionId: msg.sessionId, probeId: echoId, cancelledQueue: 0, inFlightTurn: false, handedCompactLikely: true }))
    } else if (process.env.FRESHELL_TEST_CLAUDE_PROBE_HANDED_BUSY === '1') {
      // Models the SAME-TICK handoff: an absorbed compact was handed to an
      // awaiting SDK consumer immediately before the probe — NO status has
      // been emitted yet, so the verdict is the ONLY evidence. The gate must
      // abort on the verdict alone.
      console.log(JSON.stringify({ type: 'sdk.rollback.quiesced', sessionId: msg.sessionId, probeId: echoId, cancelledQueue: 0, inFlightTurn: false, handedCompactLikely: true }))
    } else {
      const cancelled = compactQueue.splice(0).length
      console.log(JSON.stringify({ type: 'sdk.rollback.quiesced', sessionId: msg.sessionId, probeId: echoId, cancelledQueue: cancelled, inFlightTurn: false, handedCompactLikely: false }))
    }
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

    /// A fresh temp dir holding the fake sidecar script + this test's spawn-count log,
    /// with `FRESHELL_CLAUDE_SIDECAR`/`FRESHELL_CLAUDE_NODE`/
    /// `FRESHELL_TEST_CLAUDE_SPAWN_LOG` pointed at it. Caller must hold
    /// [`CLAUDE_ENV_LOCK`] for the lifetime of the returned guard.
    struct FakeClaudeSidecarEnv {
        dir: PathBuf,
        spawn_log: PathBuf,
        interrupt_log: PathBuf,
        respond_log: PathBuf,
    }
    impl FakeClaudeSidecarEnv {
        fn install() -> Self {
            Self::install_with_knobs(None, false)
        }

        /// `install` + the fake sidecar's scripted knobs (see the source header):
        /// `defer_create_ms` delays every create ANSWER (the request is logged
        /// immediately — a test can park the rollback inside its respawn);
        /// `fail_create` makes every create a spawn-time provider rejection.
        fn install_with_knobs(defer_create_ms: Option<u64>, fail_create: bool) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "freshell-fake-claude-sidecar-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).expect("create fake sidecar temp dir");
            let script = dir.join("fake-claude-sidecar.mjs");
            std::fs::write(&script, FAKE_CLAUDE_SIDECAR_SOURCE).expect("write fake sidecar");
            let spawn_log = dir.join("spawn.log");
            std::fs::write(&spawn_log, "").expect("init spawn log");
            let interrupt_log = dir.join("interrupt.log");
            std::fs::write(&interrupt_log, "").expect("init interrupt log");
            let respond_log = dir.join("respond.log");
            std::fs::write(&respond_log, "").expect("init respond log");
            std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
            std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
            std::env::set_var("FRESHELL_TEST_CLAUDE_SPAWN_LOG", &spawn_log);
            std::env::set_var("FRESHELL_TEST_CLAUDE_INTERRUPT_LOG", &interrupt_log);
            std::env::set_var("FRESHELL_TEST_CLAUDE_RESPOND_LOG", &respond_log);
            match defer_create_ms {
                Some(ms) => {
                    std::env::set_var("FRESHELL_TEST_CLAUDE_DEFER_CREATE_MS", ms.to_string())
                }
                None => std::env::remove_var("FRESHELL_TEST_CLAUDE_DEFER_CREATE_MS"),
            }
            if fail_create {
                std::env::set_var("FRESHELL_TEST_CLAUDE_FAIL_CREATE", "1");
            } else {
                std::env::remove_var("FRESHELL_TEST_CLAUDE_FAIL_CREATE");
            }
            Self {
                dir,
                spawn_log,
                interrupt_log,
                respond_log,
            }
        }

        /// Path of the spawn log (one full JSON create-request line per spawn) so tests
        /// can assert what the sidecar received (e.g. `resumeSessionId`).
        fn spawn_log_path(&self) -> &std::path::Path {
            &self.spawn_log
        }

        /// Number of times the fake sidecar has been spawned so far (one marker line per
        /// process start).
        fn spawn_count(&self) -> usize {
            std::fs::read_to_string(&self.spawn_log)
                .map(|s| s.lines().filter(|l| !l.is_empty()).count())
                .unwrap_or(0)
        }

        /// Contents of the interrupt log (one `sessionId` per line the fake sidecar
        /// received a `{"type":"interrupt",...}` request for).
        fn interrupt_log_contents(&self) -> String {
            std::fs::read_to_string(&self.interrupt_log).unwrap_or_default()
        }

        /// The parsed respond-log lines (one full JSON frame per line the fake sidecar
        /// received a `permission.respond` / `question.respond` / non-magic `send`
        /// request for). Bounded-waits for at least `min` lines so the assertion reads
        /// AFTER the sidecar's append, never racing it.
        async fn respond_log_frames(&self, min: usize) -> Vec<Value> {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
            loop {
                let frames: Vec<Value> = std::fs::read_to_string(&self.respond_log)
                    .unwrap_or_default()
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .map(|l| serde_json::from_str(l).expect("respond log line is JSON"))
                    .collect();
                if frames.len() >= min {
                    return frames;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "respond log never reached {min} frame(s)"
                );
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }
    }
    impl Drop for FakeClaudeSidecarEnv {
        fn drop(&mut self) {
            std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
            std::env::remove_var("FRESHELL_CLAUDE_NODE");
            std::env::remove_var("FRESHELL_TEST_CLAUDE_SPAWN_LOG");
            std::env::remove_var("FRESHELL_TEST_CLAUDE_INTERRUPT_LOG");
            std::env::remove_var("FRESHELL_TEST_CLAUDE_RESPOND_LOG");
            std::env::remove_var("FRESHELL_TEST_CLAUDE_DEFER_CREATE_MS");
            std::env::remove_var("FRESHELL_TEST_CLAUDE_FAIL_CREATE");
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn send_msg(session_id: &str, text: &str) -> FreshAgentSend {
        FreshAgentSend {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshclaude,
            text: text.to_string(),
            cwd: None,
            images: None,
            request_id: None,
            settings: None,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn send_applies_changed_settings_before_text_and_persists_them() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());
        let mut create = dedup_create_msg("settings-send");
        create.model = Some("opus".into());
        create.effort = Some("high".into());
        state.handle_create(create).await;
        let created = await_claude_created(&mut rx, "settings-send").await;
        let session_id = created["sessionId"].as_str().unwrap();
        let mut send = send_msg(session_id, "Review this image");
        send.settings = Some(freshell_protocol::FreshAgentSendSettings {
            cwd: None,
            model: Some("sonnet".into()),
            effort: Some("max".into()),
            permission_mode: Some("plan".into()),
            sandbox: None,
        });
        send.images = Some(vec![freshell_protocol::FreshAgentImage {
            data: "YWJj".into(),
            media_type: "image/png".into(),
        }]);
        state.handle_send(send).await;
        let frames = env.respond_log_frames(1).await;
        assert_eq!(
            frames[0]["type"], "configure",
            "settings must apply before sending text"
        );
        let frames = env.respond_log_frames(2).await;
        assert_eq!(frames[1]["text"], "Review this image");
        assert_eq!(frames[1]["images"][0]["data"], "YWJj");
        let mut snapshot = json!({});
        state
            .apply_snapshot_metadata(session_id, &mut snapshot)
            .await;
        assert_eq!(
            snapshot["settings"],
            json!({ "model": "sonnet", "effort": "max", "permissionMode": "plan" })
        );
        assert_eq!(
            snapshot["commands"],
            json!([{ "name": "review", "description": "Review changes" }])
        );
        assert_eq!(
            snapshot["status"], "running",
            "accepted input is busy before the first provider output"
        );
        assert_eq!(
            snapshot["extensions"]["claude"]["statusFromLiveState"],
            true
        );
        let bindings = fake.bindings.lock().unwrap();
        let settings = &bindings.last().unwrap().settings;
        assert_eq!(settings.model.as_deref(), Some("sonnet"));
        assert_eq!(settings.effort.as_deref(), Some("max"));
        assert_eq!(settings.permission_mode.as_deref(), Some("plan"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn failed_effort_records_the_model_that_already_took_effect() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());
        let mut create = dedup_create_msg("partial-settings");
        create.model = Some("opus".into());
        create.effort = Some("high".into());
        state.handle_create(create).await;
        let created = await_claude_created(&mut rx, "partial-settings").await;
        let session_id = created["sessionId"].as_str().unwrap();
        let mut send = send_msg(session_id, "Keep this unsent");
        send.settings = Some(freshell_protocol::FreshAgentSendSettings {
            model: Some("sonnet".into()),
            effort: Some("invalid".into()),
            cwd: None,
            permission_mode: None,
            sandbox: None,
        });
        state.handle_send(send).await;
        assert!(await_top_level_error(&mut rx)
            .await
            .contains("CLAUDE_SETTINGS_FAILED"));
        assert_eq!(
            env.respond_log_frames(1).await.len(),
            1,
            "failed configuration must not send the prompt"
        );
        let mut snapshot = json!({"status": "idle"});
        state
            .apply_snapshot_metadata(session_id, &mut snapshot)
            .await;
        assert_eq!(snapshot["settings"]["model"], "sonnet");
        assert_eq!(snapshot["settings"]["effort"], "high");
        assert_eq!(snapshot["status"], "idle");
        let bindings = fake.bindings.lock().unwrap();
        assert_eq!(
            bindings.last().unwrap().settings.model.as_deref(),
            Some("sonnet")
        );
        assert_eq!(
            bindings.last().unwrap().settings.effort.as_deref(),
            Some("high")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn send_rejects_failed_settings_without_losing_text_or_changing_saved_settings() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());
        let mut create = dedup_create_msg("settings-fail");
        create.model = Some("opus".into());
        state.handle_create(create).await;
        let created = await_claude_created(&mut rx, "settings-fail").await;
        let session_id = created["sessionId"].as_str().unwrap();
        let mut send = send_msg(session_id, "Do not lose this prompt");
        send.request_id = Some("retained-prompt".into());
        send.settings = Some(freshell_protocol::FreshAgentSendSettings {
            cwd: None,
            model: Some("unavailable".into()),
            effort: None,
            permission_mode: None,
            sandbox: None,
        });
        state.handle_send(send).await;
        let frames = env.respond_log_frames(1).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "configure");
        let error = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                assert_ne!(frame["type"], "freshAgent.send.accepted");
                if frame["type"] == "error" {
                    break frame;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(error["requestId"], "retained-prompt");
        assert!(error["message"].as_str().unwrap().contains("unavailable"));
        assert_eq!(
            fake.bindings
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .settings
                .model
                .as_deref(),
            Some("opus")
        );
        assert!(!state
            .sessions
            .lock()
            .await
            .get(session_id)
            .unwrap()
            .in_turn
            .load(std::sync::atomic::Ordering::SeqCst));
    }

    fn dedup_create_msg(request_id: &str) -> FreshAgentCreate {
        FreshAgentCreate {
            request_id: request_id.to_string(),
            session_type: SessionType::Freshclaude,
            provider: Some(freshell_protocol::AgentProvider::Claude),
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

    /// Drain `rx` until the `freshAgent.created` (or `.create.failed`) frame for
    /// `request_id` arrives (mirrors codex's `await_created`).
    async fn await_claude_created(
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
        .unwrap_or_else(|_| panic!("freshAgent.created for {request_id} resolves within budget"))
    }

    /// Node parity (`runtime-manager.ts:106-108`): a `freshAgent.create` whose
    /// ONLY identity is a provider-matched `sessionRef` must resume exactly
    /// like the legacy `resumeSessionId` carrier — the canonical field cannot
    /// be a second-class citizen while the client migrates off the legacy
    /// duplicate. The fake sidecar echoes the create request's
    /// `resumeSessionId` back as the durable id, so the created frame's
    /// sessionId proves the promotion reached the sidecar.
    #[tokio::test]
    async fn handle_create_with_session_ref_only_resumes_like_legacy() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let durable = "66666666-6666-4666-8666-666666666666";
        let mut msg = dedup_create_msg("req-sref-only-1");
        msg.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "claude".to_string(),
            session_id: durable.to_string(),
        });

        st.handle_create(msg).await;
        let frame = await_claude_created(&mut rx, "req-sref-only-1").await;

        assert_eq!(
            frame["type"], "freshAgent.created",
            "sessionRef-only create must succeed: {frame}"
        );
        let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
        assert!(
            log.contains(durable),
            "sidecar create must carry the sessionRef-derived resumeSessionId: {log}"
        );
        drop(env);
    }

    /// THE regression this task fixes: a duplicate `freshAgent.create` sharing a
    /// `requestId` (the frozen client's reconnect-resend while a pane is
    /// `status==creating`) must spawn the claude sidecar exactly once and replay the
    /// SAME session id on the second response.
    #[tokio::test]
    async fn handle_create_duplicate_request_id_reuses_the_session_and_spawns_once() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-dedup-seq"))
            .await;
        let first = await_claude_created(&mut rx, "req-claude-dedup-seq").await;
        assert_eq!(first["type"], "freshAgent.created", "sanity: {first}");
        let first_session_id = first["sessionId"].as_str().unwrap().to_string();

        st.handle_create(dedup_create_msg("req-claude-dedup-seq"))
            .await;
        let second = await_claude_created(&mut rx, "req-claude-dedup-seq").await;

        assert_eq!(
            second["sessionId"], first_session_id,
            "a duplicate requestId must replay the SAME session, not mint a new one: {second}"
        );
        assert_eq!(
            env.spawn_count(),
            1,
            "two sequential creates sharing a requestId must spawn the claude sidecar \
             exactly once"
        );
    }

    /// The concurrent variant: two GENUINELY CONCURRENT creates sharing a `requestId`
    /// must still spawn at most one sidecar and both resolve to the SAME session.
    #[tokio::test]
    async fn handle_create_concurrent_duplicate_request_id_spawns_at_most_once() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        let st1 = st.clone();
        let st2 = st.clone();
        tokio::join!(
            st1.handle_create(dedup_create_msg("req-claude-dedup-race")),
            st2.handle_create(dedup_create_msg("req-claude-dedup-race")),
        );

        let first = await_claude_created(&mut rx, "req-claude-dedup-race").await;
        let second = await_claude_created(&mut rx, "req-claude-dedup-race").await;
        assert_eq!(
            first["sessionId"], second["sessionId"],
            "both racing creates for the same requestId must resolve to the SAME session: \
             {first} / {second}"
        );
        assert_eq!(
            env.spawn_count(),
            1,
            "two CONCURRENT creates racing on the same requestId must spawn the claude \
             sidecar exactly once"
        );
    }

    /// Control: DISTINCT requestIds must never dedup against each other.
    #[tokio::test]
    async fn handle_create_distinct_request_ids_create_distinct_sessions() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-dedup-a"))
            .await;
        let a = await_claude_created(&mut rx, "req-claude-dedup-a").await;

        st.handle_create(dedup_create_msg("req-claude-dedup-b"))
            .await;
        let b = await_claude_created(&mut rx, "req-claude-dedup-b").await;

        assert_ne!(
            a["sessionId"], b["sessionId"],
            "distinct requestIds must never replay each other's session: {a} / {b}"
        );
        assert_eq!(
            env.spawn_count(),
            2,
            "two distinct requestIds must spawn the sidecar once each"
        );
    }

    /// Cache invalidation: an EXPLICIT `freshAgent.kill` DOES evict the requestId dedup
    /// cache, so a duplicate `create` for the SAME requestId after the kill genuinely
    /// mints a fresh session (a new spawn), not a replay of the killed one.
    ///
    /// NOTE (task-specified suite reduction, justified): unlike codex, claude has no
    /// exit-watcher/self-heal state machine ([`ClaudeSession`] carries no `exited` bit --
    /// an unrequested sidecar death is simply an EOF the stdout consumer stops on, with
    /// no separate "replay after unrequested exit" code path for the dedup cache to
    /// interact with). That codex-suite test would be a byte-for-byte duplicate of
    /// `handle_create_duplicate_request_id_reuses_the_session_and_spawns_once` here, so
    /// it is dropped rather than mirrored redundantly -- 4 tests, not 5.
    #[tokio::test]
    async fn handle_create_duplicate_after_explicit_kill_creates_a_fresh_session() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-dedup-kill"))
            .await;
        let created = await_claude_created(&mut rx, "req-claude-dedup-kill").await;
        let killed_session_id = created["sessionId"].as_str().unwrap().to_string();

        st.handle_kill(FreshAgentKill {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: killed_session_id.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        st.handle_create(dedup_create_msg("req-claude-dedup-kill"))
            .await;
        let recreated = await_claude_created(&mut rx, "req-claude-dedup-kill").await;

        assert_ne!(
            recreated["sessionId"], killed_session_id,
            "a duplicate create after an EXPLICIT kill must mint a fresh session, not \
             replay the killed one: {recreated}"
        );
        assert_eq!(
            env.spawn_count(),
            2,
            "the kill must evict the dedup cache, so the duplicate create genuinely \
             re-spawns"
        );
    }

    /// `freshAgent.kill` for an session id this process never created is idempotent
    /// (`success:true`), matching the codex/opencode pattern.
    #[tokio::test]
    async fn handle_kill_of_unknown_session_still_broadcasts_success() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_kill(FreshAgentKill {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: "unknown-session".to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.killed");
        assert_eq!(frame["success"], true);
        assert_eq!(frame["sessionId"], "unknown-session");
    }

    // ── freshAgent.approval.respond / question.respond / compact (Task 2) ─────────

    fn approval_respond_msg(
        session_id: &str,
        session_type: SessionType,
        request_id: &str,
        decision: Value,
    ) -> FreshAgentApprovalRespond {
        FreshAgentApprovalRespond {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type,
            decision,
            request_id: freshell_protocol::StringOrNumber::Str(request_id.to_string()),
            cwd: None,
        }
    }

    fn question_respond_msg(
        session_id: &str,
        request_id: &str,
        answers: &[(&str, &str)],
    ) -> FreshAgentQuestionRespond {
        FreshAgentQuestionRespond {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshclaude,
            answers: answers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            request_id: freshell_protocol::StringOrNumber::Str(request_id.to_string()),
            cwd: None,
        }
    }

    fn compact_msg(session_id: &str, instructions: Option<&str>) -> FreshAgentCompact {
        FreshAgentCompact {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
            instructions: instructions.map(str::to_string),
        }
    }

    /// Read the session's folded pending request ids (permissions, questions).
    async fn pending_request_ids(
        st: &FreshClaudeState,
        session_id: &str,
    ) -> (Vec<String>, Vec<String>) {
        let guard = st.sessions.lock().await;
        let session = guard.get(session_id).expect("session tracked");
        let pending = session.pending.lock().expect("pending lock");
        (
            pending
                .permissions
                .iter()
                .map(|p| p.request_id.clone())
                .collect(),
            pending
                .questions
                .iter()
                .map(|q| q.request_id.clone())
                .collect(),
        )
    }

    /// Bounded-wait until the consumer has folded a pending `requestId` permission for
    /// the session (the respond handlers refuse ids outside the pending set, so the
    /// fold MUST be observed before responding).
    async fn await_pending_permission(st: &FreshClaudeState, session_id: &str, request_id: &str) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let (permissions, _) = pending_request_ids(st, session_id).await;
            if permissions.iter().any(|id| id == request_id) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "pending permission {request_id} never folded into the session"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    /// Insert a fake session whose sidecar stdin belongs to an already-exited child:
    /// writes fail DETERMINISTICALLY (EPIPE) without racing the stdout consumer's
    /// eviction path (a real dead sidecar's consumer would evict the record out from
    /// under the assertion; this record carries a no-op consumer, so nothing evicts it).
    async fn insert_dead_stdin_session(
        st: &FreshClaudeState,
        session_id: &str,
        pending: ClaudePending,
    ) {
        let mut child = tokio::process::Command::new("true")
            .stdin(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn true");
        let stdin = child.stdin.take().expect("piped stdin");
        child.wait().await.expect("true exits");
        let consumer = tokio::spawn(async {});
        st.sessions.lock().await.insert(
            session_id.to_string(),
            ClaudeSession {
                configuration: ClaudeConfiguration::default(),
                stdin,
                child,
                ownership_id: format!("test-{session_id}"),
                consumer,
                sidecar_session_id: session_id.to_string(),
                cli_session_id: None,
                broadcast_id: Arc::new(std::sync::Mutex::new(session_id.to_string())),
                pending: Arc::new(std::sync::Mutex::new(pending)),
                in_turn: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                turn_tracker: Arc::new(std::sync::Mutex::new(TurnTracker::default())),
                result_idle_pair_pending: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                turn_lock: Arc::new(TokioMutex::new(())),
                rollback_probe_slot: Arc::new(std::sync::Mutex::new(None)),
                last_status: Arc::new(std::sync::Mutex::new("idle".to_string())),
            },
        );
    }

    /// Task 2 (a): approve/deny resolves the parked permission — the handler writes the
    /// exact `permission.respond` stdin frame (sidecar-keyed sessionId, VERBATIM
    /// decision — a defined updatedInput is forwarded untouched, never synthesized) and
    /// removes the entry from the pending set.
    #[tokio::test]
    async fn approval_respond_writes_the_frame_and_removes_the_pending_entry() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-approval-respond"))
            .await;
        let created = await_claude_created(&mut rx, "req-approval-respond").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Raise the pending permission through the fake's canUseTool stand-in; the
        // consumer folds it into the session's pending set.
        st.handle_send(send_msg(&session_id, "__raise_permission__"))
            .await;
        await_pending_permission(&st, &session_id, "req-1").await;

        let decision = json!({ "behavior": "allow", "updatedInput": { "command": "ls -la" } });
        st.handle_approval_respond(approval_respond_msg(
            &session_id,
            SessionType::Freshclaude,
            "req-1",
            decision.clone(),
        ))
        .await;

        let frames = env.respond_log_frames(1).await;
        let respond = frames
            .iter()
            .find(|f| f["type"] == "permission.respond")
            .expect("permission.respond frame written to the sidecar");
        assert_eq!(
            respond["sessionId"],
            json!(session_id),
            "sidecar-keyed sessionId"
        );
        assert_eq!(respond["requestId"], "req-1");
        assert_eq!(
            respond["decision"], decision,
            "the decision payload is a VERBATIM passthrough"
        );
        let (permissions, _) = pending_request_ids(&st, &session_id).await;
        assert!(
            !permissions.iter().any(|id| id == "req-1"),
            "the resolved entry leaves the pending set"
        );
        drop(env);
    }

    /// Task 2 (a2, fresh-eyes F3 regression pin): write-then-remove ordering — when the
    /// sidecar stdin write FAILS, the pending entry MUST stay (the card stays; the user
    /// can retry) and the failure surfaces via the nested freshAgent.error envelope.
    /// Never clear-then-fail.
    #[tokio::test]
    async fn approval_respond_write_failure_keeps_the_pending_entry_and_emits_the_error() {
        let (st, mut rx) = state_with_bus();
        let pending = ClaudePending {
            permissions: vec![PendingApprovalEntry {
                request_id: "req-9".to_string(),
                tool_name: Some("Bash".to_string()),
                tool_use_id: None,
                blocked_path: None,
                decision_reason: None,
                input: None,
            }],
            questions: Vec::new(),
        };
        insert_dead_stdin_session(&st, "dead-stdin-approval", pending).await;

        st.handle_approval_respond(approval_respond_msg(
            "dead-stdin-approval",
            SessionType::Freshclaude,
            "req-9",
            json!({ "behavior": "deny", "message": "no", "interrupt": false }),
        ))
        .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(frame["sessionId"], "dead-stdin-approval");
        let (permissions, _) = pending_request_ids(&st, "dead-stdin-approval").await;
        assert_eq!(
            permissions,
            vec!["req-9".to_string()],
            "a failed write leaves the entry pending (never clear-then-fail)"
        );
    }

    /// D2-M3 (delta-review round 2): the shared protocol requires the decision to be a
    /// RECORD (`Record<string, unknown>`) and the sidecar resolves it VERBATIM — a
    /// null/array/scalar decision forwarded and REMOVED would leave the SDK permission
    /// promise permanently parked (the sidecar treats a null decision as a no-op) while
    /// the card vanishes from the pane. A non-object decision must be refused LOUDLY
    /// (nested `freshAgent.error{INTERNAL_ERROR}`), the pending entry MUST stay (the
    /// card stays actionable), and NOTHING reaches the sidecar stdin.
    #[tokio::test]
    async fn approval_respond_with_a_non_object_decision_is_refused_and_keeps_the_pending_entry() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-approval-null-decision"))
            .await;
        let created = await_claude_created(&mut rx, "req-approval-null-decision").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Raise the pending permission through the fake's canUseTool stand-in; the
        // consumer folds it into the session's pending set.
        st.handle_send(send_msg(&session_id, "__raise_permission__"))
            .await;
        await_pending_permission(&st, &session_id, "req-1").await;

        st.handle_approval_respond(approval_respond_msg(
            &session_id,
            SessionType::Freshclaude,
            "req-1",
            json!(null),
        ))
        .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(frame["sessionId"], json!(session_id));
        let (permissions, _) = pending_request_ids(&st, &session_id).await;
        assert_eq!(
            permissions,
            vec!["req-1".to_string()],
            "a refused non-object decision leaves the entry pending (never hide-then-wedge)"
        );
        assert!(
            env.respond_log_frames(0).await.is_empty(),
            "a refused non-object decision is never forwarded to the sidecar"
        );
        drop(env);
    }

    /// Task 2 (b): a requestId outside the pending set is refused LOUDLY with the parity
    /// message on the nested hub-frame — and NOTHING is written to the sidecar (Rust
    /// validates against its pending set first; the sidecar's unknown-id path is
    /// stderr-log-only and must never be reached).
    #[tokio::test]
    async fn approval_respond_unknown_request_id_emits_parity_error_and_writes_nothing() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-approval-unknown"))
            .await;
        let created = await_claude_created(&mut rx, "req-approval-unknown").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        st.handle_approval_respond(approval_respond_msg(
            &session_id,
            SessionType::Freshclaude,
            "req-nope",
            json!({ "behavior": "allow" }),
        ))
        .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(
            frame["event"]["message"],
            "Claude approval req-nope is not available"
        );
        assert_eq!(frame["sessionType"], "freshclaude");
        assert_eq!(frame["sessionId"], json!(session_id));
        assert!(
            env.respond_log_frames(0).await.is_empty(),
            "a refused respond must never reach the sidecar"
        );
        drop(env);
    }

    /// Task 2 (c): question.respond writes the `question.respond` stdin frame with the
    /// answers object (Map → JSON object) and removes the pending question.
    #[tokio::test]
    async fn question_respond_writes_the_frame_with_the_answers_object() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-question-respond"))
            .await;
        let created = await_claude_created(&mut rx, "req-question-respond").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Seed the pending question directly (the consumer fold itself is pinned by
        // consumer_folds_permission_and_question_frames_into_the_pending_set below).
        {
            let guard = st.sessions.lock().await;
            guard
                .get(&session_id)
                .unwrap()
                .pending
                .lock()
                .unwrap()
                .questions
                .push(PendingQuestionEntry {
                    request_id: "q-1".to_string(),
                    questions: json!([{ "question": "Continue?" }]),
                });
        }

        st.handle_question_respond(question_respond_msg(
            &session_id,
            "q-1",
            &[("choice", "yes"), ("note", "ship it")],
        ))
        .await;

        let frames = env.respond_log_frames(1).await;
        let respond = frames
            .iter()
            .find(|f| f["type"] == "question.respond")
            .expect("question.respond frame written to the sidecar");
        assert_eq!(respond["sessionId"], json!(session_id));
        assert_eq!(respond["requestId"], "q-1");
        assert_eq!(
            respond["answers"],
            json!({ "choice": "yes", "note": "ship it" }),
            "answers arrive as a JSON object (Map → object)"
        );
        let (_, questions) = pending_request_ids(&st, &session_id).await;
        assert!(
            questions.is_empty(),
            "the answered question leaves the pending set"
        );
        drop(env);
    }

    /// Task 2 (d): compact forwards to the sidecar as a plain `send` of `/compact`
    /// (empty/absent instructions) or `/compact <instructions trimmed>` — the legacy
    /// adapter's shape (`adapter.ts:168-174`) — with NO send.accepted ack frame.
    #[tokio::test]
    async fn compact_writes_send_frames_with_the_compact_command() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-compact")).await;
        let created = await_claude_created(&mut rx, "req-compact").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        st.handle_compact(compact_msg(&session_id, None)).await;
        st.handle_compact(compact_msg(&session_id, Some("  focus the diff  ")))
            .await;

        let frames = env.respond_log_frames(2).await;
        let sends: Vec<&Value> = frames.iter().filter(|f| f["type"] == "send").collect();
        assert_eq!(sends.len(), 2);
        assert_eq!(sends[0]["sessionId"], json!(session_id));
        assert_eq!(sends[0]["text"], "/compact");
        assert_eq!(
            sends[1]["text"], "/compact focus the diff",
            "instructions are trimmed and appended"
        );

        // No ack: compact must not reuse handle_send's send.accepted broadcast.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        while let Ok(frame) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&frame).unwrap();
            assert_ne!(
                frame["type"], "freshAgent.send.accepted",
                "compact emits no ack frame: {frame}"
            );
        }
        drop(env);
    }

    /// Task 2 (e, AGENT-24): kilroy rides the claude provider path — every error
    /// envelope from these handlers keeps the `kilroy` sessionType flavour (never the
    /// freshclaude default), so the client routes the lost/error frame to the kilroy pane.
    #[tokio::test]
    async fn respond_error_envelopes_keep_the_kilroy_session_type() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let mut create = dedup_create_msg("req-kilroy-respond");
        create.session_type = SessionType::Kilroy;
        st.handle_create(create).await;
        let created = await_claude_created(&mut rx, "req-kilroy-respond").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Unknown pending id on a LIVE kilroy session → INTERNAL_ERROR, kilroy flavour.
        st.handle_approval_respond(approval_respond_msg(
            &session_id,
            SessionType::Kilroy,
            "req-nope",
            json!({ "behavior": "allow" }),
        ))
        .await;
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["sessionType"], "kilroy");
        assert_eq!(frame["provider"], "claude");
        assert_eq!(frame["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(
            frame["event"]["message"],
            "Claude approval req-nope is not available"
        );

        // Unknown kilroy SESSION → the nested INVALID_SESSION_ID lost-session shape,
        // still kilroy-flavoured (engages markSessionLost on the right pane).
        st.handle_approval_respond(approval_respond_msg(
            "kilroy-gone",
            SessionType::Kilroy,
            "req-1",
            json!({ "behavior": "allow" }),
        ))
        .await;
        let lost = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(lost["sessionType"], "kilroy");
        assert_eq!(lost["event"]["code"], "INVALID_SESSION_ID");
        assert_eq!(lost["sessionId"], "kilroy-gone");
        assert!(env.respond_log_frames(0).await.is_empty());
        drop(env);
    }

    /// Task 7 (AGENT-24 ride-through): a KILROY session's approval respond LANDS —
    /// the happy path is identical to the freshclaude case
    /// (`approval_respond_writes_the_frame_and_removes_the_pending_entry`): the handler
    /// writes the exact `permission.respond` stdin frame (sidecar-keyed sessionId,
    /// VERBATIM decision) and removes the pending entry. Kilroy rides the claude
    /// provider path; this pins that the respond is not freshclaude-only.
    #[tokio::test]
    async fn kilroy_approval_respond_lands_and_removes_the_pending_entry() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let mut create = dedup_create_msg("req-kilroy-approval-lands");
        create.session_type = SessionType::Kilroy;
        st.handle_create(create).await;
        let created = await_claude_created(&mut rx, "req-kilroy-approval-lands").await;
        assert_eq!(
            created["sessionType"], "kilroy",
            "the created frame keeps the kilroy flavour"
        );
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Raise the pending permission through the fake's canUseTool stand-in; the
        // consumer folds it into the kilroy session's pending set.
        st.handle_send(send_msg(&session_id, "__raise_permission__"))
            .await;
        await_pending_permission(&st, &session_id, "req-1").await;

        let decision =
            json!({ "behavior": "deny", "message": "Denied by user", "interrupt": false });
        st.handle_approval_respond(approval_respond_msg(
            &session_id,
            SessionType::Kilroy,
            "req-1",
            decision.clone(),
        ))
        .await;

        let frames = env.respond_log_frames(1).await;
        let respond = frames
            .iter()
            .find(|f| f["type"] == "permission.respond")
            .expect("permission.respond frame written to the sidecar");
        assert_eq!(
            respond["sessionId"],
            json!(session_id),
            "sidecar-keyed sessionId"
        );
        assert_eq!(respond["requestId"], "req-1");
        assert_eq!(
            respond["decision"], decision,
            "the decision payload is a VERBATIM passthrough"
        );
        let (permissions, _) = pending_request_ids(&st, &session_id).await;
        assert!(
            !permissions.iter().any(|id| id == "req-1"),
            "the resolved entry leaves the pending set"
        );
        drop(env);
    }

    /// Task 2 (f): the stdout consumer folds the sidecar's pending-state frames into the
    /// per-session pending set BEFORE normalize/broadcast: request frames push (resend of
    /// the same requestId REPLACES), cancelled frames remove.
    #[tokio::test]
    async fn consumer_folds_permission_and_question_frames_into_the_pending_set() {
        let lines = [
            json!({ "type": "sdk.permission.request", "sessionId": "s", "requestId": "req-1",
                    "subtype": "can_use_tool", "tool": { "name": "Bash", "input": { "command": "ls" } },
                    "toolUseID": "toolu_1" }),
            json!({ "type": "sdk.question.request", "sessionId": "s", "requestId": "q-1",
                    "questions": [{ "question": "Continue?" }] }),
            json!({ "type": "sdk.permission.request", "sessionId": "s", "requestId": "req-2",
                    "subtype": "can_use_tool", "tool": { "name": "Read", "input": { "file_path": "/a" } },
                    "toolUseID": "toolu_2" }),
            json!({ "type": "sdk.permission.cancelled", "sessionId": "s", "requestId": "req-1" }),
            json!({ "type": "sdk.question.cancelled", "sessionId": "s", "requestId": "q-1" }),
            // Resend of req-2 REPLACES the entry (de-dupe by requestId).
            json!({ "type": "sdk.permission.request", "sessionId": "s", "requestId": "req-2",
                    "subtype": "can_use_tool", "tool": { "name": "Read", "input": { "file_path": "/b" } },
                    "toolUseID": "toolu_2" }),
        ];
        let dir = tempfile::tempdir().unwrap();
        let lines_path = dir.path().join("fold-lines.jsonl");
        // Terminated final line: `Lines::next_line` holds an unterminated tail in its
        // buffer until EOF (which never comes — the child sleeps with the pipe open).
        let mut script = lines
            .iter()
            .map(|l| l.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        script.push('\n');
        std::fs::write(&lines_path, script).unwrap();
        // Keep the pipe OPEN after the lines (sleep) so the consumer can't hit EOF and
        // evict mid-test; kill_on_drop reaps the child at test end.
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(format!("cat {}; sleep 30", lines_path.display()))
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn scripted stdout child");
        let stdout = child.stdout.take().expect("piped stdout");
        let reader = BufReader::new(stdout).lines();

        let st = state();
        let pending = Arc::new(std::sync::Mutex::new(ClaudePending::default()));
        let consumer = st.spawn_consumer(
            reader,
            "fold-session".to_string(),
            "freshclaude".to_string(),
            "fold-session".to_string(),
            None,
            Arc::new(std::sync::Mutex::new("fold-session".to_string())),
            Arc::clone(&pending),
            Arc::new(std::sync::Mutex::new("idle".to_string())),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Arc::new(std::sync::Mutex::new(TurnTracker::default())),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            None,
        );

        // The replace-resend is the LAST scripted line: observing its input proves the
        // whole stream has been folded (consumer lines are processed in order).
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            {
                let p = pending.lock().expect("pending lock");
                if p.permissions.len() == 1
                    && p.questions.is_empty()
                    && p.permissions[0].input == Some(json!({ "file_path": "/b" }))
                {
                    break;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the pending fold never converged on the scripted final state"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let p = pending.lock().expect("pending lock");
        assert_eq!(
            p.permissions.len(),
            1,
            "cancelled + replaced ids leave ONE permission entry"
        );
        assert_eq!(p.permissions[0].request_id, "req-2");
        assert_eq!(p.permissions[0].tool_name.as_deref(), Some("Read"));
        assert_eq!(p.permissions[0].tool_use_id.as_deref(), Some("toolu_2"));
        assert_eq!(
            p.permissions[0].input,
            Some(json!({ "file_path": "/b" })),
            "resend REPLACES the prior entry (de-dupe by requestId)"
        );
        assert!(p.questions.is_empty(), "the cancelled question is removed");
        drop(p);
        consumer.abort();
    }

    /// Delta-review round 5 (AGENT-06): the snapshot-bound copy of an
    /// `sdk.question.request` is NORMALIZED at fold time to the strict wire contract
    /// (`shared/fresh-agent-contract.ts` `FreshAgentQuestionDefinitionSchema`): per
    /// question exactly `{question, header?, options?, multiSelect?}`, per option
    /// exactly `{label, description}`. SDK-valid extras (e.g. the documented `preview`
    /// option field, preserved by `permission-channel.mjs`'s `...o`) are dropped — a
    /// preview-carrying question relayed raw would fail the client's strict snapshot
    /// parse and the question card would never render. Malformed members (no coercible
    /// `question`/`label`/`description` text) are dropped rather than poisoning the
    /// whole parse. The WS broadcast of the same frame stays verbatim — see
    /// `question_request_broadcast_keeps_the_verbatim_payload`.
    #[test]
    fn fold_normalizes_question_definitions_to_the_strict_contract_shape() {
        let pending = std::sync::Mutex::new(ClaudePending::default());
        let frame = json!({
            "type": "sdk.question.request",
            "sessionId": "s",
            "requestId": "q-prev",
            "questions": [
                {
                    "question": "Pick one",
                    "header": "Choice",
                    "multiSelect": true,
                    "options": [
                        { "label": "Yes", "description": "go ahead", "preview": "diff…" },
                        { "label": "No", "description": "stop", "preview": 42, "markdown": true }
                    ],
                    "extraTop": "drop-me",
                    "nested": { "also": "dropped" }
                },
                // Malformed members DROP (they can never satisfy the strict parse):
                { "header": "no question text" },
                {
                    "question": "Only well-formed options survive",
                    "options": [
                        { "label": "Fine", "description": "kept" },
                        { "label": "missing description" },
                        "not-an-object"
                    ]
                }
            ]
        });
        fold_pending_frame(&pending, &frame);

        let p = pending.lock().expect("pending lock");
        assert_eq!(p.questions.len(), 1);
        assert_eq!(
            p.questions[0].questions,
            json!([
                {
                    "question": "Pick one",
                    "header": "Choice",
                    "multiSelect": true,
                    "options": [
                        { "label": "Yes", "description": "go ahead" },
                        { "label": "No", "description": "stop" }
                    ]
                },
                {
                    "question": "Only well-formed options survive",
                    "options": [{ "label": "Fine", "description": "kept" }]
                }
            ]),
            "extras dropped at BOTH nesting levels — the pending copy parses against the strict contract"
        );
        drop(p);

        // A non-array `questions` never reaches the snapshot as a parse-breaking
        // scalar/null — the entry stays (respond-membership) with an empty array.
        fold_pending_frame(
            &pending,
            &json!({
                "type": "sdk.question.request",
                "sessionId": "s",
                "requestId": "q-scalar",
                "questions": "not-an-array"
            }),
        );
        fold_pending_frame(
            &pending,
            &json!({
                "type": "sdk.question.request",
                "sessionId": "s",
                "requestId": "q-missing"
            }),
        );
        let p = pending.lock().expect("pending lock");
        let scalar = p
            .questions
            .iter()
            .find(|q| q.request_id == "q-scalar")
            .unwrap();
        assert_eq!(scalar.questions, json!([]));
        let missing = p
            .questions
            .iter()
            .find(|q| q.request_id == "q-missing")
            .unwrap();
        assert_eq!(missing.questions, json!([]));
    }

    // ── cliSessionId recording (restart-parity plan §2.8 item 2) ──────────────────

    /// The stdout consumer must record `sdk.session.init`'s durable `cliSessionId` in
    /// [`FreshClaudeState::cli_index`] (durable id → sessions-map key), and an explicit
    /// kill must evict the index entry along with the session.
    #[tokio::test]
    async fn session_init_records_cli_session_id_in_the_index() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-cli-idx-1")).await;
        let created_frame = await_claude_created(&mut rx, "req-cli-idx-1").await;
        let created = created_frame["sessionId"].as_str().unwrap().to_string();

        // The fake emits sdk.session.init with the durable uuid; poll until the
        // consumer has recorded it (bounded).
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            {
                let idx = st.cli_index.lock().await;
                if idx.get("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") == Some(&created) {
                    break;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "cli_index never recorded the durable id"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        // The session carries the best-effort copy of the durable id.
        assert_eq!(
            st.sessions
                .lock()
                .await
                .get(&created)
                .unwrap()
                .cli_session_id
                .as_deref(),
            Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        );
        // Kill evicts the index entry.
        st.handle_kill(FreshAgentKill {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: created.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;
        assert!(st.cli_index.lock().await.is_empty());
        drop(env);
    }

    /// P1.13 (Task 9): the `sdk.session.init` arm must record ONE fresh-agent binding
    /// row through the identity sink — keyed by the DURABLE cliSessionId, carrying the
    /// FULL create-settings snapshot and the sessionType flavour — AWAITED before the
    /// init-driven broadcast proceeds (durable-before-answer, V8/A11).
    #[tokio::test(flavor = "multi_thread")]
    async fn session_init_records_binding_with_create_settings() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        // Drive freshAgent.create with sessionType kilroy + explicit settings.
        let mut msg = dedup_create_msg("req-binding-init");
        msg.session_type = SessionType::Kilroy;
        msg.model = Some("opus-x".to_string());
        msg.permission_mode = Some("plan".to_string());
        msg.effort = Some("high".to_string());
        msg.cwd = Some(env.dir.to_string_lossy().to_string());
        state.handle_create(msg).await;
        await_claude_created(&mut rx, "req-binding-init").await;

        // Wait for sdk.session.init to be consumed: the binding write is AWAITED
        // before the init frame broadcasts, so seeing the freshAgent.session.init
        // envelope proves the row already landed.
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["event"]["type"] == "freshAgent.session.init" {
                    break;
                }
            }
        })
        .await
        .expect("freshAgent.session.init consumed within budget");

        let bindings = fake.bindings.lock().unwrap();
        let b = bindings.last().expect("binding at sdk.session.init");
        assert_eq!(b.provider, "claude");
        assert_eq!(b.mode, "kilroy", "sessionType flavour preserved in the row");
        assert_eq!(
            b.session_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "keyed by cliSessionId"
        );
        assert_eq!(b.settings.model.as_deref(), Some("opus-x"));
        assert_eq!(b.settings.permission_mode.as_deref(), Some("plan"));
        assert_eq!(b.settings.effort.as_deref(), Some("high"));
        assert!(b.settings.cwd.is_some());
    }

    /// No-laundering guard (V7/A10, parity with codex's `record_codex_binding`):
    /// a create carrying NO optional settings (model/permissionMode/effort/cwd all
    /// None) must NOT persist an all-blank binding row at `sdk.session.init`. A blank
    /// row makes `was_recorded` true while `load_settings` returns None (the server
    /// sink's blank-snapshot guard) — the exact SETTINGS_RESET alarm condition — so a
    /// legitimately-default session would false-alarm on a later resume. The init
    /// frame itself still broadcasts; only the ledger write is skipped.
    #[tokio::test(flavor = "multi_thread")]
    async fn session_init_with_all_blank_settings_records_no_binding() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        // dedup_create_msg carries no model/permissionMode/effort/cwd — the
        // all-blank snapshot shape.
        state
            .handle_create(dedup_create_msg("req-binding-blank"))
            .await;
        await_claude_created(&mut rx, "req-binding-blank").await;

        // The init frame still broadcasts (the skip affects ONLY the ledger write).
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["event"]["type"] == "freshAgent.session.init" {
                    break;
                }
            }
        })
        .await
        .expect("freshAgent.session.init consumed within budget");

        assert!(
            fake.bindings.lock().unwrap().is_empty(),
            "an all-blank settings snapshot must not be persisted \
             (it would arm a false SETTINGS_RESET on resume)"
        );
        drop(env);
    }

    // ── resume settings-from-ledger (P1.13, Task 10) ─────────────────────────────

    /// P1.13 (Task 10): resume-in-place must reapply the pane's recorded
    /// model/permissionMode/effort from the ledger record instead of sending Nulls —
    /// the known defect where a restarted freshclaude/kilroy pane silently reverted
    /// its settings. The fake sidecar logs the WHOLE create-request JSON per spawn,
    /// so the wire itself is the assertion surface.
    #[tokio::test(flavor = "multi_thread")]
    async fn resume_for_attach_reapplies_settings_from_ledger() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, _rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed(
            "claude",
            DURABLE,
            crate::identity_sink::FreshAgentSettings {
                model: Some("opus-x".into()),
                sandbox: None,
                permission_mode: Some("plan".into()),
                effort: Some("high".into()),
                cwd: None,
            },
        );
        state.set_identity_sink(fake);

        // Drive the donor resume flow (attach to DURABLE with a transcript on disk).
        state
            .handle_attach(attach_msg_with_resume("client-nanoid-settings", DURABLE))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
        let create_req: serde_json::Value =
            serde_json::from_str(log.lines().next().expect("one spawn-logged create request"))
                .unwrap();
        assert_eq!(create_req["model"], "opus-x");
        assert_eq!(create_req["permissionMode"], "plan");
        assert_eq!(create_req["effort"], "high");
        drop(env);
    }

    /// V7/A10: record misses are ROUTINE — `resume_for_attach` exists precisely to
    /// serve never-tracked transcripts (every claude-CLI-created and pre-ship session
    /// in the shared `~/.claude/projects` store). They resume silently with nulls
    /// exactly as today (the preserved fallback), and record NOTHING under the new
    /// cliSessionId (settings: None ⇒ no laundered blank row — Task 9).
    #[tokio::test(flavor = "multi_thread")]
    async fn resume_without_record_is_silent_and_sends_nulls() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, mut rx) = state_with_bus();
        // Deliberately empty: no record, no snapshot.
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        state
            .handle_attach(attach_msg_with_resume("client-nanoid-norec", DURABLE))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        // Today's behavior preserved as the silent fallback: nulls on the wire.
        let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
        let create_req: serde_json::Value =
            serde_json::from_str(log.lines().next().expect("one spawn-logged create request"))
                .unwrap();
        assert_eq!(create_req["model"], Value::Null);
        assert_eq!(create_req["permissionMode"], Value::Null);
        assert_eq!(create_req["effort"], Value::Null);

        // Bounded bus drain (pattern from Task 5): NO SETTINGS_RESET frame may appear.
        while let Ok(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await
        {
            let Ok(text) = frame else { break };
            assert!(
                !text.contains("SETTINGS_RESET"),
                "never-recorded resume must stay silent"
            );
        }
        // No defaults laundering: no binding row was written under the new cliSessionId.
        assert!(
            fake.bindings.lock().unwrap().is_empty(),
            "a load_settings miss must not write a blank row"
        );
        drop(env);
    }

    /// The genuine anomaly (V7/A10): the ledger PROVES prior fresh-agent recording,
    /// yet no snapshot is recoverable — the only resume case that alarms.
    #[tokio::test(flavor = "multi_thread")]
    async fn resume_with_prior_record_but_unrecoverable_settings_alarms() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        // was_recorded=true, load_settings=None — the SETTINGS_RESET-positive fixture.
        fake.seed_recorded_only("claude", DURABLE);
        state.set_identity_sink(fake);

        state
            .handle_attach(attach_msg_with_resume("client-nanoid-alarm", DURABLE))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let mut found = false;
        while let Ok(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await
        {
            let Ok(text) = frame else { break };
            let frame: Value = serde_json::from_str(&text).unwrap();
            if frame["event"]["code"] == "SETTINGS_RESET" {
                // Top-level sessionType/provider (locator resolution) + a
                // user-facing message (the banner shows the message, never the code).
                assert_eq!(frame["event"]["type"], "freshAgent.error");
                assert_eq!(frame["sessionType"], "freshclaude");
                assert_eq!(frame["provider"], "claude");
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
        drop(env);
    }

    /// Ledger A9: consumer exit (== sidecar death) must evict the dead session AND its
    /// `cli_index` entries — kill/shutdown are NOT the only eviction paths. Without this,
    /// a dead-but-tracked session makes the tracked⇒no-op attach row strand panes forever.
    #[tokio::test]
    async fn consumer_exit_evicts_dead_session_and_index() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-evict-1")).await;
        let created_frame = await_claude_created(&mut rx, "req-evict-1").await;
        let created = created_frame["sessionId"].as_str().unwrap().to_string();
        // Kill the sidecar through the public API (fake exits on text "__exit__"),
        // then poll (bounded) until the consumer-exit eviction clears BOTH maps.
        st.handle_send(send_msg(&created, "__exit__")).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if st.sessions.lock().await.is_empty() && st.cli_index.lock().await.is_empty() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "consumer exit must evict the dead session and its cli_index entries"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        drop(env);
    }

    // ── freshAgent.interrupt (parity gap fix -- see terminal.rs's dispatch arm) ────

    /// A missing session mirrors the `SESSION_NOT_FOUND` convention already
    /// established by [`FreshClaudeState::handle_send`] (and codex/opencode's own
    /// `handle_interrupt`): an `error` frame, never a silent drop.
    #[tokio::test]
    async fn handle_interrupt_errors_for_unknown_session() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_interrupt(FreshAgentInterrupt {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: "does-not-exist".to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "error");
        assert!(
            frame["message"]
                .as_str()
                .unwrap()
                .contains("claude session not found"),
            "{frame}"
        );
    }

    /// A known session's interrupt is forwarded to the sidecar (the Rust-side half of
    /// the parity fix -- mirrors `adapters/claude/adapter.ts:163-168`'s
    /// `sdkBridge.interrupt(sessionId)` -> `sp.query.interrupt()`), observed via the
    /// fake sidecar's interrupt log since a successful interrupt broadcasts NOTHING
    /// (fire-and-forget, matching legacy exactly -- there is no confirmation frame to
    /// assert on instead).
    #[tokio::test]
    async fn handle_interrupt_forwards_the_request_to_the_sidecar_for_a_known_session() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-interrupt"))
            .await;
        let created = await_claude_created(&mut rx, "req-claude-interrupt").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        st.handle_interrupt(FreshAgentInterrupt {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        // Bounded poll for the fake sidecar's interrupt log (it's an OS-level pipe
        // write, not synchronous with `handle_interrupt`'s `write_line` await).
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if env.interrupt_log_contents().contains(&session_id) {
                break;
            }
            if std::time::Instant::now() >= deadline {
                panic!(
                    "sidecar never logged the interrupt for {session_id}: {:?}",
                    env.interrupt_log_contents()
                );
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Success is silent -- no `error` frame was broadcast for this interrupt. The
        // fake sidecar also emits `sdk.session.init`/`sdk.status` after `created`
        // (Task 1); those unrelated `freshAgent.event` frames are skipped rather than
        // miscounted as an interrupt response.
        while let Ok(raw) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(
                frame["type"], "freshAgent.event",
                "a successful interrupt must not broadcast: {frame}"
            );
            assert_ne!(
                frame["event"]["type"], "freshAgent.error",
                "a successful interrupt must not broadcast an error: {frame}"
            );
        }
    }

    /// Adapter-asymmetry fix (bug-hunt pbh-20260807): an UNREQUESTED sidecar death
    /// (crash/OOM/kill -9, never `freshAgent.kill`) must broadcast a pane-unwedging
    /// `freshAgent.error` after the consumer-exit eviction. The codex sibling broadcasts
    /// its crash self-heal `exited` status (`codex.rs spawn_exit_watcher`) and opencode's
    /// turn task emits an unconditional `idle` (`opencode_ws.rs run_turn`); claude was the
    /// only provider whose death edge was TOTAL SILENCE, leaving the pane stuck
    /// busy/"working" forever (the reference bridge broadcasts an explicit idle for
    /// exactly this reason -- `server/sdk-bridge.ts:344-353`). The client folds this frame
    /// into a visible banner AND drops the stuck running/streaming state
    /// (`fresh-agent-ws.ts:333-342`, `freshAgentSlice.sessionError`).
    #[tokio::test]
    async fn unrequested_sidecar_death_broadcasts_a_pane_unwedging_error() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-death-unwedge"))
            .await;
        let created = await_claude_created(&mut rx, "req-claude-death-unwedge").await;
        assert_eq!(created["type"], "freshAgent.created", "sanity: {created}");
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Simulate the crash: SIGKILL the sidecar child directly (NOT handle_kill, which
        // removes the map entry first and must stay silent).
        {
            let mut guard = st.sessions.lock().await;
            let session = guard.get_mut(&session_id).expect("live session in map");
            let _ = session.child.start_kill();
        }

        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let raw = tokio::time::timeout(remaining, rx.recv())
                .await
                .expect(
                    "no SIDECAR_EXITED freshAgent.error was broadcast after an unrequested \
                     sidecar death -- the pane stays wedged busy forever",
                )
                .expect("broadcast bus closed");
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.event"
                && frame["event"]["type"] == "freshAgent.error"
                && frame["event"]["code"] == "SIDECAR_EXITED"
            {
                // Stamped with the session's broadcast id so the frozen client routes it
                // to the right pane (fresh-agent-ws.ts:190-201).
                assert_eq!(frame["sessionId"], json!(session_id), "{frame}");
                assert_eq!(frame["event"]["sessionId"], json!(session_id), "{frame}");
                assert_eq!(frame["provider"], "claude", "{frame}");
                assert_eq!(frame["sessionType"], "freshclaude", "{frame}");
                assert!(
                    !frame["event"]["message"].as_str().unwrap_or("").is_empty(),
                    "user-facing message required: {frame}"
                );
                break;
            }
        }
        // The pre-existing consumer-exit eviction (ledger A9) still happened.
        assert!(
            !st.sessions.lock().await.contains_key(&session_id),
            "dead session must still be evicted from the sessions map"
        );
    }

    // ── kata 1wxv Task 4: claude/kilroy undo/redo (fork-at-point emulation) ──

    use crate::identity_sink::PaneIdentitySink as _;
    use crate::rollback_record::{
        RollbackDirection, RollbackEntry, RollbackModeReq, RollbackRecord, RollbackRequest,
        LEDGER_WRITE_REFUSAL_COPY, REDO_EMPTY_MESSAGE, REDO_REMOVED_HISTORY_COPY,
        ROLLBACK_BUSY_MESSAGE,
    };

    /// The FrameSink that records every delivered requesting-sink frame (codex.rs's
    /// `capturing_sink` idiom — `conn_sink` in terminal.rs).
    fn capturing_sink() -> (
        freshell_terminal::FrameSink,
        Arc<std::sync::Mutex<Vec<ServerMessage>>>,
    ) {
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: freshell_terminal::FrameSink = {
            let captured = captured.clone();
            Arc::new(move |msg| captured.lock().expect("captured mutex").push(msg))
        };
        (sink, captured)
    }

    fn captured_json(captured: &Arc<std::sync::Mutex<Vec<ServerMessage>>>) -> Vec<Value> {
        captured
            .lock()
            .expect("captured mutex")
            .iter()
            .map(|m| serde_json::to_value(m).expect("frame serializes"))
            .collect()
    }

    fn rollback_op(
        session_id: &str,
        request_id: &str,
        direction: RollbackDirection,
    ) -> RollbackRequest {
        RollbackRequest {
            direction,
            mode: RollbackModeReq::Step,
            turn_id: None,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshclaude,
            provider: freshell_protocol::AgentProvider::Claude,
            request_id: request_id.to_string(),
            cwd: None,
        }
    }

    /// u1/a1/u2/a2 chain (uuid + parentUuid linked): the rollback fixture corpus.
    fn two_turn_transcript() -> String {
        [
            json!({"type":"user","uuid":"u1","parentUuid":null,"timestamp":"t1","message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"t2","message":{"role":"assistant","content":[{"type":"text","text":"answer one"}]}}),
            json!({"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"t3","message":{"role":"user","content":[{"type":"text","text":"prompt two"}]}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"t4","message":{"role":"assistant","content":[{"type":"text","text":"answer two"}]}}),
        ]
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join("\n")
    }

    /// Write the durable transcript under `<home>/projects/-t/<durable>.jsonl`
    /// (the layout `find_transcript` scans) — the rollback handler's disk truth.
    /// Every parsed line gains `cwd: "/tmp"` (ledger A15: the CLI's resume lookup
    /// is scoped to the transcript's ORIGINAL cwd, so the durable-id resume form
    /// only survives when the recorded cwd exists on disk — `/tmp` always does).
    fn write_rollback_transcript(home: &std::path::Path, durable: &str, text: &str) {
        let dir = home.join("projects").join("-t");
        std::fs::create_dir_all(&dir).unwrap();
        let mut out: Vec<String> = Vec::new();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(mut v) => {
                    if v.get("cwd").is_none() {
                        v["cwd"] = json!("/tmp");
                    }
                    out.push(v.to_string());
                }
                Err(_) => out.push(line.to_string()),
            }
        }
        std::fs::write(dir.join(format!("{durable}.jsonl")), out.join("\n")).unwrap();
    }

    /// A rollback-fixture live session: a `tee <stdin_log>` child stands in for the
    /// sidecar — every byte the handler writes to its stdin lands in stdin_log (the
    /// "no sidecar churn" oracle for the refusal legs) — registered with
    /// `cli_session_id` = durable and the cli_index alias, exactly like a
    /// fully-initialized live session.
    async fn insert_rollback_fixture_session(
        st: &FreshClaudeState,
        map_key: &str,
        durable: &str,
    ) -> PathBuf {
        let stdin_log = std::env::temp_dir().join(format!(
            "freshell-claude-rollback-stdin-{}",
            uuid::Uuid::new_v4()
        ));
        // ep4-r2: a real probe-answering child (node does exactly what `tee`
        // did — every raw stdin line lands verbatim in stdin_log — PLUS the
        // ep4-r2 quiesce probe: an `interrupt` request is answered with the
        // sidecar's settled receipt, so rollback's probe never stalls the
        // fixture. A live consumer folds those receipts (stream order).
        const FIXTURE_CHILD_SCRIPT: &str = r#"
const fs = require('node:fs')
const readline = require('node:readline')
const stdinLog = process.argv[1]
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  fs.appendFileSync(stdinLog, `${line}\n`)
  try {
    const msg = JSON.parse(line)
    if (msg && msg.type === 'interrupt') {
      process.stdout.write(JSON.stringify({
        type: 'sdk.interrupt_settled',
        sessionId: msg.sessionId,
        ok: true,
      }) + '\n')
    } else if (msg && msg.type === 'rollback.quiesce') {
      process.stdout.write(JSON.stringify({
        type: 'sdk.rollback.quiesced',
        sessionId: msg.sessionId,
        probeId: msg.probeId ?? null,
        cancelledQueue: 0,
        inFlightTurn: false,
        handedCompactLikely: false,
      }) + '\n')
    }
  } catch {}
})
"#;
        let mut child = tokio::process::Command::new("node")
            .arg("-e")
            .arg(FIXTURE_CHILD_SCRIPT)
            .arg(&stdin_log)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn fixture probe child");
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let reader = BufReader::new(stdout).lines();
        let in_turn = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let turn_tracker = Arc::new(std::sync::Mutex::new(TurnTracker::default()));
        let pending = Arc::new(std::sync::Mutex::new(ClaudePending::default()));
        let result_idle_pair_pending = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let turn_lock = Arc::new(TokioMutex::new(()));
        let last_status = Arc::new(std::sync::Mutex::new("idle".to_string()));
        let broadcast_id = Arc::new(std::sync::Mutex::new(map_key.to_string()));
        let consumer = st.spawn_consumer(
            reader,
            map_key.to_string(),
            "freshclaude".to_string(),
            map_key.to_string(),
            None,
            Arc::clone(&broadcast_id),
            Arc::clone(&pending),
            Arc::clone(&last_status),
            Arc::clone(&in_turn),
            Arc::clone(&turn_tracker),
            Arc::clone(&result_idle_pair_pending),
            None,
        );
        st.sessions.lock().await.insert(
            map_key.to_string(),
            ClaudeSession {
                configuration: ClaudeConfiguration::default(),
                stdin,
                child,
                ownership_id: format!("test-{map_key}"),
                consumer,
                sidecar_session_id: map_key.to_string(),
                cli_session_id: Some(durable.to_string()),
                broadcast_id,
                pending,
                in_turn,
                turn_tracker,
                result_idle_pair_pending,
                turn_lock,
                rollback_probe_slot: Arc::new(std::sync::Mutex::new(None)),
                last_status,
            },
        );
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), map_key.to_string());
        stdin_log
    }

    /// Legacy tee rig: dead consumer, stdin is a plain `tee` — used ONLY by the
    /// failed-arm families that SIGSTOP/SIGKILL the child to fail a parked
    /// write (a live consumer would reap the tracker at EOF, which is the
    /// production-correct behavior these tests deliberately bypass).
    async fn insert_rollback_fixture_session_no_probe(
        st: &FreshClaudeState,
        map_key: &str,
        durable: &str,
    ) -> PathBuf {
        let stdin_log = std::env::temp_dir().join(format!(
            "freshell-claude-rollback-stdin-{}",
            uuid::Uuid::new_v4()
        ));
        let mut child = tokio::process::Command::new("tee")
            .arg(&stdin_log)
            .stdin(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn tee");
        let stdin = child.stdin.take().expect("piped stdin");
        let consumer = tokio::spawn(async {});
        st.sessions.lock().await.insert(
            map_key.to_string(),
            ClaudeSession {
                configuration: ClaudeConfiguration::default(),
                stdin,
                child,
                ownership_id: format!("test-{map_key}"),
                consumer,
                sidecar_session_id: map_key.to_string(),
                cli_session_id: Some(durable.to_string()),
                broadcast_id: Arc::new(std::sync::Mutex::new(map_key.to_string())),
                pending: Arc::new(std::sync::Mutex::new(ClaudePending::default())),
                in_turn: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                turn_tracker: Arc::new(std::sync::Mutex::new(TurnTracker::default())),
                result_idle_pair_pending: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                turn_lock: Arc::new(TokioMutex::new(())),
                rollback_probe_slot: Arc::new(std::sync::Mutex::new(None)),
                last_status: Arc::new(std::sync::Mutex::new("idle".to_string())),
            },
        );
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), map_key.to_string());
        stdin_log
    }

    /// Focused ep4-r2 F2 rig: like [`insert_rollback_fixture_session`] (a
    /// durable-bound, transcript-eligible rollback fixture) but with a LIVE
    /// consumer attached to the real fake-sidecar script — so rollback's
    /// in-order quiesce probe genuinely round-trips (the plain fixture's dead
    /// consumer would skip it). The scripted fake is written per-call into a
    /// unique temp dir (its own spawn/interrupt/respond logs); test knobs the
    /// script honors ride the same process env (CLAUDE_ENV_LOCK guarded).
    async fn insert_rollback_fixture_session_with_live_sidecar(
        st: &FreshClaudeState,
        map_key: &str,
        durable: &str,
    ) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "freshell-fake-claude-fixture-live-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create live-fixture temp dir");
        let script = dir.join("fake-claude-sidecar.mjs");
        std::fs::write(&script, FAKE_CLAUDE_SIDECAR_SOURCE).expect("write live fixture fake");
        let stdin_log = dir.join("stdin.log");
        let spawn_log = dir.join("spawn.log");
        std::fs::write(&spawn_log, "").expect("init spawn log");

        let stderr_log = std::fs::File::create(dir.join("stderr.log")).expect("init stderr log");
        let mut child = tokio::process::Command::new("node")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(stderr_log))
            .env("FRESHELL_TEST_CLAUDE_SPAWN_LOG", &spawn_log)
            .env(
                "FRESHELL_TEST_CLAUDE_INTERRUPT_LOG",
                dir.join("interrupt.log"),
            )
            .env("FRESHELL_TEST_CLAUDE_RESPOND_LOG", dir.join("respond.log"))
            .env("FRESHELL_TEST_CLAUDE_PRESEED_SESSIONS", map_key)
            .kill_on_drop(true)
            .spawn()
            .expect("spawn live fake sidecar");
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let reader = BufReader::new(stdout).lines();

        let in_turn = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let turn_tracker = Arc::new(std::sync::Mutex::new(TurnTracker::default()));
        let pending = Arc::new(std::sync::Mutex::new(ClaudePending::default()));
        let result_idle_pair_pending = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let turn_lock = Arc::new(TokioMutex::new(()));
        let last_status = Arc::new(std::sync::Mutex::new("idle".to_string()));
        let broadcast_id = Arc::new(std::sync::Mutex::new(map_key.to_string()));
        let consumer = st.spawn_consumer(
            reader,
            map_key.to_string(),
            "freshclaude".to_string(),
            map_key.to_string(),
            None,
            Arc::clone(&broadcast_id),
            Arc::clone(&pending),
            Arc::clone(&last_status),
            Arc::clone(&in_turn),
            Arc::clone(&turn_tracker),
            Arc::clone(&result_idle_pair_pending),
            None,
        );
        st.sessions.lock().await.insert(
            map_key.to_string(),
            ClaudeSession {
                configuration: ClaudeConfiguration::default(),
                stdin,
                child,
                ownership_id: format!("test-live-{map_key}"),
                consumer,
                sidecar_session_id: map_key.to_string(),
                cli_session_id: Some(durable.to_string()),
                broadcast_id,
                pending,
                in_turn,
                turn_tracker,
                result_idle_pair_pending,
                turn_lock,
                rollback_probe_slot: Arc::new(std::sync::Mutex::new(None)),
                last_status,
            },
        );
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), map_key.to_string());
        stdin_log
    }

    /// Poll until the session's `cli_session_id` differs from `prior` (the fork
    /// adoption mints a NEW durable id mid-rollback) or the budget dies.
    async fn await_adopted_durable(st: &FreshClaudeState, map_key: &str, prior: &str) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let current = st
                .sessions
                .lock()
                .await
                .get(map_key)
                .and_then(|s| s.cli_session_id.clone());
            if let Some(current) = current {
                if current != prior {
                    return current;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the session's cli_session_id never moved off {prior}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn in_turn_of(st: &FreshClaudeState, map_key: &str) -> bool {
        st.sessions
            .lock()
            .await
            .get(map_key)
            .map(|s| s.in_turn.load(std::sync::atomic::Ordering::SeqCst))
            .unwrap_or(false)
    }

    async fn await_in_turn(st: &FreshClaudeState, map_key: &str, want: bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if in_turn_of(st, map_key).await == want {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "in_turn never became {want}"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn interrupt_msg(session_id: &str) -> FreshAgentInterrupt {
        FreshAgentInterrupt {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        }
    }

    /// Focused ep1-r1 F1 test rig: write a `send` frame to the session's
    /// sidecar stdin DIRECTLY (bypassing `handle_send`) — the fake sidecar's
    /// magic texts then emit their canned sdk.* frame IN-STREAM with NO
    /// freshCode-side set edge, emulating the provider's asynchronous
    /// turn-terminal frames (the busy flag was set when the turn was
    /// SUBMITTED, not when its result arrives).
    async fn inject_raw_send(st: &FreshClaudeState, map_key: &str, text: &str) {
        let mut guard = st.sessions.lock().await;
        let session = guard.get_mut(map_key).expect("tracked session");
        let frame =
            json!({ "type": "send", "sessionId": session.sidecar_session_id, "text": text });
        write_line(&mut session.stdin, &frame)
            .await
            .expect("raw stdin write");
    }

    /// Drain bus frames until the session's `freshAgent.status` carries
    /// `status` — used post-create so the fake's CREATE-TIME `sdk.status:idle`
    /// (printed with the `created` answer) provably folds BEFORE the test's
    /// first turn sets the busy truth: otherwise that stale idle can land
    /// mid-test and spoof a clear edge.
    async fn await_status_frame(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        session_id: &str,
        status: &str,
    ) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            while let Ok(raw) = rx.try_recv() {
                let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                if v["type"] == "freshAgent.event"
                    && v["sessionId"] == session_id
                    && v["event"]["type"] == "freshAgent.status"
                    && v["event"]["status"] == status
                {
                    return;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no freshAgent.status:{status} frame for {session_id}"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn in_turn_clears_on_exactly_the_four_contract_edges_fail_closed_otherwise() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-in-turn-edges"))
            .await;
        let created = await_claude_created(&mut rx, "req-in-turn-edges").await;
        let sid = created["sessionId"].as_str().unwrap().to_string();
        // Fold the create-time idle BEFORE any turn starts: otherwise that
        // stale idle can land mid-test and spoof a clear edge (flaked twice
        // under full-suite load — this is the documented post-create hygiene
        // every other busy-tracker test already follows).
        await_status_frame(&mut rx, &sid, "idle").await;

        // (a) sdk.result clears with ANY subtype (r2: a result frame ends the turn —
        // here an ERRORED result, the subtype the voided "success-only" wording excluded):
        st.handle_send(send_msg(&sid, "turn one")).await;
        assert!(in_turn_of(&st, &sid).await, "a send sets the busy truth");
        // inject_raw_send: the provider's terminal edge, NOT another tracked op
        // (a magic-text handle_send would enqueue a phantom second op under the
        // ep2-r2 order-explicit tracker).
        inject_raw_send(&st, &sid, "__emit_result_error__").await;
        await_in_turn(&st, &sid, false).await;

        // Fail-closed: the NON-EDGES must NOT clear — sdk.error, sdk.status
        // compacting, sdk.assistant frames all leave in_turn TRUE.
        st.handle_send(send_msg(&sid, "turn two")).await;
        inject_raw_send(&st, &sid, "__emit_error__").await;
        inject_raw_send(&st, &sid, "__emit_compacting__").await;
        inject_raw_send(&st, &sid, "__emit_assistant__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &sid).await,
            "sdk.error / sdk.status=compacting / sdk.assistant are NOT clear edges (fail-closed)"
        );

        // (b) sdk.status with status == "idle" clears:
        inject_raw_send(&st, &sid, "__emit_idle__").await;
        await_in_turn(&st, &sid, false).await;

        // (d) a completed handle_interrupt clears — the interrupted turn's OWN
        // terminal frames (result + idle, per the SDK receipt-before-result
        // contract) do it; an error-subtype result never chimes:
        st.handle_send(send_msg(&sid, "turn three")).await;
        assert!(in_turn_of(&st, &sid).await);
        // Baseline: drop every frame the create/emit dance left on the bus.
        while rx.try_recv().is_ok() {}
        st.handle_interrupt(interrupt_msg(&sid)).await;
        // ep4-r2 F1: the gate releases at the interrupted op's OWN result fold
        // (the fake emits settle → result → idle in SDK order); poll it.
        await_in_turn(&st, &sid, false).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        while let Ok(raw) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&raw).unwrap();
            assert_ne!(
                frame["event"]["type"],
                json!("freshAgent.turn.complete"),
                "an interrupt NEVER chimes even though the turn's own result frame lands: {frame}"
            );
        }

        // (c) sidecar EOF/death (the SIDECAR_EXITED arm) clears:
        st.handle_send(send_msg(&sid, "turn four")).await;
        assert!(in_turn_of(&st, &sid).await);
        let in_turn_handle = {
            st.sessions
                .lock()
                .await
                .get(&sid)
                .expect("still tracked")
                .in_turn
                .clone()
        };
        st.handle_send(send_msg(&sid, "__exit__")).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while in_turn_handle.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "sidecar EOF/death never cleared the busy truth (edge c)"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        drop(env);
    }

    #[tokio::test]
    async fn handle_rollback_mid_turn_is_busy_and_never_touches_the_sidecar() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, _rx) = state_with_bus();
        let stdin_log = insert_rollback_fixture_session(&st, "rb-busy", "dur-busy").await;
        prime_fixture_running_turn(&st, "rb-busy").await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-busy", "rb-busy-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames.len(),
            1,
            "exactly one requesting-sink frame: {frames:?}"
        );
        let frame = &frames[0];
        assert_eq!(frame["type"], "freshAgent.event");
        assert_eq!(frame["event"]["type"], "freshAgent.error");
        assert_eq!(frame["event"]["code"], "BUSY_TURN");
        assert_eq!(frame["event"]["message"], ROLLBACK_BUSY_MESSAGE);
        assert_eq!(frame["event"]["rollback"], json!(true));
        assert_eq!(frame["event"]["requestId"], "rb-busy-1");
        // THE SAFETY GATE: a refused attempt emits NO sidecar traffic — no stdin
        // bytes, no sidecar spawn/kill, the session record never torn down.
        assert_eq!(
            std::fs::read_to_string(&stdin_log).unwrap_or_default(),
            "",
            "no line was written to the session's stdin"
        );
        assert_eq!(
            env.spawn_count(),
            0,
            "no sidecar was spawned/killed for a refused attempt"
        );
        assert!(
            st.sessions.lock().await.contains_key("rb-busy"),
            "the session was never torn down"
        );
        drop(env);
    }

    #[tokio::test]
    async fn rollback_during_a_compact_turn_is_refused_busy_turn_with_zero_teardown_traffic() {
        // Delta-r1 F1: handle_compact marks the claude busy truth (`in_turn`) UNDER
        // the session turn lock BEFORE writing the /compact send to the sidecar —
        // the check-then-set window against handle_rollback's busy gate is closed.
        // A claude compact turn ends at the SDK's `sdk.result` frame (any subtype —
        // the existing four-edge clear set, no new clear edge): WHILE it runs, a
        // rollback refuses BUSY_TURN with zero teardown/spawn traffic; AFTER it,
        // the gate reopens.
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-compact-rb")).await;
        let created = await_claude_created(&mut rx, "req-compact-rb").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        st.handle_compact(compact_msg(&session_id, None)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "a compact marks in_turn BEFORE the sidecar write (F1)"
        );

        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-compact-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["code"], "BUSY_TURN");
        assert_eq!(frames[0]["event"]["message"], ROLLBACK_BUSY_MESSAGE);
        assert_eq!(frames[0]["event"]["rollback"], json!(true));
        assert_eq!(
            env.spawn_count(),
            1,
            "only the original create spawned — the refused rollback produced zero teardown/spawn traffic"
        );
        assert!(
            st.sessions.lock().await.contains_key(&session_id),
            "no teardown"
        );

        // The compact turn ends at the SDK's result frame (any subtype — here an
        // ERRORED one); the four-edge clear set already covers it, and the busy
        // gate reopens (a follow-up rollback leaves the window for its true
        // verdict — NOTHING_TO_UNDO on this transcript-less session).
        // inject_raw_send: the compact op's OWN edge, not a phantom second op.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        await_in_turn(&st, &session_id, false).await;
        let (sink2, captured2) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-compact-2", RollbackDirection::Undo),
            sink2,
        )
        .await;
        let frames2 = captured_json(&captured2);
        assert_eq!(
            frames2[0]["event"]["code"], "NOTHING_TO_UNDO",
            "the busy gate reopened once the compact turn's sdk.result landed: {frames2:?}"
        );
        drop(env);
    }

    /// Focused-review ep1-r1 F1 + ep1-r2 F2 + ep1-r3 F1 — the exact THREE-STAGE
    /// queue repro (the fake sidecar consumes stdin FIFO, so each magic text
    /// below models one queued provider turn's frames, in strict consumption
    /// order): turn A running → `/compact` QUEUED behind it (armed) → user
    /// send B QUEUED behind the compact (the garlanded tracker). Rollback is
    /// BUSY_TURN from A's terminal edge all the way through B's own terminal
    /// edge, with zero teardown traffic throughout:
    ///
    ///   1. A's `sdk.result` folds as the arm's structural prior edge — gate
    ///      HOLDS (ep1-r1 F1);
    ///   2. B's acceptance disarms nothing (ep1-r2 F2 — a send ACCEPTED onto
    ///      the FIFO queue proves nothing about drainage);
    ///   3. the compact's observed `sdk.status:compacting` + its OWN terminal
    ///      edge DISARM the trackers but the busy truth SURVIVES (ep1-r3 F1:
    ///      the observed-compaction branch must never release busy while a
    ///      garlanded send is still owed — B is generating NOW);
    ///   4. B's own terminal edge — folding through the NORMAL unarmed
    ///      four-edge path — releases the gate exactly there.
    #[tokio::test]
    async fn queued_compact_with_a_garlanded_send_holds_busy_until_the_sends_own_terminal_edge() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-qcompact")).await;
        let created = await_claude_created(&mut rx, "req-qcompact").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        // Fold the create-time idle BEFORE any turn starts (no stale clear edge).
        await_status_frame(&mut rx, &session_id, "idle").await;

        // Turn A starts (busy); the compact queues BEHIND it.
        st.handle_send(send_msg(&session_id, "turn one")).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "turn A marks the busy truth"
        );
        st.handle_compact(compact_msg(&session_id, None)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "the queued compact keeps the busy truth set"
        );

        // (1) The PRIOR turn's terminal edge arrives in-stream: consumed as
        // the arm's owed prior edge — the TRACKER holds the queued compact
        // (ep1-r1 F1). ep3-r3 F1: at the rollback GATE, a provably-quiescent
        // compact-only debt ADMITS and survives-absorbs (nothing running, no
        // live candidate, no Turn owed): the rollback proceeds (nothing to
        // undo here — zero teardown), the entry SURVIVES, and the gate is
        // opened optimistically — C's later proven start re-closes it.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "the prior turn's terminal edge never releases a queued compact"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qcompact-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(
            frames[0]["event"]["code"], "NOTHING_TO_UNDO",
            "ep3-r3 F1: provably-quiescent compact-only debt absorbs at the gate (the entry SURVIVES — its proven start re-closes the gate): {frames:?}"
        );
        assert!(
            st.sessions.lock().await.contains_key(&session_id),
            "no teardown"
        );

        // (2) Send B lands (queued BEHIND the compact provider-side). ep1-r2
        // F2 + ep3-r3 F1: a queued TURN behind the surviving compact RE-CLOSES
        // the gate — owed turn debt is never absorbable.
        st.handle_send(send_msg(&session_id, "turn three")).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qcompact-2", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "F2: an accepted send never proves the compact drained — the gate stays closed"
        );

        // (3a) The compact's own turn starts: the provider OBSERVABLY compacts
        // and its completion boundary confirms the run was the manual one
        // (ep3-r1 F1: the trigger-blind status alone never promotes).
        inject_raw_send(&st, &session_id, "__emit_compacting__").await;
        inject_raw_send(&st, &session_id, "__emit_compact_boundary_manual__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qcompact-3", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "mid-compact: the gate is held until the compact's OWN terminal edge"
        );

        // (3b) ep1-r3 F1 CORE: the compact's OWN terminal edge lands while the
        // garlanded send B is STILL generating. The trackers disarm here, but
        // the busy truth MUST SURVIVE — a rollback admitted now would tear
        // down/fork B mid-turn (the sole mid-turn protection requirement).
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "F1: the compact's terminal edge never releases the gate while the garlanded send B generates"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qcompact-4", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "BUSY_TURN",
            "F1: BUSY_TURN from A's result THROUGH the compact's result — B still owns the turn: {frames:?}"
        );
        assert_eq!(
            env.spawn_count(),
            1,
            "zero teardown traffic while B generates"
        );
        assert!(
            st.sessions.lock().await.contains_key(&session_id),
            "no teardown"
        );

        // (4) B's OWN terminal edge folds through the normal unarmed four-edge
        // path — the gate releases EXACTLY here.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        await_in_turn(&st, &session_id, false).await;
        let (sink2, captured2) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qcompact-5", RollbackDirection::Undo),
            sink2,
        )
        .await;
        let frames2 = captured_json(&captured2);
        assert_eq!(
            frames2[0]["event"]["code"], "NOTHING_TO_UNDO",
            "the busy gate released exactly at B's own terminal edge: {frames2:?}"
        );
        drop(env);
    }

    /// Focused-review ep3-r1 F1 (automatic compaction is NEVER a queued
    /// explicit compact's evidence): the bare `sdk.status:compacting` frame
    /// carries NO trigger — the SDK fires it for an explicit `/compact` AND for
    /// its own automatic context compaction. With [A done, C1 (queue-dropped)
    /// ahead, B queued as the de-facto active turn], B automatically
    /// compacts mid-turn: status-time promotion attributed the AUTO compaction
    /// to C1 ("promotes the phantom"); B's own result frame then retired the
    /// PHANTOM compact and stranded B queued — its PAIRED idle deliberately
    /// skipped (ep2-r1 F1) — `in_turn` held FOREVER (BUSY_TURN for every later
    /// undo). Only the SDK's compact COMPLETION boundary
    /// (`sdk.compact_boundary {trigger}`) discriminates the trigger; promotion
    /// now requires the `manual` boundary.
    ///
    ///   A → C1 → B → A's pair (A retires) → B generating → AUTO compact
    ///   (status + boundary auto — NO promotion) → B's own result + idle pair
    ///   (B retires) → the gate OPENS.
    #[tokio::test]
    async fn an_automatic_compaction_mid_turn_is_never_attributed_to_a_queued_compact() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-autocompact")).await;
        let created = await_claude_created(&mut rx, "req-autocompact").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await; // A
        st.handle_compact(compact_msg(&session_id, None)).await; // C1
        st.handle_send(send_msg(&session_id, "turn two")).await; // B

        // A's pair retires A; [C1 dropped, B (de-facto active)] remains.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(in_turn_of(&st, &session_id).await, "C1(dropped) + B owed");

        // B's AUTOMATIC context compaction: bare compacting status + its
        // completion boundary tagged `auto`. NEVER C1's evidence: C1 is NOT
        // promoted and the gate stays closed while B generates.
        inject_raw_send(&st, &session_id, "__emit_compacting__").await;
        inject_raw_send(&st, &session_id, "__emit_compact_boundary_auto__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-auto-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "ep3-r1 F1: the queued C1 is NOT promoted by an automatic compaction — B still owes its terminal edge"
        );

        // B's own result + its PAIRED idle retires B — and the gate OPENS:
        // nothing is owed (C1's silent drop is proven by B's activity per the
        // existing drop-absorber), the pane is never permanently busy.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-auto-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "NOTHING_TO_UNDO",
            "ep3-r1 F1: the gate opened at B's own terminal edge — never wedged by a mis-promoted phantom compact: {frames:?}"
        );
        drop(env);
    }

    /// Focused-review ep3-r2 F1 (interrupt inside the compact candidate
    /// window): C1's bare `sdk.status:compacting` has arrived but its manual
    /// completion boundary has NOT — C1 is exactly the execution the SDK's
    /// `query.interrupt()` cancels, while every op QUEUED BEHIND it (C2, S)
    /// provably still runs. The silent-drop absorber (retire-to-first-Turn)
    /// erased them too: `in_turn` went FALSE while C2 and S remained owed —
    /// the sole mid-turn gate admitted a rollback wipe mid-generation. With a
    /// LIVE candidate the interrupt retires EXACTLY the front compact.
    ///
    ///   A → C1 → C2 → S → A's pair (A retires) → C1 compacting (candidate) →
    ///   INTERRUPT (cancels C1 only — the gate STAYS CLOSED for C2 + S) → C2's
    ///   manual boundary + pair (C2 retires; S still owed) → S's pair (gate
    ///   OPENS exactly here).
    #[tokio::test]
    async fn an_interrupt_inside_the_compact_candidate_window_retires_only_the_interrupted_compact()
    {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-icand")).await;
        let created = await_claude_created(&mut rx, "req-icand").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await; // A
        st.handle_compact(compact_msg(&session_id, None)).await; // C1
        st.handle_compact(compact_msg(&session_id, None)).await; // C2
        st.handle_send(send_msg(&session_id, "turn two")).await; // S

        // A's pair retires A: [C1, C2, S] all queued, running empty.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;

        // C1 starts compacting (candidate pending — the boundary lands later).
        inject_raw_send(&st, &session_id, "__emit_compacting__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;

        // The interrupt cancels C1 — C2 and S provably survive provider-side:
        // the gate MUST stay closed.
        st.handle_interrupt(interrupt_msg(&session_id)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "ep3-r2 F1: the interrupt cancelled ONLY the in-flight C1 — C2 and S are still owed"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-icand-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "ep3-r2 F1: rollback stays refused while C2/S remain owed"
        );

        // C2 then runs for real: status marks its candidate, the manual
        // boundary promotes it, and its own pair retires it; S is still owed
        // behind it — the gate holds.
        inject_raw_send(&st, &session_id, "__emit_compacting__").await;
        inject_raw_send(&st, &session_id, "__emit_compact_boundary_manual__").await;
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(in_turn_of(&st, &session_id).await, "S still owed behind C2");

        // S's own pair: the gate OPENS at the last owed edge, exactly.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-icand-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "NOTHING_TO_UNDO",
            "ep3-r2 F1: the gate opened at S's own edge — never early, never wedged: {frames:?}"
        );
        drop(env);
    }

    /// Focused-review ep3-r2 F2 (provider-session death behind a live stdout):
    /// the sidecar's consumeStream finally DELETES the JS session while the
    /// long-lived stdout stays open; a later send arms the tracker and is then
    /// answered by a lone signed `sdk.error{sessionNotFound:true}` — no result,
    /// no idle, no EOF ever follows. The queue-only clear wedged `in_turn`
    /// forever (BUSY_TURN for every later undo). The signed not-found error
    /// retires the WHOLE tracker: the ops provably cannot complete.
    #[tokio::test]
    async fn a_signed_session_not_found_error_opens_the_gate_instead_of_wedging_it() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-notfound")).await;
        let created = await_claude_created(&mut rx, "req-notfound").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        // One completed turn (armed then retired by its pair) — the gate is open.
        st.handle_send(send_msg(&session_id, "turn one")).await;
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        await_in_turn(&st, &session_id, false).await;

        // The provider-side session DIES (stream end deletes it) — stdout stays
        // open, nothing announces it yet.
        inject_raw_send(&st, &session_id, "__drop_session__").await;

        // A new send ARMS the tracker; the fake answers with the signed
        // not-found error and NOTHING after.
        st.handle_send(send_msg(&session_id, "turn two")).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "the send arms the gate before the death surfaces"
        );

        // The signed not-found error must retire the whole tracker — pre-fix
        // the queue-only clear left `running` armed forever (the BUSY wedge).
        await_in_turn(&st, &session_id, false).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-nf-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_ne!(
            frames[0]["event"]["code"], "BUSY_TURN",
            "ep3-r2 F2: the gate is open after the provider session's death — never wedged: {frames:?}"
        );
        drop(env);
    }

    /// F2 disarm case (b) — the FIFO-DROP proof, modeled on the strict queue
    /// order: prior turn running + compact queued (armed) + prior turn's
    /// result consumed + a fresh send accepted + the SEND's terminal edge with
    /// NO observed compacting anywhere since the arm. FIFO-strictly, that edge
    /// can only be the garlanded send's own terminal — and a compact that had
    /// run ahead of it would have been observed compacting first. So the
    /// queued compact provably never ran (provider-dropped): the trackers
    /// disarm and the send's edge ends the busy truth (the gate reopens).
    #[tokio::test]
    async fn queued_compact_disarms_on_the_garlanded_sends_result_without_observed_compacting() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-qproof")).await;
        let created = await_claude_created(&mut rx, "req-qproof").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await;
        assert!(in_turn_of(&st, &session_id).await);
        st.handle_compact(compact_msg(&session_id, None)).await;

        // The prior turn's result: consumed as the prior turn's — gate holds.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "the armed window holds through the prior turn's result"
        );

        // The garlanded send, then ITS terminal edge with NO compacting
        // observed since the arm: the FIFO-drop proof fires — the queued
        // compact provably never ran, busy releases with the send's edge.
        st.handle_send(send_msg(&session_id, "turn three")).await;
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        await_in_turn(&st, &session_id, false).await;
        let (sink2, captured2) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qproof-1", RollbackDirection::Undo),
            sink2,
        )
        .await;
        assert_eq!(
            captured_json(&captured2)[0]["event"]["code"],
            "NOTHING_TO_UNDO",
            "the dropped-compact proof released the gate with the send's terminal edge"
        );
        drop(env);
    }

    /// F2 disarm case (c): an in-stream `sdk.error` frame disarms the pending
    /// compact (the provider errored — the queued compact provably never
    /// arrives as its own turn); the error itself never clears `in_turn`
    /// (fail-closed), so the NEXT terminal edge ends the busy truth.
    #[tokio::test]
    async fn queued_compact_pending_disarms_on_sdk_error() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-qdisarm")).await;
        let created = await_claude_created(&mut rx, "req-qdisarm").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        // Fold the create-time idle BEFORE any turn starts (no stale clear edge).
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await;
        assert!(in_turn_of(&st, &session_id).await);
        st.handle_compact(compact_msg(&session_id, None)).await;
        inject_raw_send(&st, &session_id, "__emit_error__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "sdk.error is NOT itself an in_turn clear edge (fail-closed)"
        );
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        await_in_turn(&st, &session_id, false).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qdisarm-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "NOTHING_TO_UNDO",
            "the sdk.error disarmed the pending compact — the next terminal edge reopened the gate"
        );
        drop(env);
    }

    /// F2's interposition window, FIFO-strict: a send accepted BETWEEN the arm
    /// and the prior turn's result queues BEHIND the compact on the provider
    /// — its acceptance (the deleted belt) and even the PRIOR turn's result
    /// must not open the gate: the compact and the send are BOTH still queued.
    /// (The pre-F2 belt disarmed at the send, so the prior result then cleared
    /// the busy truth with the compact still queued — the review's repro for
    /// "rollback mid-compact".) ep1-r3 F1: with the send still owed after the
    /// compact, the gate survives the compact's own observed terminal edge too
    /// and opens only at the garlanded send's own terminal edge.
    #[tokio::test]
    async fn a_send_between_the_arm_and_the_prior_result_keeps_the_gate_closed_through_both() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-qinterpose")).await;
        let created = await_claude_created(&mut rx, "req-qinterpose").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await;
        assert!(in_turn_of(&st, &session_id).await);
        st.handle_compact(compact_msg(&session_id, None)).await;
        // IMMEDIATELY after the arm, before ANY terminal edge: the send.
        st.handle_send(send_msg(&session_id, "turn two")).await;

        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qinterpose-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "no terminal edge yet — the gate is closed beyond doubt"
        );

        // The PRIOR turn's result arrives. Both the compact and the send are
        // STILL queued behind it — rollback must still refuse.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qinterpose-2", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "FIFO-strict: compact + send are still queued behind the prior turn's result — the gate holds"
        );
        assert_eq!(
            env.spawn_count(),
            1,
            "no teardown traffic from any refused attempt"
        );

        // The compact's observed run + terminal edge: ep1-r3 F1 — the gate
        // SURVIVES here (the garlanded send "turn two" is still generating);
        // only the send's own terminal edge releases it.
        inject_raw_send(&st, &session_id, "__emit_compacting__").await;
        inject_raw_send(&st, &session_id, "__emit_compact_boundary_manual__").await;
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "F1: the compact's observed terminal edge never releases the gate with a garlanded send owed"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qinterpose-3", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "F1: the garlanded send owns the turn past the compact's terminal edge — the gate holds"
        );
        assert_eq!(
            env.spawn_count(),
            1,
            "zero teardown traffic while the garlanded send generates"
        );

        // The garlanded send's OWN terminal edge reopens the gate.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        await_in_turn(&st, &session_id, false).await;
        let (sink2, captured2) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qinterpose-4", RollbackDirection::Undo),
            sink2,
        )
        .await;
        assert_eq!(
            captured_json(&captured2)[0]["event"]["code"],
            "NOTHING_TO_UNDO",
            "the garlanded send's own terminal edge released the gate"
        );
        drop(env);
    }

    /// Focused-review ep1-r5 F1 (queued-compact CARDINALITY): TWO `/compact`s
    /// armed behind the same running turn are TWO distinct queued ops —
    /// SUPERSEDED in ep3-r3 F1 (see the test body), which replaced the
    /// hold-closed-until-every-edge rule with provable-quiescence absorption.
    /// Queue: turn A running → C₁ queued → C₂ queued.
    /// compact's run carries its OWN start evidence (the compacting candidate),
    /// the queue's UNPROMOTED compacts are provably quiescent — nothing running,
    /// no candidate pending, and (critically) no Turn owed. The rollback gate
    /// ADMITS there and absorbs the compact debt (the teardown discards the
    /// unstarted provider inputs; see [`absorb_unstarted_compact_debt`]). The
    /// pre-fix shape wedged busy FOREVER on exactly this debt whenever the
    /// front-entry promotion consumed a LATER compact's evidence (a dropped
    /// compact ahead of a running one — in-band indistinguishable, so the debt
    /// must settle at the gate, not the attribution). A turnaround edge replay
    /// after absorption folds as benign noise (boundary-promotion on an empty
    /// queue promotes nothing; the pair-skip consumes the trailing idle).
    #[tokio::test]
    async fn two_queued_compacts_are_provably_quiescent_and_absorb_at_the_rollback_gate() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-q2compact")).await;
        let created = await_claude_created(&mut rx, "req-q2compact").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        // Turn A running; BOTH compacts queue behind it.
        st.handle_send(send_msg(&session_id, "turn one")).await;
        assert!(in_turn_of(&st, &session_id).await, "turn A is running");
        st.handle_compact(compact_msg(&session_id, None)).await;
        st.handle_compact(compact_msg(&session_id, None)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "the running turn holds the busy truth"
        );

        // A's terminal edge retires A: [C1, C2] queued, nothing running, no
        // candidate — the provider is provably quiescent: the rollback ADMITS
        // and absorbs both compacts (their unstarted inputs die with the
        // teardown; a stray loner races into the signed session-not-found
        // fence).
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "both compacts still owed past A's edge"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-q2c-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "NOTHING_TO_UNDO",
            "ep3-r3 F1: provably-quiescent compact debt absorbs at the gate — never wedged: {frames:?}"
        );
        assert!(
            !in_turn_of(&st, &session_id).await,
            "the absorbed debt leaves the gate open"
        );

        // The absorbed entries' later provider evidence (had either actually
        // run against the stream before the teardown) RE-ARMS the gate for the
        // duration of that proven run — and its OWN terminal edge re-opens it.
        inject_raw_send(&st, &session_id, "__emit_compacting__").await;
        inject_raw_send(&st, &session_id, "__emit_compact_boundary_manual__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "a revived absorbed compact RE-ARMS the gate at its proven start"
        );
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "the revived compact's edge retires IT — the second absorbed entry still owes (tracker-truth busy)"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-q2c-2", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "NOTHING_TO_UNDO",
            "the remnant survivor absorbs at the gate again — optimistic admit, entry survives"
        );
        assert!(
            !in_turn_of(&st, &session_id).await,
            "the gate stays open for quiescent compact-only debt"
        );
        drop(env);
    }

    /// Focused-review ep1-r5 F1 (garlanded-send CARDINALITY): TWO sends
    /// accepted behind an armed compact owe TWO terminal edges. The one-slot
    /// bool garlanded tracker kept busy through the compact's own terminal
    /// edge but released at the FIRST garlanded send's edge — while S₂ was
    /// still generating (a rollback admitted there forks/tears down S₂
    /// mid-turn).
    ///
    /// Queue: turn A running → C queued → S₁ queued → S₂ queued.
    ///   1. A's terminal edge: the arm's structural prior edge — HOLDS;
    ///   2. C's observed compacting + OWN terminal edge retires C — HOLDS
    ///      (S₁ and S₂ still owe their edges);
    ///   3. S₁'s terminal edge: one garlanded send remains — HOLDS;
    ///   4. S₂'s terminal edge: the gate RELEASES exactly there.
    #[tokio::test]
    async fn a_compact_with_two_garlanded_sends_holds_busy_until_the_last_sends_terminal_edge() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-q2sends")).await;
        let created = await_claude_created(&mut rx, "req-q2sends").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await; // A
        st.handle_compact(compact_msg(&session_id, None)).await; // C
        st.handle_send(send_msg(&session_id, "turn two")).await; // S₁
        st.handle_send(send_msg(&session_id, "turn three")).await; // S₂

        // (1) A's terminal edge: the arm's owed prior edge — C, S₁, S₂ are
        // ALL still queued behind it.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-q2s-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "compact + both sends still queued behind the prior turn's edge"
        );

        // (2) C's observed run + OWN terminal edge: retires C — S₁ and S₂
        // still owe their terminal edges, so the gate HOLDS.
        inject_raw_send(&st, &session_id, "__emit_compacting__").await;
        inject_raw_send(&st, &session_id, "__emit_compact_boundary_manual__").await;
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "the compact's terminal edge never releases the gate with two garlanded sends owed"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-q2s-2", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "BUSY_TURN",
            "S₁ and S₂ still owed past the compact's terminal edge: {frames:?}"
        );
        assert_eq!(
            env.spawn_count(),
            1,
            "zero teardown traffic while the garlanded sends generate"
        );

        // (3) ep1-r5 F1 CORE: S₁'s terminal edge is NOT the last owed edge —
        // S₂ is still generating, so the gate MUST stay closed here (the
        // one-slot garlanded bit released at S₁'s edge).
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "S₁'s terminal edge never releases the gate — S₂ is still generating"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-q2s-3", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "BUSY_TURN",
            "S₂ still generating past S₁'s terminal edge: {frames:?}"
        );
        assert_eq!(env.spawn_count(), 1, "zero teardown traffic while S₂ runs");
        assert!(
            st.sessions.lock().await.contains_key(&session_id),
            "no teardown"
        );

        // (4) S₂'s OWN terminal edge: the gate releases EXACTLY here.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        await_in_turn(&st, &session_id, false).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-q2s-4", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "NOTHING_TO_UNDO",
            "the gate released exactly at the last garlanded send's terminal edge: {frames:?}"
        );
        drop(env);
    }

    /// Focused-review ep2-r1 F1 (the PAIRED terminal frames): the supported
    /// Claude/Kilroy protocol emits `sdk.result` AND a trailing
    /// `sdk.status:idle` for ONE turn (both provider fixtures emit exactly that
    /// pair; the real sidecar's consumeStream finally emits the trailing idle).
    /// The trailing idle is the SAME turn's closing punctuation, never a new
    /// op's edge — folding it through attribution double-counts the turn. The
    /// repair-delta fold missed this: with turn A running and C+S queued
    /// behind it, A's result consumed the prior debt and then A's TRAILING IDLE
    /// was attributed to the garlanded send (the FIFO-drop branch), clearing
    /// the compact/send trackers and `in_turn` while C and S were still
    /// queued — rollback passed the sole busy gate mid-queue.
    ///
    /// Queue: A running → C queued → S queued. EVERY turn ends with its pair
    /// (result then idle).
    ///   1. A's pair: the result folds as the owed prior edge; the trailing
    ///      idle is pair-skipped (NEVER the garlanded drop proof) — the gate
    ///      HOLDS;
    ///   2. C's observed compacting + result + trailing idle retires C — the
    ///      gate HOLDS (S still owed);
    ///   3. S's result releases the gate (its trailing idle is skipped too).
    #[tokio::test]
    async fn a_turns_trailing_idle_is_pair_skipped_never_attributed_to_queued_ops() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-qpair")).await;
        let created = await_claude_created(&mut rx, "req-qpair").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await; // A
        st.handle_compact(compact_msg(&session_id, None)).await; // C
        st.handle_send(send_msg(&session_id, "turn two")).await; // S

        // (1) A's pair — the result consumes the ONE owed prior edge; the
        // trailing idle is C's/S's edges' queue-mate punctuation, NEVER theirs.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "A's trailing idle is pair-punctuation, not the garlanded drop proof — the compact and send are STILL queued"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qpair-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "BUSY_TURN",
            "ep2-r1 F1: A's trailing idle must not release the gate over queued C/S: {frames:?}"
        );
        assert_eq!(
            env.spawn_count(),
            1,
            "zero teardown from the refused attempt"
        );

        // (2) C observably runs and its pair lands: retires C — the gate HOLDS
        // (S is generating behind it).
        inject_raw_send(&st, &session_id, "__emit_compacting__").await;
        inject_raw_send(&st, &session_id, "__emit_compact_boundary_manual__").await;
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "C's pair retires C only — S's own terminal edge is still owed"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qpair-2", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "the garlanded send is still owed after C's pair — the gate holds"
        );

        // (3) S's pair: the result is the garlanded tail's last owed edge — the
        // gate releases here; the trailing idle folds nothing further.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        await_in_turn(&st, &session_id, false).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qpair-3", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "NOTHING_TO_UNDO",
            "the gate released exactly at S's own terminal edge: {frames:?}"
        );
        drop(env);
    }

    /// Focused-review ep2-r1 F2 (the stale prior-edge debt): a SECOND compact
    /// armed while the FIRST compact is mid-compaction owes C₁'s terminal edge
    /// (the one op active at its arm). When C₁'s terminal lands it is C₁'s OWN
    /// edge (the observed-compacting branch) — yet that edge ALSO settles C₂'s
    /// debt: miss that and, with C₂ subsequently provider-DROPPED while a
    /// garlanded send completes, the send's edge is swallowed consuming the
    /// stale debt, leaving every tracker set forever with no edge left to
    /// retire them — the pane wedges BUSY and rollback is disabled
    /// permanently.
    ///
    /// Queue: A completed → C₁ mid-compaction → C₂ armed (owes C₁'s edge) → S
    /// garlanded → C₁'s result lands (C₂'s debt settled redundantly with C₁'s
    /// retirement) → C₂ provider-dropped (never observed compacting) → S's
    /// result is the drop proof: extinguishes C₂ AND releases the gate.
    #[tokio::test]
    async fn arming_a_compact_during_an_active_compaction_settles_its_debt_at_that_compactions_edge(
    ) {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-qstale")).await;
        let created = await_claude_created(&mut rx, "req-qstale").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await; // A
        st.handle_compact(compact_msg(&session_id, None)).await; // C₁ queued
                                                                 // A's pair lands first: the result settles the arm's prior debt; A's
                                                                 // trailing idle is pair-skipped.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;

        // C₁ observably starts; C₂ arms while C₁ is MID-COMPACTION — it owes
        // C₁'s terminal edge; S queues behind BOTH compacts.
        inject_raw_send(&st, &session_id, "__emit_compacting__").await;
        inject_raw_send(&st, &session_id, "__emit_compact_boundary_manual__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        st.handle_compact(compact_msg(&session_id, None)).await; // C₂ armed
        st.handle_send(send_msg(&session_id, "turn two")).await; // S garlanded

        // C₁'s pair: retires C₁ AND settles C₂'s owed edge — C₂ remains the
        // sole queued compact; S is still owed. The gate HOLDS throughout.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "C₁'s edge retired C₁ and settled C₂'s debt — C₂ and S still owe edges"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qstale-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "C₂ queued + S owed — the gate holds past C₁'s pair"
        );

        // C₂ is provider-DROPPED (never observed compacting); S's pair lands:
        // the result is the FIFO-drop proof (C₂ provably never ran), releasing
        // at the LAST garlanded edge; the trailing idle is pair-skipped.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        await_in_turn(&st, &session_id, false).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qstale-2", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"],
            "NOTHING_TO_UNDO",
            "ep2-r1 F2: S's edge is the drop proof and releases — no stale debt may swallow it: {frames:?}"
        );
        drop(env);
    }

    /// Focused-review ep3-r5 F2 (publication contract): the candidate mark and
    /// its gate-visible `in_turn` boost publish under ONE critical section — a
    /// rollback probe that reads `in_turn` first and refuses to consult the
    /// tracker on a false read can therefore never slip past a live candidate.
    /// (The torn two-step shape is not statically reachable; this pins the
    /// end-state contract the gate's decision rule leans on.)
    #[test]
    fn compact_candidate_publication_is_atomic_under_the_tracker_lock() {
        let in_turn = std::sync::atomic::AtomicBool::new(false);
        let tracker = std::sync::Mutex::new(TurnTracker::default());
        mark_compact_candidate(&in_turn, &tracker);
        assert!(tracker.lock().expect("turn tracker lock").compact_candidate);
        assert!(in_turn.load(std::sync::atomic::Ordering::SeqCst));
        // The consume side unwinds the same pair under the same lock.
        confirm_compact_candidate(&in_turn, &tracker, false); // auto boundary
        assert!(!tracker.lock().expect("turn tracker lock").compact_candidate);
        assert!(!in_turn.load(std::sync::atomic::Ordering::SeqCst));
    }

    /// Focused-review ep3-r5 F1 (the admit→teardown window): the gate's
    /// quiescence-proof is consulted ONCE at admission; the rollback handler
    /// then runs transcript I/O before tearing the sidecar down, and the
    /// consumer task folds evidence WITHOUT the session turn lock — a compact
    /// armed just before admission can START mid-handler (its status folded,
    /// candidate observed), and pre-fix the complete-determined handler tore
    /// the sidecar down mid-compaction anyway (the sole busy gate defeated).
    /// The handler now RECHECKS the tracker at the point of no return: revived
    /// busy truth aborts the rollback with BUSY_TURN and a compensating ledger
    /// rewrite, with zero teardown traffic.
    ///
    /// Choreography: C1 armed (running) → C2 queued → C1 settles (fold retires
    /// it; C2 quiescent) → rollback admitted at the gate (absorb, C2 survives)
    /// → parked in the admit→teardown window (test knob) → C2's compacting
    /// status folds (the candidate marks mid-flight compaction) → the recheck
    /// ABORTS the rollback.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_compaction_starting_mid_rollback_aborts_at_the_pre_teardown_recheck() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        std::env::set_var("FRESHELL_TEST_CLAUDE_ROLLBACK_PRE_TEARDOWN_MS", "400");
        write_rollback_transcript(home.path(), "dur-midcomp", &two_turn_transcript());
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink_impl.clone());
        let _stdin_log = insert_rollback_fixture_session(&st, "dur-midcomp", "dur-midcomp").await;

        // Arm two compacts: C1 takes the running slot, C2 queues behind.
        st.handle_compact(compact_msg("dur-midcomp", None)).await;
        st.handle_compact(compact_msg("dur-midcomp", None)).await;
        let (in_turn, turn_tracker) = busy_tracker_arcs(&st, "dur-midcomp").await;
        assert!(in_turn.load(std::sync::atomic::Ordering::SeqCst));

        // C1's own terminal edge (its compacted run settled): retires C1; C2
        // remains queued-but-quiescent.
        fold_terminal_edge(&in_turn, &turn_tracker);
        assert!(
            in_turn.load(std::sync::atomic::Ordering::SeqCst),
            "C2's debt keeps the busy truth"
        );

        let (sink, captured) = capturing_sink();
        let rollback_driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_rollback(
                    rollback_op("dur-midcomp", "rb-midcomp-1", RollbackDirection::Undo),
                    sink,
                )
                .await;
            })
        };
        // Let the rollback pass the gate (absorb admits the quiescent C2) and
        // park in the admit→teardown window — then C2's compaction STARTS.
        tokio::time::sleep(Duration::from_millis(150)).await;
        mark_compact_candidate(&in_turn, &turn_tracker);
        rollback_driver.await.expect("rollback task");

        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"],
            "BUSY_TURN",
            "ep3-r5 F1: a compaction starting mid-handler aborts the rollback at the pre-teardown recheck: {frames:?}"
        );
        assert_eq!(
            env.spawn_count(),
            0,
            "zero fork-create traffic — the teardown never engaged"
        );
        assert!(
            st.sessions.lock().await.contains_key("dur-midcomp"),
            "no teardown"
        );
        assert!(
            sink_impl.load_rollback("claude", "dur-midcomp").is_none(),
            "ep4-r6 F5: no pre-op record existed, so the compensation DELETED the pre-write row"
        );
        std::env::remove_var("FRESHELL_TEST_CLAUDE_ROLLBACK_PRE_TEARDOWN_MS");
        drop(env);
    }

    /// Focused-review ep3-r4 F1 (the absorb-revival STATUS window): SURVIVE-
    /// absorb leaves the debt queued with the gate open; when an absorbed
    /// compact actually starts, its bare `sdk.status:compacting` marks the
    /// candidate — but pre-fix NOTHING re-armed `in_turn` until the manual
    /// boundary arrived, so the whole status→boundary interval (and a status
    /// arriving a beat AFTER a probe's admission check) let a rollback proceed
    /// while the provider compacted mid-flight. The status marks the candidate
    /// AND closes the gate (in_turn=true); consumption at the boundary either
    /// promotes (gate stays held) or recomputes the owed-debt busy truth.
    ///
    ///   A → C1 → C2 → A's pair → absorb probe (admitted; C1+C2 survive; gate
    ///   open) → C1's STATUS lands (candidate: the gate RE-CLOSES immediately)
    ///   → manual boundary (C1 promoted; held) → C1's pair (C1 retires; C2
    ///   owed) → absorb probe (admitted again) — the gate never rides the
    ///   proven-running interval.
    #[tokio::test]
    async fn a_revived_absorbed_compact_closes_the_gate_at_its_status_frame_not_just_its_boundary()
    {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-revive")).await;
        let created = await_claude_created(&mut rx, "req-revive").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await; // A
        st.handle_compact(compact_msg(&session_id, None)).await; // C1
        st.handle_compact(compact_msg(&session_id, None)).await; // C2

        // A's pair retires A: [C1, C2] queued, nothing running.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;

        // Provably-quiescent debt: the gate ADMITS (entries survive).
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-rev-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "NOTHING_TO_UNDO",
            "quiescent compact debt admits"
        );
        assert!(
            !in_turn_of(&st, &session_id).await,
            "the absorb opened the gate"
        );

        // C1 now actually starts: the STATUS alone must RE-CLOSE the gate (the
        // candidate is provable in-flight compaction — mid-compaction rollback
        // is never admissible).
        inject_raw_send(&st, &session_id, "__emit_compacting__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-rev-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "ep3-r4 F1: the revived compact's status frame holds the gate — never admit mid-compaction"
        );
        assert!(in_turn_of(&st, &session_id).await);

        // C1's boundary promotes it (still held); its own pair retires it; C2
        // is owed; the gate admits at the next absorb probe, quiescent again.
        inject_raw_send(&st, &session_id, "__emit_compact_boundary_manual__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "promotion holds the closed gate through the boundary"
        );
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "C2's surviving debt keeps the tracker busy"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-rev-2", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "NOTHING_TO_UNDO",
            "the remnant survivor absorbs again — quiescent debt settles only at the gate"
        );
        drop(env);
    }

    /// Focused-review ep3-r3 F1 (dropped compact ahead of a RUNNING compact):
    /// the wire carries no compaction-op identity — the manual boundary always
    /// promotes the FRONT queued compact, so [C1 silently dropped, C2 runs] is
    /// in-band indistinguishable from [C1 runs, C2 queued]: C2's whole evidence
    /// set is consumed by the phantom C1 entry, and C2's own entry remains as
    /// debt with NO further evidence — the trailing idle is pair-skipped, so
    /// `in_turn` holds forever and every later undo/redo is refused BUSY_TURN
    /// ("unavailable until another submission, which would itself destroy
    /// redo"). The gate now admits when the debt is provably quiescent:
    /// nothing running, no live candidate, and no Turn owed — unpromoted
    /// compacts have not started (their runs raise the candidate FIRST), and
    /// the rollback teardown discards their provider-side inputs.
    ///
    ///   A → C1 → C2 → A's pair (A retires) → C1 dropped (never evidences) →
    ///   C2 runs (status + manual boundary promotes the phantom C1) → C2's
    ///   result + paired idle (the phantom retires; C2's entry remains) →
    ///   the rollback gate OPENS on admission: the provably-quiescent debt
    ///   absorbs (both in a single atomic decision).
    #[tokio::test]
    async fn a_dropped_compacts_remnant_debt_absorbs_at_the_gate_after_the_running_compact_retires_it(
    ) {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-dropahead")).await;
        let created = await_claude_created(&mut rx, "req-dropahead").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await; // A
        st.handle_compact(compact_msg(&session_id, None)).await; // C1
        st.handle_compact(compact_msg(&session_id, None)).await; // C2

        // A's pair retires A: [C1, C2] queued, running empty.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(in_turn_of(&st, &session_id).await, "both compacts owed");

        // C1 is provider-DROPPED (never evidences). C2 RUNS: its status marks
        // the candidate and its manual boundary promotes the FRONT — the
        // phantom C1. C2's pair lands: the result retires running (phantom C1);
        // the trailing idle is deliberately pair-skipped (ep2-r1 F1). C2's own
        // entry is the surviving dead debt.
        inject_raw_send(&st, &session_id, "__emit_compacting__").await;
        inject_raw_send(&st, &session_id, "__emit_compact_boundary_manual__").await;
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;

        // The debt is provably quiescent (nothing running, no candidate, no
        // Turn owed): the rollback gate ADMITS and absorbs — never wedges busy.
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-dropahead-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "NOTHING_TO_UNDO",
            "ep3-r3 F1: the dropped compact's remnant debt absorbed at the gate — rollback proceeds, never wedged: {frames:?}"
        );
        assert!(
            !in_turn_of(&st, &session_id).await,
            "the absorbed debt leaves the busy truth open"
        );
        drop(env);
    }

    /// Focused-review ep2-r2 F1 (the INTERLEAVED queue): the FIFO-drop proof may
    /// extinguish ONLY compacts queued AHEAD of the evidenced send — a compact
    /// queued BEHIND it remains genuinely queued and survives. Bare op-counts
    /// cannot express that order: with queue [C1, S1, C2] and C1
    /// provider-dropped (never observed compacting), S1's terminal edge fired
    /// the drop branch and zeroed the whole compact count — C2 included —
    /// releasing the gate while C2 could still run. Rollback passed the sole
    /// busy gate with a compact mid-queue.
    ///
    /// Queue: A running → C1 → S1 → C2 (C2 queued BEHIND the send). C1 never
    /// observed (silent provider drop); C2 then runs for real.
    #[tokio::test]
    async fn a_dropped_compact_extinguishes_only_compacts_ahead_of_the_evidencing_send() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-qinterleave")).await;
        let created = await_claude_created(&mut rx, "req-qinterleave").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await; // A
        st.handle_compact(compact_msg(&session_id, None)).await; // C1
        st.handle_send(send_msg(&session_id, "turn two")).await; // S1
        st.handle_compact(compact_msg(&session_id, None)).await; // C2 (behind S1)

        // A's pair: the result retires A; the trailing idle is pair-skipped.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(in_turn_of(&st, &session_id).await, "three ops still queued");

        // C1 is provider-DROPPED (never observed); S1's pair lands: the result
        // evidences C1's drop and retires S1 — but C2 is queued BEHIND S1 and
        // may still run, so the busy gate MUST stay closed past S1's edge.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "S1's edge retires C1's drop + S1 only — C2 is still queued behind the send"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qint-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"],
            "NOTHING_TO_UNDO",
            "ep3-r3 F1: the surviving queued-behind compact is provably quiescent (no candidate) — the gate ADMITS its debt optimistically, and the entry SURVIVES (its proven start re-closes the gate): {frames:?}"
        );
        assert!(
            st.sessions.lock().await.contains_key(&session_id),
            "no teardown"
        );

        // C2 then runs for real: its observed compacting + confirmed-manual
        // boundary → pair lands — the gate releases EXACTLY at C2's own
        // terminal edge (never earlier).
        inject_raw_send(&st, &session_id, "__emit_compacting__").await;
        inject_raw_send(&st, &session_id, "__emit_compact_boundary_manual__").await;
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        await_in_turn(&st, &session_id, false).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qint-2", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "NOTHING_TO_UNDO",
            "the gate released exactly at C2's own terminal edge: {frames:?}"
        );
        drop(env);
    }

    /// Focused-review ep2-r4 (interrupt inside the drop window): with the
    /// running slot empty and a queue [C1 (dropped silently — NEVER promoted),
    /// B (the de-facto active turn)], the queue-front retirement rule popped
    /// the FRONT — the COMPACT — off the tracker and left the interrupted B
    /// stranded forever (no result frame exists for an interrupted turn):
    /// `in_turn` held and every undo/redo was refused BUSY_TURN from then on.
    /// The interrupt retires the op ACTUALLY in flight — the de-facto ACTIVE
    /// queued op — and a Turn can only be de-facto active with every op ahead
    /// of it already retired-or-dropped: those ahead compacts' silence at the
    /// live turn's generation IS the drop evidence, absorbed here.
    ///
    ///   A running → C1 queued → B queued → A's pair → B generating NOW →
    ///   interrupt. Aftermath: NOTHING stands — the gate opens and STAYS sized
    ///   (a follow-up turn cycles fully clean).
    #[tokio::test]
    async fn interrupting_the_active_turn_absorbs_ahead_queued_silently_dropped_compacts() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-qdropint")).await;
        let created = await_claude_created(&mut rx, "req-qdropint").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await; // A
        st.handle_compact(compact_msg(&session_id, None)).await; // C1
        st.handle_send(send_msg(&session_id, "turn two")).await; // B

        // A's pair retires the running op; C1's compacting frame NEVER came —
        // B generates (the drop-evidence window). The gate is closed.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "C1 believed queued + B outstanding — the gate is closed pre-interrupt"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qdi-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "pre-interrupt the gate is closed beyond doubt"
        );

        // Interrupt the ACTIVE turn (B): its entry AND C1's never-evidenced
        // drop retire together — nothing remains to wedge the gate.
        st.handle_interrupt(interrupt_msg(&session_id)).await;
        // ep4-r1 F1: retirement waits for the sidecar's awaited settle ack.
        await_in_turn(&st, &session_id, false).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qdi-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "NOTHING_TO_UNDO",
            "ep2-r4 F1: the gate opened exactly at the interrupt and stays truthful: {frames:?}"
        );

        // No-residue proof: a fresh turn's pair cycles the tracker fully clean.
        st.handle_send(send_msg(&session_id, "turn three")).await;
        assert!(in_turn_of(&st, &session_id).await);
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        await_in_turn(&st, &session_id, false).await;
        drop(env);
    }

    /// Focused-review ep2-r3 (queue-advanced interrupt): queued TURNS are never
    /// OBSERVED promoted (only compacts promote via the compacting frame), so
    /// once the prior op's edge frees the `running` slot, the queue FRONT is the
    /// de-facto active turn. Interrupting THAT turn produces no result frame —
    /// nothing retires its queued entry afterward, so an interrupt that only
    /// cleared the `running` slot left the entry there forever: `in_turn` stayed
    /// true and the sole mid-turn gate rejected undo/redo permanently. The
    /// interrupt retires the running slot OR the queue FRONT (the op actually in
    /// flight) — never the still-queued ops behind it.
    ///
    /// A running → B queued → A's pair retires A → B starts → interrupt B.
    #[tokio::test]
    async fn interrupting_a_queue_advanced_turn_releases_the_gate() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-qadv")).await;
        let created = await_claude_created(&mut rx, "req-qadv").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await; // A
        st.handle_send(send_msg(&session_id, "turn two")).await; // B queued

        // A's pair retires the running op; B (the queue front) is now the
        // de-facto active turn — the gate stays closed (B owes its own edge).
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "B advanced from the queue — the gate holds for its own edge"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qadv-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "B is in flight — the gate is closed pre-interrupt"
        );

        // Interrupt B (no result frame exists for it — the interrupt IS its
        // busy-clear edge): the gate opens here, permanently.
        st.handle_interrupt(interrupt_msg(&session_id)).await;
        // ep4-r1 F1: retirement waits for the sidecar's awaited settle ack.
        await_in_turn(&st, &session_id, false).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qadv-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "NOTHING_TO_UNDO",
            "the gate released with the interrupt — never wedged: {frames:?}"
        );
        drop(env);
    }

    /// Focused-review ep2-r4 (interrupt with a never-promoted compact between):
    /// [A running → C1 queued → B queued → A retires → B generates with C1
    /// silently DROPPED ahead of it (never promoted)]: the interrupted op is B.
    /// The naive queue-front retirement removed C1 instead — stranding B (no
    /// result frame exists for an interrupted turn) and wedging the sole
    /// mid-turn gate FOREVER (BUSY_TURN for every later undo/redo). The
    /// interrupt retires the OLDEST QUEUED TURN; the compacts ahead of it were
    /// provably dropped by B's own generation (C1 promoted would have been
    /// observed compacting before B's activity), so they absorb into the same
    /// retirement.
    #[tokio::test]
    async fn interrupting_a_turn_behind_a_silently_dropped_compact_retires_the_turn_not_the_compact(
    ) {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-qdropabs")).await;
        let created = await_claude_created(&mut rx, "req-qdropabs").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await; // A
        st.handle_compact(compact_msg(&session_id, None)).await; // C1
        st.handle_send(send_msg(&session_id, "turn two")).await; // B

        // A's pair retires A. [C1 (never promoted — dropped), B (now the
        // de-facto active turn)] remains; the gate is closed.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(in_turn_of(&st, &session_id).await, "C1(dropped) + B owed");
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qda-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "pre-interrupt: C1 + B are owed"
        );

        // Interrupt: retires B (the op actually in flight) and absorbs C1's
        // never-evidenced drop. The gate OPENS — the pane must never wedge
        // permanently busy over an interrupted turn.
        st.handle_interrupt(interrupt_msg(&session_id)).await;
        // ep4-r1 F1: retirement waits for the sidecar's awaited settle ack (the
        // interrupt clears B AND absorbs the never-evidenced drop).
        await_in_turn(&st, &session_id, false).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qda-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "NOTHING_TO_UNDO",
            "ep2-r4 F1: the gate opened at the interrupt — never wedged: {frames:?}"
        );
        drop(env);
    }

    /// Focused-review ep2-r2 F2 (interrupt ≠ drain): a completed
    /// `handle_interrupt` ends the ACTIVE turn's busy truth, but
    /// `query.interrupt()` does not drain the sidecar's FIFO input queue — a
    /// queued compact AND a queued send behind it both still run. The counter
    /// gate read `in_turn || queued_compacts > 0` but NEITHER counted a queued
    /// SEND: interrupting A with [C, S] behind it, then letting C complete,
    /// left in_turn=false, queued=0, and S still generating — the gate accepted
    /// rollback mid-send.
    ///
    /// Queue: A running → C → S; A is interrupted mid-turn; then C runs for
    /// real and S generates — the gate stays closed until S's own edge.
    #[tokio::test]
    async fn an_interrupt_keeps_the_gate_closed_until_the_queued_compact_and_send_both_finish() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-qirq")).await;
        let created = await_claude_created(&mut rx, "req-qirq").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await; // A
        st.handle_compact(compact_msg(&session_id, None)).await; // C
        st.handle_send(send_msg(&session_id, "turn two")).await; // S

        // A is interrupted mid-turn (its OWN busy truth ends — but the FIFO
        // queue is intact: C and S still owe their edges).
        st.handle_interrupt(interrupt_msg(&session_id)).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qirq-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "the interrupt freed A only — C and S are still queued"
        );

        // C runs for real: observed compacting + confirmed-manual boundary +
        // its pair — retires C, and S is STILL owed: the gate MUST stay closed
        // here.
        inject_raw_send(&st, &session_id, "__emit_compacting__").await;
        inject_raw_send(&st, &session_id, "__emit_compact_boundary_manual__").await;
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "ep2-r2 F2: C's edge retires C — S is still generating"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qirq-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"],
            "BUSY_TURN",
            "ep2-r2 F2: past the interrupted turn's compact, the queued send still owns the gate: {frames:?}"
        );
        assert_eq!(env.spawn_count(), 1, "zero teardown from refused attempts");

        // S's pair: the gate releases exactly at S's own terminal edge.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        await_in_turn(&st, &session_id, false).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-qirq-2", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "NOTHING_TO_UNDO",
            "the gate released exactly at S's own terminal edge: {frames:?}"
        );
        drop(env);
    }

    /// Focused-review ep4-r1 F1 (the request↔settle gap, now resolved as
    /// settle-ack ≠ turn-complete per the SDK receipt-before-result contract
    /// at ep4-r2): with the settle deferred, the gate must stay closed for the
    /// whole provider-work window — and opens only at the interrupted turn's
    /// OWN terminal frames (result + paired idle, emitted after the receipt
    /// in that order).
    ///
    ///   A running → interrupt (settle chain deferred by knob) → mid-window
    ///   rollback probe: BUSY_TURN → deferred chain (settle → result → idle)
    ///   → gate OPENS exactly there.
    #[tokio::test]
    async fn an_interrupt_keeps_the_gate_closed_until_the_interrupted_turns_own_frames_land() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        std::env::set_var("FRESHELL_TEST_CLAUDE_INTERRUPT_SETTLE_MS", "400");
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-settle")).await;
        let created = await_claude_created(&mut rx, "req-settle").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await;
        assert!(in_turn_of(&st, &session_id).await, "the turn is running");

        st.handle_interrupt(interrupt_msg(&session_id)).await;
        // The write landed; the settle is DEFERRED: the gate MUST stay closed.
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-settle-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "ep4-r1 F1: an interrupt REQUEST never opens the gate — the interrupted turn's own terminal frames own the fold"
        );
        assert!(
            in_turn_of(&st, &session_id).await,
            "the busy truth holds past the request write"
        );

        // The deferred chain arrives (receipt, then the turn's own result +
        // paired idle): the gate opens exactly at the op's own terminal edge.
        await_in_turn(&st, &session_id, false).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-settle-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "NOTHING_TO_UNDO",
            "the gate opened at the interrupted turn's own terminal frames, never at the receipt"
        );
        std::env::remove_var("FRESHELL_TEST_CLAUDE_INTERRUPT_SETTLE_MS");
        drop(env);
    }

    /// Focused-review ep4-r1 F1 (rejection): a REJECTED interrupt (the sidecar
    /// answers ok:false — e.g. the provider had no cancellable turn) retires
    /// NOTHING: the gate stays closed and the turn's OWN terminal edge releases
    /// it later.
    #[tokio::test]
    async fn a_rejected_interrupt_never_retires_the_running_turn() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        std::env::set_var("FRESHELL_TEST_CLAUDE_INTERRUPT_REJECT", "1");
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-ireject")).await;
        let created = await_claude_created(&mut rx, "req-ireject").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await;

        st.handle_interrupt(interrupt_msg(&session_id)).await;
        // The rejection settles immediately: NOTHING retires — gate closed.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "ep4-r1 F1: a rejected interrupt retires nothing"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-ireject-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "the rejected interrupt left the running turn owed — gate closed"
        );

        // The turn's OWN terminal edge (its real result + paired idle) retires
        // it — the gate opens exactly there.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        await_in_turn(&st, &session_id, false).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-ireject-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "NOTHING_TO_UNDO",
            "the turn's own edge released the gate after the rejected interrupt"
        );
        std::env::remove_var("FRESHELL_TEST_CLAUDE_INTERRUPT_REJECT");
        drop(env);
    }

    /// Focused-review ep4-r2 F2 (the absorbed-debt-started-behind-our-back
    /// window): absorbed compact debt was pronounced "never started on the
    /// provider side," but the sidecar's FIFO dispatch can start it AFTER the
    /// absorb — and with the ep4-r1 fold-under-turn_lock shape, that start's
    /// candidate fold blocked behind the rollback-held lock, so the recheck
    /// saw nothing. The repair is the quiesce probe: the pre-teardown
    /// interrupt's settle frame reaches the consumer's fold only AFTER every
    /// already-emitted piece of evidence (stream order), so the revived
    /// candidate is provably visible at the recheck — the rollback ABORTS
    /// (BUSY_TURN + compensating ledger rewrite), the sidecar survives.
    ///
    ///   Transcript-eligible durable fixture on a LIVE fake sidecar; [A → C1 →
    ///   A's pair → C2] owed compacts; the gate absorb admits; the pre-teardown
    ///   quiesce probe (an interrupt write) elicits the fake's
    ///   FRESHELL_TEST_CLAUDE_PROBE_COMPACT_BEFORE_SETTLE compacting STATUS
    ///   before its settle → the recheck provably sees the revived candidate
    ///   → BUSY_TURN, zero teardown, compensated ledger.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_compaction_starting_behind_the_absorb_aborts_at_the_quiesce_probes_recheck() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        std::env::set_var("FRESHELL_TEST_CLAUDE_PROBE_COMPACT_BEFORE_SETTLE", "1");
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), "dur-probe", &two_turn_transcript());
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink_impl.clone());
        insert_rollback_fixture_session_with_live_sidecar(&st, "rb-probe", "dur-probe").await;

        // [A → C1][A's pair][C2] — compact-only owed queue (C1 promoted
        // briefly under A, so retiring A leaves BOTH compacts queued and
        // never-promoted: the absorb family's admittance shape).
        st.handle_send(send_msg("rb-probe", "turn one")).await; // A
        st.handle_compact(compact_msg("rb-probe", None)).await; // C1 queued behind A
        inject_raw_send(&st, "rb-probe", "__emit_result_error__").await;
        inject_raw_send(&st, "rb-probe", "__emit_idle__").await;
        st.handle_compact(compact_msg("rb-probe", None)).await; // C2 queued
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, "rb-probe").await,
            "the owed debt holds the gate closed pre-rollback"
        );

        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-probe", "rb-probe-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"],
            "BUSY_TURN",
            "ep4-r2 F2: the absorbed compact provably STARTED in the sidecar — the quiesce probe's post-settle recheck aborts the teardown: {frames:?}"
        );
        assert!(
            in_turn_of(&st, "rb-probe").await,
            "the revived candidate keeps the gate closed after the abort"
        );
        assert!(
            sink_impl.load_rollback("claude", "dur-probe").is_none(),
            "the compensation deleted the pre-write row (nothing ever happened)"
        );
        std::env::remove_var("FRESHELL_TEST_CLAUDE_PROBE_COMPACT_BEFORE_SETTLE");
        drop(env);
    }

    /// Focused-review ep4-r1 F1 (misattribution) — the ep4-r1 repair retired
    /// the running op at the interrupt receipt, but per the SDK contract the
    /// receipt is written BEFORE the interrupted turn's terminal `sdk.result`.
    /// With a turn queued behind, that trailing result then folds against the
    /// NEXT op — the gate opens while it still runs. The receipt must retire
    /// nothing; the result belongs to the interrupted op alone.
    ///
    ///   A running, B queued → interrupt (fake emits settle → result → idle in
    ///   contract order) → the gate stays CLOSED for B (in_turn true, rollback
    ///   BUSY_TURN) → B's own terminal frames → gate OPENS.
    #[tokio::test]
    async fn an_interrupted_turns_trailing_result_never_retires_the_next_queued_op() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-misattr")).await;
        let created = await_claude_created(&mut rx, "req-misattr").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        await_status_frame(&mut rx, &session_id, "idle").await;

        st.handle_send(send_msg(&session_id, "turn one")).await; // A running
        st.handle_send(send_msg(&session_id, "turn two")).await; // B queued

        // Interrupt A: receipt + A's own trailing result/idle (in that order).
        // NOTHING beyond A may retire.
        st.handle_interrupt(interrupt_msg(&session_id)).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            in_turn_of(&st, &session_id).await,
            "ep4-r1 F1: A's trailing result belongs to A alone — B is still owed"
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-misattr-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "BUSY_TURN",
            "the gate never opened over the still-queued B"
        );

        // B's own terminal frames retire it — the gate opens exactly there.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        inject_raw_send(&st, &session_id, "__emit_idle__").await;
        await_in_turn(&st, &session_id, false).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-misattr-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "NOTHING_TO_UNDO",
            "the gate opened at B's own terminal frames"
        );
        drop(env);
    }

    /// Focused-review ep4-r3 F2 (probe correlation): an answer whose probeId
    /// does NOT match the armed probe (a stale receipt from an earlier probe
    /// or an unrelated interrupt's settle frame) must never close it. The
    /// knobs force the fake to answer with a foreign probe id and shrink the
    /// probe timeout so the wait resolves by timeout => BUSY_TURN — the SAFE
    /// default, never a blind admit.
    ///
    /// RED harness: verifying the correlation code is what saves us requires
    /// only flipping the consumer's probeId equality (the temporary
    /// `armed_id == frame_probe_id` toggle) — the rollback then admits on the
    /// stale answer (rolledBack), proving the exact attacker the finding named.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_stale_quiesced_frame_never_closes_a_live_rollback_probe() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        std::env::set_var("FRESHELL_TEST_CLAUDE_PROBE_WRONG_ID", "1");
        std::env::set_var("FRESHELL_TEST_CLAUDE_ROLLBACK_PROBE_TIMEOUT_MS", "200");
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), "dur-stale", &two_turn_transcript());
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink_impl.clone());
        insert_rollback_fixture_session_with_live_sidecar(&st, "rb-stale", "dur-stale").await;

        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-stale", "rb-stale-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"],
            "BUSY_TURN",
            "ep4-r3 F2: the stale (foreign probeId) answer never closes the probe — the wait times out into the safe refusal: {frames:?}"
        );
        assert_eq!(env.spawn_count(), 0, "no teardown happened");
        std::env::remove_var("FRESHELL_TEST_CLAUDE_PROBE_WRONG_ID");
        std::env::remove_var("FRESHELL_TEST_CLAUDE_ROLLBACK_PROBE_TIMEOUT_MS");
        drop(env);
    }

    /// Focused ep4-r3 (the probe's ADMIT path stays true): absorbed compact
    /// debt the sidecar never started is cancelled AT the quiesce (its drain
    /// count rides the answer), the verdict comes back all-clear, and the
    /// rollback completes — absorb never became a BUSY-wedge (the point of
    /// the ep3-r3 absorb lane).
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_quiesce_probe_admits_when_the_sidecar_drains_unstarted_compacts() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), "dur-qadmit", &two_turn_transcript());
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink_impl.clone());
        let _ =
            insert_rollback_fixture_session_with_live_sidecar(&st, "rb-qadmit", "dur-qadmit").await;

        // Compact-only owed queue (C1 rides under A; A's pair retires it; C2).
        st.handle_send(send_msg("rb-qadmit", "turn one")).await;
        st.handle_compact(compact_msg("rb-qadmit", None)).await;
        inject_raw_send(&st, "rb-qadmit", "__emit_result_error__").await;
        inject_raw_send(&st, "rb-qadmit", "__emit_idle__").await;
        st.handle_compact(compact_msg("rb-qadmit", None)).await;
        tokio::time::sleep(Duration::from_millis(300)).await;

        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-qadmit", "rb-qadmit-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["type"],
            "freshAgent.rolledBack",
            "the quiesce drained the never-started compacts and answered all-clear — the rollback completed: {frames:?}"
        );
        // The absorbed debt was dropped at the sidecar's OWN dispatch boundary;
        // both probe round-trips passed.
        assert!(
            !st.sessions.lock().await.is_empty(),
            "the respawned session exists post-rollback"
        );
        drop(env);
    }

    /// Focused-review ep4-r3 F1 (same-tick handoff): an absorbed compact
    /// handed to an AWAITING SDK consumer in the tick before the probe is
    /// un-cancellable AND emits no status before the quiesce answers — the
    /// verdict is the ONLY evidence, so the busy branch of the verdict gate is
    /// standalone load-bearing (the recheck's candidate fold covers the OTHER,
    /// status-visible leg).
    ///
    ///   folded-debt fixture on a live sidecar; the probe answers BUSY via
    ///   `handedCompactLikely` with zero status frames → BUSY_TURN, zero
    ///   teardown, gate re-closed by the verdict... note: the verdict itself
    ///   re-boosts nothing — the queue was absorbed empty — so the gate's
    ///   post-abort truth is open (the compact still owes its own evidence;
    ///   this assert anchors the abort, not a wedge).
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_compact_handed_in_the_probes_tick_aborts_on_the_verdict_alone() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        std::env::set_var("FRESHELL_TEST_CLAUDE_PROBE_HANDED_BUSY", "1");
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), "dur-vhanded", &two_turn_transcript());
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink_impl.clone());
        insert_rollback_fixture_session_with_live_sidecar(&st, "rb-vhanded", "dur-vhanded").await;

        // A send+compact arm the debt realistically (A's pair folds them to
        // absorb shape: [C] owed, running empty).
        st.handle_send(send_msg("rb-vhanded", "turn one")).await;
        st.handle_compact(compact_msg("rb-vhanded", None)).await;
        inject_raw_send(&st, "rb-vhanded", "__emit_result_error__").await;
        inject_raw_send(&st, "rb-vhanded", "__emit_idle__").await;
        tokio::time::sleep(Duration::from_millis(300)).await;

        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-vhanded", "rb-vhanded-0", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"],
            "BUSY_TURN",
            "ep4-r3 F1: the verdict alone refuses — the handed compact is un-cancellable: {frames:?}"
        );
        assert!(
            sink_impl.load_rollback("claude", "dur-vhanded").is_none(),
            "the compensation deleted the pre-write row (nothing ever happened)"
        );
        std::env::remove_var("FRESHELL_TEST_CLAUDE_PROBE_HANDED_BUSY");
        drop(env);
    }

    /// Focused-review ep2-r2 F3 (arm-revert vs queued sends): a queued
    /// compact's no-write failure must undo EXACTLY its own bookkeeping — with
    /// a send queued behind an EARLIER compact still outstanding, releasing
    /// `in_turn` at the failed arm's revert opens the rollback gate while that
    /// send generates. The counter revert cleared `in_turn` unconditionally on
    /// its spent-prior CAS, and the gate never consulted the garlanded count:
    /// C1 completed (its edge folded mid-window) while C2's write failed behind
    /// it, leaving S1's send owed with the gate wide open.
    ///
    /// Rig: a REAL armed C1 behind fixture turn A; S1 accepted (garlanded); C1
    /// observably compacting; C2 armed and parked in its write window
    /// (SIGSTOP'd fixture child, full pipe); C1's terminal edge folds
    /// mid-window; C2's write then fails (SIGKILL) — the revert must keep the
    /// gate closed for S1, and S1's own terminal edge releases it.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_failed_compact_write_keeps_the_gate_closed_while_a_garlanded_send_is_owed() {
        let (st, _rx) = state_with_bus();
        insert_rollback_fixture_session_no_probe(&st, "rb-armfail-gar", "dur-armfail-gar").await;
        // Turn A running at the STRUCTURAL level (the running slot + busy cache).
        prime_fixture_running_turn(&st, "rb-armfail-gar").await;

        // Fetch the tracker arcs NOW: the compact driver holds the sessions
        // lock ACROSS its parked write await — reading from the map mid-window
        // would deadlock the rig.
        let (in_turn, turn_tracker) = busy_tracker_arcs(&st, "rb-armfail-gar").await;

        // C1 arms behind A (write succeeds un-frozen) — then A's terminal edge
        // retires the running turn, S1 accepts queued behind C1, and C1
        // observably starts compacting (promoted into `running`).
        st.handle_compact(compact_msg("rb-armfail-gar", None)).await;
        fold_terminal_edge(&in_turn, &turn_tracker);
        st.handle_send(send_msg("rb-armfail-gar", "turn garlanded"))
            .await;
        mark_compact_candidate(&in_turn, &turn_tracker);
        confirm_compact_candidate(&in_turn, &turn_tracker, true);

        // Let the fixture `tee` fully drain the pipe before freezing — a
        // partially-consumed pipe would park the fill loop short of the
        // helper's full-buffer assertion (its 64KiB threshold assumes an empty
        // pipe: armrace/armfail freeze before any handler write).
        tokio::time::sleep(Duration::from_millis(300)).await;
        // Park C2's write mid-window.
        let pid = freeze_fixture_stdin(&st, "rb-armfail-gar").await;
        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_compact(compact_msg("rb-armfail-gar", None)).await;
            })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;

        // C1's terminal edge folds mid-window: retires the promoted C1 — the
        // gate stays closed with C2's armed entry + S1 still owed.
        fold_terminal_edge(&in_turn, &turn_tracker);
        assert!(
            in_turn.load(std::sync::atomic::Ordering::SeqCst),
            "C2 armed + S1 owed — the gate holds past C1's edge"
        );

        // C2's write FAILS: the undo pops EXACTLY C2's own entry — and the gate
        // MUST stay closed for S1 (still queued behind the completed C1).
        assert_eq!(
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) },
            0,
            "SIGKILL the fixture child — the parked write fails"
        );
        tokio::time::timeout(Duration::from_secs(15), driver)
            .await
            .expect("the failed write resolves the handler")
            .expect("the compact task joins");
        assert!(
            in_turn.load(std::sync::atomic::Ordering::SeqCst),
            "ep2-r2 F3: the failed arm's undo never releases the gate while S1 is owed"
        );
        {
            let tracker = turn_tracker.lock().expect("turn tracker lock");
            assert_eq!(
                tracker.queued.iter().copied().collect::<Vec<_>>(),
                vec![TrackedOp::Turn],
                "exactly S1's queued entry survives the undo"
            );
            assert!(
                tracker.running.is_none(),
                "nothing is marked running after the undo"
            );
        }
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-armfail-gar", "rb-ag-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames[0]["event"]["code"], "BUSY_TURN",
            "ep2-r2 F3: rollback must refuse while the garlanded send is owed: {frames:?}"
        );

        // S1's own terminal edge: the gate releases exactly here.
        fold_terminal_edge(&in_turn, &turn_tracker);
        assert!(!in_turn.load(std::sync::atomic::Ordering::SeqCst));
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-armfail-gar", "rb-ag-2", RollbackDirection::Undo),
            sink,
        )
        .await;
        assert_eq!(
            captured_json(&captured)[0]["event"]["code"],
            "NOTHING_TO_UNDO",
            "the gate released exactly at S1's terminal edge"
        );
        assert!(
            st.sessions.lock().await.contains_key("rb-armfail-gar"),
            "the failed write never tore the session down"
        );
    }

    /// ep1-r3 F3 rig: the session's busy-truth Arc + the FIFO turn tracker the
    /// stdout consumer folds against (the whole tracked state the rig's direct
    /// folds mutate).
    #[cfg(target_os = "linux")]
    async fn busy_tracker_arcs(
        st: &FreshClaudeState,
        map_key: &str,
    ) -> (
        Arc<std::sync::atomic::AtomicBool>,
        Arc<std::sync::Mutex<TurnTracker>>,
    ) {
        let guard = st.sessions.lock().await;
        let s = guard.get(map_key).expect("tracked session");
        (s.in_turn.clone(), s.turn_tracker.clone())
    }

    /// ep2-r2 rig: mark a fixture session mid-turn at the STRUCTURAL level
    /// (the running slot holds the op + the derived busy cache set) — a bare
    /// `in_turn.store(true)` would leave the tracker empty and steal the next
    /// fold's attribution from the running op it never recorded.
    async fn prime_fixture_running_turn(st: &FreshClaudeState, map_key: &str) {
        let guard = st.sessions.lock().await;
        let s = guard.get(map_key).expect("tracked session");
        arm_turn_op(&s.in_turn, &s.turn_tracker, TrackedOp::Turn);
    }

    /// ep1-r3 F3 rig: SIGSTOP the fixture's `tee` and FILL its stdin pipe, so
    /// the next `write_line` parks INSIDE the write await (a deterministic,
    /// harness-pausable "mid-write" window) until the child resumes. Returns
    /// the child's pid for the later SIGCONT/SIGKILL.
    #[cfg(target_os = "linux")]
    async fn freeze_fixture_stdin(st: &FreshClaudeState, map_key: &str) -> u32 {
        let mut guard = st.sessions.lock().await;
        let session = guard.get_mut(map_key).expect("tracked session");
        let pid = session.child.id().expect("live child");
        assert_eq!(
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGSTOP) },
            0,
            "SIGSTOP the fixture child"
        );
        // A stopped reader never drains: fill the kernel pipe buffer until a
        // write parks (the elbow timeout elapses) — the NEXT write_line parks
        // INSIDE the write await. (ChildStdin has no userspace buffer, so a
        // parked write means the KERNEL pipe is full; the per-iteration
        // timeout IS the full-pipe signal — deterministic, no guessing.)
        use tokio::io::AsyncWriteExt as _;
        let junk = [b'x'; 4096];
        let mut filled = 0usize;
        loop {
            match tokio::time::timeout(Duration::from_millis(100), session.stdin.write_all(&junk))
                .await
            {
                Ok(Ok(())) => filled += junk.len(),
                Ok(Err(e)) => panic!("the stdin fill failed: {e}"),
                Err(_elapsed) => break,
            }
        }
        assert!(
            filled >= 65536,
            "the classic 64KiB pipe accepted a full buffer before refusing ({filled})"
        );
        drop(guard);
        pid
    }

    /// ep1-r3 F3 CORE — the arm/await race: the stdout consumer folds terminal
    /// events WITHOUT the turn lock, so the queued compact's tracker MUST be
    /// armed BEFORE the sidecar write await — otherwise the prior turn's
    /// `sdk.result` folds past the unarmed tracker (the busy truth dies with
    /// the compact still owed, and a phantom "prior edge owed" is invented
    /// once the post-await arm lands). Here the consumer's fold of the PRIOR
    /// turn's terminal edge lands DURING the parked write window (a stopped,
    /// pipe-full fixture child): after the fix the fold consumes the ARMED
    /// owed edge and the busy truth survives coherently.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_prior_turns_terminal_edge_during_the_compact_write_window_folds_against_the_armed_tracker(
    ) {
        let (st, _rx) = state_with_bus();
        insert_rollback_fixture_session(&st, "rb-armrace", "dur-armrace").await;
        prime_fixture_running_turn(&st, "rb-armrace").await;
        let pid = freeze_fixture_stdin(&st, "rb-armrace").await;

        // Fetch the tracker arcs NOW: the compact handler holds the sessions
        // lock ACROSS its parked write await, so reading them from the map
        // mid-window would deadlock the rig.
        let (in_turn, turn_tracker) = busy_tracker_arcs(&st, "rb-armrace").await;

        // The compact queues behind the running prior turn — and parks INSIDE
        // the write await (the stopped child never drains a full pipe).
        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_compact(compact_msg("rb-armrace", None)).await;
            })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        fold_terminal_edge(&in_turn, &turn_tracker);
        {
            let tracker = turn_tracker.lock().expect("turn tracker lock");
            assert!(
                tracker.running.is_none(),
                "the fold retired the prior turn's running entry mid-window"
            );
            assert_eq!(
                tracker.queued.iter().copied().collect::<Vec<_>>(),
                vec![TrackedOp::Compact],
                "F3: the compact was armed BEFORE the write await — the fold saw its queued entry"
            );
        }
        assert!(
            in_turn.load(std::sync::atomic::Ordering::SeqCst),
            "F3: the busy truth survives the mid-window fold (the queued compact persists)"
        );

        // Resume: the parked write drains and the handler completes with the
        // tracker still armed (the queued compact's busy truth is intact).
        assert_eq!(
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGCONT) },
            0,
            "SIGCONT the fixture child"
        );
        tokio::time::timeout(Duration::from_secs(15), driver)
            .await
            .expect("the parked compact write completes once the child resumes")
            .expect("the compact task joins");
        assert!(in_turn.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(
            turn_tracker.lock().expect("turn tracker lock").queued.len(),
            1,
            "the accepted queued compact's busy truth survives the whole window"
        );

        // End-to-end (ep3-r3 F1): a rollback against the survived-but-quiescent
        // compact debt ADMITS optimistically (nothing to undo → no teardown),
        // the armed entry SURVIVES, and the gate opens; a proven start of the
        // compact re-closes the gate again.
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-armrace", "rb-armrace-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(frames[0]["event"]["code"], "NOTHING_TO_UNDO", "{frames:?}");
        assert!(
            st.sessions.lock().await.contains_key("rb-armrace"),
            "zero teardown traffic"
        );
        assert!(
            !in_turn.load(std::sync::atomic::Ordering::SeqCst),
            "the absorb opened the gate"
        );
        assert_eq!(
            turn_tracker.lock().expect("turn tracker lock").queued.len(),
            1,
            "the armed compact's entry SURVIVES the absorb (its proven start re-arms the gate)"
        );
    }

    /// ep1-r3 F3 failure path: the armed tracker state is REVERTED synchronously
    /// when the write fails — and when the consumer's fold already consumed the
    /// prior turn's terminal edge DURING the window, the REVERT also releases
    /// the busy truth (nothing remains that could clear it: the compact never
    /// went out and the prior edge is spent — the pane must never wedge busy
    /// over a compact the blocked sidecar never received). The post-failure
    /// tracker state carries NO phantom edges: a later ordinary turn's terminal
    /// edge folds through the normal unarmed path and clears cleanly.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_failed_compact_write_reverts_the_armed_tracker_and_releases_the_spent_busy_truth() {
        let (st, mut rx) = state_with_bus();
        insert_rollback_fixture_session_no_probe(&st, "rb-armfail", "dur-armfail").await;
        prime_fixture_running_turn(&st, "rb-armfail").await;
        let pid = freeze_fixture_stdin(&st, "rb-armfail").await;

        // Fetch the tracker arcs NOW: the compact handler holds the sessions
        // lock ACROSS its parked write await, so reading them from the map
        // mid-window would deadlock the rig.
        let (in_turn, turn_tracker) = busy_tracker_arcs(&st, "rb-armfail").await;

        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_compact(compact_msg("rb-armfail", None)).await;
            })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        // The prior turn's terminal edge folds mid-window: retires the running
        // turn; the armed compact's queued entry survives (busy holds).
        fold_terminal_edge(&in_turn, &turn_tracker);

        // The write now FAILS (the child is SIGKILLed — the parked write gets
        // EPIPE): the armed entry must be undone synchronously.
        assert_eq!(
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) },
            0,
            "SIGKILL the fixture child — the parked write fails"
        );
        tokio::time::timeout(Duration::from_secs(15), driver)
            .await
            .expect("the failed write resolves the handler")
            .expect("the compact task joins");

        // The frame is LOUD (the compact failure surfaces as INTERNAL_ERROR).
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], json!("INTERNAL_ERROR"), "{frame}");

        // UNDO PROOF: busy released (the running prior turn's edge was spent
        // mid-window and the compact never went out — nothing remains that
        // could end a surviving busy truth), and the tracker is EMPTY (no
        // phantom ops outstanding — the undo removed exactly the arm's entry).
        use std::sync::atomic::Ordering::SeqCst;
        assert!(
            !in_turn.load(SeqCst),
            "the undo released the spent busy truth — no wedge"
        );
        {
            let tracker = turn_tracker.lock().expect("turn tracker lock");
            assert!(
                tracker.running.is_none() && tracker.queued.is_empty(),
                "no phantom ops outstanding — the undo removed exactly the arm's entry"
            );
        }
        // The phantom-op proof IN ACTION: a later ordinary turn's terminal
        // edge folds through the NORMAL nothing-outstanding path and clears (a
        // lingering entry would have swallowed it and wedged busy).
        in_turn.store(true, SeqCst); // a new turn is running
        fold_terminal_edge(&in_turn, &turn_tracker);
        assert!(
            !in_turn.load(SeqCst),
            "a later turn's terminal edge clears cleanly — no phantom op swallowed it"
        );
        assert!(
            st.sessions.lock().await.contains_key("rb-armfail"),
            "the failed write never tore the session down"
        );
    }

    #[tokio::test]
    async fn handle_rollback_redo_without_a_record_is_redo_unavailable() {
        let (st, _rx) = state_with_bus();
        let stdin_log = insert_rollback_fixture_session(&st, "rb-redo-none", "dur-redo-none").await;
        // No identity sink at all => no record can exist.
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-redo-none", "rb-r-1", RollbackDirection::Redo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["code"], "REDO_UNAVAILABLE");
        assert_eq!(frames[0]["event"]["message"], REDO_EMPTY_MESSAGE);
        assert_eq!(frames[0]["event"]["rollback"], json!(true));
        assert_eq!(frames[0]["event"]["requestId"], "rb-r-1");
        assert_eq!(std::fs::read_to_string(&stdin_log).unwrap_or_default(), "");
        assert!(st.sessions.lock().await.contains_key("rb-redo-none"));
    }

    #[tokio::test]
    async fn handle_rollback_record_write_failure_refuses_before_any_sidecar_churn() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), "dur-nowrite", &two_turn_transcript());
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        sink_impl.set_fail_writes(true);
        st.set_identity_sink(sink_impl.clone());
        let stdin_log = insert_rollback_fixture_session(&st, "rb-nowrite", "dur-nowrite").await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-nowrite", "rb-nw-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(frames[0]["event"]["message"], LEDGER_WRITE_REFUSAL_COPY);
        assert_eq!(frames[0]["event"]["rollback"], json!(true));
        assert_eq!(frames[0]["event"]["requestId"], "rb-nw-1");
        // Durable-BEFORE-mutation: a pre-write failure REFUSES — the provider history
        // is NEVER mutated: no stdin bytes, no sidecar spawn/kill, session intact.
        assert_eq!(std::fs::read_to_string(&stdin_log).unwrap_or_default(), "");
        assert_eq!(env.spawn_count(), 0);
        assert!(st.sessions.lock().await.contains_key("rb-nowrite"));
        assert!(
            sink_impl.rollbacks.lock().unwrap().is_empty(),
            "no durable row landed"
        );
        drop(env);
    }

    #[tokio::test]
    async fn handle_rollback_redo_with_a_moved_original_tip_is_redo_unavailable() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        // The original MOVED since the undo: a third turn (u3 chaining off a2) now tips it.
        let moved = format!(
            "{}\n{}",
            two_turn_transcript(),
            json!({"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"t5","message":{"role":"user","content":[{"type":"text","text":"prompt three"}]}})
        );
        write_rollback_transcript(home.path(), "orig-moved", &moved);
        // The current (post-undo) transcript is the prefix only.
        write_rollback_transcript(
            home.path(),
            "dur-moved-tip",
            &two_turn_transcript()
                .lines()
                .take(2)
                .collect::<Vec<_>>()
                .join("\n"),
        );
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        sink_impl
            .record_rollback("claude", "dur-moved-tip", {
                let mut r = RollbackRecord::empty(100);
                r.original_session_id = Some("orig-moved".to_string());
                r.original_tip_uuid = Some("a2".to_string()); // the tip observed at undo time
                r.set_can_redo(true, 100);
                r
            })
            .await
            .expect("seed write");
        st.set_identity_sink(sink_impl.clone());
        let stdin_log = insert_rollback_fixture_session(&st, "rb-moved", "dur-moved-tip").await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-moved-tip", "rb-mt-1", RollbackDirection::Redo),
            sink,
        )
        .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["code"], "REDO_UNAVAILABLE");
        assert_eq!(frames[0]["event"]["message"], REDO_REMOVED_HISTORY_COPY);
        assert_eq!(frames[0]["event"]["rollback"], json!(true));
        assert_eq!(std::fs::read_to_string(&stdin_log).unwrap_or_default(), "");
        assert_eq!(
            env.spawn_count(),
            0,
            "nothing is forked over a moved original"
        );
        drop(env);
    }

    #[tokio::test]
    async fn emit_pending_cancellations_maps_every_parked_entry() {
        let (st, mut rx) = state_with_bus();
        insert_fake_claude_session_with_pending(
            &st,
            "rb-pending",
            Some("dur-pending"),
            &[
                json!({"type":"sdk.permission.request","sessionId":"rb-pending","requestId":"req-1","tool":{"name":"Bash","input":{"command":"ls"}},"toolUseID":"toolu_1"}),
                json!({"type":"sdk.question.request","sessionId":"rb-pending","requestId":"q-1","questions":[{"question":"Continue?"}]}),
            ],
        )
        .await;
        st.emit_pending_cancellations("rb-pending", "dur-pending", "freshclaude")
            .await;
        let perm = await_frame_of_inner_type(&mut rx, "freshAgent.permission.cancelled").await;
        assert_eq!(perm["event"]["requestId"], json!("req-1"), "{perm}");
        let question = await_frame_of_inner_type(&mut rx, "freshAgent.question.cancelled").await;
        assert_eq!(question["event"]["requestId"], json!("q-1"), "{question}");
        let (permissions, questions) = pending_request_ids(&st, "rb-pending").await;
        assert!(
            permissions.is_empty() && questions.is_empty(),
            "decision 6: cancelled means cancelled — pending cards are never silently resolved"
        );
    }

    /// The r3 epoch rule end-to-end on the claude lane (undo→send→undo↔redo): the
    /// new undo re-roots the chain state to the CURRENT durable id while markers
    /// accumulate as the UNION of both epochs.
    #[tokio::test]
    async fn handle_rollback_after_a_resend_re_roots_the_chain_and_redo_restores_the_new_epoch() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        // Original O: retained on disk, chain tip a2 — the OLD epoch's fork-chain root.
        write_rollback_transcript(home.path(), "orig-epoch", &two_turn_transcript());
        // S' (the CURRENT live session): a fork of O (u1/a1 prefix) whose user
        // RESENT an edited prompt — its own u-prime/a-prime turn.
        let s_prime_transcript = [
            json!({"type":"user","uuid":"u1","parentUuid":null,"timestamp":"t1","message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"t2","message":{"role":"assistant","content":[{"type":"text","text":"answer one"}]}}),
            json!({"type":"user","uuid":"uq","parentUuid":"a1","timestamp":"t5","message":{"role":"user","content":[{"type":"text","text":"prompt two edited"}]}}),
            json!({"type":"assistant","uuid":"aq","parentUuid":"uq","timestamp":"t6","message":{"role":"assistant","content":[{"type":"text","text":"answer two edited"}]}}),
        ]
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        write_rollback_transcript(home.path(), "s-prime", &s_prime_transcript);
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        // The old-epoch record keyed by S': the resend already destroyed redo
        // (redo_destroyed) while the u2/a2 marker entry survives (decision 6 union).
        sink_impl
            .record_rollback("claude", "s-prime", {
                let mut r = RollbackRecord::empty(100);
                r.original_session_id = Some("orig-epoch".to_string());
                r.original_tip_uuid = Some("a2".to_string());
                r.push_entry(
                    RollbackEntry {
                        removed_turns: vec![
                            json!({"id":"u2","turnId":"u2","role":"user","summary":"prompt two","items":[]}),
                            json!({"id":"a2","turnId":"a2","role":"assistant","summary":"answer two","items":[]}),
                        ],
                        prompt_text: "prompt two".to_string(),
                        at_ms: 100,
                        epoch: 0,
                    },
                    100,
                );
                r.set_can_redo(true, 100);
                r.destroy_redo(110); // the resend destroyed the old epoch's redo (markers survive)
                r
            })
            .await
            .expect("seed write");
        st.set_identity_sink(sink_impl.clone());
        insert_rollback_fixture_session(&st, "epoch-live", "s-prime").await;

        // Undo the edited turn: lands while redo_destroyed == true ⇒ a NEW epoch.
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("s-prime", "rb-epoch-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let adopted = await_adopted_durable(&st, "epoch-live", "s-prime").await;

        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["type"], "freshAgent.rolledBack");
        assert_eq!(
            frames[0]["event"]["removedPromptText"],
            json!("prompt two edited")
        );
        assert_eq!(frames[0]["event"]["canRedo"], json!(true));
        assert_eq!(frames[0]["event"]["newSessionId"], json!(adopted));

        // The fork-at-point create landed with the computed options: resume the
        // CURRENT durable id (S'), keep through a1 (uq's raw parent), guard = the
        // first-to-discard prompt uuid uq.
        let creates: Vec<Value> = std::fs::read_to_string(env.spawn_log_path())
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("spawn log line is JSON"))
            .collect();
        assert_eq!(
            creates.len(),
            1,
            "exactly the rollback's fork create: {creates:?}"
        );
        assert_eq!(creates[0]["resumeSessionId"], json!("s-prime"));
        assert_eq!(creates[0]["resumeSessionAt"], json!("a1"));
        assert_eq!(creates[0]["forkSession"], json!(true));
        assert_eq!(
            creates[0]["resumeDropsTurn"],
            json!("uq"),
            "the guard is the first-to-discard turn's prompt uuid (brief/SDK semantics)"
        );

        // Re-rooted chain state on the record (re-keyed old→new by adoption):
        let record = sink_impl
            .load_rollback("claude", &adopted)
            .expect("record re-keyed to the adopted id");
        assert_eq!(
            record.original_session_id.as_deref(),
            Some("s-prime"),
            "the new epoch re-roots to the CURRENT durable id — O's chain is never reused for redo"
        );
        assert_eq!(
            record.original_tip_uuid.as_deref(),
            Some("aq"),
            "S' chain tip"
        );
        assert!(
            !record.redo_destroyed,
            "the new epoch's redo fields describe the NEW chain"
        );
        assert!(
            record.can_redo(),
            "redo source exists beyond the new live prefix"
        );
        assert_eq!(
            record.entries.len(),
            2,
            "the marker bucket is the UNION of both epochs"
        );
        let first_entry_ids: Vec<&str> = record.entries[0]
            .removed_turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(
            first_entry_ids,
            vec!["u2", "a2"],
            "the frozen prior-epoch markers stay first (decision 6; r3)"
        );
        let second_entry_ids: Vec<&str> = record.entries[1]
            .removed_turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(
            second_entry_ids,
            vec!["uq", "aq"],
            "the newest epoch's removed slice"
        );
        // Delta-r1 F8 case (a): the destroy bit at load opened a NEW epoch — the
        // frozen prior-epoch entry KEEPS its epoch (0), the new op records the
        // bumped counter (1); positions never read timestamps.
        assert_eq!(record.current_epoch, 1);
        assert_eq!(record.entries[0].epoch, 0);
        assert_eq!(record.entries[1].epoch, 1);
        assert!(
            sink_impl.load_rollback("claude", "s-prime").is_none(),
            "the rollback row MOVED old→new (never a stale duplicate)"
        );

        // Simulated SDK write: the forked child's transcript on disk is the kept prefix.
        write_rollback_transcript(
            home.path(),
            &adopted,
            &two_turn_transcript()
                .lines()
                .take(2)
                .collect::<Vec<_>>()
                .join("\n"),
        );

        // Now the redo re-forks from S' (the re-rooted chain root) restoring EXACTLY
        // the newest epoch's removed tail — the frozen prior-epoch markers are not restorable.
        let (sink2, captured2) = capturing_sink();
        st.handle_rollback(
            rollback_op(&adopted, "rb-epoch-2", RollbackDirection::Redo),
            sink2,
        )
        .await;
        let adopted2 = await_adopted_durable(&st, "epoch-live", &adopted).await;
        let frames2 = captured_json(&captured2);
        assert_eq!(frames2.len(), 1, "{frames2:?}");
        assert_eq!(frames2[0]["event"]["type"], "freshAgent.redone");
        assert_eq!(
            frames2[0]["event"]["restoredThroughTurnId"],
            json!("aq"),
            "redone restores through the restored step's OWN last uuid (r3 boundary rule)"
        );
        assert_eq!(
            frames2[0]["event"]["canRedo"],
            json!(false),
            "nothing lies beyond the re-rooted tip"
        );
        let creates: Vec<Value> = std::fs::read_to_string(env.spawn_log_path())
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("spawn log line is JSON"))
            .collect();
        assert_eq!(creates.len(), 2, "{creates:?}");
        assert_eq!(
            creates[1]["resumeSessionId"],
            json!("s-prime"),
            "redo re-forks the re-rooted chain root"
        );
        assert_eq!(creates[1]["resumeSessionAt"], json!("aq"));
        assert_eq!(creates[1]["forkSession"], json!(true));
        assert!(
            creates[1].get("resumeDropsTurn").is_none(),
            "the guard is omitted when the discard range is empty (redo to the tip) — never fabricated"
        );
        let record2 = sink_impl
            .load_rollback("claude", &adopted2)
            .expect("record re-keyed again");
        assert_eq!(
            record2.entries.len(),
            1,
            "the restored turns left the CURRENT-epoch portion"
        );
        let remaining_ids: Vec<&str> = record2.entries[0]
            .removed_turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(
            remaining_ids,
            vec!["u2", "a2"],
            "only the frozen prior-epoch markers remain"
        );
        assert!(!record2.can_redo());
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        drop(env);
    }

    /// The r2 lock discipline on the claude lane: a send fired mid-rollback waits on
    /// the per-session turn lock (handle_send NEVER acquires rollback_in_flight — it
    /// only PARKS on the registry's membership while the rollback's teardown→respawn
    /// window hides the map entry), then proceeds against the POST-rollback session
    /// and destroys redo.
    ///
    /// DETERMINISM (task 4 review C1): the fake sidecar's create ANSWER is deferred
    /// 750ms — the spawn-log gate observes the create request receipt while the
    /// rollback is PARKED inside `read_created`, so the send provably arrives in the
    /// teardown→respawn window (the map entry is already removed). Pre-fix the send
    /// died with SESSION_NOT_FOUND on a resolve-before-lock; post-fix it parks,
    /// serializes behind the rollback, and lands on the adopted session.
    #[tokio::test]
    async fn concurrent_send_plus_undo_serializes_on_the_turn_lock_without_deadlock() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install_with_knobs(Some(750), false);
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), "dur-serial", &two_turn_transcript());
        let (st, mut rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink_impl.clone());
        insert_rollback_fixture_session(&st, "serial-live", "dur-serial").await;

        let rollback = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_rollback(
                    rollback_op("dur-serial", "rb-serial-1", RollbackDirection::Undo),
                    capturing_sink().0,
                )
                .await
            })
        };
        // Wait until the rollback is parked INSIDE the respawn: the fork create
        // request has landed at the fake sidecar (spawn-log receipt) AND its answer
        // stays deferred for 750ms — the rollback already holds the session turn
        // lock and the map entry is already removed. The send fired below provably
        // arrives in the mid-rollback window.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while env.spawn_count() < 1 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the rollback never reached its fork create"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let send = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_send(send_msg("dur-serial", "edited followup"))
                    .await
            })
        };
        // Bounded completion == no deadlock between the two handlers' lock waits.
        tokio::time::timeout(Duration::from_secs(20), async {
            let (r, s) = tokio::join!(rollback, send);
            r.expect("rollback task");
            s.expect("send task");
        })
        .await
        .expect("send+rollback must serialize, never deadlock");

        let adopted = await_adopted_durable(&st, "serial-live", "dur-serial").await;
        // The send's sidecar write landed strictly AFTER the rollback's
        // kill+spawn+adoption completed: it targeted the NEW sidecar's id, never
        // the torn-down one.
        let sends = env.respond_log_frames(1).await;
        let send_frame = sends
            .iter()
            .find(|f| f["type"] == "send")
            .expect("the send eventually writes to the sidecar");
        assert_ne!(
            send_frame["sessionId"],
            json!("serial-live"),
            "the send waited, then ran against the POST-rollback session: {send_frame}"
        );
        assert!(
            send_frame["sessionId"]
                .as_str()
                .unwrap_or_default()
                .starts_with("fake-claude-session-"),
            "the send addressed the freshly-adopted sidecar: {send_frame}"
        );
        // SESSION_NOT_FOUND is structurally impossible on this lane: the send
        // parked while the rollback was in flight, never resolved-before-lock.
        while let Ok(raw) = rx.try_recv() {
            assert!(
                !raw.contains("SESSION_NOT_FOUND"),
                "no SESSION_NOT_FOUND frame may ever surface for a mid-rollback send: {raw}"
            );
        }
        // And destroy_redo_on_submit ran against the POST-rollback record —
        // keyed by the adopted durable id (the post-lock session state), never
        // the pre-MOVE id ("send waits, rollback wins, then destroys").
        let record = sink_impl
            .load_rollback("claude", &adopted)
            .expect("record under the adopted id");
        assert!(
            record.redo_destroyed,
            "the trailing send destroyed redo (decision 5)"
        );
        assert!(!record.can_redo());
        assert_eq!(
            record.entries.len(),
            1,
            "the marker bucket is NEVER touched by a destroy"
        );
        assert!(
            sink_impl.load_rollback("claude", "dur-serial").is_none(),
            "the rollback row MOVED old→new; nothing remains under the pre-rollback id"
        );
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        drop(env);
    }

    /// Task 4 review (Minor-2): a READ FAILURE on the redo's current transcript
    /// (locate succeeded, bytes unreadable) is a loud INTERNAL_ERROR — never the
    /// vacuous-empty leg (a silent false `redone` ack plus a pointless fork).
    #[tokio::test]
    async fn redo_current_transcript_read_failure_is_internal_error_with_no_fork_traffic() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        // Original: the recorded chain root (tip a2). Current (post-undo): the
        // u1/a1 prefix — located, then made UNREADABLE.
        write_rollback_transcript(home.path(), "dur-rf-orig", &two_turn_transcript());
        write_rollback_transcript(
            home.path(),
            "dur-rf",
            &two_turn_transcript()
                .lines()
                .take(2)
                .collect::<Vec<_>>()
                .join("\n"),
        );
        let current_path = home.path().join("projects/-t").join("dur-rf.jsonl");
        std::fs::set_permissions(
            &current_path,
            <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o000),
        )
        .unwrap();
        if std::fs::read_to_string(&current_path).is_ok() {
            // Root / CAP_DAC_OVERRIDE bypasses mode bits — restore + vacate.
            std::fs::set_permissions(
                &current_path,
                <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o644),
            )
            .unwrap();
            std::env::remove_var("CLAUDE_CONFIG_DIR");
            eprintln!("skipping: euid bypasses permission checks");
            return;
        }
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        sink_impl
            .record_rollback("claude", "dur-rf", {
                let mut r = RollbackRecord::empty(100);
                r.original_session_id = Some("dur-rf-orig".to_string());
                r.original_tip_uuid = Some("a2".to_string());
                r.set_can_redo(true, 100);
                r
            })
            .await
            .expect("seed write");
        st.set_identity_sink(sink_impl.clone());
        let stdin_log = insert_rollback_fixture_session(&st, "rb-rf", "dur-rf").await;

        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-rf", "rb-rf-1", RollbackDirection::Redo),
            sink,
        )
        .await;

        std::fs::set_permissions(
            &current_path,
            <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o644),
        )
        .unwrap();
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(frames[0]["event"]["rollback"], json!(true));
        assert_eq!(frames[0]["event"]["requestId"], "rb-rf-1");
        // NO fork traffic: the read failure refused BEFORE any spawn, pending
        // cancellation, or teardown.
        assert_eq!(env.spawn_count(), 0, "a read failure forks nothing");
        assert_eq!(std::fs::read_to_string(&stdin_log).unwrap_or_default(), "");
        assert!(
            st.sessions.lock().await.contains_key("rb-rf"),
            "the session was never torn down"
        );
        drop(env);
    }

    /// Task 4 review (Minor-3): a provably-rejected rollback (the fork create
    /// dies before `created`) on a session with NO pre-op record compensates by
    /// DELETING the pre-write row — never by fabricating an empty record.
    #[tokio::test]
    async fn rollback_spawn_rejection_compensates_by_deleting_a_fabricated_record_never_written() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install_with_knobs(None, true);
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), "dur-nocomp", &two_turn_transcript());
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink_impl.clone());
        insert_rollback_fixture_session(&st, "rb-nocomp", "dur-nocomp").await;

        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-nocomp", "rb-nocomp-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(frames[0]["event"]["rollback"], json!(true));
        assert_eq!(frames[0]["event"]["requestId"], "rb-nocomp-1");
        assert_eq!(
            env.spawn_count(),
            1,
            "the fork create WAS attempted — the provable-rejection leg ran"
        );
        assert!(
            sink_impl.load_rollback("claude", "dur-nocomp").is_none(),
            "compensation deleted the pre-write row"
        );
        assert!(
            !sink_impl
                .rollbacks
                .lock()
                .unwrap()
                .contains_key(&("claude".to_string(), "dur-nocomp".to_string())),
            "the ledger holds NO row at all afterward — not even an empty record"
        );
        drop(env);
    }
}
