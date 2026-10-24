//! Stop the owned process for recovery, retaining the conversation's binding.

use super::*;
use freshell_protocol::{FreshAgentRecoveryStop, FreshAgentRecoveryStopped};

type StopFailure = (&'static str, String);

struct RecoveryOperation {
    registry: Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    durable: String,
    operation_id: String,
    generation: u64,
    _settlement: crate::ownership_lane::StopSettlementGuard,
}

impl RecoveryOperation {
    fn commit(&self, state: &FreshClaudeState) -> Result<(), StopFailure> {
        let outcome = crate::ownership_lane::commit_fresh_agent_stop(
            &self.registry,
            PROVIDER,
            &self.durable,
            &self.operation_id,
            self.generation,
        );
        if !matches!(outcome, freshell_ownership::CommitOutcome::Committed) {
            return Err((
                "STALE_CLAIM",
                "Ownership changed while stopping Claude. Refresh and retry.".into(),
            ));
        }
        if let Some(frame) = crate::ownership_lane::released_owner_frame(
            &state.ownership,
            PROVIDER,
            &self.durable,
            &self.operation_id,
            self.registry.boot_epoch(),
            self.generation,
        ) {
            state.broadcast(&frame);
        }
        Ok(())
    }
}

struct RecoveryRuntime {
    session: ClaudeSession,
    map_key: String,
    durable: String,
    aliases: Vec<String>,
    operation: Option<RecoveryOperation>,
}

impl FreshClaudeState {
    pub async fn handle_recovery_stop(&self, msg: FreshAgentRecoveryStop) {
        if msg.provider != freshell_protocol::AgentProvider::Claude
            || !matches!(
                msg.session_type,
                SessionType::Freshclaude | SessionType::Kilroy
            )
        {
            self.reply_recovery_stop(
                &msg,
                Err((
                    "UNSUPPORTED_CAPABILITY",
                    "Recovery stop is unavailable for this provider and session type.".into(),
                )),
            );
            return;
        }
        let fence =
            match crate::ownership_lane::wire_fence(msg.observed_epoch, msg.observed_generation) {
                Ok(fence) => fence,
                Err(error) => {
                    self.reply_recovery_stop(&msg, Err((error.code(), error.message().into())));
                    return;
                }
            };
        let runtime = match self.take_recovery_runtime(&msg, fence).await {
            Ok(Some(runtime)) => runtime,
            Ok(None) => {
                self.reply_recovery_stop(
                    &msg,
                    self.recovery_already_stopped(&msg.session_id, fence),
                );
                return;
            }
            Err(error) => {
                self.reply_recovery_stop(&msg, Err(error));
                return;
            }
        };
        // Capture before the first post-removal await. Cancellation can never
        // leave an unrecorded child tree for the ownership watchdog to probe.
        if let Some(pid) = runtime.session.child.id() {
            let recorded = crate::session_lease::record_condemned_runtime_identity(
                pid,
                CLAUDE_SIDECAR_OWNERSHIP_ENV,
                &runtime.session.ownership_id,
            );
            self.condemned_priors
                .lock()
                .expect("condemned priors lock")
                .insert(runtime.durable.clone(), recorded);
        }
        // The process cleanup owns its operation, lease, and removed session.
        // A canceled requesting handler detaches this task rather than canceling
        // cleanup or leaving a completed lease permanently attached to no runtime.
        let state = self.clone();
        let outcome = tokio::spawn(async move { state.finish_recovery_stop(runtime).await }).await;
        let outcome = outcome.unwrap_or_else(|error| {
            tracing::error!(provider = PROVIDER, request_id = %msg.request_id,
                cause = %error, "freshagent.claude.recovery_stop_task_failed");
            Err((
                "TEARDOWN_FAILED",
                "Claude cleanup did not finish. Try again after it settles.".into(),
            ))
        });
        self.reply_recovery_stop(&msg, outcome);
    }

    async fn take_recovery_runtime(
        &self,
        msg: &FreshAgentRecoveryStop,
        fence: Option<freshell_ownership::ObservedFence>,
    ) -> Result<Option<RecoveryRuntime>, StopFailure> {
        let Some(map_key) = self.resolve_session_key(&msg.session_id).await else {
            return Ok(None);
        };
        // Match the established alias->map lock order. No process I/O or await
        // follows the claim until the removal, pending drain and end are visible.
        let mut sessions = self.sessions.lock().await;
        let Some(session) = sessions.get(&map_key) else {
            return Err((
                "STALE_CLAIM",
                "Claude changed before recovery stopped it. Try again.".into(),
            ));
        };
        let durable = session.identity.current();
        let operation = self.claim_recovery_stop(session, &map_key, &durable, fence)?;
        let aliases = session.identity.ids();
        let mut session = sessions
            .remove(&map_key)
            .expect("validated recovery runtime");
        session.consumer.abort();
        session.quiet.cancel();
        session.ledger.lock().expect("turn ledger lock").eof();
        let stamp = session.identity.current();
        {
            let mut pending = session.pending.lock().expect("pending lock");
            pending.permissions.clear();
            pending.questions.clear();
        }
        self.edges.pending_drained(&stamp);
        self.dead_sessions
            .record(crate::claude_dead_sessions::Death {
                map_key: &map_key,
                stamp: &stamp,
                session_type: &session.session_type,
                durables: &aliases,
                settings: &session.configuration.settings,
                ownership_id: &session.ownership_id,
                launch_genesis: session.launch_genesis.as_ref(),
                turn_lock: &session.turn_lock,
                freshell_context: session.configuration.freshell_context.as_ref(),
                commands: session.configuration.commands.as_ref(),
                reason: "recovery_stop",
                clock: &session.clock,
            });
        self.edges.ended(
            &crate::claude_edges::EdgeRecord {
                session_key: &map_key,
                stamp: &stamp,
                sidecar_session_id: &session.sidecar_session_id,
                session_type: &session.session_type,
                clock: &session.clock,
            },
            false,
            "recovery_stop",
            &session.ownership_id,
        );
        self.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
            provider: PROVIDER.into(),
            session_id: stamp.clone(),
            session_type: session.session_type.clone(),
            event: crate::claude_dead_sessions::exited_status_event(&stamp),
        }));
        Ok(Some(RecoveryRuntime {
            session,
            map_key,
            durable,
            aliases,
            operation,
        }))
    }

    fn claim_recovery_stop(
        &self,
        session: &ClaudeSession,
        map_key: &str,
        durable: &str,
        fence: Option<freshell_ownership::ObservedFence>,
    ) -> Result<Option<RecoveryOperation>, StopFailure> {
        let Some(registry) = self.ownership.as_ref() else {
            return Ok(None);
        };
        let snapshot = registry.observe(PROVIDER, durable);
        if fence.is_some_and(|fence| {
            fence.epoch != snapshot.epoch || fence.generation != snapshot.generation
        }) {
            return Err((
                "STALE_CLAIM",
                "Ownership changed before recovery stopped Claude. Refresh and retry.".into(),
            ));
        }
        let owner = match snapshot.state {
            freshell_ownership::OwnershipState::Live { owner, .. }
                if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
                    && owner.live_session_key.as_deref() == Some(map_key)
                    && owner.pid == session.child.id() =>
            {
                owner
            }
            freshell_ownership::OwnershipState::Vacant => return Ok(None),
            freshell_ownership::OwnershipState::Live { .. } => {
                return Err((
                    "FOREIGN_OWNER",
                    "Another runtime owns this conversation. Refresh and retry.".into(),
                ))
            }
            freshell_ownership::OwnershipState::Handoff { .. } => {
                return Err((
                    "HANDOFF_IN_FLIGHT",
                    "A handoff is moving this conversation. Try again after it settles.".into(),
                ))
            }
            _ => {
                return Err((
                    "LIFECYCLE_IN_FLIGHT",
                    "Claude is already changing runtime. Try again after it settles.".into(),
                ))
            }
        };
        let operation_id = format!("recovery-stop-{}", uuid::Uuid::new_v4());
        let claim = freshell_ownership::StopClaim {
            expected_kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
            expected_runtime: Some(owner),
            observed: fence.unwrap_or(freshell_ownership::ObservedFence {
                epoch: snapshot.epoch,
                generation: snapshot.generation,
            }),
        };
        let generation = match crate::ownership_lane::begin_fresh_agent_stop(
            registry,
            PROVIDER,
            durable,
            &operation_id,
            &claim,
            "freshclaude/recovery-stop",
            crate::session_lease::now_epoch_ms(),
        ) {
            freshell_ownership::StopOutcome::Granted { generation } => generation,
            freshell_ownership::StopOutcome::NotLive {
                state: freshell_ownership::OwnershipState::Vacant,
            } => return Ok(None),
            freshell_ownership::StopOutcome::BlockedHandoff { .. } => {
                return Err((
                    "HANDOFF_IN_FLIGHT",
                    "A handoff is moving this conversation. Try again after it settles.".into(),
                ))
            }
            freshell_ownership::StopOutcome::StaleClaim { .. } => {
                return Err((
                    "STALE_CLAIM",
                    "Ownership changed before recovery stopped Claude. Refresh and retry.".into(),
                ))
            }
            freshell_ownership::StopOutcome::NotLive { .. } => {
                return Err((
                    "LIFECYCLE_IN_FLIGHT",
                    "Claude is already changing runtime. Try again after it settles.".into(),
                ))
            }
        };
        crate::ownership_lane::take_retained_stamp(&self.ownership_stamps, durable);
        let settlement = crate::ownership_lane::register_stop_settlement_for_claim(
            &self.ownership,
            PROVIDER,
            durable,
            &operation_id,
            generation,
        );
        Ok(Some(RecoveryOperation {
            registry: registry.clone(),
            durable: durable.into(),
            operation_id,
            generation,
            _settlement: settlement,
        }))
    }

    async fn finish_recovery_stop(&self, runtime: RecoveryRuntime) -> Result<(), StopFailure> {
        let RecoveryRuntime {
            session,
            map_key,
            durable,
            aliases,
            operation,
        } = runtime;
        let ownership_id = session.ownership_id.clone();
        self.create_dedup
            .clear_for_session(|record| {
                record.session_id == map_key || aliases.contains(&record.session_id)
            })
            .await;

        let teardown = self.teardown_removed_session_logged(session).await;
        let teardown = self.release_leases_after_teardown(
            teardown,
            aliases,
            map_key,
            Some(ownership_id.clone()),
        );
        match teardown {
            LoggedTeardown::Confirmed => {
                self.clear_recovery_prior(&durable, &ownership_id);
                if let Some(operation) = operation {
                    operation.commit(self)?;
                }
                Ok(())
            }
            LoggedTeardown::NotConfirmed { escalation } => {
                let state = self.clone();
                tokio::spawn(async move {
                    if escalation.await.unwrap_or(false) {
                        state.clear_recovery_prior(&durable, &ownership_id);
                        if let Some(operation) = operation {
                            if let Err((code, message)) = operation.commit(&state) {
                                tracing::error!(provider = PROVIDER, session_id = %durable, code, message,
                                    "freshagent.claude.recovery_stop_deferred_commit_failed");
                            }
                        }
                    }
                });
                Err((
                    "TEARDOWN_NOT_CONFIRMED",
                    "Claude is stopping. Try again after its process tree is confirmed gone."
                        .into(),
                ))
            }
            LoggedTeardown::PlatformLimited => {
                if let Some(operation) = operation {
                    let _ = operation.registry.fence_unconfirmed_stop(
                        PROVIDER,
                        &operation.durable,
                        &operation.operation_id,
                        operation.generation,
                        freshell_ownership::FenceReason::PlatformLimited,
                    );
                }
                Err((
                    "TEARDOWN_PLATFORM_LIMITED",
                    "This platform could not confirm Claude's process tree stopped.".into(),
                ))
            }
        }
    }

    fn clear_recovery_prior(&self, durable: &str, ownership_id: &str) {
        let mut priors = self.condemned_priors.lock().expect("condemned priors lock");
        if priors
            .get(durable)
            .is_some_and(|prior| prior.ownership_id == ownership_id)
        {
            priors.remove(durable);
        }
    }

    fn recovery_already_stopped(
        &self,
        id: &str,
        fence: Option<freshell_ownership::ObservedFence>,
    ) -> Result<(), StopFailure> {
        let id = self.resolve_ownership_key(id);
        if self.resuming.lock().expect("resuming lock").contains(&id)
            || self
                .condemned_priors
                .lock()
                .expect("condemned priors lock")
                .contains_key(&id)
        {
            return Err((
                "LIFECYCLE_IN_FLIGHT",
                "Claude is already changing runtime. Try again after it settles.".into(),
            ));
        }
        let snapshot = self.ownership_snapshot(PROVIDER, &id);
        if fence.is_some_and(|fence| {
            fence.epoch != snapshot.epoch || fence.generation != snapshot.generation
        }) {
            return Err((
                "STALE_CLAIM",
                "Ownership changed before recovery stopped Claude. Refresh and retry.".into(),
            ));
        }
        if !matches!(snapshot.state, freshell_ownership::OwnershipState::Vacant) {
            return Err((
                "LIFECYCLE_IN_FLIGHT",
                "Another runtime operation owns this conversation. Refresh and retry.".into(),
            ));
        }
        if self.dead_sessions.find(&id).is_some()
            || self
                .identity_sink()
                .is_some_and(|sink| sink.row_is_bound(PROVIDER, &id))
        {
            Ok(())
        } else {
            Err((
                "INVALID_SESSION_ID",
                "The Claude conversation for this session could not be found.".into(),
            ))
        }
    }

    fn reply_recovery_stop(&self, msg: &FreshAgentRecoveryStop, outcome: Result<(), StopFailure>) {
        let (code, message) = outcome
            .err()
            .map(|(code, message)| (Some(code.into()), Some(message)))
            .unwrap_or_default();
        tracing::info!(provider = PROVIDER, session_id = %msg.session_id, request_id = %msg.request_id,
            success = code.is_none(), code = ?code, "freshagent.claude.recovery_stop_settled");
        self.broadcast(&ServerMessage::FreshAgentRecoveryStopped(
            FreshAgentRecoveryStopped {
                request_id: msg.request_id.clone(),
                provider: PROVIDER.into(),
                session_id: msg.session_id.clone(),
                session_type: session_type_str(msg.session_type).into(),
                success: code.is_none(),
                code,
                message,
            },
        ));
    }
}
