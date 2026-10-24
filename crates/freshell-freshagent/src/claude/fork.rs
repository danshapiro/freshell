//! Fork a claude/kilroy conversation (core-runtime design §4.5 `handle_fork`,
//! C14; audit G09).
//!
//! A fork gives the conversation a second, independent future: a child session
//! C, minted here, booted as the SDK's lazy fork of the parent's conversation
//! through a chosen turn (T6: `resume`, `resumeSessionAt`, `forkSession`,
//! `sessionId: C`). The child is boot-verified through `establish_runtime` while
//! the parent stays live and untouched (the fork only reads the parent's
//! transcript, and writes nothing until its own first prompt), registered under
//! C (map key = envelope stamp = durable id), and recorded in C's binding row
//! with its `Fork` genesis, so a restart before C's first send boots the same
//! fork again. The requester gets `freshAgent.forked` at once (decision 5): the
//! pane switches to the child and closes the parent itself.

use super::*;

use freshell_protocol::{FreshAgentFork, FreshAgentForked};

use crate::claude_handshake::RESUME_POINT_NOT_FOUND_CODE;
use crate::claude_launch::{ClaudeBoot, ClaudeGenesis, ClaudeLaunchSpec};
use crate::claude_snapshot as snap;

use super::establish::{EstablishError, EstablishLane, EstablishPlan, GenesisBinding};
use super::history::EffectiveTranscriptError;

/// A fork while the parent runs a turn (`BUSY_TURN`).
pub(crate) const FORK_BUSY_MESSAGE: &str =
    "Claude is still working on this conversation. Fork it once the turn finishes.";

/// A fork of a conversation with no messages yet (`FORK_REFUSED`).
pub(crate) const FORK_EMPTY_MESSAGE: &str =
    "There is nothing to fork yet: this conversation has no messages.";

/// A fork at a turn the conversation does not hold (`FORK_REFUSED`).
pub(crate) const FORK_TURN_MISSING_MESSAGE: &str =
    "That turn is not in this conversation, so it can't be forked from.";

/// The CLI no longer holds the point the fork starts from (`FORK_REFUSED`).
pub(crate) const FORK_POINT_GONE_MESSAGE: &str =
    "That point is no longer in Claude's copy of the conversation, so it can't be forked from.";

/// A second fork of the same pane while the first is booting its child.
pub(crate) const FORK_IN_PROGRESS_MESSAGE: &str =
    "This conversation is already being forked. Wait for the new conversation to open.";

/// The pane closed the conversation while its fork was booting the child
/// (`FORK_REFUSED`; nothing shows it, since the pane is gone).
pub(crate) const FORK_PARENT_CLOSED_MESSAGE: &str =
    "The conversation was closed while it was being forked, so the fork was discarded.";

/// The child's binding row could not be written.
pub(crate) const FORK_LEDGER_WRITE_MESSAGE: &str =
    "Fork is unavailable right now: the new conversation could not be saved. Try again.";

/// The nested `freshAgent.error` every fork failure answers with on the
/// requesting connection, keyed to the parent id the pane addressed (any code
/// but `INVALID_SESSION_ID` shows on the pane as an error banner).
fn fork_error_frame(
    session_id: &str,
    session_type: &str,
    code: &str,
    message: &str,
) -> ServerMessage {
    ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: json!({
            "type": "freshAgent.error",
            "sessionId": session_id,
            "code": code,
            "message": message,
        }),
        provider: PROVIDER.to_string(),
        session_id: session_id.to_string(),
        session_type: session_type.to_string(),
    })
}

/// The fork error a child that was not established answers with.
fn fork_failure(error: &EstablishError) -> (&'static str, String) {
    match error {
        EstablishError::Boot(failure) if failure.is_refusal(RESUME_POINT_NOT_FOUND_CODE) => {
            ("FORK_REFUSED", FORK_POINT_GONE_MESSAGE.to_string())
        }
        other => ("INTERNAL_ERROR", other.message(EstablishLane::Fork)),
    }
}

/// The parent a fork reads, as it stands once the fork holds its turn lock.
struct ForkParent {
    /// The parent's sessions-map key.
    live_key: String,
    /// The id the requester knows the parent by (the reply's `parentSessionId`).
    reply_id: String,
    /// The parent's durable id: whose effective transcript the fork reads.
    durable: String,
    /// The parent's turn ledger (the busy gate reads it).
    ledger: crate::claude_turns::SharedLedger,
    /// The settings the parent runs with (model, effort, permission mode,
    /// plugins, cwd): the child starts with the same.
    settings: crate::identity_sink::FreshAgentSettings,
    /// The pane the parent runs for (G19): the pane follows the child, so the
    /// child runs for it too.
    freshell_context: Option<crate::claude_freshell_mcp::ClaudeFreshellContext>,
}

impl FreshClaudeState {
    /// Handle a `freshAgent.fork` for claude/kilroy (core design §4.5, C14).
    ///
    /// Ordering: fence shape → resolve the parent (unknown: the nested lost
    /// frame) → fork single-flight on the parent → the parent's turn lock (a
    /// fork never runs beside a send, an undo or another fork; it follows a
    /// replacement an undo made while it waited) → busy gate (`BUSY_TURN`) →
    /// the keep point on the parent's effective transcript (the last line of
    /// the step holding `input.atTurnId`, or the tip; a pending fork's source
    /// is its own parent, so chains never nest) → the child's coordinator claim
    /// and lease → `establish_runtime(C)` beside the live parent → the child's
    /// AWAITED binding row (its `Fork` genesis, the parent's settings, the
    /// forking connection's provenance, no `supersedes`) → the coordinator
    /// commit → `freshAgent.forked` on the requesting connection. Every failure
    /// answers a nested `freshAgent.error` on the same connection, leaves the
    /// parent untouched and tears down whatever the fork started. A fork never
    /// rings.
    pub async fn handle_fork(
        &self,
        msg: FreshAgentFork,
        provenance: Option<crate::BindProvenance>,
        reply_sink: freshell_terminal::FrameSink,
    ) {
        let session_type = session_type_str(msg.session_type);
        let refuse = |code: &str, message: &str| {
            reply_sink(fork_error_frame(
                &msg.session_id,
                session_type,
                code,
                message,
            ));
        };
        // The delayed-request fence's shape (send/attach/rollback parity): a
        // half-sent pair is the typed INVALID_FENCE refusal. A fork never touches
        // the parent's runtime, so a whole pair has nothing further to guard.
        if let Err(err) =
            crate::ownership_lane::wire_fence(msg.observed_epoch, msg.observed_generation)
        {
            tracing::warn!(target: "freshell_freshagent::claude",
                event = "freshagent.claude.fork_refused",
                session_id = %msg.session_id, code = err.code(),
                "the fork's observed fence is half-sent");
            refuse(err.code(), err.message());
            return;
        }
        let Some(map_key) = self.resolve_session_key(&msg.session_id).await else {
            reply_sink(lost_session_frame(&msg.session_id, msg.session_type));
            return;
        };
        let Some(_in_flight) = self.fork_in_flight.try_acquire(&map_key) else {
            tracing::info!(target: "freshell_freshagent::claude",
                event = "freshagent.claude.fork_refused",
                session_id = %msg.session_id, code = "FORK_IN_PROGRESS",
                "a fork of this session is already booting its child");
            refuse("FORK_IN_PROGRESS", FORK_IN_PROGRESS_MESSAGE);
            return;
        };
        let (turn_lock, durable_before) = {
            let sessions = self.sessions.lock().await;
            match sessions.get(&map_key) {
                Some(session) => (Arc::clone(&session.turn_lock), session.identity.current()),
                None => {
                    drop(sessions);
                    reply_sink(lost_session_frame(&msg.session_id, msg.session_type));
                    return;
                }
            }
        };
        let _turn = turn_lock.lock().await;
        let Some(parent) = self
            .fork_parent(&map_key, &msg.session_id, &durable_before, &turn_lock)
            .await
        else {
            reply_sink(lost_session_frame(&msg.session_id, msg.session_type));
            return;
        };
        if parent.ledger.lock().expect("turn ledger lock").busy() {
            tracing::info!(target: "freshell_freshagent::claude",
                event = "freshagent.claude.fork_refused",
                session_id = %parent.durable, code = "BUSY_TURN",
                "a fork waits for the parent's turn to finish");
            refuse("BUSY_TURN", FORK_BUSY_MESSAGE);
            return;
        }

        // The keep point, on what the parent holds now (its transcript, or for
        // a pending fork its parent's chain through the fork point).
        let current = match self.effective_transcript(&parent.durable).await {
            Ok(current) => current,
            Err(EffectiveTranscriptError::Missing) => {
                refuse("FORK_REFUSED", FORK_EMPTY_MESSAGE);
                return;
            }
            Err(EffectiveTranscriptError::Unreadable(error)) => {
                snap::log_transcript_unreadable("fork", &parent.durable, &error);
                refuse(
                    "INTERNAL_ERROR",
                    &format!("claude transcript store unreadable: {}", error.kind_label()),
                );
                return;
            }
            Err(EffectiveTranscriptError::Read(message)) => {
                refuse("INTERNAL_ERROR", &message);
                return;
            }
        };
        let at_turn_id = msg
            .input
            .as_ref()
            .and_then(|input| input.get("atTurnId"))
            .and_then(Value::as_str);
        let at = match snap::fork_point(&current.text, at_turn_id) {
            Ok(at) => at,
            Err(snap::ForkPointError::Empty) => {
                refuse("FORK_REFUSED", FORK_EMPTY_MESSAGE);
                return;
            }
            Err(snap::ForkPointError::TurnNotFound) => {
                refuse("FORK_REFUSED", FORK_TURN_MISSING_MESSAGE);
                return;
            }
        };
        // A fork discards nothing of its source that the pane shows as its own
        // conversation, so no drops-turn guard is armed (that guard is undo's).
        let genesis = ClaudeGenesis::Fork {
            parent: current.source.clone(),
            at: Some(at.clone()),
            drops_turn: None,
        };

        // The child's launch: the parent's settings and the lane's hosted MCP
        // selection, resuming the source by id under its ORIGINAL cwd while that
        // cwd exists (ledger A15), else by the transcript path the read above
        // located (G28: never a second scan).
        let located = current
            .source_path
            .as_deref()
            .map(|path| crate::claude_launch::resume_target(&current.source, path));
        let spawn_cwd = located
            .as_ref()
            .and_then(|(_, cwd)| cwd.clone())
            .or_else(|| msg.cwd.clone())
            .or_else(|| parent.settings.cwd.clone());
        let boot = ClaudeBoot::Fork {
            resume: located
                .map(|(resume, _)| resume)
                .unwrap_or_else(|| current.source.clone()),
            at: Some(at.clone()),
            drops_turn: None,
        };
        let mut launch_settings = parent.settings.clone();
        if spawn_cwd.is_some() {
            launch_settings.cwd = spawn_cwd.clone();
        }
        // D8: the child's attribution comes from the FORKING connection, then
        // the parent's row (a hollow connection identity never overrides).
        let fork_provenance = provenance.filter(|p| p.is_meaningful()).or_else(|| {
            self.identity_sink()
                .and_then(|sink| sink.load_provenance(PROVIDER, &parent.durable))
        });

        let child = uuid::Uuid::new_v4().to_string();
        // The child's id is minted, never observed: its coordinator claim needs
        // no fence, and it makes the child cross-kind-authoritative from birth.
        let fork_operation = format!("fork-child-{}", uuid::Uuid::new_v4());
        let mut own_ticket = match self.begin_lane_claim_at(
            &child,
            &fork_operation,
            None,
            &Self::initiator_for(fork_provenance.as_ref(), "freshclaude/fork"),
        ) {
            crate::ownership_lane::LaneClaim::Granted(ticket) => Some(ticket),
            crate::ownership_lane::LaneClaim::Unwired => None,
            crate::ownership_lane::LaneClaim::Adopt => {
                tracing::warn!(target: "freshell_freshagent::claude",
                    event = "freshagent.claude.fork_refused",
                    session_id = %parent.durable, child = %child, code = "SESSION_RESERVED",
                    "the ownership coordinator found a live owner under the minted fork child id");
                refuse(
                    "SESSION_RESERVED",
                    "Another resume for this session is in flight",
                );
                return;
            }
            crate::ownership_lane::LaneClaim::Refused(outcome) => {
                tracing::warn!(target: "freshell_freshagent::claude",
                    event = "freshagent.claude.fork_refused",
                    session_id = %parent.durable, child = %child, code = "SESSION_RESERVED",
                    outcome = ?outcome,
                    "the ownership coordinator refused the fork child's claim");
                refuse(
                    "SESSION_RESERVED",
                    "Another resume for this session is in flight",
                );
                return;
            }
        };
        let start_pid_slot = crate::ownership_lane::sidecar_pid_cancel_slot();
        let _start_cancellation = crate::ownership_lane::register_start_cancellation_for_ticket(
            &self.ownership,
            PROVIDER,
            &child,
            &own_ticket,
            crate::ownership_lane::pid_slot_cancellation(&start_pid_slot),
        );
        if own_ticket.is_some() {
            crate::ownership_lane::register_partial_fresh_runtime(
                &self.ownership,
                PROVIDER,
                &child,
                &own_ticket,
                &child,
                None,
            );
        }
        // The child's lease binds its id to the live session once established
        // (one live writer per durable transcript).
        let lease_id = format!("fork-{}", uuid::Uuid::new_v4());
        let mut lease_guard = match self.leases.claim(
            PROVIDER,
            &child,
            &lease_id,
            crate::session_lease::now_epoch_ms(),
        ) {
            crate::session_lease::FreshSessionClaim::Acquired => {
                Some(crate::FreshSessionLeaseGuard::armed(
                    Arc::clone(&self.leases),
                    PROVIDER,
                    &child,
                    &lease_id,
                ))
            }
            other => {
                tracing::error!(target: "invariant",
                    event = "freshagent.claude.fork_refused",
                    child = %child, claim = ?other,
                    "a freshly minted fork child id already holds a lease");
                refuse(
                    "SESSION_RESERVED",
                    "Another resume for this session is in flight",
                );
                return;
            }
        };

        tracing::info!(target: "freshell_freshagent::claude",
            event = "freshagent.claude.fork_boot",
            session_id = %parent.durable,
            child = %child,
            source = %current.source,
            at = %at,
            at_turn_id = ?at_turn_id,
            "the fork boots its child beside the live parent"
        );
        let spec = ClaudeLaunchSpec::new(
            format!("fork-{}", uuid::Uuid::new_v4()),
            session_type,
            boot,
            spawn_cwd,
            &launch_settings,
            self.hosted_mcp,
        )
        .with_session_id(Some(child.clone()))
        .with_freshell_context(parent.freshell_context.clone());
        let established = match self
            .establish_runtime(
                EstablishPlan {
                    lane: EstablishLane::Fork,
                    spec,
                    native_id: child.clone(),
                    claim: None,
                    recorded_settings: Some(launch_settings.clone()),
                    owning_generation: None,
                    provenance: fork_provenance.clone(),
                    naming: None,
                    partial_runtime_key: own_ticket.as_ref().map(|_| child.clone()),
                    start_pid_slot: &start_pid_slot,
                    inherit: None,
                    genesis: Some(genesis.clone()),
                    retry: None,
                },
                &mut lease_guard,
                &mut own_ticket,
            )
            .await
        {
            Ok(established) => established,
            Err(error) => {
                let (code, message) = fork_failure(&error);
                tracing::warn!(target: "freshell_freshagent::claude",
                    event = "freshagent.claude.fork_refused",
                    session_id = %parent.durable,
                    child = %child,
                    code,
                    failure = %error.message(EstablishLane::Fork),
                    "the fork's child was not established; the parent is untouched"
                );
                refuse(code, &message);
                return;
            }
        };

        self.test_holds.fork_child().await;
        // The pane may have closed the parent while the child booted (about a
        // second, decision 4): then nothing would ever show or close the
        // child, so it is torn down instead of handed out.
        if self
            .refuse_fork_of_closed_parent(&parent, &child, false)
            .await
        {
            refuse("FORK_REFUSED", FORK_PARENT_CLOSED_MESSAGE);
            return;
        }

        // The child's binding row, AWAITED before the answer (durable before
        // answer): how it came to be (its genesis, so a restart before its first
        // send boots the same fork), the parent's settings and the forking
        // connection's attribution. No `supersedes`: the parent lives on.
        if let Err(error) = self
            .record_genesis_binding(GenesisBinding {
                session_id: &child,
                session_type,
                genesis: &genesis,
                settings: &launch_settings,
                supersedes: None,
                provenance: fork_provenance.clone(),
                ticket: &own_ticket,
            })
            .await
        {
            tracing::error!(target: "freshell_freshagent::claude",
                event = "freshagent.claude.fork_binding_write_failed",
                session_id = %parent.durable, child = %child, error = %error,
                "the fork child's binding could not be written; the child is torn down"
            );
            self.unwind_fork_child(&child, false).await;
            refuse("INTERNAL_ERROR", FORK_LEDGER_WRITE_MESSAGE);
            return;
        }

        // Again once the row is written: from here to the answer nothing
        // awaits, so a close of the parent lands either before this check or
        // after the pane was answered.
        if self
            .refuse_fork_of_closed_parent(&parent, &child, true)
            .await
        {
            refuse("FORK_REFUSED", FORK_PARENT_CLOSED_MESSAGE);
            return;
        }

        // The child is live: commit `Live{FreshAgent}` under its id (the owner
        // record is broadcast, so the client holds the child's fence pair).
        if let Err(outcome) =
            self.commit_lane_claim_at(&mut own_ticket, &child, established.sidecar_pid)
        {
            tracing::error!(target: "invariant",
                event = "freshagent.claude.fork_commit_stale",
                provider = PROVIDER, session_id = %parent.durable, child = %child,
                outcome = ?outcome,
                "the coordinator moved on while the fork child registered; the child is torn down"
            );
            self.unwind_fork_child(&child, true).await;
            refuse(
                "INTERNAL_ERROR",
                "session ownership changed during fork; the new conversation was torn down",
            );
            return;
        }

        tracing::info!(target: "freshell_freshagent::claude",
            event = "freshagent.claude.fork_completed",
            session_id = %parent.durable,
            child = %child,
            session_type,
            "the fork's child is live beside its parent"
        );
        reply_sink(ServerMessage::FreshAgentForked(FreshAgentForked {
            request_id: msg.request_id.clone(),
            parent_session_id: parent.reply_id,
            session_id: child.clone(),
            session_type: session_type.to_string(),
            provider: PROVIDER.to_string(),
            runtime_provider: PROVIDER.to_string(),
            parent_retired_by_runtime: None,
            session_ref: Some(claude_session_ref(&child)),
        }));
    }

    /// The parent a fork reads once it holds `turn_lock`: the session `map_key`
    /// names while it is still registered; else the runtime an undo or redo
    /// replaced it with while the fork waited (it took this very lock over), so
    /// the fork reads what the pane now shows. `None` when the parent is gone.
    async fn fork_parent(
        &self,
        map_key: &str,
        wire_id: &str,
        durable: &str,
        turn_lock: &Arc<TokioMutex<()>>,
    ) -> Option<ForkParent> {
        let live_key = self
            .live_key_after_turn_wait(
                TurnLockedRequest::Fork,
                map_key,
                wire_id,
                durable,
                turn_lock,
            )
            .await?;
        let sessions = self.sessions.lock().await;
        let session = sessions.get(&live_key)?;
        Some(ForkParent {
            live_key: live_key.clone(),
            // The pane follows a replacement through its `materialized` re-key,
            // so it then knows the parent by the replacement's id.
            reply_id: if live_key == map_key {
                wire_id.to_string()
            } else {
                live_key.clone()
            },
            durable: session.identity.current(),
            ledger: Arc::clone(&session.ledger),
            settings: session.configuration.settings.clone(),
            freshell_context: session.configuration.freshell_context.clone(),
        })
    }

    /// Whether the pane closed the fork's parent: a kill of it is in flight
    /// (its close is pending) or done (its runtime left the live map without
    /// ending on its own, which leaves a dead-session record instead). A parent
    /// whose sidecar merely died is still the pane's, so its fork goes on.
    async fn fork_parent_closed(&self, parent_key: &str) -> bool {
        if let Some(session) = self.sessions.lock().await.get(parent_key) {
            return session.identity.is_closing();
        }
        self.dead_sessions.find(parent_key).is_none()
    }

    /// When the pane closed the fork's parent, tear the child down (retiring
    /// its binding row once written) and say so; the caller refuses the fork.
    async fn refuse_fork_of_closed_parent(
        &self,
        parent: &ForkParent,
        child: &str,
        row_written: bool,
    ) -> bool {
        if !self.fork_parent_closed(&parent.live_key).await {
            return false;
        }
        tracing::info!(target: "freshell_freshagent::claude",
            event = "freshagent.claude.fork_parent_closed",
            session_id = %parent.durable,
            child = %child,
            row_written,
            "the pane closed the parent while its fork booted the child; the child is torn down"
        );
        self.unwind_fork_child(child, row_written).await;
        true
    }

    /// Tear down a fork child that registered but cannot be handed to the
    /// pane; the parent is untouched. Once the child's binding row was written
    /// (`row_written`), it is retired so nothing offers to restore a
    /// conversation no pane ever showed.
    async fn unwind_fork_child(&self, child: &str, row_written: bool) {
        if let Some(session) = self.sessions.lock().await.remove(child) {
            let _teardown: LoggedTeardown = self.teardown_removed_session_logged(session).await;
        }

        self.leases.clear_binding(PROVIDER, child);
        if row_written {
            if let Some(sink) = self.identity_sink() {
                if let Err(error) = sink.retire_closed(PROVIDER, child).await {
                    tracing::warn!(target: "freshell_freshagent::claude",
                        event = "freshagent.claude.fork_child_retire_failed",
                        child = %child, error = ?error,
                        "the torn-down fork child's binding row could not be retired");
                }
            }
        }
    }
}
