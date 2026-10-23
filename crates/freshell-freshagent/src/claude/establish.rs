//! One spawn-and-commit path for claude sidecars (core-runtime design §4.9, C11).
//!
//! Every launch boots its sidecar through [`FreshClaudeState::boot_sidecar`]: spawn
//! the sidecar, arm the lease's kill handle and the start's cancellation, write the
//! launch's one `create` line ([`ClaudeLaunchSpec::create_request`]) and read the
//! sidecar's answer. A create and an attach-resume (the handoff resume is one) then
//! commit the booted sidecar through [`FreshClaudeState::establish_runtime`]:
//!
//! ```text
//! boot → naming admission (create) → kill-fence claim commit (resumes)
//!      → provisional-key rekey (fresh create) → register the session
//!      → alias records (resumes) → post-registration dead-state recheck
//!      → lease completion → coordinator commit (resumes)
//! ```
//!
//! The guards are the ones the create and attach handlers used to run inline,
//! moved here unchanged, so the kill/claim/commit race tests pin this one path. The
//! rollback respawn boots through `boot_sidecar` too; its registration still waits
//! for the fork's first turn until C13 moves it onto `establish_runtime`.

use super::*;

use crate::claude_handshake::{CreateFailure, SidecarCreated};
use crate::claude_launch::ClaudeLaunchSpec;

/// The launch establishing a runtime: it names the failures and the log events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EstablishLane {
    Create,
    AttachResume,
}

impl EstablishLane {
    fn name(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::AttachResume => "attach-resume",
        }
    }
}

/// The map key a new session registers under.
pub(super) enum RegisterUnder {
    /// The id the sidecar minted (`created.sessionId`): a create.
    Minted,
    /// The attaching pane's id: an attach-resume (the client routes the pane's
    /// frames by it).
    Pane(String),
}

/// The durable session a launch claims, with the identity's dead state as it
/// stood when the claim started (before the spawn), so a close that lands while
/// the sidecar boots refuses the commit instead of being undone by it.
pub(super) struct DurableClaim {
    pub(super) durable: String,
    pub(super) dead_state: Option<i64>,
}

/// One runtime to establish.
pub(super) struct EstablishPlan<'a> {
    pub(super) lane: EstablishLane,
    pub(super) spec: ClaudeLaunchSpec,
    pub(super) register_under: RegisterUnder,
    /// The durable session this launch claims (every resume). `None` for a fresh
    /// create: its durable id appears only with its first turn.
    pub(super) claim: Option<DurableClaim>,
    /// A fresh create's coordinator claim is held under its pane-scoped
    /// provisional key; the minted session id takes it over once `created`
    /// names it (b8ke ext r22 F1).
    pub(super) rekey_provisional_claim: bool,
    /// The settings the session records at `sdk.session.init` (`None`: record
    /// nothing, the resume of a session that never recorded any, V7/A10). The
    /// session runs with them, or with the defaults.
    pub(super) recorded_settings: Option<crate::identity_sink::FreshAgentSettings>,
    /// The lifecycle operation that owns this runtime's coordinator transition.
    pub(super) owning_operation: Option<String>,
    pub(super) owning_generation: Option<u64>,
    pub(super) provenance: Option<crate::BindProvenance>,
    /// A create's request: its pending naming handle is admitted under the
    /// minted id once the sidecar answered.
    pub(super) naming: Option<&'a FreshAgentCreate>,
    /// The coordinator key the spawn registers as the start's partial runtime
    /// (the watchdog's reap target), when the start holds a claim.
    pub(super) partial_runtime_key: Option<String>,
    /// The start's cancellation slot: the watchdog signals the spawned sidecar.
    pub(super) start_pid_slot: &'a crate::ownership_lane::SidecarPidSlot,
}

/// A runtime that is registered and committed.
pub(super) struct Established {
    /// The sessions-map key (the minted id, or the attaching pane's id).
    pub(super) map_key: String,
    /// The create's naming projection (the pending handle's record).
    pub(super) naming_projection: Option<(
        freshell_protocol::session_names::SessionNameRef,
        freshell_protocol::session_names::SessionNameRecord,
    )>,
}

/// Why a runtime was not established. Everything the launch spawned is torn down.
#[derive(Debug)]
pub(super) enum EstablishError {
    /// The sidecar process did not start.
    Spawn(String),
    /// The `create` line could not be written.
    Write(String),
    /// The sidecar did not answer `created` (a typed refusal, a protocol
    /// mismatch, or no answer).
    Boot(CreateFailure),
    /// A close of the session landed while the launch was in flight.
    ClosedInFlight,
    /// The launch's lease was revoked while it was in flight.
    LeaseRevoked,
    /// The ownership coordinator moved on while the launch registered.
    OwnershipChanged,
    /// Another owner claimed the minted session id during a fresh create.
    MintedIdClaimed,
}

impl EstablishError {
    /// What went wrong, in words.
    pub(super) fn message(&self, lane: EstablishLane) -> String {
        match self {
            Self::Spawn(detail) | Self::Write(detail) => detail.clone(),
            Self::Boot(failure) => failure.message().to_string(),
            Self::ClosedInFlight => {
                "session closed while the resume was in flight; torn down".to_string()
            }
            Self::LeaseRevoked => {
                format!("session lease revoked during {}; torn down", lane.name())
            }
            Self::OwnershipChanged => format!(
                "session ownership changed during {}; torn down",
                lane.name()
            ),
            Self::MintedIdClaimed => {
                "the minted session id was claimed by another owner during the create; torn down"
                    .to_string()
            }
        }
    }

    /// The `freshAgent.create.failed` code of a create that failed this way.
    pub(super) fn create_code(&self) -> &str {
        match self {
            Self::Spawn(_) => "CLAUDE_SIDECAR_START_FAILED",
            Self::Write(_) => "CLAUDE_SIDECAR_WRITE_FAILED",
            Self::Boot(failure) => failure.code(),
            Self::ClosedInFlight
            | Self::LeaseRevoked
            | Self::OwnershipChanged
            | Self::MintedIdClaimed => "FRESH_AGENT_CREATE_FAILED",
        }
    }

    /// The transient failure a resume reports for this.
    pub(super) fn resume_detail(&self) -> String {
        match self {
            Self::Boot(failure) => format!("{}: {}", failure.code(), failure.message()),
            other => other.message(EstablishLane::AttachResume),
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::Spawn(_) => "spawn",
            Self::Write(_) => "write",
            Self::Boot(_) => "boot",
            Self::ClosedInFlight => "closed_in_flight",
            Self::LeaseRevoked => "lease_revoked",
            Self::OwnershipChanged => "ownership_changed",
            Self::MintedIdClaimed => "minted_id_claimed",
        }
    }
}

/// A sidecar that answered `created`: the CLI booted the launch's conversation.
pub(super) struct BootedSidecar {
    pub(super) child: Child,
    pub(super) stdin: ChildStdin,
    /// The sidecar's stdout, positioned on the line after `created`.
    pub(super) reader: tokio::io::Lines<BufReader<ChildStdout>>,
    pub(super) ownership_id: String,
    pub(super) log_labels: crate::claude_sidecar_io::SidecarLogLabels,
    pub(super) tree_guard: crate::claude_spawn::SidecarTreeGuard,
    pub(super) created: SidecarCreated,
}

/// The start's cancellation, armed with the spawned sidecar.
pub(super) struct StartWatch<'a> {
    pid_slot: &'a crate::ownership_lane::SidecarPidSlot,
    partial_runtime_key: Option<&'a str>,
    ticket: &'a Option<freshell_ownership::OperationTicket>,
}

impl FreshClaudeState {
    /// The transcript store this lane's sidecars write: the roots their CLI
    /// resolves. That is this process's environment, unless the lane gives its
    /// sidecars their own (the `test-support` seam a rig uses), whose
    /// `CLAUDE_CONFIG_DIR`, `CLAUDE_HOME` and `HOME` then decide.
    pub(super) fn transcript_roots(&self) -> Vec<PathBuf> {
        match self.sidecar_environment.as_deref() {
            Some(environment) => {
                let lookup = |key: &str| {
                    environment
                        .iter()
                        .find(|(name, _)| name == key)
                        .map(|(_, value)| value.clone())
                };
                crate::claude_snapshot::claude_home_candidates_from(
                    lookup,
                    lookup("HOME").map(PathBuf::from),
                )
            }
            None => crate::claude_snapshot::claude_home_candidates(),
        }
    }

    /// Where the transcript of `session_id` is in this lane's store.
    pub(super) fn locate_transcript(
        &self,
        session_id: &str,
    ) -> crate::claude_snapshot::TranscriptLocation {
        crate::claude_snapshot::locate_transcript_state_in(&self.transcript_roots(), session_id)
    }

    /// Spawn a sidecar for `spec`, arm the lease's kill handle and (when given)
    /// the start's cancellation, write the launch's `create` line and read the
    /// sidecar's answer, bounded by [`SIDECAR_CREATE_BUDGET`]. A failure kills
    /// what was spawned; the lease is the caller's to release.
    pub(super) async fn boot_sidecar(
        &self,
        spec: &ClaudeLaunchSpec,
        lease_guard: Option<&mut crate::FreshSessionLeaseGuard>,
        start: Option<StartWatch<'_>>,
    ) -> Result<BootedSidecar, EstablishError> {
        let SpawnedSidecar {
            mut child,
            mut stdin,
            stdout,
            ownership_id,
            log_labels,
            tree_guard,
        } = self
            .spawn_sidecar_process(&spec.session_type)
            .await
            .map_err(EstablishError::Spawn)?;
        // Arm the lease's TTL tree-kill path now that the child and its tag exist.
        if let Some(guard) = lease_guard {
            if let Some(pid) = child.id() {
                guard.set_kill_handle(pid, &ownership_id);
            }
        }
        if let Some(start) = start {
            let sidecar_pid = child.id();
            // From here the watchdog's start cancellation signals this child, and
            // the spawn is the start's partial runtime (its reap target).
            crate::ownership_lane::arm_sidecar_pid_slot(start.pid_slot, sidecar_pid);
            if let Some(key) = start.partial_runtime_key {
                crate::ownership_lane::register_partial_fresh_runtime(
                    &self.ownership,
                    PROVIDER,
                    key,
                    start.ticket,
                    key,
                    sidecar_pid,
                );
            }
        }
        if let Err(error) = write_line(&mut stdin, &spec.create_request()).await {
            let _ = child.start_kill();
            reap_owned_claude_sidecars(&ownership_id);
            return Err(EstablishError::Write(error));
        }
        // The sidecar answers `created` only once the CLI has booted the
        // conversation, and a refused boot is a typed `create.failed`, never a
        // session that is already dead. The reader is kept for the consumer, so
        // no line after `created` is lost.
        let mut reader = BufReader::new(stdout).lines();
        let context = BootContext {
            request_id: &spec.request_id,
            session_type: &spec.session_type,
            boot: &spec.boot,
        };
        match read_created(&mut reader, SIDECAR_CREATE_BUDGET, &context).await {
            Ok(created) => Ok(BootedSidecar {
                child,
                stdin,
                reader,
                ownership_id,
                log_labels,
                tree_guard,
                created,
            }),
            Err(failure) => {
                let _ = child.start_kill();
                reap_owned_claude_sidecars(&ownership_id);
                Err(EstablishError::Boot(failure))
            }
        }
    }

    /// Boot a sidecar for `plan` and commit it as the session's live runtime
    /// (design §4.9). Every failure tears down what was spawned and releases the
    /// lease; `own_ticket` is committed on success and otherwise left for the
    /// caller's drop (the RAII typed fail).
    pub(super) async fn establish_runtime(
        &self,
        plan: EstablishPlan<'_>,
        lease_guard: &mut Option<crate::FreshSessionLeaseGuard>,
        own_ticket: &mut Option<freshell_ownership::OperationTicket>,
    ) -> Result<Established, EstablishError> {
        let lane = plan.lane;
        let request_id = plan.spec.request_id.clone();
        let boot_kind = plan.spec.boot.kind();
        let durable = plan.claim.as_ref().map(|claim| claim.durable.clone());
        let outcome = self.establish(plan, lease_guard, own_ticket).await;
        match &outcome {
            Ok(established) => tracing::info!(
                target: "freshell_freshagent::claude",
                event = "freshagent.claude.runtime_established",
                lane = lane.name(),
                request_id = %request_id,
                boot = boot_kind,
                session_id = %established.map_key,
                durable = durable.as_deref(),
                "a claude runtime is established"
            ),
            Err(error) => tracing::warn!(
                target: "freshell_freshagent::claude",
                event = "freshagent.claude.runtime_not_established",
                lane = lane.name(),
                request_id = %request_id,
                boot = boot_kind,
                durable = durable.as_deref(),
                failure = error.kind(),
                message = %error.message(lane),
                "a claude runtime was not established; everything it spawned is torn down"
            ),
        }
        outcome
    }

    async fn establish(
        &self,
        plan: EstablishPlan<'_>,
        lease_guard: &mut Option<crate::FreshSessionLeaseGuard>,
        own_ticket: &mut Option<freshell_ownership::OperationTicket>,
    ) -> Result<Established, EstablishError> {
        let EstablishPlan {
            lane,
            spec,
            register_under,
            claim,
            rekey_provisional_claim,
            recorded_settings,
            owning_operation,
            owning_generation,
            provenance,
            naming,
            partial_runtime_key,
            start_pid_slot,
        } = plan;
        let start = StartWatch {
            pid_slot: start_pid_slot,
            partial_runtime_key: partial_runtime_key.as_deref(),
            ticket: own_ticket,
        };
        let booted = match self
            .boot_sidecar(&spec, lease_guard.as_mut(), Some(start))
            .await
        {
            Ok(booted) => booted,
            Err(error) => {
                // The spawned tree is torn down: releasing the lease is safe.
                if let Some(mut guard) = lease_guard.take() {
                    guard.fail();
                }
                return Err(error);
            }
        };
        let BootedSidecar {
            mut child,
            stdin,
            reader,
            ownership_id,
            log_labels,
            tree_guard,
            created,
        } = booted;
        // The pid for the commit's owner identity (captured before `child` moves
        // into the session record).
        let sidecar_pid = child.id();
        let minted = created.session_id;
        let map_key = match register_under {
            RegisterUnder::Minted => minted.clone(),
            RegisterUnder::Pane(pane) => pane,
        };

        // Unified agent names (Task 2): a create's pending handle is admitted with
        // the minted id BEFORE any failure arm, so no failure strands a handle the
        // pane already carries (retries re-ensure the same handle idempotently).
        let naming_projection = match naming {
            Some(msg) => {
                self.admit_create_handle(msg, &spec.session_type, &minted)
                    .await
            }
            None => None,
        };

        // Retire-on-kill rounds 2-6: a resume GENUINELY CLAIMS the durable id, and
        // the claim commits here, once the replacement is established (`created`
        // answered) and strictly before the consumer starts, so its
        // `sdk.session.init` adoption write never consults a fence whose clear it
        // raced. The commit is conditional on the claim-start dead state: a close
        // that landed while the sidecar booted refuses it with no side effects,
        // and the just-spawned sidecar is an orphan of a pane the user closed. A
        // close fence under the registration seat (the minted id, or the
        // attaching pane's id) blocks the commit exactly like one under the
        // durable id (round 6).
        if let Some(claim) = claim.as_ref() {
            if !self
                .commit_session_claim(
                    &claim.durable,
                    claim.dead_state,
                    std::slice::from_ref(&map_key),
                )
                .await
            {
                let _ = child.start_kill();
                reap_owned_claude_sidecars(&ownership_id);
                if let Some(mut guard) = lease_guard.take() {
                    guard.fail();
                }
                return Err(EstablishError::ClosedInFlight);
            }
        }

        // b8ke ext r22 F1: a fresh create's in-flight coordinator record moves
        // from its pane-scoped provisional key to the minted id in one atomic
        // step (`rekey_starting`; the provisional key becomes the resolution
        // alias an idempotent re-drive adopts through). A record already under
        // the minted id (a competitor claimed it inside the window) refuses
        // typed, and the minted runtime is torn down: never two writers.
        if rekey_provisional_claim {
            if let Some(ticket) = own_ticket.as_mut() {
                let Some(registry) = self.ownership.as_ref() else {
                    unreachable!("a live ticket implies a wired coordinator");
                };
                match registry.rekey_starting(
                    PROVIDER,
                    ticket.session_id(),
                    &minted,
                    ticket.operation_id(),
                    ticket.generation(),
                ) {
                    freshell_ownership::CommitOutcome::Committed => {
                        ticket.rekey_session_id(&minted);
                    }
                    outcome => {
                        tracing::error!(target: "invariant",
                            provider = PROVIDER, session_id = %minted,
                            request_id = %spec.request_id, outcome = ?outcome,
                            "freshagent.claude.create_rekey_refused: the minted session id \
                             was claimed by another owner during the create window — the \
                             minted runtime is torn down (kata b8ke ext r22 F1)"
                        );
                        let _ = child.start_kill();
                        reap_owned_claude_sidecars(&ownership_id);
                        return Err(EstablishError::MintedIdClaimed);
                    }
                }
            }
        }

        // Start the stdout consumer and register the session under the sessions
        // map lock (review PRB-C10): the consumer reaches its session only
        // through that lock, so no line it reads (the boot's command catalog, a
        // CLI death right after the boot) can find the session missing.
        let durable = claim.as_ref().map(|claim| claim.durable.clone());
        let configuration_settings = recorded_settings.clone().unwrap_or_default();
        let broadcast_id = Arc::new(std::sync::Mutex::new(map_key.clone()));
        log_labels.bind_session(&broadcast_id);
        let pending = Arc::new(std::sync::Mutex::new(ClaudePending::default()));
        let in_turn = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let turn_tracker = Arc::new(std::sync::Mutex::new(TurnTracker::default()));
        // Task 5: the session's death-mint clock (see the field doc).
        let last_synthesized_complete_at = Arc::new(std::sync::Mutex::new(None));
        let turn_lock = Arc::new(TokioMutex::new(()));
        // A just-booted session has announced nothing: no turn can be in flight
        // before the client sends.
        let last_status = Arc::new(std::sync::Mutex::new("idle".to_string()));
        {
            let mut sessions = self.sessions.lock().await;
            let consumer = self.spawn_consumer(
                reader,
                map_key.clone(),
                spec.session_type.clone(),
                minted.clone(),
                recorded_settings,
                Arc::clone(&broadcast_id),
                Arc::clone(&pending),
                Arc::clone(&last_status),
                Arc::clone(&in_turn),
                Arc::clone(&turn_tracker),
                Arc::clone(&last_synthesized_complete_at),
                None,
                provenance,
            );
            self.test_holds.registration().await;
            sessions.insert(
                map_key.clone(),
                ClaudeSession {
                    configuration: ClaudeConfiguration {
                        settings: configuration_settings,
                        ..ClaudeConfiguration::default()
                    },
                    stdin,
                    child,
                    tree_guard,
                    ownership_id,
                    consumer,
                    sidecar_session_id: minted,
                    cli_session_id: durable.clone(),
                    // b8ke focused episode-2 round-2 F2: the lifecycle op that owns
                    // this runtime's coordinator transition, so the session-init
                    // adoption's Blocked arm can correlate its own in-flight claim.
                    owning_operation,
                    // b8ke ext r27 F2: the handoff's generation (the under-ticket
                    // target resume) stamps the adoption's binding write.
                    owning_generation,
                    broadcast_id,
                    pending,
                    in_turn,
                    turn_tracker,
                    last_synthesized_complete_at,
                    turn_lock,
                    rollback_probe_slot: Arc::new(std::sync::Mutex::new(None)),
                    last_status,
                },
            );
            // C09: a resumed session is live again, so it is no longer an ended
            // one. Forgotten before the lock is released, so a death of this new
            // incarnation is recorded after it, never forgotten by it.
            if let Some(durable) = durable.as_deref() {
                self.dead_sessions
                    .forget(&[map_key.as_str(), durable], "resumed");
            }
        }
        // V5 interleaving 2 (Task 12): the durable id resolves to the session at
        // registration, not lazily at `sdk.session.init` (hundreds of ms later,
        // exactly when a 1 s loser retry arrives).
        if let Some(durable) = durable.as_deref() {
            self.cli_index
                .lock()
                .await
                .insert(durable.to_string(), map_key.clone());
        }
        // Test seam (Task 6 round-3 review I-1): park with the target session
        // registered but the resume unreturned (the handoff abort-window tests).
        if lane == EstablishLane::AttachResume {
            if let Some(pause) = self.handoff_resume_pause.as_ref() {
                let _ = pause.notified().await;
            }
        }
        // Round 6 (Finding 2): the seat→durable mapping is durable at registration.
        if let Some(durable) = durable.as_deref() {
            if let Some(sink) = self.identity_sink() {
                if let Err(e) = sink
                    .record_alias_tombstone(
                        PROVIDER,
                        &map_key,
                        durable,
                        crate::session_lease::now_epoch_ms() as i64,
                    )
                    .await
                {
                    tracing::warn!(error = %e, session = %durable, placeholder = %map_key,
                        "freshagent.claude.alias_tombstone_write_failed");
                }
            }
        }

        // Round 5 (focused-ep5-r4 Finding 1): the claim's POST-REGISTRATION
        // dead-state recheck. The commit and a kill's retire serialize on the
        // ledger guard, so a kill queued behind the commit lands between the
        // commit and the registration. Now that the session is kill-visible, an
        // advanced fence means the row was retired after the commit: the
        // registered session is a late orphan of the pane the user closed. Kill
        // always wins against an in-flight claim.
        if let Some(claim) = claim.as_ref() {
            if self.claim_dead_state_advanced(&claim.durable, claim.dead_state) {
                tracing::info!(target: "freshell_freshagent::claude",
                    durable = %claim.durable,
                    "freshagent.claude.claim_late_orphan_torn_down: a close landed between the \
                     claim's commit and its registration; the registered orphan is torn down"
                );
                if let Some(session) = self.sessions.lock().await.remove(&map_key) {
                    // R2-2: this unwind holds no coordinator fence, so the
                    // helper's typed log and detached escalation are the whole
                    // discipline here.
                    let _teardown: LoggedTeardown =
                        self.teardown_removed_session_logged(session).await;
                }
                // Demote, never drop: a later kill naming the seat still
                // resolves the durable.
                self.evict_cli_index_aliases(&map_key).await;
                if let Some(mut guard) = lease_guard.take() {
                    guard.fail();
                }
                return Err(EstablishError::ClosedInFlight);
            }
        }

        // Task 12/13: bind the durable id to the live session and release the
        // lease in one lock scope. A revoked lease (an expired handle-less
        // holder) means the session must not be kept.
        if let Some(mut guard) = lease_guard.take() {
            if !guard.complete(&map_key) {
                if let Some(session) = self.sessions.lock().await.remove(&map_key) {
                    session.consumer.abort();
                    let mut child = session.child;
                    let _ = child.start_kill();
                    reap_owned_claude_sidecars(&session.ownership_id);
                }
                if let Some(claim) = claim.as_ref() {
                    // Finding 5's re-raise: the one post-commit failure arm. The
                    // session is torn back down, so the close the commit undid is
                    // durable again (fence re-raised, the revived row re-retired).
                    self.rollback_session_claim(&claim.durable).await;
                    // Finding 1: demote, never drop.
                    self.evict_cli_index_aliases(&map_key).await;
                }
                guard.fail(); // own tree torn down: reopen the key
                return Err(EstablishError::LeaseRevoked);
            }
        }

        // kata b8ke Task 3: the registration survived every teardown gate; commit
        // `Live{FreshAgent}` under the claimed durable id. A fresh create claims
        // no durable id: its canonical commit is the consumer's
        // `sdk.session.init` adoption.
        if claim.is_some() {
            if let Err(outcome) = self.commit_lane_claim_at(own_ticket, &map_key, sidecar_pid) {
                let event = match lane {
                    EstablishLane::Create => "freshagent.claude.create_commit_stale",
                    EstablishLane::AttachResume => "freshagent.claude.attach_commit_stale",
                };
                tracing::error!(target: "invariant",
                    event, provider = PROVIDER, session_id = ?durable,
                    request_id = %spec.request_id, outcome = ?outcome,
                    "{event}: the coordinator moved on while the session registered; the \
                     uncommitted session is torn down"
                );
                if let Some(session) = self.sessions.lock().await.remove(&map_key) {
                    let _teardown: LoggedTeardown =
                        self.teardown_removed_session_logged(session).await;
                }
                self.evict_cli_index_aliases(&map_key).await;
                return Err(EstablishError::OwnershipChanged);
            }
        }

        Ok(Established {
            map_key,
            naming_projection,
        })
    }
}
