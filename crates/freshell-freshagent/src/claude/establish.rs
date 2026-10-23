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
//! moved here unchanged, so the kill/claim/commit race tests pin this one path.
//! An undo or redo establishes its replacement runtime here too (C13): it boots
//! the replacement under the id the rollback minted, registered as already
//! adopted, while the original is still live; the rollback then moves
//! ownership and stops the original (`claude/rollback.rs`). A fork establishes
//! its child the same way, beside the parent, which it never touches
//! (`claude/fork.rs`, C14).

use super::*;

use crate::claude_handshake::{CreateFailure, SidecarCreated};
use crate::claude_launch::{retry_refused_boot, ClaudeLaunchSpec};

/// The launch establishing a runtime: it names the failures and the log events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EstablishLane {
    Create,
    AttachResume,
    /// An undo or redo's replacement runtime.
    Rollback,
    /// A fork's child runtime.
    Fork,
}

impl EstablishLane {
    fn name(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::AttachResume => "attach-resume",
            Self::Rollback => "rollback",
            Self::Fork => "fork",
        }
    }
}

/// The map key a new session registers under.
pub(super) enum RegisterUnder {
    /// The attaching pane's id: an attach-resume (the client routes the pane's
    /// frames by it).
    Pane(String),
    /// A durable id the server minted and the CLI boots under (a rollback's
    /// replacement): registered as already adopted, so it is the map key, the
    /// envelope stamp and the session's durable id at once.
    Adopted(String),
}

/// The per-session state a replacement runtime takes over from the runtime it
/// replaces (an undo or redo, design §4.6): the turn lock a parked send waits
/// on, the turn ledger and the attention clock. Only the process changes.
pub(super) struct InheritedRuntime {
    pub(super) turn_lock: Arc<TokioMutex<()>>,
    pub(super) ledger: crate::claude_turns::SharedLedger,
    pub(super) clock: crate::attention::AttentionClock,
}

/// What a launch's claim of the provider lease on a durable id found (design
/// §4.9 "lease(id)": one live writer per durable transcript).
pub(super) enum LaunchLease {
    /// The lease is the launch's: the armed guard releases it if the launch
    /// fails, and binds it to the registered session if it succeeds.
    Acquired(crate::FreshSessionLeaseGuard),
    /// A live session is bound to the id: the launch adopts it or refuses.
    BoundLive { live_session_key: String },
    /// Another launch holds the lease.
    Held,
    /// An expired holder could not be confirmed dead: the id stays closed.
    ExpiredUnconfirmed,
}

/// The binding row of a session a launch minted with no transcript yet (an
/// undo's replacement, a fork's child; design §4.9 "binding write").
pub(super) struct GenesisBinding<'a> {
    /// The minted id.
    pub(super) session_id: &'a str,
    pub(super) session_type: &'a str,
    /// How it came to be, so a launch before its transcript exists boots it
    /// again (§4.1).
    pub(super) genesis: &'a crate::claude_launch::ClaudeGenesis,
    /// The settings it launched with (the plugins too, G15).
    pub(super) settings: &'a crate::identity_sink::FreshAgentSettings,
    /// The session it replaces (an undo's original): its row retires and links
    /// to this one, and its rollback record follows in the same write.
    pub(super) supersedes: Option<&'a str>,
    /// Whose it is (a fork's forking connection); `None` inherits.
    pub(super) provenance: Option<crate::BindProvenance>,
    /// The launch's coordinator claim: the write is fenced with its pair.
    pub(super) ticket: &'a Option<freshell_ownership::OperationTicket>,
}

/// What a launch that boots a durable session from its recorded state needs
/// for its one typed retry (design §4.2, [`retry_refused_boot`]): the session,
/// and the genesis its binding row records.
pub(super) struct BootRetry {
    pub(super) durable: String,
    pub(super) genesis: Option<crate::claude_launch::ClaudeGenesis>,
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
    /// The state a replacement takes over (a rollback); `None` starts afresh.
    pub(super) inherit: Option<InheritedRuntime>,
    /// The genesis a launch that mints a session with no transcript yet boots
    /// (an undo's replacement, a fork's child): the session keeps it, so its
    /// snapshot shows the conversation before the transcript exists, also on a
    /// lane with no ledger. `None` for every other launch.
    pub(super) genesis: Option<crate::claude_launch::ClaudeGenesis>,
    /// A launch that boots a durable session from its recorded state (a
    /// resume, a boot from its genesis) retries a typed refusal once (design
    /// §4.2). `None` for a launch under an id it minted (an undo, a fork):
    /// its refusals are its own typed answers.
    pub(super) retry: Option<BootRetry>,
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
    /// The established sidecar's pid (the coordinator's owner identity).
    pub(super) sidecar_pid: Option<u32>,
}

/// Why a runtime was not established. Everything the launch spawned is torn down.
#[derive(Debug)]
pub(super) enum EstablishError {
    /// The sidecar process did not start.
    Spawn(String),
    /// The `create` line could not be written.
    Write(String),
    /// The create-time identity could not be made durable.
    Binding(String),
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
            Self::Spawn(detail) | Self::Write(detail) | Self::Binding(detail) => detail.clone(),
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
            Self::Binding(_) => "LEDGER_WRITE_FAILED",
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
            Self::Binding(_) => "binding",
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
    /// A completed lease belongs to its exact sidecar incarnation until the
    /// process tree is confirmed gone. This continuation runs even on hosted
    /// lanes without an ownership coordinator; a replacement's lease is fenced
    /// by its map key and ownership tag.
    pub(super) fn release_leases_after_teardown(
        &self,
        teardown: LoggedTeardown,
        durables: Vec<String>,
        map_key: String,
        ownership_id: Option<String>,
    ) -> LoggedTeardown {
        let leases = self.leases.clone();
        let release = move || {
            if let Some(ownership_id) = ownership_id.as_deref() {
                for durable in &durables {
                    leases.clear_binding_if_matches(PROVIDER, durable, &map_key, ownership_id);
                }
            }
        };
        match teardown {
            LoggedTeardown::Confirmed => {
                release();
                LoggedTeardown::Confirmed
            }
            LoggedTeardown::NotConfirmed { escalation } => LoggedTeardown::NotConfirmed {
                escalation: tokio::spawn(async move {
                    let confirmed = escalation.await.unwrap_or(false);
                    if confirmed {
                        release();
                    }
                    confirmed
                }),
            },
            other => other,
        }
    }

    /// Claim the provider lease on `durable` for the launch `request_id`, the
    /// one claim every launch of a durable id makes (create-resume, attach,
    /// handoff resume, rollback). A holder whose lease expired with a recorded
    /// kill handle is killed, its whole tree confirmed dead by its ownership
    /// tag, and the claim retried once; one that cannot be confirmed dead keeps
    /// the id closed.
    pub(super) async fn claim_launch_lease(&self, durable: &str, request_id: &str) -> LaunchLease {
        for round in 0..2u8 {
            match self.leases.claim(
                PROVIDER,
                durable,
                request_id,
                crate::session_lease::now_epoch_ms(),
            ) {
                crate::session_lease::FreshSessionClaim::Acquired => {
                    return LaunchLease::Acquired(crate::FreshSessionLeaseGuard::armed(
                        Arc::clone(&self.leases),
                        PROVIDER,
                        durable,
                        request_id,
                    ));
                }
                crate::session_lease::FreshSessionClaim::BoundLive { live_session_key } => {
                    return if self.sessions.lock().await.contains_key(&live_session_key) {
                        LaunchLease::BoundLive { live_session_key }
                    } else {
                        // Teardown still owns the completed lease. It releases
                        // only after confirmed death; do not acknowledge its
                        // absent runtime as an adopted live session.
                        LaunchLease::Held
                    };
                }
                crate::session_lease::FreshSessionClaim::Held { .. } => return LaunchLease::Held,
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
                            .force_release_after_confirmed_kill(PROVIDER, durable);
                        continue;
                    }
                    tracing::error!(target: "invariant", pid, session_id = %durable,
                        request_id = %request_id,
                        "fresh_agent_lease_expired_kill_unconfirmed: holding closed");
                    return LaunchLease::ExpiredUnconfirmed;
                }
            }
        }
        LaunchLease::ExpiredUnconfirmed
    }

    /// Write the binding row of a session the launch minted (`binding`),
    /// awaited: durable before the launch answers. A lane with no ledger
    /// records nothing.
    pub(super) async fn record_genesis_binding(
        &self,
        binding: GenesisBinding<'_>,
    ) -> std::io::Result<()> {
        let Some(sink) = self.identity_sink() else {
            return Ok(());
        };
        let fenced = binding.ticket.as_ref().map(|ticket| ticket.generation());
        sink.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
            genesis: crate::identity_sink::GenesisUpdate::Set(binding.genesis.clone()),
            provider: PROVIDER.into(),
            session_id: binding.session_id.to_string(),
            mode: binding.session_type.to_string(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: binding.supersedes.map(str::to_string),
            name_transition: None,
            provenance: binding.provenance.into(),
            observed_epoch: fenced.and(self.ownership.as_ref().map(|r| r.boot_epoch())),
            observed_generation: fenced,
            authoritative: false,
            settings: binding.settings.clone(),
        })
        .await
    }

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
        // The Freshell MCP recipe is resolved per launch (G19), so the
        // setting applies to the next sidecar without a restart.
        let spec = &self.freshell_mcp.launch(spec.clone()).await;
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

    /// The launch to retry after the typed boot refusal `failure` of `spec`
    /// ([`retry_refused_boot`]), logged; `None` when the refusal stands.
    fn retry_spec(
        &self,
        lane: EstablishLane,
        spec: &ClaudeLaunchSpec,
        failure: &CreateFailure,
        retry: &BootRetry,
    ) -> Option<ClaudeLaunchSpec> {
        let planned = retry_refused_boot(
            failure.code(),
            &spec.boot,
            spec.session_id.as_deref(),
            &retry.durable,
            retry.genesis.as_ref(),
            |id| self.locate_transcript(id),
        )?;
        tracing::info!(
            target: "freshell_freshagent::claude",
            event = "freshagent.claude.boot_retry",
            lane = lane.name(),
            request_id = %spec.request_id,
            session_id = %retry.durable,
            code = failure.code(),
            refused = spec.boot.kind(),
            retry = planned.boot.kind(),
            "the CLI refused the boot for a reason the store explains; it is retried once"
        );
        let mut next = spec.clone();
        next.boot = planned.boot;
        next.cwd = planned.cwd.or_else(|| spec.cwd.clone());
        next.session_id = planned.session_id;
        Some(next)
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
            mut spec,
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
            inherit,
            genesis,
            retry,
        } = plan;
        let start = StartWatch {
            pid_slot: start_pid_slot,
            partial_runtime_key: partial_runtime_key.as_deref(),
            ticket: own_ticket,
        };
        let mut booted = self
            .boot_sidecar(&spec, lease_guard.as_mut(), Some(start))
            .await;
        // Design §4.2: a typed refusal the store can explain is retried once,
        // decided again from a fresh look at the store.
        if let (Err(EstablishError::Boot(failure)), Some(retry)) = (&booted, retry.as_ref()) {
            if let Some(retried) = self.retry_spec(lane, &spec, failure, retry) {
                spec = retried;
                let start = StartWatch {
                    pid_slot: start_pid_slot,
                    partial_runtime_key: partial_runtime_key.as_deref(),
                    ticket: own_ticket,
                };
                booted = self
                    .boot_sidecar(&spec, lease_guard.as_mut(), Some(start))
                    .await;
            }
        }
        let booted = match booted {
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
        let (map_key, adopted) = match register_under {
            RegisterUnder::Pane(pane) => (pane, None),
            RegisterUnder::Adopted(id) => (id.clone(), Some(id)),
        };

        // Unified agent names (Task 2): a create's pending handle is admitted with
        // the minted id BEFORE any failure arm, so no failure strands a handle the
        // pane already carries (retries re-ensure the same handle idempotently).
        let mut naming_projection = match naming {
            Some(msg) => {
                self.admit_create_handle(msg, &spec.session_type, &map_key)
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
        let durable = claim
            .as_ref()
            .map(|claim| claim.durable.clone())
            .or(adopted);
        let configuration_settings = recorded_settings.clone().unwrap_or_default();
        let broadcast_id = Arc::new(std::sync::Mutex::new(map_key.clone()));
        log_labels.bind_session(&broadcast_id);
        let pending = Arc::new(std::sync::Mutex::new(ClaudePending::default()));
        // A resume after an unrequested death continues the dead session's
        // attention clock (design §5.5): its edges stay above the death's.
        let resumed_clock = || {
            [Some(map_key.as_str()), durable.as_deref()]
                .into_iter()
                .flatten()
                .find_map(|id| self.dead_sessions.find(id))
                .map(|dead| dead.clock)
        };
        let InheritedRuntime {
            turn_lock,
            ledger,
            // The session's attention clock (see the field doc).
            clock,
        } = inherit.unwrap_or_else(|| InheritedRuntime {
            turn_lock: Arc::new(TokioMutex::new(())),
            ledger: crate::claude_turns::SharedLedger::default(),
            clock: resumed_clock().unwrap_or_default(),
        });
        let (stdin, fault) = crate::claude_sidecar_io::SidecarWriter::spawn(
            stdin,
            log_labels,
            crate::claude_sidecar_io::write_timeout(self.sidecar_environment.as_deref()),
        );
        self.watch_writer_failure(&map_key, &ownership_id, fault);
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
                Arc::clone(&ledger),
                clock.clone(),
                provenance.clone(),
                naming.is_some(),
            );
            self.test_holds.registration().await;
            sessions.insert(
                map_key.clone(),
                ClaudeSession {
                    configuration: ClaudeConfiguration {
                        settings: configuration_settings,
                        freshell_context: spec.freshell_context.clone(),
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
                    ledger,
                    clock,
                    turn_lock,
                    launch_genesis: genesis.map(|genesis| crate::identity_sink::RecordedGenesis {
                        genesis,
                        updated_at_ms: crate::rollback_record::now_ms(),
                    }),
                },
            );
            self.edges.registered(&map_key, &spec.session_type);
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
        if let Some(durable) = claim
            .as_ref()
            .map(|claim| claim.durable.as_str())
            .filter(|durable| *durable != map_key)
        {
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

        // A created session is already a durable identity, including before
        // its first prompt. Write lineage/genesis while the ownership claim
        // still fences the registration, before Live or the acknowledgement.
        if let Some(create) = naming {
            if let Err(error) = self
                .record_create_binding(&map_key, create, provenance.as_ref(), own_ticket)
                .await
            {
                if let Some(session) = { self.sessions.lock().await.remove(&map_key) } {
                    let _teardown: LoggedTeardown =
                        self.teardown_removed_session_logged(session).await;
                }
                self.evict_cli_index_aliases(&map_key).await;
                if let Some(mut guard) = lease_guard.take() {
                    guard.fail();
                }
                if let Some(claim) = claim.as_ref().filter(|claim| claim.dead_state.is_some()) {
                    self.rollback_session_claim(&claim.durable).await;
                }
                return Err(EstablishError::Binding(error.to_string()));
            }
            if let Some(claim) = claim.as_ref() {
                if self.claim_dead_state_advanced(&claim.durable, claim.dead_state) {
                    if let Some(session) = { self.sessions.lock().await.remove(&map_key) } {
                        let _teardown: LoggedTeardown =
                            self.teardown_removed_session_logged(session).await;
                    }
                    self.evict_cli_index_aliases(&map_key).await;
                    if let Some(mut guard) = lease_guard.take() {
                        guard.fail();
                    }
                    return Err(EstablishError::ClosedInFlight);
                }
            }
            naming_projection = self
                .bind_create_name(&map_key, &spec.session_type)
                .await
                .or(naming_projection);
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
                    EstablishLane::AttachResume | EstablishLane::Rollback | EstablishLane::Fork => {
                        "freshagent.claude.attach_commit_stale"
                    }
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
            sidecar_pid,
        })
    }
}
