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
    FreshAgentSend, FreshAgentSendAccepted, ServerMessage, SessionType,
};

use crate::{FreshAgentCreateDedup, FreshAgentCreateOutcome, SharedPaneIdentitySink};

/// The runtime provider (`AGENT_SESSION_TYPES.claude.provider`).
const PROVIDER: &str = "claude";
/// The ownership tag env the sidecar + its claude CLI grandchild carry (the codex analog
/// is `FRESHELL_CODEX_SIDECAR_ID`); the `/proc` reaper keys on it.
const CLAUDE_SIDECAR_OWNERSHIP_ENV: &str = "FRESHELL_CLAUDE_SIDECAR_ID";
/// Cold-boot budget for the sidecar to answer the `create` request (`created`).
const SIDECAR_CREATE_BUDGET: Duration = Duration::from_secs(45);

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

/// One live freshclaude session: the Node sidecar it drives + its stdout consumer.
struct ClaudeSession {
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
    /// The session's tracked status (the stdout consumer's fold: the reference
    /// bridge's turn lifecycle — `running` on `sdk.assistant`, `idle` on every
    /// `sdk.result` — plus the raw `sdk.status` wire values folded on top).
    /// Read by the attach-ack sites so a reconnect ack tells the truth instead of
    /// the hardcoded "idle" that used to wedge stale-busy/stale-idle panes.
    /// Starts "idle" — a fresh/just-resumed session has announced nothing else.
    last_status: Arc<std::sync::Mutex<String>>,
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
        // Fresh session: nothing announced yet; the consumer's status fold owns it.
        let last_status = Arc::new(std::sync::Mutex::new("idle".to_string()));
        let consumer = self.spawn_consumer(
            reader,
            created.clone(),
            session_type.to_string(),
            created.clone(),
            Some(settings),
            Arc::clone(&broadcast_id),
            Arc::clone(&pending),
            Arc::clone(&last_status),
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
                stdin,
                child,
                ownership_id: ownership_id.clone(),
                consumer,
                sidecar_session_id: created.clone(),
                cli_session_id: resume_sid.clone(),
                broadcast_id,
                pending,
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
        // Success: no broadcast (mirrors legacy's silent fire-and-forget interrupt).
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
        let Some(map_key) = self.resolve_session_key(&session_id).await else {
            self.send_error(&request_id, "SESSION_NOT_FOUND", "claude session not found");
            return;
        };
        let mut guard = self.sessions.lock().await;
        let Some(session) = guard.get_mut(&map_key) else {
            drop(guard);
            self.send_error(&request_id, "SESSION_NOT_FOUND", "claude session not found");
            return;
        };
        // Address the sidecar by ITS id for this session (== the map key for created
        // sessions; differs for resumed-on-attach sessions, Task 6).
        let send_req =
            json!({ "type": "send", "sessionId": session.sidecar_session_id, "text": msg.text });
        if let Err(err) = write_line(&mut session.stdin, &send_req).await {
            drop(guard);
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
    pub async fn handle_compact(&self, msg: FreshAgentCompact) {
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);

        let Some(mut session) = self
            .respond_session_guard(&session_id, msg.session_type)
            .await
        else {
            return;
        };
        let text = match msg.instructions.as_deref().map(str::trim) {
            Some(instructions) if !instructions.is_empty() => {
                format!("/compact {instructions}")
            }
            _ => "/compact".to_string(),
        };
        let send_req =
            json!({ "type": "send", "sessionId": session.sidecar_session_id, "text": text });
        if let Err(err) = write_line(&mut session.stdin, &send_req).await {
            drop(session);
            self.emit_fresh_agent_error(&session_id, session_type, "INTERNAL_ERROR", &err);
        }
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
        // Freshly resumed session: the tracked status starts "idle" (truthful — no
        // turn can be in flight before the client sends).
        let last_status = Arc::new(std::sync::Mutex::new("idle".to_string()));
        let consumer = self.spawn_consumer(
            reader,
            msg.session_id.clone(),
            session_type.clone(),
            sidecar_session_id.clone(),
            recovered,
            Arc::clone(&broadcast_id),
            Arc::clone(&pending),
            Arc::clone(&last_status),
        );
        self.sessions.lock().await.insert(
            msg.session_id.clone(),
            ClaudeSession {
                stdin,
                child,
                ownership_id,
                consumer,
                sidecar_session_id,
                cli_session_id: Some(durable.to_string()),
                broadcast_id,
                pending,
                last_status: Arc::clone(&last_status),
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
    ) -> tokio::task::JoinHandle<()> {
        let broadcast_tx = self.broadcast_tx.clone();
        let sessions = self.sessions.clone();
        let cli_index = self.cli_index.clone();
        let identity_sink = self.identity_sink();
        let state = self.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
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
                // Restart-parity (plan §2.8 item 2): record the durable Claude UUID.
                // The index insert is load-bearing; the session-field copy is
                // best-effort (the map entry may not exist yet during create).
                if value.get("type").and_then(Value::as_str) == Some("sdk.session.init") {
                    if let Some(cli_id) = value.get("cliSessionId").and_then(Value::as_str) {
                        cli_index
                            .lock()
                            .await
                            .insert(cli_id.to_string(), session_id.clone());
                        if let Some(session) = sessions.lock().await.get_mut(&session_id) {
                            session.cli_session_id = Some(cli_id.to_string());
                        }
                        // P1.13: binding row keyed by the DURABLE cliSessionId, with
                        // the FULL create-settings snapshot — AWAITED here (this arm
                        // runs on the async consumer task) so the row is durable
                        // BEFORE the init-driven broadcast below proceeds (V8/A11).
                        // A failed write is surfaced user-visibly, never
                        // warn-and-drop, then the identity event proceeds.
                        // No-laundering guard (V7/A10, parity with codex's
                        // `record_codex_binding`): never persist an all-blank
                        // snapshot — it would make `was_recorded` true while
                        // `load_settings` returns None (the server sink's
                        // blank-snapshot guard), arming a FALSE SETTINGS_RESET
                        // for a legitimately-default create on a later resume.
                        let recordable = settings
                            .as_ref()
                            .filter(|s| **s != crate::identity_sink::FreshAgentSettings::default());
                        if let (Some(sink), Some(settings)) = (identity_sink.clone(), recordable) {
                            if let Err(e) = sink
                                .record_binding(crate::identity_sink::FreshAgentBindingUpsert {
                                    provider: PROVIDER.into(),
                                    session_id: cli_id.to_string(),
                                    mode: session_type.clone(),
                                    create_request_id: None,
                                    resolves_pending: None,
                                    supersedes: None,
                                    settings: settings.clone(),
                                })
                                .await
                            {
                                tracing::warn!(error = %e, session = %cli_id, "freshagent.claude.binding_write_failed");
                                state.emit_fresh_agent_error(
                                    cli_id,
                                    &session_type,
                                    "LEDGER_WRITE_FAILED",
                                    "Failed to persist this session's resume record - settings may not survive a server restart.",
                                );
                            }
                        }
                    }
                }
                // Task 10b: stamp the envelope from the SHARED handle (not the captured
                // map key) so an attach-by-durable rebind flips live event routing.
                let stamp = broadcast_id.lock().expect("broadcast id lock").clone();
                if let Some(frame) = sdk_line_to_frame(&value, &stamp, &session_type) {
                    let _ = broadcast_tx.send(frame);
                }
            }
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
                stdin,
                child,
                ownership_id: format!("test-{session_id}"),
                consumer,
                sidecar_session_id: session_id.to_string(),
                cli_session_id: None,
                broadcast_id: Arc::new(std::sync::Mutex::new(session_id.to_string())),
                pending: Arc::new(std::sync::Mutex::new(ClaudePending::default())),
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

let counter = 0
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
    counter += 1
    const sessionId = `fake-claude-session-${process.pid}-${counter}`
    process.stdout.write(JSON.stringify({ type: 'created', sessionId }) + '\n')
    // Mirror the real sidecar's post-create init: echo resumeSessionId as the durable
    // id when present (resume continuity), else a fixed fake uuid.
    const cliSessionId = msg.resumeSessionId || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    console.log(JSON.stringify({ type: 'sdk.session.init', sessionId, cliSessionId, model: 'fake-model', cwd: '/tmp', tools: [] }))
    console.log(JSON.stringify({ type: 'sdk.status', sessionId, status: 'idle' }))
  } else if (msg.type === 'send') {
    // Test hook: lets tests kill the sidecar THROUGH the public API to exercise
    // the consumer-exit eviction path (ledger A9).
    if (msg.text === '__exit__') process.exit(0)
    // Task 2 test hook: raise a canned pending permission the approve/deny flow can
    // respond to. The fake parks nothing — Rust's pending fold is the state under test.
    if (msg.text === '__raise_permission__') {
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
                stdin,
                child,
                ownership_id: format!("test-{session_id}"),
                consumer,
                sidecar_session_id: session_id.to_string(),
                cli_session_id: None,
                broadcast_id: Arc::new(std::sync::Mutex::new(session_id.to_string())),
                pending: Arc::new(std::sync::Mutex::new(pending)),
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
}
