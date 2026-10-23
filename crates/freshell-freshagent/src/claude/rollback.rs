//! Undo and redo for claude/kilroy (core-runtime design §4.5 and §4.6, C13).
//!
//! A rollback replaces the session's runtime with a boot-verified fork (or a
//! fresh conversation for a first-turn undo) under a durable id minted here.
//! The replacement boots while the original is still live (`establish_runtime`
//! answers once the CLI booted it, T2/T6), so a refused or failed boot leaves
//! the original untouched. Only after the replacement is registered and its
//! binding written does ownership move to it and the original stop.

use super::*;

use crate::claude_launch::{ClaudeBoot, ClaudeGenesis, ClaudeLaunchSpec};
use crate::claude_snapshot as snap;
use crate::rollback_record::*;

use super::establish::{
    EstablishError, EstablishLane, EstablishPlan, InheritedRuntime, RegisterUnder,
};

/// Decision 2: the CLI refused the fork's drops-turn guard because the turn
/// being undone absorbed another message (a send made during a tool call, a
/// background agent's notice) the pane never showed as its own turn.
pub(crate) const ROLLBACK_FOLDED_TURN_MESSAGE: &str =
    "Claude folded another message into that turn, so it can't be undone to that point.";

/// The CLI no longer has the point the rollback forks at.
pub(crate) const ROLLBACK_POINT_GONE_MESSAGE: &str =
    "That point is no longer in Claude's copy of the conversation, so it can't be undone to.";

/// The `create.failed` codes of a fork the CLI refused (`claude-sidecar/boot.mjs`).
const FORK_GUARD_REFUSED_CODE: &str = "FORK_GUARD_REFUSED";
const RESUME_POINT_NOT_FOUND_CODE: &str = "RESUME_POINT_NOT_FOUND";

/// What a rollback replaces the session's conversation with, from the reads.
struct RollbackPlan {
    /// The display turns the undo removes (or the redo restores).
    removed_turns: Vec<Value>,
    /// The composer refill (the removed step's prompt as typed).
    prompt_text: String,
    /// The redo chain's root and its raw-chain tip at undo time.
    chain_root: String,
    original_tip_uuid: Option<String>,
    can_redo_after: bool,
    /// How the replacement comes to be (its binding row records it).
    genesis: ClaudeGenesis,
    /// The conversation whose transcript the fork reads, and where it is.
    source: String,
    source_path: Option<PathBuf>,
}

/// A session's effective transcript (design §4.5): what it holds now, and the
/// real transcript a fork of it reads.
struct EffectiveTranscript {
    /// The conversation as the session holds it.
    text: String,
    /// The session a fork of it reads: itself, or, for a pending fork, its
    /// parent (source collapse).
    source: String,
    /// That source's own transcript text and path (empty / `None` for a
    /// `Fresh` session, which has none).
    source_text: String,
    source_path: Option<PathBuf>,
}

/// Why a session's effective transcript could not be read.
enum EffectiveTranscriptError {
    /// No transcript and no genesis: nothing the store knows.
    Missing,
    /// The store could not be checked (G28: never "empty").
    Unreadable(snap::LocateError),
    /// A located transcript (or a pending fork's parent) could not be read.
    Read(String),
}

impl EffectiveTranscriptError {
    /// The rollback refusal for this (`Missing` is the caller's to word).
    fn refusal(&self, op: &RollbackRequest, session_id: &str) -> freshell_protocol::ServerMessage {
        match self {
            Self::Unreadable(error) => snap::unreadable_rollback_refusal(op, session_id, error),
            Self::Missing => rollback_error_frame(op, "INTERNAL_ERROR", "transcript missing"),
            Self::Read(message) => rollback_error_frame(op, "INTERNAL_ERROR", message),
        }
    }
}

/// The rollback error a replacement that was not established answers with.
fn rollback_failure(error: &EstablishError) -> (&'static str, String) {
    match error {
        EstablishError::Boot(failure) if failure.is_refusal(FORK_GUARD_REFUSED_CODE) => {
            ("ROLLBACK_REFUSED", ROLLBACK_FOLDED_TURN_MESSAGE.to_string())
        }
        EstablishError::Boot(failure) if failure.is_refusal(RESUME_POINT_NOT_FOUND_CODE) => {
            ("ROLLBACK_REFUSED", ROLLBACK_POINT_GONE_MESSAGE.to_string())
        }
        other => ("INTERNAL_ERROR", other.message(EstablishLane::Rollback)),
    }
}

impl FreshClaudeState {
    /// Decision 6: pending cards inside undone turns are CANCELLED, never silently
    /// resolved. Emits the exact `freshAgent.permission.cancelled` /
    /// `freshAgent.question.cancelled` frames the fold consumes, one per parked
    /// entry, then clears the pending map. Invoked BEFORE the old sidecar is
    /// torn down.
    pub(super) async fn emit_pending_cancellations(
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

    /// Handle a `freshAgent.undo` / `freshAgent.redo` for claude/kilroy (core
    /// design §4.5, C13; kata 1wxv Task 4 for the record and its redo contract):
    /// conversation rollback by a boot-verified FORK RUNTIME.
    ///
    /// The replacement gets a fresh durable id C, minted here, and a genesis
    /// (§4.1): `Fork{source, at, dropsTurn}` (the SDK's lazy fork: `resume`,
    /// `resumeSessionAt`, `forkSession`, `sessionId: C`; the standalone
    /// `forkSession()` fn is never used, it remaps every uuid), or `Fresh` when
    /// the undo removes the first step (r2: legal; the empty conversation is
    /// the target). The source is the session's EFFECTIVE transcript: its own
    /// file, or, for a session that is itself a pending fork, its parent's
    /// prefix (source collapse: chains never nest, so a second undo with no
    /// send in between forks the parent at the earlier point). Redo re-forks
    /// the chain root at a later point under the tip+LCP validity contract
    /// (`REDO_UNAVAILABLE` + `REDO_REMOVED_HISTORY_COPY` when history moved).
    ///
    /// Ordering (durable-BEFORE-mutation, spawn before teardown): toTurn
    /// validation → `rollback_in_flight` single-flight (FIRST) → turn lock
    /// (held across the whole handler; a send parked on it re-resolves to the
    /// replacement afterwards) → busy gate (`BUSY_TURN`; the tracker plus the
    /// quiesce probe until C17) → coordinator claim and lease on the original
    /// → transcript reads and resume math → AWAITED record pre-write → quiesce
    /// probe → pending-card cancellations → `establish_runtime(C)` while the
    /// original is still live: the sidecar answers `created` only once the CLI
    /// booted the fork (T6: it writes nothing until its first prompt), so no
    /// init is ever awaited (G01) → ONE awaited ledger batch (binding C with
    /// its genesis, the original's settings and `supersedes`, and the rollback
    /// record re-keyed to C) → ownership moves to C → the original's record
    /// is replaced by C's (aliases follow) and its sidecar is stopped as a
    /// requested teardown → `materialized` + rolledBack broadcasts → the
    /// requester's ack. Any failure before the move compensates the record and
    /// tears C down; the original is untouched and live. A fork the CLI refuses
    /// because the turn being undone absorbed another message (the
    /// drops-turn guard, decision 2) or whose point is gone is
    /// `ROLLBACK_REFUSED`, never retried without the guard. A rollback never
    /// chimes.
    pub async fn handle_rollback(
        &self,
        op: crate::rollback_record::RollbackRequest,
        reply_sink: freshell_terminal::FrameSink,
    ) {
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
        let (
            durable_id,
            in_turn,
            turn_tracker,
            turn_lock,
            session_type,
            last_synthesized_complete_at,
        ) = {
            let guard = self.sessions.lock().await;
            match guard.get(&map_key) {
                Some(s) => (
                    s.cli_session_id.clone().unwrap_or_else(|| map_key.clone()),
                    s.in_turn.clone(),
                    s.turn_tracker.clone(),
                    s.turn_lock.clone(),
                    session_type_str(op.session_type),
                    // Task 5: the fork continues the SAME per-session
                    // death-mint clock (carried like `in_turn` — the fork is
                    // the same logical session lifetime, so a death-mint
                    // after the fork can never regress past one before it).
                    s.last_synthesized_complete_at.clone(),
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
        // it only POLLS membership while a miss resolves (task 4 review C1); a
        // send that resolved the session waits on its turn lock instead, and
        // follows the replacement after it (C13).
        let Some(_guard) = self.rollback_in_flight.try_acquire(&durable_id) else {
            reply_sink(rollback_error_frame(
                &op,
                "INTERNAL_ERROR",
                &format!("rollback already in progress for {durable_id}"),
            ));
            return;
        };
        // b8ke ext r29 F2 + focused ep5 r4 F3: the rollback's observed
        // generation fence — the wire's observedEpoch/observedGeneration
        // pair (additive since ext r21 F2) is HONORED verbatim: a request
        // already stale on ARRIVAL (its pair predates a completed
        // handoff/crash advance) can never be made current — the claim
        // under the coordinator lock typed-refuses it, so a queued
        // old-generation rollback can never tear down or roll back a
        // newer runtime. A half-sent pair is the typed INVALID_FENCE
        // refusal (the F7 discipline). And since ep5 r4 F3 the
        // FULLY-ABSENT pair is the SAME typed refusal on a
        // coordinator-wired lane — the ext-r13-F3 entry-observation
        // discipline this replaces was the laundering the round-4
        // reviewer rejects: a handler-START observation can detect an
        // ownership change occurring AFTER it, but nothing can detect
        // that an unfenced request was already stale WHEN RECEIVED
        // (queued under generation N, arriving after the session moved
        // away and returned at N+2 — indistinguishable from a current
        // request, so it could adopt and roll back the NEWER owner).
        // The refusal is the actionable contract (identical to the
        // opencode lanes' FENCE_REQUIRED): the client re-observes the
        // owner record and retries WITH the pair. Only the UNWIRED lane
        // (no coordinator — the legacy no-coordinator lane) proceeds
        // unfenced: there is nothing to launder against.
        let rollback_fence =
            match crate::ownership_lane::wire_fence(op.observed_epoch, op.observed_generation) {
                Ok(fence) => fence,
                Err(err) => {
                    tracing::warn!(target: "freshell_freshagent::claude",
                        session_id = %durable_id, request_id = %op.request_id, code = err.code(),
                        "fresh_agent_rollback_refused: the observed fence is half-sent (invalid)");
                    reply_sink(rollback_error_frame(&op, err.code(), err.message()));
                    return;
                }
            };
        let rollback_fence = match rollback_fence {
            Some(fence) => Some(fence),
            None => {
                if self.ownership.is_some() {
                    tracing::warn!(target: "freshell_freshagent::claude",
                        session_id = %durable_id, request_id = %op.request_id,
                        code = "INVALID_FENCE",
                        "fresh_agent_rollback_refused: the rollback carried no observed \\
                         ownership pair against a coordinator-wired lane — the client \\
                         re-observes the owner record and retries with the pair (kata \\
                         b8ke focused ep5 r4 F3)");
                    reply_sink(rollback_error_frame(
                        &op,
                        "INVALID_FENCE",
                        "the rollback carried no observed ownership pair; re-observe the \\
                         session's owner record and retry",
                    ));
                    return;
                }
                None
            }
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
        // id mid-fork. A REFUSAL LEG — before any record write or boot.
        // kata b8ke Task 3: the coordinator claim comes FIRST — before the
        // provider lease — so the rollback window (the replacement's boot and
        // the move of ownership onto it) is cross-kind-authoritative. The "we
        // ARE the bound live owner" case surfaces as AdoptLive (same-kind live).
        let rollback_lease_id = format!("rollback-{}", uuid::Uuid::new_v4());
        // b8ke delta round-2 F2: the replacement start's watchdog
        // machinery (the sidecar pid slot + the settle guard — see the
        // create-resume claim site).
        let start_pid_slot = crate::ownership_lane::sidecar_pid_cancel_slot();
        let mut _start_cancellation: Option<crate::ownership_lane::StartCancellationGuard> = None;
        let granted_ticket = match self.begin_lane_claim_at(
            &durable_id,
            &rollback_lease_id,
            rollback_fence,
            "freshclaude/rollback",
        ) {
            crate::ownership_lane::LaneClaim::Granted(ticket) => Some(ticket),
            crate::ownership_lane::LaneClaim::Unwired => None,
            crate::ownership_lane::LaneClaim::Adopt => {
                // Same-kind live under this exact id (the lease arm's "we
                // ARE the bound live owner" twin): proceed WITHOUT a claim
                // — the binding already names this lane.
                None
            }
            crate::ownership_lane::LaneClaim::Refused(outcome) => {
                tracing::warn!(target: "freshell_freshagent::claude",
                    session_id = %durable_id, outcome = ?outcome,
                    "fresh_agent_rollback_refused: the ownership coordinator refused the \
                     claim (kata b8ke cross-kind authority)"
                );
                reply_sink(rollback_error_frame(
                    &op,
                    "SESSION_RESERVED",
                    "Another resume for this session is in flight",
                ));
                return;
            }
        };
        let mut lease_guard: Option<crate::FreshSessionLeaseGuard> = None;
        // b8ke delta round-2 F2 + focused episode-2 round-3 F5: the granted
        // claim registers its REAL cancellation + settle with the watchdog
        // IMMEDIATELY — the replacement's boot waits up to the
        // 45-second create budget for the CLI; a watchdog sweep in that wait
        // must find armed, cancellable evidence, never a fence with nothing
        // registered. The sidecar pid slot arms when the child exists
        // (below); the PARTIAL runtime registers NOW with the
        // kind-appropriate identity (pid unknown until the spawn returns —
        // the same evidence shape the codex spawn hook rearms with the
        // real pid).
        // b8ke ext r13 F3: the Adopt arm holds REAL authority across the
        // replace window — the guard arms on the live incumbent's key and
        // is held through the replacement's boot + register + rekey and the
        // original's stop (this handler's scope), so a handoff or stop begin inside the window
        // answers the typed Blocked outcome and can NEVER start a terminal
        // beside the replacement (pre-r13 the Adopt arm proceeded with NO
        // claim, and the rekey's verify was the only — post-overlap —
        // defense).
        // b8ke ext r38 F1: the arm is the ATOMIC ADOPT — the request's
        // ORIGINAL observed fence (the pair the coordinator's claim already
        // verified when it answered AdoptLive) plus the EXPECTED
        // fresh-agent owner, validated in ONE coordinator-lock decision.
        // Pre-r38 the arm RE-OBSERVED whatever was live and armed on it
        // (the discard-and-re-observe laundering): a terminal handoff
        // committing between the claim and the arm armed the guard on the
        // TERMINAL owner and the rollback spawned a Fresh Claude sidecar
        // beside the terminal before the late rekey tore it down — two
        // live writers. The adopt closes the window: the observed pair
        // names the record the rollback decided on; any advance or a
        // foreign owner refuses typed BEFORE anything is killed or
        // spawned.
        let mut _rollback_adopt_guard: Option<freshell_ownership::AttachGuard> = None;
        if granted_ticket.is_none() && self.ownership.is_some() {
            // Test seam (b8ke ext r38 F1): park with the claim ANSWERED
            // (AdoptLive) but the adopt guard NOT yet armed — the
            // claim-to-arm race test's deterministic hold (the test
            // commits a terminal handoff against the key mid-park).
            if let (Some(parked), Some(release)) = (
                self.rollback_adopt_parked.as_ref(),
                self.rollback_adopt_release.as_ref(),
            ) {
                parked.notify_one();
                let _ = release.notified().await;
            }
            let resolved = self.resolve_ownership_key(&durable_id);
            // The Adopt arm only fires on a WIRED lane, where the
            // original pair is REQUIRED (the ep5-r4-F3 gate above refused
            // the absent pair typed).
            let Some(adopt_fence) = rollback_fence else {
                tracing::warn!(target: "freshell_freshagent::claude",
                    session_id = %durable_id,
                    "fresh_agent_rollback_refused: the Adopt arm requires the \
                     original observed pair (unreachable — the gate above refused \
                     the absent pair)"
                );
                reply_sink(rollback_error_frame(
                    &op,
                    "SESSION_RESERVED",
                    "Another resume for this session is in flight",
                ));
                return;
            };
            let expected_fresh_owner = freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: None,
                pid: None,
                ownership_id: None,
            };
            match crate::ownership_lane::arm_adopt_guard(
                &self.ownership,
                PROVIDER,
                &resolved,
                &format!("rollback-adopt-{rollback_lease_id}"),
                &expected_fresh_owner,
                adopt_fence,
                "freshclaude/rollback-adopt",
            ) {
                crate::ownership_lane::LaneAttachGuard::Armed(guard) => {
                    _rollback_adopt_guard = Some(guard);
                }
                crate::ownership_lane::LaneAttachGuard::Unwired => {}
                crate::ownership_lane::LaneAttachGuard::Refused => {
                    tracing::warn!(target: "freshell_freshagent::claude",
                        session_id = %durable_id,
                        "fresh_agent_rollback_refused: the Adopt arm's atomic adopt \
                         refused to arm (ownership advanced or a foreign owner holds \
                         the key) — the rollback aborts typed, nothing is killed or \
                         spawned"
                    );
                    reply_sink(rollback_error_frame(
                        &op,
                        "SESSION_RESERVED",
                        "Another resume for this session is in flight",
                    ));
                    return;
                }
            }
        }
        let mut own_ticket = granted_ticket;
        if own_ticket.is_some() {
            _start_cancellation = Some(
                crate::ownership_lane::register_start_cancellation_for_ticket(
                    &self.ownership,
                    PROVIDER,
                    &durable_id,
                    &own_ticket,
                    crate::ownership_lane::pid_slot_cancellation(&start_pid_slot),
                ),
            );
            crate::ownership_lane::register_partial_fresh_runtime(
                &self.ownership,
                PROVIDER,
                &durable_id,
                &own_ticket,
                &map_key,
                None,
            );
        }
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

        let plan = match op.direction {
            RollbackDirection::Undo => {
                let current = match self.effective_transcript(&durable_id) {
                    Ok(current) => current,
                    Err(EffectiveTranscriptError::Missing) => {
                        reply_sink(rollback_error_frame(
                            &op,
                            "NOTHING_TO_UNDO",
                            UNDO_EMPTY_MESSAGE,
                        ));
                        return;
                    }
                    Err(error) => {
                        reply_sink(error.refusal(&op, &durable_id));
                        return;
                    }
                };
                let target = match op.mode {
                    RollbackModeReq::Step => snap::ResumeTarget::Step,
                    RollbackModeReq::ToTurn => {
                        snap::ResumeTarget::ToTurn(op.turn_id.clone().expect("validated"))
                    }
                };
                let point = match snap::resolve_resume_point(&current.text, &durable_id, target) {
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
                // CHAIN-ROOT transcript (at the first undo the current
                // conversation IS the root).
                let root_text = if chain_root == durable_id {
                    current.text.clone()
                } else {
                    match self.read_located_transcript(&chain_root) {
                        Ok(Some(text)) => text,
                        Ok(None) => {
                            reply_sink(rollback_error_frame(
                                &op,
                                "INTERNAL_ERROR",
                                "chain-root transcript unreadable",
                            ));
                            return;
                        }
                        Err(error) => {
                            reply_sink(error.refusal(&op, &chain_root));
                            return;
                        }
                    }
                };
                let tip = snap::raw_chain_tip(&root_text);
                // The fork reads the source's REAL transcript, so the guard is
                // computed over it (§4.5 source collapse: a pending fork's
                // source is its parent, past the point the earlier undo kept).
                let genesis = match point.resume_at_uuid.clone() {
                    Some(at) => ClaudeGenesis::Fork {
                        parent: current.source.clone(),
                        drops_turn: snap::drops_turn_guard(&current.source_text, Some(&at)),
                        at: Some(at),
                    },
                    None => ClaudeGenesis::Fresh,
                };
                // can_redo after the undo: the removed content provably exists in
                // the original beyond the resume point (on the r2 first-turn leg
                // the fresh conversation's tip is NONE — strictly beyond holds
                // whenever a tip exists).
                RollbackPlan {
                    removed_turns: point.removed_turns,
                    prompt_text: point.prompt_text,
                    chain_root,
                    original_tip_uuid: tip,
                    can_redo_after: true,
                    genesis,
                    source: current.source,
                    source_path: current.source_path,
                }
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
                let original_path = match self.locate_transcript(&original) {
                    snap::TranscriptLocation::Found(path) => path,
                    snap::TranscriptLocation::Absent => {
                        reply_sink(rollback_error_frame(
                            &op,
                            "REDO_UNAVAILABLE",
                            REDO_REMOVED_HISTORY_COPY,
                        ));
                        return;
                    }
                    snap::TranscriptLocation::Unreadable(error) => {
                        reply_sink(snap::unreadable_rollback_refusal(&op, &original, &error));
                        return;
                    }
                };
                let original_text = match std::fs::read_to_string(&original_path) {
                    Ok(t) => t,
                    Err(e) => {
                        reply_sink(rollback_error_frame(&op, "INTERNAL_ERROR", &e.to_string()));
                        return;
                    }
                };
                // The current conversation is the session's effective
                // transcript: empty after a first-turn undo, the kept prefix of
                // a pending fork. A real read error is a loud INTERNAL_ERROR,
                // never a silent empty chain yielding a false `redone` ack.
                let current_text = match self.effective_transcript(&durable_id) {
                    Ok(current) => current.text,
                    Err(EffectiveTranscriptError::Missing) => {
                        reply_sink(rollback_error_frame(
                            &op,
                            "INTERNAL_ERROR",
                            "current transcript missing",
                        ));
                        return;
                    }
                    Err(error) => {
                        reply_sink(error.refusal(&op, &durable_id));
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
                // The guard: the one prompted turn of the original the redo
                // still leaves out, when exactly one (`None` redoing TO the
                // tip: nothing is discarded).
                let drops_turn = snap::drops_turn_guard(&original_text, Some(&resume_at));
                RollbackPlan {
                    removed_turns: restored.turns,
                    prompt_text: restored.prompt_text,
                    chain_root: original.clone(),
                    original_tip_uuid: record.original_tip_uuid.clone(),
                    can_redo_after: can_redo_after_redo,
                    genesis: ClaudeGenesis::Fork {
                        parent: original.clone(),
                        at: Some(resume_at),
                        drops_turn,
                    },
                    source: original,
                    source_path: Some(original_path),
                }
            }
        };
        let RollbackPlan {
            removed_turns,
            prompt_text,
            chain_root,
            original_tip_uuid,
            can_redo_after,
            genesis,
            source,
            source_path,
        } = plan;

        // Durable record FIRST (durable-BEFORE-mutation): computed from the
        // pre-mutation reads, keyed by the CURRENT durable id, AWAITED before
        // anything boots. The replacement's binding batch re-keys the row
        // old→new inside the same awaited write — exactly one
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

        // ep3-r5 F1 (the admit→boot window): the gate's quiescence-proof is
        // consumed ONCE at admission — a compact can arm and start (status
        // folded, candidate set, gate re-boosted by ep3-r4 F1) while this
        // already-admitted handler is doing transcript I/O. The quiesce probe
        // above makes all provably-written evidence folded-visible; the
        // recheck here (immediately before the replacement boots) aborts the rollback with BUSY_TURN plus a compensating
        // ledger rewrite whenever that truth revived (the durable pre-write
        // provably matches the provider: nothing was mutated).
        if let Ok(ms) = std::env::var("FRESHELL_TEST_CLAUDE_ROLLBACK_PRE_TEARDOWN_MS") {
            // Test-only knob: parks this handler in the admit→boot window so
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

        // Cancel pending cards (decision 6) before the replacement boots.
        self.emit_pending_cancellations(&map_key, &op.session_id, session_type)
            .await;

        // The replacement's launch: the original's recorded settings (plugins
        // included, G15) and the lane's hosted MCP selection; a fork resumes
        // its source by id under the source's ORIGINAL cwd while that cwd
        // exists (ledger A15 slug scoping), else by the transcript PATH (the
        // verified cli.js escape hatch). The path is the one the reads above
        // located (G28: never a second scan that a store turning unreadable
        // could miss).
        let recovered = self
            .identity_sink()
            .and_then(|s| s.load_settings(PROVIDER, &durable_id));
        let located = source_path
            .as_deref()
            .map(|path| crate::claude_launch::resume_target(&source, path));
        let spawn_cwd = located
            .as_ref()
            .and_then(|(_, cwd)| cwd.clone())
            .or_else(|| op.cwd.clone())
            .or_else(|| recovered.as_ref().and_then(|r| r.cwd.clone()));
        let boot = match &genesis {
            ClaudeGenesis::Fresh => ClaudeBoot::Fresh,
            ClaudeGenesis::Fork { at, drops_turn, .. } => ClaudeBoot::Fork {
                resume: located
                    .as_ref()
                    .map(|(resume, _)| resume.clone())
                    .unwrap_or_else(|| source.clone()),
                at: at.clone(),
                drops_turn: drops_turn.clone(),
            },
        };
        let mut launch_settings = recovered.clone().unwrap_or_default();
        if spawn_cwd.is_some() {
            launch_settings.cwd = spawn_cwd.clone();
        }
        let replacement = uuid::Uuid::new_v4().to_string();
        tracing::info!(target: "freshell_freshagent::claude",
            event = "freshagent.claude.rollback_boot",
            session_id = %durable_id,
            replacement = %replacement,
            direction = ?op.direction,
            genesis = genesis.kind(),
            drops_turn_guard = matches!(&genesis, ClaudeGenesis::Fork { drops_turn: Some(_), .. }),
            "the rollback boots its replacement runtime while the original stays live"
        );
        self.test_holds.rollback_boot().await;
        let spec = ClaudeLaunchSpec::new(
            format!("rollback-{}", uuid::Uuid::new_v4()),
            session_type,
            boot,
            spawn_cwd,
            &launch_settings,
            self.hosted_mcp,
        )
        .with_session_id(Some(replacement.clone()));
        // A lease the rollback took on the original completes onto the
        // replacement (the original's durable id resolves to it); a lease the
        // original already held as its live owner is cleared once it is gone.
        let lease_held = lease_guard.is_some();
        let established = match self
            .establish_runtime(
                EstablishPlan {
                    lane: EstablishLane::Rollback,
                    spec,
                    register_under: RegisterUnder::Adopted(replacement.clone()),
                    claim: None,
                    rekey_provisional_claim: false,
                    recorded_settings: Some(launch_settings.clone()),
                    // b8ke focused episode-2 round-2 F2: the ROLLBACK's claim
                    // owns this runtime's coordinator transition — the
                    // adoption's Blocked arm correlates through the op id.
                    owning_operation: own_ticket.as_ref().map(|t| t.operation_id().to_string()),
                    owning_generation: None,
                    // Conn-less lane (D8): the ledger merge inherits the
                    // superseded parent's stamps.
                    provenance: None,
                    naming: None,
                    partial_runtime_key: own_ticket.as_ref().map(|_| durable_id.clone()),
                    start_pid_slot: &start_pid_slot,
                    inherit: Some(InheritedRuntime {
                        turn_lock: turn_lock.clone(),
                        in_turn: in_turn.clone(),
                        turn_tracker: turn_tracker.clone(),
                        last_synthesized_complete_at: Arc::clone(&last_synthesized_complete_at),
                    }),
                },
                &mut lease_guard,
                &mut own_ticket,
            )
            .await
        {
            Ok(established) => established,
            Err(error) => {
                // Nothing moved: the original is untouched and live.
                self.compensate_rollback_record(&durable_id, existing.clone())
                    .await;
                let (code, message) = rollback_failure(&error);
                tracing::warn!(target: "freshell_freshagent::claude",
                    event = "freshagent.claude.rollback_refused",
                    session_id = %durable_id,
                    replacement = %replacement,
                    code,
                    failure = %error.message(EstablishLane::Rollback),
                    "the replacement runtime was not established; the original stays live"
                );
                reply_sink(rollback_error_frame(&op, code, &message));
                return;
            }
        };

        // ONE awaited ledger batch: the replacement's binding (its genesis,
        // the original's settings, `supersedes` = the original, which retires
        // the original's row and links it to the replacement) with the
        // rollback record re-keyed to the replacement in the same write.
        if let Some(sink) = self.identity_sink() {
            let fenced = own_ticket.as_ref().map(|ticket| ticket.generation());
            if let Err(error) = sink
                .record_binding(crate::identity_sink::FreshAgentBindingUpsert {
                    genesis: crate::identity_sink::GenesisUpdate::Set(genesis.clone()),
                    provider: PROVIDER.into(),
                    session_id: replacement.clone(),
                    mode: session_type.to_string(),
                    create_request_id: None,
                    resolves_pending: None,
                    supersedes: Some(durable_id.clone()),
                    name_transition: None,
                    provenance: None.into(),
                    observed_epoch: fenced.and(self.ownership.as_ref().map(|r| r.boot_epoch())),
                    observed_generation: fenced,
                    authoritative: false,
                    settings: launch_settings.clone(),
                })
                .await
            {
                tracing::error!(target: "freshell_freshagent::claude",
                    event = "freshagent.claude.rollback_binding_write_failed",
                    session_id = %durable_id, replacement = %replacement, error = %error,
                    "the replacement's binding could not be written; it is torn down and the \
                     original stays live"
                );
                self.unwind_replacement(&replacement, &durable_id, lease_held)
                    .await;
                self.compensate_rollback_record(&durable_id, existing.clone())
                    .await;
                reply_sink(rollback_error_frame(
                    &op,
                    "INTERNAL_ERROR",
                    LEDGER_WRITE_REFUSAL_COPY,
                ));
                return;
            }
        }

        // Ownership moves to the replacement in ONE coordinator step (the
        // original's record re-keys; the original's id becomes a resolvable
        // alias). The claim/adopt guard has held the key since admission, so a
        // refusal here is an invariant breach.
        if let Err(outcome) = self.commit_lane_claim_rekey_at(
            &durable_id,
            &mut own_ticket,
            &replacement,
            &map_key,
            &replacement,
            established.sidecar_pid,
            "claude/rollback",
        ) {
            tracing::error!(target: "invariant",
                event = "freshagent.claude.rollback_commit_stale",
                provider = PROVIDER, session_id = %durable_id, replacement = %replacement,
                outcome = ?outcome,
                "the coordinator moved on while the rollback held its claim; the replacement \
                 is torn down and the original stays live"
            );
            self.unwind_replacement(&replacement, &durable_id, lease_held)
                .await;
            self.compensate_rollback_record(&durable_id, existing.clone())
                .await;
            if let Some(sink) = self.identity_sink() {
                let _ = sink.delete_rollback(PROVIDER, &replacement).await;
            }
            reply_sink(rollback_error_frame(
                &op,
                "INTERNAL_ERROR",
                "session ownership changed during rollback; torn down",
            ));
            return;
        }

        // The replacement takes the original's place: every id that named the
        // original (its map key, its durable id) now names the replacement,
        // and the original's sidecar is stopped as a requested teardown (its
        // record is gone first, so its end of output stays silent; #859's
        // graceful stop).
        if let Some(original) = self
            .replace_runtime(&map_key, &durable_id, &replacement)
            .await
        {
            let _teardown: LoggedTeardown = self.teardown_removed_session_logged(original).await;
        }
        if !lease_held {
            self.leases.clear_binding(PROVIDER, &durable_id);
        }

        // Pane re-key: the materialized broadcast (old → new) goes out BEFORE
        // the rollback frames stamped with the new id.
        self.broadcast_materialized(&op.session_id, &replacement, session_type)
            .await;
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
        // replacement.
        let switch = RollbackRequest {
            session_id: replacement.clone(),
            ..op
        };
        self.broadcast(&rollback_broadcast_frame(
            &switch,
            &replacement,
            &removed_ids,
            record.can_redo(),
        ));
        tracing::info!(target: "freshell_freshagent::claude",
            event = "freshagent.claude.rollback_completed",
            session_id = %durable_id,
            replacement = %replacement,
            direction = ?switch.direction,
            removed = removed_ids.len(),
            "the rollback's replacement is live and the original is stopped"
        );
        reply_sink(rollback_ack_frame(
            &switch,
            &replacement,
            Some(&prompt_text),
            &removed_ids,
            record.can_redo(),
            Some(&replacement),
        ));
    }

    /// The session's effective transcript (design §4.5): its transcript when
    /// the CLI wrote one; before that, what its genesis holds (a pending fork
    /// holds its parent's chain through the fork point, a fresh session
    /// nothing).
    fn effective_transcript(
        &self,
        session_id: &str,
    ) -> Result<EffectiveTranscript, EffectiveTranscriptError> {
        match self.locate_transcript(session_id) {
            snap::TranscriptLocation::Found(path) => {
                let text = std::fs::read_to_string(&path)
                    .map_err(|e| EffectiveTranscriptError::Read(e.to_string()))?;
                Ok(EffectiveTranscript {
                    source_text: text.clone(),
                    text,
                    source: session_id.to_string(),
                    source_path: Some(path),
                })
            }
            snap::TranscriptLocation::Unreadable(error) => {
                Err(EffectiveTranscriptError::Unreadable(error))
            }
            snap::TranscriptLocation::Absent => {
                let genesis = self
                    .identity_sink()
                    .and_then(|sink| sink.load_genesis(PROVIDER, session_id))
                    .map(|recorded| recorded.genesis);
                match genesis {
                    None => Err(EffectiveTranscriptError::Missing),
                    Some(ClaudeGenesis::Fresh) => Ok(EffectiveTranscript {
                        text: String::new(),
                        source: session_id.to_string(),
                        source_text: String::new(),
                        source_path: None,
                    }),
                    Some(ClaudeGenesis::Fork { parent, at, .. }) => {
                        let path = match self.locate_transcript(&parent) {
                            snap::TranscriptLocation::Found(path) => path,
                            snap::TranscriptLocation::Absent => {
                                return Err(EffectiveTranscriptError::Read(format!(
                                    "the conversation this one was forked from ({parent}) is gone"
                                )))
                            }
                            snap::TranscriptLocation::Unreadable(error) => {
                                return Err(EffectiveTranscriptError::Unreadable(error))
                            }
                        };
                        let parent_text = std::fs::read_to_string(&path)
                            .map_err(|e| EffectiveTranscriptError::Read(e.to_string()))?;
                        let text = snap::fork_prefix_transcript(&parent_text, at.as_deref())
                            .ok_or_else(|| {
                                EffectiveTranscriptError::Read(format!(
                                    "the point this conversation was forked at is no longer in {parent}"
                                ))
                            })?;
                        Ok(EffectiveTranscript {
                            text,
                            source: parent,
                            source_text: parent_text,
                            source_path: Some(path),
                        })
                    }
                }
            }
        }
    }

    /// `session_id`'s transcript text, when the store has one (`Ok(None)`
    /// when it has none).
    fn read_located_transcript(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, EffectiveTranscriptError> {
        match self.locate_transcript(session_id) {
            snap::TranscriptLocation::Found(path) => std::fs::read_to_string(&path)
                .map(Some)
                .map_err(|e| EffectiveTranscriptError::Read(e.to_string())),
            snap::TranscriptLocation::Absent => Ok(None),
            snap::TranscriptLocation::Unreadable(error) => {
                Err(EffectiveTranscriptError::Unreadable(error))
            }
        }
    }

    /// The replacement takes the original's place (design §4.6, the rollback
    /// re-key): the original's record leaves the sessions map, and every id
    /// that resolved to it (its map key, its durable id, their aliases)
    /// resolves to the replacement, as does its pending naming handle. The
    /// original's record is returned for its teardown. Lock order `cli_index`
    /// then `sessions`, as the adoption's publication takes them.
    async fn replace_runtime(
        &self,
        original_key: &str,
        original_durable: &str,
        replacement: &str,
    ) -> Option<ClaudeSession> {
        let original = {
            let mut index = self.cli_index.lock().await;
            let mut sessions = self.sessions.lock().await;
            let original = sessions.remove(original_key);
            for mapped in index.values_mut() {
                if mapped == original_key {
                    *mapped = replacement.to_string();
                }
            }
            index.insert(original_key.to_string(), replacement.to_string());
            index.insert(original_durable.to_string(), replacement.to_string());
            original
        };
        let handle = self.naming_handles.lock().await.remove(original_key);
        if let Some(handle) = handle {
            self.naming_handles
                .lock()
                .await
                .insert(replacement.to_string(), handle);
        }
        // A replayed create requestId of the original must not answer with
        // its retired map key.
        self.create_dedup
            .clear_for_session(|record| record.session_id == original_key)
            .await;
        original
    }

    /// Tear down a registered replacement whose rollback cannot complete; the
    /// original stays live. A lease the rollback held on the original was
    /// completed onto the replacement and is cleared with it.
    async fn unwind_replacement(
        &self,
        replacement: &str,
        original_durable: &str,
        lease_held: bool,
    ) {
        if let Some(session) = self.sessions.lock().await.remove(replacement) {
            let _teardown: LoggedTeardown = self.teardown_removed_session_logged(session).await;
        }
        self.evict_cli_index_aliases(replacement).await;
        if lease_held {
            self.leases.clear_binding(PROVIDER, original_durable);
        }
    }
}
