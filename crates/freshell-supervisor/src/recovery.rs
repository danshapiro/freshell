//! Serialized automatic recovery for managed souls.
//!
//! Replacement ordering is intentionally strict:
//! probe -> durable recovery attempt -> stop exact owned enclosure -> verify
//! empty -> prepare one replacement claim -> exact resume -> verify the native
//! identity -> publish LIVE. No branch can substitute a fresh provider session
//! for a failed native resume.

use crate::{
    backend::{BackendError, BackendRuntimeState},
    checkpoints,
    loss_report::{IncidentExporter, LossDecisionInput, LostDecision},
    registry::{OwnedRuntimeHandle, RecoveryContext, RegistryError},
    resume_catalog,
    service::Supervisor,
};
use freshell_agent_runtime::{classify_provider_failure, recovery_paths, verify_native_identity};
use freshell_runtime_protocol::{
    CommandState, DesiredState, EvidenceStoreState, HostCommand, HostResult, IncidentAnalysis,
    IncidentTimelineEvent, LossBuildEvidence, LossCleanupReport, ManagedRolloutMode,
    ReattachHandle, RecoverRequest, RecoveryAttemptId, RecoveryBlockReason,
    RecoveryEvidenceVerdict, RecoveryOutcome, RecoveryPath, RecoveryPathEvidence, RecoveryProbe,
    RecoveryResult, RecoveryTrigger, RetryHint, RuntimeError, RuntimeErrorCode, RuntimeView,
    SoulId, StopOutcome, TerminalLaunchSpec, CONTROL_PROTOCOL_VERSION,
};
use tokio::time::{sleep, Duration, Instant};

impl Supervisor {
    pub(crate) async fn probe_recovery(
        &self,
        soul_id: SoulId,
    ) -> Result<RecoveryProbe, RuntimeError> {
        self.probe_recovery_inner(soul_id).await
    }

    async fn probe_recovery_inner(&self, soul_id: SoulId) -> Result<RecoveryProbe, RuntimeError> {
        let context = self
            .registry
            .recovery_context(soul_id)
            .await
            .map_err(map_registry)?;
        if context.desired_state == DesiredState::Stopped {
            return Ok(blocked(
                RecoveryPath::Reattach,
                RecoveryBlockReason::StopIntent,
                "the durable desired state is STOPPED",
                None,
            ));
        }

        let inspection = match self.backend.inspect(&context.prior_handle).await {
            Ok(inspection) => inspection,
            Err(BackendError::OwnershipMismatch(message)) => {
                return Ok(blocked(
                    RecoveryPath::Reattach,
                    RecoveryBlockReason::OldRuntimeNotEmpty,
                    &message,
                    None,
                ))
            }
            Err(error) => {
                return Ok(blocked(
                    RecoveryPath::Reattach,
                    RecoveryBlockReason::ProviderUnavailable,
                    &error.to_string(),
                    Some(2_000),
                ))
            }
        };

        if inspection.state == BackendRuntimeState::Running {
            match self
                .authenticate_host(
                    context.prior_handle.incarnation_id(),
                    context.prior_handle.runtime_dir(),
                )
                .await
            {
                Ok(host) => {
                    let status = match self
                        .host_status(
                            context.prior_handle.incarnation_id().clone(),
                            context.prior_handle.runtime_dir(),
                            &host,
                        )
                        .await
                    {
                        Ok(status) => status,
                        Err(_) if context.resume_spec.is_some() => return offline_probe(&context),
                        Err(error) => {
                            return Ok(blocked(
                                RecoveryPath::Reattach,
                                RecoveryBlockReason::ProviderUnavailable,
                                &error.message,
                                Some(2_000),
                            ));
                        }
                    };
                    if let Some(native_session_id) = status.native_session_id.as_ref() {
                        self.registry
                            .record_native_session(
                                context.soul_id.clone(),
                                context.prior_handle.incarnation_id().clone(),
                                native_session_id.clone(),
                            )
                            .await
                            .map_err(map_registry)?;
                    }
                    let candidate = match resume_catalog::exact_resume_candidate(
                        &context,
                        status.native_session_id.as_deref(),
                    ) {
                        Ok(candidate) => candidate,
                        Err(probe) => return Ok(probe),
                    };
                    let store_probe = self.probe_host_store(&context, &host, candidate).await?;
                    crate::service::append_event(
                        &self.config.lifecycle_log,
                        "supervisor.recovery.store_probe",
                        serde_json::json!({
                            "soulId": context.soul_id,
                            "incarnationId": context.prior_handle.incarnation_id(),
                            "probe": store_probe,
                        }),
                    );
                    let captured = match store_probe {
                        RecoveryProbe::ResumeReady { resume_spec, .. } => {
                            let stored = self
                                .registry
                                .store_verified_resume_spec(context.soul_id.clone(), *resume_spec)
                                .await
                                .map_err(map_registry)?;
                            RecoveryProbe::ResumeReady {
                                evidence_revision: stored.evidence_revision,
                                resume_spec: Box::new(stored),
                            }
                        }
                        other => other,
                    };

                    if !status.exited {
                        return Ok(RecoveryProbe::ReattachReady {
                            handle: ReattachHandle {
                                incarnation_id: context.prior_handle.incarnation_id().clone(),
                                host_boot_id: status.host_boot_id,
                                container_id: context.prior_handle.container_id().to_string(),
                            },
                            protocol_version: CONTROL_PROTOCOL_VERSION,
                        });
                    }
                    return Ok(after_native_probe(&context, captured));
                }
                Err(_) if context.resume_spec.is_some() => return offline_probe(&context),
                Err(error) => {
                    return Ok(blocked(
                        RecoveryPath::Reattach,
                        RecoveryBlockReason::ProviderUnavailable,
                        &error.message,
                        Some(2_000),
                    ))
                }
            }
        }

        if matches!(
            inspection.state,
            BackendRuntimeState::Exited | BackendRuntimeState::Dead | BackendRuntimeState::Missing
        ) {
            return offline_probe(&context);
        }

        Ok(blocked(
            RecoveryPath::Reattach,
            RecoveryBlockReason::OldRuntimeNotEmpty,
            &format!(
                "owned runtime is {:?}; it is neither attachable nor verified empty",
                inspection.state
            ),
            Some(2_000),
        ))
    }

    async fn probe_host_store(
        &self,
        context: &RecoveryContext,
        host: &crate::service::AuthenticatedHost,
        resume_spec: Option<freshell_runtime_protocol::ResumeSpec>,
    ) -> Result<RecoveryProbe, RuntimeError> {
        let (run_as_uid, run_as_gid) = context
            .terminal
            .as_ref()
            .map(|terminal| (terminal.run_as_uid, terminal.run_as_gid))
            .or_else(|| {
                context
                    .fresh_agent
                    .as_ref()
                    .map(|agent| (agent.run_as_uid, agent.run_as_gid))
            })
            // Test fixtures run as the host's workload user (root inside the
            // enclosure); real providers are always probed as their configured
            // unprivileged uid/gid above.
            .unwrap_or((0, 0));
        match self
            .send_authenticated_host_command(
                context.prior_handle.incarnation_id().clone(),
                context.prior_handle.runtime_dir(),
                host,
                HostCommand::ProbeRecovery {
                    incarnation_id: context.prior_handle.incarnation_id().clone(),
                    resume_spec: resume_spec.map(Box::new),
                    creation_seed_ref: context.creation_seed_ref.clone(),
                    never_dispatched: context.never_dispatched,
                    run_as_uid,
                    run_as_gid,
                },
            )
            .await?
        {
            HostResult::RecoveryProbe(probe) => Ok(probe),
            _ => Err(RuntimeError::new(
                RuntimeErrorCode::HostAuthenticationFailed,
                "unexpected recovery probe reply",
            )),
        }
    }

    pub(crate) async fn recover(
        &self,
        request: RecoverRequest,
    ) -> Result<RecoveryResult, RuntimeError> {
        let lifecycle_lock = self.lifecycle_lock(&request.soul_id).await;
        let _recovery_guard = lifecycle_lock.lock().await;
        self.registry
            .assert_soul_intent_revision(request.soul_id.clone(), request.expected_intent_revision)
            .await
            .map_err(map_registry)?;
        if let Some(view) = self
            .registry
            .inventory()
            .await
            .map_err(map_registry)?
            .into_iter()
            .rev()
            .find(|view| view.soul_id == request.soul_id)
        {
            if view.recovery_state == freshell_runtime_protocol::RecoveryState::Lost {
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Lost,
                    incident_id: view.incident_id.clone(),
                    expected_native_session_id: view.native_session_id.clone(),
                    observed_native_session_id: None,
                    prior_incarnation_id: view.prior_incarnation_id.clone(),
                    attempt_id: None,
                    probe: None,
                    view,
                });
            }
        }
        if self
            .registry
            .retire_unowned_prepared_replacement(request.soul_id.clone())
            .await
            .map_err(map_registry)?
        {
            crate::service::append_event(
                &self.config.lifecycle_log,
                "supervisor.recovery.interrupted_prepared_retired",
                serde_json::json!({"soulId": request.soul_id}),
            );
        }
        if request.trigger == RecoveryTrigger::RetryExhausted {
            let evidence =
                vec!["bounded automatic retry schedule exhausted (initial, 2s, 10s)".into()];
            let probe = RecoveryProbe::Blocked {
                path: RecoveryPath::NativeResume,
                reason: RecoveryBlockReason::RetryBudget,
                retry_hint: freshell_runtime_protocol::RetryHint {
                    automatic_after_ms: None,
                    manual_retry: true,
                    repair: Some("repair the dependency, then explicitly retry this soul".into()),
                },
                evidence: evidence.clone(),
            };
            self.registry
                .mark_recovery_blocked(
                    request.soul_id.clone(),
                    None,
                    RecoveryBlockReason::RetryBudget,
                    evidence,
                )
                .await
                .map_err(map_registry)?;
            let context = self
                .registry
                .recovery_context(request.soul_id)
                .await
                .map_err(map_registry)?;
            return Ok(RecoveryResult {
                outcome: RecoveryOutcome::Blocked,
                view: self.view_for(context.prior_handle.incarnation_id()).await?,
                probe: Some(probe),
                prior_incarnation_id: None,
                attempt_id: None,
                expected_native_session_id: None,
                observed_native_session_id: None,
                incident_id: None,
            });
        }
        let probe = self.probe_recovery_inner(request.soul_id.clone()).await?;
        match probe.clone() {
            RecoveryProbe::ReattachReady { handle, .. } => {
                self.registry
                    .mark_recovery_live(request.soul_id.clone(), handle.incarnation_id.clone())
                    .await
                    .map_err(map_registry)?;
                Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Reattached,
                    view: self.view_for(&handle.incarnation_id).await?,
                    probe: Some(probe),
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: None,
                    observed_native_session_id: None,
                    incident_id: None,
                })
            }
            RecoveryProbe::Blocked {
                reason, evidence, ..
            } => {
                if reason == RecoveryBlockReason::StopIntent {
                    let context = self
                        .registry
                        .recovery_context(request.soul_id)
                        .await
                        .map_err(map_registry)?;
                    return Ok(RecoveryResult {
                        outcome: RecoveryOutcome::Stopped,
                        view: self.view_for(context.prior_handle.incarnation_id()).await?,
                        probe: Some(probe),
                        prior_incarnation_id: None,
                        attempt_id: None,
                        expected_native_session_id: None,
                        observed_native_session_id: None,
                        incident_id: None,
                    });
                }
                self.registry
                    .mark_recovery_blocked(request.soul_id.clone(), None, reason, evidence)
                    .await
                    .map_err(map_registry)?;
                let context = self
                    .registry
                    .recovery_context(request.soul_id)
                    .await
                    .map_err(map_registry)?;
                Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Blocked,
                    view: self.view_for(context.prior_handle.incarnation_id()).await?,
                    probe: Some(probe),
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: None,
                    observed_native_session_id: None,
                    incident_id: None,
                })
            }
            RecoveryProbe::DefinitivelyUnavailable { .. } => {
                // Legacy and opt-out rollout states retain Phase 3 semantics:
                // a definitive provider-path negative is preserved as BLOCKED.
                // Only newly opted-in/default managed operation may authorize
                // the stricter Phase 5 loss certificate and cleanup pipeline.
                if self.registry.rollout_mode().await.map_err(map_registry)?
                    == ManagedRolloutMode::Legacy
                {
                    return self
                        .preserve_definitive_as_blocked(request.soul_id, probe)
                        .await;
                }
                // Loss authority requires a fresh second probe after every
                // recovery path has already reported a negative. A late host,
                // store, checkpoint, or stop-intent transition cancels loss.
                let rechecked = self.probe_recovery_inner(request.soul_id.clone()).await?;
                match rechecked.clone() {
                    RecoveryProbe::ReattachReady { handle, .. } => {
                        self.registry
                            .mark_recovery_live(
                                request.soul_id.clone(),
                                handle.incarnation_id.clone(),
                            )
                            .await
                            .map_err(map_registry)?;
                        Ok(RecoveryResult {
                            outcome: RecoveryOutcome::Reattached,
                            view: self.view_for(&handle.incarnation_id).await?,
                            probe: Some(rechecked),
                            prior_incarnation_id: None,
                            attempt_id: None,
                            expected_native_session_id: None,
                            observed_native_session_id: None,
                            incident_id: None,
                        })
                    }
                    RecoveryProbe::ResumeReady { resume_spec, .. } => {
                        let path = if resume_spec.checkpoint_revision > 0 {
                            RecoveryPath::CheckpointRestore
                        } else {
                            RecoveryPath::NativeResume
                        };
                        self.replace(
                            request.soul_id,
                            request.trigger,
                            path,
                            Some(*resume_spec),
                            rechecked,
                        )
                        .await
                    }
                    RecoveryProbe::PristineSeedReady { .. } => {
                        self.replace(
                            request.soul_id,
                            request.trigger,
                            RecoveryPath::PristineSeed,
                            None,
                            rechecked,
                        )
                        .await
                    }
                    RecoveryProbe::Blocked {
                        reason, evidence, ..
                    } => {
                        self.registry
                            .mark_recovery_blocked(request.soul_id.clone(), None, reason, evidence)
                            .await
                            .map_err(map_registry)?;
                        let context = self
                            .registry
                            .recovery_context(request.soul_id)
                            .await
                            .map_err(map_registry)?;
                        Ok(RecoveryResult {
                            outcome: if reason == RecoveryBlockReason::StopIntent {
                                RecoveryOutcome::Stopped
                            } else {
                                RecoveryOutcome::Blocked
                            },
                            view: self.view_for(context.prior_handle.incarnation_id()).await?,
                            probe: Some(rechecked),
                            prior_incarnation_id: None,
                            attempt_id: None,
                            expected_native_session_id: None,
                            observed_native_session_id: None,
                            incident_id: None,
                        })
                    }
                    RecoveryProbe::DefinitivelyUnavailable { .. } => {
                        self.certify_and_cleanup_loss(request.soul_id, request.trigger, rechecked)
                            .await
                    }
                }
            }
            RecoveryProbe::ResumeReady { resume_spec, .. } => {
                let path = if resume_spec.checkpoint_revision > 0 {
                    RecoveryPath::CheckpointRestore
                } else {
                    RecoveryPath::NativeResume
                };
                self.replace(
                    request.soul_id,
                    request.trigger,
                    path,
                    Some(*resume_spec),
                    probe,
                )
                .await
            }
            RecoveryProbe::PristineSeedReady { .. } => {
                self.replace(
                    request.soul_id,
                    request.trigger,
                    RecoveryPath::PristineSeed,
                    None,
                    probe,
                )
                .await
            }
        }
    }

    async fn replace(
        &self,
        soul_id: SoulId,
        trigger: RecoveryTrigger,
        path: RecoveryPath,
        resume_spec: Option<freshell_runtime_protocol::ResumeSpec>,
        probe: RecoveryProbe,
    ) -> Result<RecoveryResult, RuntimeError> {
        let recovery_started = Instant::now();
        let start = match self
            .registry
            .begin_recovery(soul_id.clone(), trigger, path)
            .await
        {
            Ok(start) => start,
            Err(RegistryError::RecoveryBlocked { reason, .. })
                if reason.contains("STOP_INTENT") =>
            {
                let context = self
                    .registry
                    .recovery_context(soul_id)
                    .await
                    .map_err(map_registry)?;
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Stopped,
                    view: self.view_for(context.prior_handle.incarnation_id()).await?,
                    probe: Some(blocked(
                        path,
                        RecoveryBlockReason::StopIntent,
                        &reason,
                        None,
                    )),
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: None,
                    observed_native_session_id: None,
                    incident_id: None,
                });
            }
            Err(error) => return Err(map_registry(error)),
        };
        let prior_incarnation_id = start.context.prior_handle.incarnation_id().clone();
        let attempt_id = start.attempt_id.clone();

        let stop_outcome = self
            .terminate_owned_for_recovery(&start.context.prior_handle)
            .await?;
        if stop_outcome != StopOutcome::VerifiedEmpty {
            let reason = RecoveryBlockReason::OldRuntimeNotEmpty;
            self.registry
                .mark_recovery_blocked(
                    soul_id.clone(),
                    Some(attempt_id.clone()),
                    reason,
                    vec![format!("stopOutcome={stop_outcome:?}")],
                )
                .await
                .map_err(map_registry)?;
            return Ok(RecoveryResult {
                outcome: RecoveryOutcome::Blocked,
                view: self.view_for(&prior_incarnation_id).await?,
                probe: Some(blocked(
                    path,
                    reason,
                    "the prior enclosure could not be proved empty",
                    Some(2_000),
                )),
                prior_incarnation_id: Some(prior_incarnation_id),
                attempt_id: Some(attempt_id),
                expected_native_session_id: resume_spec
                    .as_ref()
                    .map(|spec| spec.provider_session.native_session_id.clone()),
                observed_native_session_id: None,
                incident_id: None,
            });
        }

        let replacement_terminal = if resume_spec.is_some() {
            terminal_without_first_boot_state(start.context.terminal.clone())
        } else {
            start.context.terminal.clone()
        };
        let prepared = match self
            .registry
            .prepare_replacement(
                start.clone(),
                replacement_terminal,
                start.context.fresh_agent.clone(),
                resume_spec.clone(),
                path,
            )
            .await
        {
            Ok(prepared) => prepared,
            Err(RegistryError::RecoveryBlocked { reason, .. })
                if reason.contains("STOP_INTENT") || reason.contains("STALE_ATTEMPT") =>
            {
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Stopped,
                    view: self.view_for(&prior_incarnation_id).await?,
                    probe: Some(blocked(
                        path,
                        RecoveryBlockReason::StopIntent,
                        &reason,
                        None,
                    )),
                    prior_incarnation_id: Some(prior_incarnation_id),
                    attempt_id: Some(attempt_id),
                    expected_native_session_id: resume_spec
                        .as_ref()
                        .map(|spec| spec.provider_session.native_session_id.clone()),
                    observed_native_session_id: None,
                    incident_id: None,
                });
            }
            Err(error) => return Err(map_registry(error)),
        };

        let launch = self
            .activate_prepared(
                prepared.prepared.clone(),
                soul_id.clone(),
                prepared.fixture,
                prepared.terminal.clone(),
                prepared.fresh_agent.clone(),
                prepared.resume_spec.clone(),
                start.context.requested_limits,
            )
            .await;
        match launch {
            Ok(_) => {}
            Err(error) => {
                let reason = classify_provider_failure(&error.message);
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.recovery.activation_failed",
                    recovery_activation_failure_data(
                        &soul_id,
                        &prior_incarnation_id,
                        &prepared.prepared.incarnation_id,
                        &attempt_id,
                        path,
                        reason,
                        &error,
                    ),
                );
                self.cleanup_failed_replacement(&prepared.prepared.incarnation_id)
                    .await;
                self.registry
                    .mark_recovery_blocked(
                        soul_id.clone(),
                        Some(attempt_id.clone()),
                        reason,
                        vec![error.message.clone()],
                    )
                    .await
                    .map_err(map_registry)?;
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Blocked,
                    view: self
                        .view_for_or_prior(&prepared.prepared.incarnation_id, &prior_incarnation_id)
                        .await?,
                    probe: Some(blocked(path, reason, &error.message, Some(2_000))),
                    prior_incarnation_id: Some(prior_incarnation_id),
                    attempt_id: Some(attempt_id),
                    expected_native_session_id: resume_spec
                        .as_ref()
                        .map(|spec| spec.provider_session.native_session_id.clone()),
                    observed_native_session_id: None,
                    incident_id: None,
                });
            }
        };

        let expected_native_session_id = resume_spec
            .as_ref()
            .map(|spec| spec.provider_session.native_session_id.clone());
        let observed_native_session_id = if let Some(expected) =
            expected_native_session_id.as_deref()
        {
            let observed = self
                .wait_for_native_identity(&prepared.prepared.incarnation_id)
                .await?;
            if let Err(error) = verify_native_identity(expected, observed.as_deref()) {
                self.cleanup_failed_replacement(&prepared.prepared.incarnation_id)
                    .await;
                self.registry
                    .mark_recovery_blocked(
                        soul_id.clone(),
                        Some(attempt_id.clone()),
                        RecoveryBlockReason::WrongNativeIdentity,
                        vec![error.to_string()],
                    )
                    .await
                    .map_err(map_registry)?;
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Blocked,
                    view: self
                        .view_for_or_prior(&prepared.prepared.incarnation_id, &prior_incarnation_id)
                        .await?,
                    probe: Some(blocked(
                        path,
                        RecoveryBlockReason::WrongNativeIdentity,
                        &error.to_string(),
                        None,
                    )),
                    prior_incarnation_id: Some(prior_incarnation_id),
                    attempt_id: Some(attempt_id),
                    expected_native_session_id,
                    observed_native_session_id: observed,
                    incident_id: None,
                });
            }
            observed
        } else {
            None
        };

        if let Err(message) = self
            .replay_queued_inputs(soul_id.clone(), prepared.prepared.incarnation_id.clone())
            .await
        {
            self.registry
                .mark_recovery_blocked(
                    soul_id.clone(),
                    Some(attempt_id.clone()),
                    RecoveryBlockReason::CommandAmbiguous,
                    vec![message.clone()],
                )
                .await
                .map_err(map_registry)?;
            return Ok(RecoveryResult {
                outcome: RecoveryOutcome::Blocked,
                view: self.view_for(&prepared.prepared.incarnation_id).await?,
                probe: Some(blocked(
                    path,
                    RecoveryBlockReason::CommandAmbiguous,
                    &message,
                    None,
                )),
                prior_incarnation_id: Some(prior_incarnation_id),
                attempt_id: Some(attempt_id),
                expected_native_session_id,
                observed_native_session_id,
                incident_id: None,
            });
        }

        let provider = start.context.provider.clone();
        self.registry
            .mark_recovery_success(
                soul_id,
                prepared.prepared.incarnation_id.clone(),
                attempt_id.clone(),
            )
            .await
            .map_err(map_registry)?;
        let elapsed_ms = recovery_started
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;
        for (name, label) in [
            ("recovery_outcome", format!("{provider}:replaced")),
            (
                "recovery_downtime_bucket",
                format!("{provider}:{}", downtime_bucket(elapsed_ms)),
            ),
            (
                "checkpoint_age_bucket",
                format!(
                    "{provider}:{}",
                    if path == RecoveryPath::CheckpointRestore {
                        "verified_restore"
                    } else {
                        "not_used"
                    }
                ),
            ),
        ] {
            if let Err(error) = self
                .registry
                .increment_runtime_counter(name, label, 1)
                .await
            {
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.metrics.counter_failed",
                    serde_json::json!({"name": name, "error": error.to_string()}),
                );
            }
        }
        Ok(RecoveryResult {
            outcome: RecoveryOutcome::Replaced,
            view: self.view_for(&prepared.prepared.incarnation_id).await?,
            probe: Some(probe),
            prior_incarnation_id: Some(prior_incarnation_id),
            attempt_id: Some(attempt_id),
            expected_native_session_id,
            observed_native_session_id,
            incident_id: None,
        })
    }

    async fn preserve_definitive_as_blocked(
        &self,
        soul_id: SoulId,
        probe: RecoveryProbe,
    ) -> Result<RecoveryResult, RuntimeError> {
        let (path, message, evidence) = match &probe {
            RecoveryProbe::DefinitivelyUnavailable {
                path,
                reason,
                evidence,
                ..
            } => (*path, reason.clone(), evidence.clone()),
            _ => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvalidRequest,
                    "legacy loss preservation requires a definitive-negative probe",
                ))
            }
        };
        let mut preserved_evidence = evidence;
        preserved_evidence.push("rolloutMode=legacy".into());
        preserved_evidence.push(format!("definitiveNegative={message}"));
        self.registry
            .mark_recovery_blocked(
                soul_id.clone(),
                None,
                RecoveryBlockReason::ImplementationUnavailable,
                preserved_evidence.clone(),
            )
            .await
            .map_err(map_registry)?;
        let context = self
            .registry
            .recovery_context(soul_id)
            .await
            .map_err(map_registry)?;
        Ok(RecoveryResult {
            outcome: RecoveryOutcome::Blocked,
            view: self.view_for(context.prior_handle.incarnation_id()).await?,
            probe: Some(RecoveryProbe::Blocked {
                path,
                reason: RecoveryBlockReason::ImplementationUnavailable,
                retry_hint: RetryHint {
                    automatic_after_ms: None,
                    manual_retry: true,
                    repair: Some(
                        "enable managed-opt-in/default only after migration preflight and backup"
                            .into(),
                    ),
                },
                evidence: preserved_evidence,
            }),
            prior_incarnation_id: None,
            attempt_id: None,
            expected_native_session_id: context.native_session_id,
            observed_native_session_id: None,
            incident_id: None,
        })
    }

    async fn certify_and_cleanup_loss(
        &self,
        soul_id: SoulId,
        trigger: RecoveryTrigger,
        definitive_probe: RecoveryProbe,
    ) -> Result<RecoveryResult, RuntimeError> {
        let context = self
            .registry
            .recovery_context(soul_id.clone())
            .await
            .map_err(map_registry)?;
        let path_evidence = match self
            .collect_loss_path_evidence(&context, &definitive_probe)
            .await
        {
            Ok(evidence) => evidence,
            Err(probe) => {
                return self.preserve_nonloss_probe(soul_id, trigger, probe).await;
            }
        };
        let provider_version = context
            .resume_spec
            .as_ref()
            .and_then(|spec| spec.provider_version.clone())
            .unwrap_or_else(|| match context.provider.as_str() {
                "shell" => "builtin-shell".into(),
                "phase1-fixture" | "native-session-fixture" => "native-session-fixture-v1".into(),
                provider => format!("unreported-{provider}"),
            });
        let now = freshell_runtime_observability::now_rfc3339_millis();
        let observed_cause = match &definitive_probe {
            RecoveryProbe::DefinitivelyUnavailable { reason, .. } => reason.clone(),
            _ => "all recovery paths were exhausted".into(),
        };
        let analysis = IncidentAnalysis {
            observed_cause: observed_cause.clone(),
            missing_invariant: "no live enclosure, readable native store, verified checkpoint, or pristine never-dispatched seed remained".into(),
            hypotheses: vec![
                "provider state was removed or became irreversibly inconsistent".into(),
                "the runtime exited after its last durable recovery artifact disappeared".into(),
            ],
            preventive_action: "retain and continuously verify at least one independent native-store or checkpoint recovery artifact".into(),
            regression_case: "P5-G02".into(),
        };
        let decision = match LostDecision::try_new(LossDecisionInput {
            installation_id: self.registry.installation_id(),
            context: &context,
            cleanup_handle: &context.prior_handle,
            path_evidence,
            builds: LossBuildEvidence {
                web_commit: option_env!("FRESHELL_BUILD_COMMIT")
                    .unwrap_or("unknown")
                    .into(),
                supervisor_commit: option_env!("FRESHELL_BUILD_COMMIT")
                    .unwrap_or("unknown")
                    .into(),
                host_image_digest: self.config.image_ref.clone(),
                provider_version,
                protocol_version: CONTROL_PROTOCOL_VERSION,
                registry_schema_version: crate::registry::SCHEMA_VERSION,
            },
            timeline: vec![
                IncidentTimelineEvent {
                    seq: 1,
                    at: now.clone(),
                    event: format!("recovery_trigger:{trigger:?}"),
                    evidence_ref: Some(format!(
                        "registry://soul/{}/incarnation/{}",
                        soul_id,
                        context.prior_handle.incarnation_id()
                    )),
                    exit_code: None,
                    oom_killed: None,
                },
                IncidentTimelineEvent {
                    seq: 2,
                    at: now.clone(),
                    event: "all_applicable_recovery_paths_definitively_negative".into(),
                    evidence_ref: Some("capability-manifest://recoveryPaths".into()),
                    exit_code: None,
                    oom_killed: None,
                },
            ],
            analysis,
            created_at: Some(now.clone()),
        }) {
            Ok(decision) => decision,
            Err(error) => {
                let message = format!("loss certification blocked: {error}");
                self.registry
                    .mark_recovery_blocked(
                        soul_id.clone(),
                        None,
                        RecoveryBlockReason::ImplementationUnavailable,
                        vec![message.clone()],
                    )
                    .await
                    .map_err(map_registry)?;
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.loss.certification_blocked",
                    serde_json::json!({"soulId": soul_id, "error": message}),
                );
                return Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Blocked,
                    view: self.view_for(context.prior_handle.incarnation_id()).await?,
                    probe: Some(blocked(
                        RecoveryPath::NativeResume,
                        RecoveryBlockReason::ImplementationUnavailable,
                        &message,
                        None,
                    )),
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: context.native_session_id,
                    observed_native_session_id: None,
                    incident_id: None,
                });
            }
        };

        // The SQLite transaction below is the destructive-action gate. If it
        // cannot durably commit the incident and export intent, no stop signal
        // is sent and the caller receives an explicit persistence failure.
        let prepared = self
            .registry
            .prepare_loss(decision)
            .await
            .map_err(|error| {
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.loss.incident_commit_failed",
                    serde_json::json!({"soulId": soul_id, "error": error.to_string()}),
                );
                RuntimeError::new(
                    RuntimeErrorCode::IncidentPersistenceFailed,
                    format!("incident-before-cleanup commit failed: {error}"),
                )
            })?;
        crate::service::append_event(
            &self.config.lifecycle_log,
            "supervisor.loss.incident_committed",
            serde_json::json!({
                "soulId": soul_id,
                "incidentId": prepared.certificate.incident_id,
                "cleanupTarget": prepared.certificate.cleanup_target.owned_handle_ref,
                "foreignObjectsTouched": 0,
            }),
        );
        crate::service::crash_if("after_loss_incident_commit");
        self.export_pending_incidents().await;

        let preexisting_empty = self
            .backend
            .verify_empty(&prepared.handle)
            .await
            .unwrap_or(false);
        let outcome = self.terminate_owned_for_loss(&prepared.handle).await?;
        let verified_empty = outcome == StopOutcome::VerifiedEmpty;
        let cleanup = LossCleanupReport {
            owned_handle_ref: prepared.certificate.cleanup_target.owned_handle_ref.clone(),
            ownership_verified: true,
            graceful_attempt: if preexisting_empty {
                "not_required".into()
            } else {
                "authenticated_host_and_exact_backend_stop_requested".into()
            },
            forced_attempt: if preexisting_empty {
                "not_required".into()
            } else if verified_empty {
                "attempted_only_if_graceful_verification_required_escalation".into()
            } else {
                "attempted_if_safe_but_empty_state_unconfirmed".into()
            },
            verified_empty,
            verified_at: verified_empty.then(freshell_runtime_observability::now_rfc3339_millis),
            foreign_objects_touched: 0,
        };
        crate::service::crash_if("after_loss_cleanup_before_finalize");
        let incident_id = prepared.certificate.incident_id.clone();
        let _notice = self
            .registry
            .finalize_loss_cleanup(incident_id.clone(), outcome, cleanup)
            .await
            .map_err(map_registry)?;
        crate::service::crash_if("after_loss_finalize_before_export");
        self.export_pending_incidents().await;
        crate::service::append_event(
            &self.config.lifecycle_log,
            "supervisor.loss.finalized",
            serde_json::json!({
                "soulId": soul_id,
                "incidentId": incident_id,
                "cleanupOutcome": outcome,
                "foreignObjectsTouched": 0,
            }),
        );
        Ok(RecoveryResult {
            outcome: RecoveryOutcome::Lost,
            view: self.view_for(prepared.handle.incarnation_id()).await?,
            probe: Some(definitive_probe),
            prior_incarnation_id: None,
            attempt_id: None,
            expected_native_session_id: context.native_session_id,
            observed_native_session_id: None,
            incident_id: Some(incident_id),
        })
    }

    async fn preserve_nonloss_probe(
        &self,
        soul_id: SoulId,
        trigger: RecoveryTrigger,
        probe: RecoveryProbe,
    ) -> Result<RecoveryResult, RuntimeError> {
        match probe.clone() {
            RecoveryProbe::ReattachReady { handle, .. } => {
                self.registry
                    .mark_recovery_live(soul_id, handle.incarnation_id.clone())
                    .await
                    .map_err(map_registry)?;
                Ok(RecoveryResult {
                    outcome: RecoveryOutcome::Reattached,
                    view: self.view_for(&handle.incarnation_id).await?,
                    probe: Some(probe),
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: None,
                    observed_native_session_id: None,
                    incident_id: None,
                })
            }
            RecoveryProbe::ResumeReady { resume_spec, .. } => {
                let path = if resume_spec.checkpoint_revision > 0 {
                    RecoveryPath::CheckpointRestore
                } else {
                    RecoveryPath::NativeResume
                };
                self.replace(soul_id, trigger, path, Some(*resume_spec), probe)
                    .await
            }
            RecoveryProbe::PristineSeedReady { .. } => {
                self.replace(soul_id, trigger, RecoveryPath::PristineSeed, None, probe)
                    .await
            }
            RecoveryProbe::Blocked {
                reason, evidence, ..
            } => {
                self.registry
                    .mark_recovery_blocked(soul_id.clone(), None, reason, evidence)
                    .await
                    .map_err(map_registry)?;
                let context = self
                    .registry
                    .recovery_context(soul_id)
                    .await
                    .map_err(map_registry)?;
                Ok(RecoveryResult {
                    outcome: if reason == RecoveryBlockReason::StopIntent {
                        RecoveryOutcome::Stopped
                    } else {
                        RecoveryOutcome::Blocked
                    },
                    view: self.view_for(context.prior_handle.incarnation_id()).await?,
                    probe: Some(probe),
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: context.native_session_id,
                    observed_native_session_id: None,
                    incident_id: None,
                })
            }
            RecoveryProbe::DefinitivelyUnavailable { .. } => Err(RuntimeError::new(
                RuntimeErrorCode::LossCertificationBlocked,
                "loss evidence collector returned a second unhandled definitive-negative probe",
            )),
        }
    }

    async fn collect_loss_path_evidence(
        &self,
        context: &RecoveryContext,
        native_probe: &RecoveryProbe,
    ) -> Result<Vec<RecoveryPathEvidence>, RecoveryProbe> {
        let provider_paths = recovery_paths(&context.provider).ok_or_else(|| {
            blocked(
                RecoveryPath::NativeResume,
                RecoveryBlockReason::ImplementationUnavailable,
                "provider has no recovery capability manifest entry",
                None,
            )
        })?;
        let mut evidence = Vec::new();
        for path in provider_paths {
            let row = match path {
                RecoveryPath::Reattach => self.prove_reattach_unavailable(context).await?,
                RecoveryPath::NativeResume => match native_probe {
                    RecoveryProbe::DefinitivelyUnavailable {
                        reason,
                        evidence,
                        store_state,
                        ..
                    } => {
                        if matches!(
                            store_state,
                            EvidenceStoreState::Unknown | EvidenceStoreState::PresentUnreadable
                        ) {
                            return Err(blocked(
                                RecoveryPath::NativeResume,
                                RecoveryBlockReason::StoreUnreadable,
                                "native provider state is not definitively readable or missing",
                                None,
                            ));
                        }
                        RecoveryPathEvidence {
                            path: RecoveryPath::NativeResume,
                            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                            reason_code: reason.clone(),
                            evidence_refs: evidence.clone(),
                            store_state: *store_state,
                        }
                    }
                    other => return Err(other.clone()),
                },
                RecoveryPath::CheckpointRestore => {
                    match checkpoints::probe_after_provider(context, native_probe) {
                        RecoveryProbe::DefinitivelyUnavailable {
                            reason,
                            evidence,
                            store_state,
                            ..
                        } => RecoveryPathEvidence {
                            path: RecoveryPath::CheckpointRestore,
                            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                            reason_code: reason,
                            evidence_refs: evidence,
                            store_state,
                        },
                        other => return Err(other),
                    }
                }
                RecoveryPath::PristineSeed => {
                    if context.never_dispatched {
                        return Err(RecoveryProbe::PristineSeedReady {
                            seed: context.creation_seed_ref.clone(),
                            never_dispatched_proof: format!(
                                "{}:command-journal-empty",
                                context.prior_handle.incarnation_id()
                            ),
                        });
                    }
                    RecoveryPathEvidence {
                        path: RecoveryPath::PristineSeed,
                        verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                        reason_code: "input_was_dispatched".into(),
                        evidence_refs: vec![
                            format!("acceptedCommandCount={}", context.accepted_command_count),
                            format!("completedCommandCount={}", context.completed_command_count),
                        ],
                        store_state: EvidenceStoreState::NotApplicable,
                    }
                }
                RecoveryPath::NativeImport => {
                    return Err(blocked(
                        RecoveryPath::NativeImport,
                        RecoveryBlockReason::ImplementationUnavailable,
                        "native import remains applicable but no definitive importer verdict exists",
                        None,
                    ));
                }
            };
            evidence.push(row);
        }
        Ok(evidence)
    }

    async fn prove_reattach_unavailable(
        &self,
        context: &RecoveryContext,
    ) -> Result<RecoveryPathEvidence, RecoveryProbe> {
        let inspection = self
            .backend
            .inspect(&context.prior_handle)
            .await
            .map_err(|error| {
                blocked(
                    RecoveryPath::Reattach,
                    match error {
                        BackendError::OwnershipMismatch(_) => {
                            RecoveryBlockReason::OldRuntimeNotEmpty
                        }
                        _ => RecoveryBlockReason::ProviderUnavailable,
                    },
                    &error.to_string(),
                    Some(2_000),
                )
            })?;
        match inspection.state {
            BackendRuntimeState::Missing
            | BackendRuntimeState::Exited
            | BackendRuntimeState::Dead => Ok(RecoveryPathEvidence {
                path: RecoveryPath::Reattach,
                verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                reason_code: format!("backend_{:?}", inspection.state).to_ascii_lowercase(),
                evidence_refs: vec![
                    format!("containerId={}", context.prior_handle.container_id()),
                    format!("backendState={:?}", inspection.state),
                ],
                store_state: EvidenceStoreState::NotApplicable,
            }),
            BackendRuntimeState::Running => {
                let host = self
                    .authenticate_host(
                        context.prior_handle.incarnation_id(),
                        context.prior_handle.runtime_dir(),
                    )
                    .await
                    .map_err(|error| {
                        blocked(
                            RecoveryPath::Reattach,
                            RecoveryBlockReason::ProviderUnavailable,
                            &format!(
                                "running enclosure has no authenticated host certainty: {}",
                                error.message
                            ),
                            Some(2_000),
                        )
                    })?;
                let status = self
                    .host_status(
                        context.prior_handle.incarnation_id().clone(),
                        context.prior_handle.runtime_dir(),
                        &host,
                    )
                    .await
                    .map_err(|error| {
                        blocked(
                            RecoveryPath::Reattach,
                            RecoveryBlockReason::ProviderUnavailable,
                            &format!("host liveness remains unknown: {}", error.message),
                            Some(2_000),
                        )
                    })?;
                if !status.exited {
                    return Err(RecoveryProbe::ReattachReady {
                        handle: ReattachHandle {
                            incarnation_id: context.prior_handle.incarnation_id().clone(),
                            host_boot_id: status.host_boot_id,
                            container_id: context.prior_handle.container_id().to_string(),
                        },
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                    });
                }
                Ok(RecoveryPathEvidence {
                    path: RecoveryPath::Reattach,
                    verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                    reason_code: "provider_worker_exited".into(),
                    evidence_refs: vec![
                        format!("containerId={}", context.prior_handle.container_id()),
                        format!("workerLaunchCount={}", status.worker_launch_count),
                        format!("workerPid={:?}", status.worker_pid),
                    ],
                    store_state: EvidenceStoreState::NotApplicable,
                })
            }
            other => Err(blocked(
                RecoveryPath::Reattach,
                RecoveryBlockReason::OldRuntimeNotEmpty,
                &format!(
                    "owned runtime is {other:?}; liveness is neither attachable nor definitively ended"
                ),
                Some(2_000),
            )),
        }
    }

    /// Resume the incident-before-cleanup pipeline after a supervisor
    /// crash. The incident row and exact cleanup capability were committed
    /// together, so this never discovers authority from Docker-wide state.
    pub async fn reconcile_pending_loss_cleanup(&self) -> Result<(), RuntimeError> {
        self.export_pending_incidents().await;
        let incidents = self
            .registry
            .unresolved_loss_incident_ids()
            .await
            .map_err(map_registry)?;
        for incident_id in incidents {
            let certificate = self
                .registry
                .loss_certificate(incident_id.clone())
                .await
                .map_err(map_registry)?;
            let lifecycle_lock = self.lifecycle_lock(&certificate.soul_id).await;
            let _guard = lifecycle_lock.lock().await;
            let handle = self
                .registry
                .owned_handle(certificate.cleanup_target.incarnation_id.clone())
                .await
                .map_err(map_registry)?;
            let preexisting_empty = self.backend.verify_empty(&handle).await.unwrap_or(false);
            let outcome = self.terminate_owned_for_loss(&handle).await?;
            let verified_empty = outcome == StopOutcome::VerifiedEmpty;
            let cleanup = LossCleanupReport {
                owned_handle_ref: certificate.cleanup_target.owned_handle_ref.clone(),
                ownership_verified: true,
                graceful_attempt: if preexisting_empty {
                    "not_required".into()
                } else {
                    "startup_resume_authenticated_host_and_exact_backend_stop_requested".into()
                },
                forced_attempt: if preexisting_empty {
                    "not_required".into()
                } else if verified_empty {
                    "attempted_only_if_graceful_verification_required_escalation".into()
                } else {
                    "attempted_if_safe_but_empty_state_unconfirmed".into()
                },
                verified_empty,
                verified_at: verified_empty
                    .then(freshell_runtime_observability::now_rfc3339_millis),
                foreign_objects_touched: 0,
            };
            self.registry
                .finalize_loss_cleanup(incident_id.clone(), outcome, cleanup)
                .await
                .map_err(map_registry)?;
            crate::service::append_event(
                &self.config.lifecycle_log,
                "supervisor.loss.startup_cleanup_resumed",
                serde_json::json!({
                    "incidentId": incident_id,
                    "soulId": certificate.soul_id,
                    "cleanupOutcome": outcome,
                }),
            );
        }
        self.export_pending_incidents().await;
        Ok(())
    }

    pub(crate) async fn export_pending_incidents(&self) {
        let exports = match self.registry.pending_incident_exports(100).await {
            Ok(exports) => exports,
            Err(error) => {
                crate::service::append_event(
                    &self.config.lifecycle_log,
                    "supervisor.loss.export_queue_read_failed",
                    serde_json::json!({"error": error.to_string()}),
                );
                return;
            }
        };
        let exporter = IncidentExporter::new(
            self.registry.registry_root().join("incidents"),
            self.config.control_secret.clone(),
        );
        for event in exports {
            #[cfg(feature = "runtime-test-faults")]
            let injected_export_failure = std::env::var("FRESHELL_RUNTIME_INCIDENT_EXPORT_FAIL")
                .ok()
                .as_deref()
                == Some("1");
            #[cfg(not(feature = "runtime-test-faults"))]
            let injected_export_failure = false;
            let result = if injected_export_failure {
                Err(std::io::Error::other("injected incident export failure"))
            } else if event.event_kind == "loss_incident.open" {
                serde_json::from_value(event.payload.clone())
                    .map_err(std::io::Error::other)
                    .and_then(|certificate| exporter.export_certificate(&certificate))
            } else if event.event_kind == "loss_incident.final" {
                let closed = event
                    .payload
                    .get("cleanupState")
                    .and_then(serde_json::Value::as_str)
                    == Some("closed");
                exporter.export_summary(&event.incident_id, closed, &event.payload)
            } else {
                Err(std::io::Error::other(format!(
                    "unsupported incident export kind {}",
                    event.event_kind
                )))
            };
            match result {
                Ok(path) => {
                    if let Err(error) = self
                        .registry
                        .acknowledge_incident_export(event.event_id.clone())
                        .await
                    {
                        crate::service::append_event(
                            &self.config.lifecycle_log,
                            "supervisor.loss.export_ack_failed",
                            serde_json::json!({
                                "incidentId": event.incident_id,
                                "path": path,
                                "error": error.to_string(),
                            }),
                        );
                    }
                }
                Err(error) => {
                    // The SQLite incident/export intent is already durable, so
                    // exact cleanup may proceed. Leave this outbox row pending
                    // and surface an emergency operator-visible event.
                    eprintln!(
                        "Freshell loss incident export pending for {}: {}",
                        event.incident_id, error
                    );
                    crate::service::append_event(
                        &self.config.lifecycle_log,
                        "supervisor.loss.export_failed",
                        serde_json::json!({
                            "incidentId": event.incident_id,
                            "error": error.to_string(),
                            "retryPending": true,
                        }),
                    );
                }
            }
        }
    }

    async fn replay_queued_inputs(
        &self,
        soul_id: SoulId,
        incarnation_id: freshell_runtime_protocol::IncarnationId,
    ) -> Result<(), String> {
        let handle = self
            .registry
            .owned_handle(incarnation_id.clone())
            .await
            .map_err(|error| error.to_string())?;
        let host = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await
            .map_err(|error| error.message)?;
        loop {
            let Some(command) = self
                .registry
                .claim_next_queued_input(soul_id.clone(), incarnation_id.clone())
                .await
                .map_err(|error| error.to_string())?
            else {
                return Ok(());
            };
            let request_id = command.request_id.clone();
            let host_command = if let Some(agent) = handle.fresh_agent() {
                HostCommand::FreshAgentSend {
                    incarnation_id: incarnation_id.clone(),
                    request_id: request_id.clone(),
                    text: command.data,
                    settings: Some(fresh_agent_replay_settings(agent)),
                }
            } else {
                HostCommand::TerminalInput {
                    incarnation_id: incarnation_id.clone(),
                    request_id: request_id.clone(),
                    data: command.data,
                }
            };
            let response = self
                .send_authenticated_host_command(
                    incarnation_id.clone(),
                    handle.runtime_dir(),
                    &host,
                    host_command,
                )
                .await;
            match response {
                Ok(HostResult::TerminalInput {
                    state: CommandState::Completed,
                })
                | Ok(HostResult::FreshAgentCommand {
                    state: CommandState::ProviderAcked | CommandState::Completed,
                    ..
                }) => {
                    self.registry
                        .mark_input_completed(soul_id.clone(), request_id)
                        .await
                        .map_err(|error| error.to_string())?;
                }
                Ok(HostResult::TerminalInput { state })
                | Ok(HostResult::FreshAgentCommand { state, .. }) => {
                    self.registry
                        .mark_input_ambiguous(soul_id.clone(), request_id)
                        .await
                        .map_err(|error| error.to_string())?;
                    return Err(format!(
                        "queued input reply was {state:?}; the prompt will not be replayed"
                    ));
                }
                Ok(_) => {
                    self.registry
                        .mark_input_ambiguous(soul_id.clone(), request_id)
                        .await
                        .map_err(|error| error.to_string())?;
                    return Err(
                        "queued input received an unexpected host reply; the prompt will not be replayed"
                            .into(),
                    );
                }
                Err(error) => {
                    self.registry
                        .mark_input_ambiguous(soul_id.clone(), request_id)
                        .await
                        .map_err(|registry_error| registry_error.to_string())?;
                    return Err(format!(
                        "queued input acknowledgement was lost: {}; the prompt will not be replayed",
                        error.message
                    ));
                }
            }
        }
    }

    async fn terminate_owned_for_loss(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<StopOutcome, RuntimeError> {
        #[cfg(feature = "runtime-test-faults")]
        if let Ok(value) = std::env::var("FRESHELL_RUNTIME_LOSS_CLEANUP_FAILPOINT") {
            let outcome = match value.as_str() {
                "backend_unavailable" => Some(StopOutcome::BackendUnavailable),
                "blocked_ownership" => Some(StopOutcome::BlockedOwnership),
                "termination_unconfirmed" => Some(StopOutcome::TerminationUnconfirmed),
                _ => None,
            };
            if let Some(outcome) = outcome {
                self.registry
                    .mark_stop_outcome(handle.incarnation_id().clone(), outcome)
                    .await
                    .map_err(map_registry)?;
                return Ok(outcome);
            }
        }
        self.terminate_owned_for_recovery(handle).await
    }

    async fn terminate_owned_for_recovery(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<StopOutcome, RuntimeError> {
        if self.backend.verify_empty(handle).await.unwrap_or(false) {
            self.registry
                .mark_stop_outcome(handle.incarnation_id().clone(), StopOutcome::VerifiedEmpty)
                .await
                .map_err(map_registry)?;
            return Ok(StopOutcome::VerifiedEmpty);
        }
        if let Ok(host) = self
            .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
            .await
        {
            let _ = self
                .send_host_stop(handle.incarnation_id().clone(), handle.runtime_dir(), &host)
                .await;
        }
        let outcome = match self.backend.request_stop(handle, 2).await {
            Ok(()) => match self
                .verify_empty_with_budget(handle, Duration::from_secs(3))
                .await
            {
                Ok(true) => StopOutcome::VerifiedEmpty,
                Ok(false) => match self.backend.force_stop(handle).await {
                    Ok(()) => match self
                        .verify_empty_with_budget(handle, Duration::from_secs(3))
                        .await
                    {
                        Ok(true) => StopOutcome::VerifiedEmpty,
                        _ => StopOutcome::TerminationUnconfirmed,
                    },
                    Err(BackendError::OwnershipMismatch(_)) => StopOutcome::BlockedOwnership,
                    Err(_) => StopOutcome::TerminationUnconfirmed,
                },
                Err(error) if error.code == RuntimeErrorCode::OwnershipMismatch => {
                    StopOutcome::BlockedOwnership
                }
                Err(_) => StopOutcome::TerminationUnconfirmed,
            },
            Err(BackendError::OwnershipMismatch(_)) => StopOutcome::BlockedOwnership,
            Err(BackendError::Unavailable(_)) => StopOutcome::BackendUnavailable,
            Err(_) => StopOutcome::TerminationUnconfirmed,
        };
        self.registry
            .mark_stop_outcome(handle.incarnation_id().clone(), outcome)
            .await
            .map_err(map_registry)?;
        Ok(outcome)
    }

    async fn wait_for_native_identity(
        &self,
        incarnation_id: &freshell_runtime_protocol::IncarnationId,
    ) -> Result<Option<String>, RuntimeError> {
        let handle = self
            .registry
            .owned_handle(incarnation_id.clone())
            .await
            .map_err(map_registry)?;
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let host = self
                .authenticate_host(handle.incarnation_id(), handle.runtime_dir())
                .await?;
            let status = self
                .host_status(handle.incarnation_id().clone(), handle.runtime_dir(), &host)
                .await?;
            if let Some(observed) = status.native_session_id {
                return Ok(Some(observed));
            }
            if status.exited || Instant::now() >= deadline {
                return Ok(None);
            }
            sleep(Duration::from_millis(100)).await;
        }
    }

    async fn cleanup_failed_replacement(
        &self,
        incarnation_id: &freshell_runtime_protocol::IncarnationId,
    ) {
        if let Ok(handle) = self.registry.owned_handle(incarnation_id.clone()).await {
            let _ = self.terminate_owned_for_recovery(&handle).await;
        }
    }

    async fn view_for(
        &self,
        incarnation_id: &freshell_runtime_protocol::IncarnationId,
    ) -> Result<RuntimeView, RuntimeError> {
        self.registry
            .inventory()
            .await
            .map_err(map_registry)?
            .into_iter()
            .find(|view| &view.incarnation_id == incarnation_id)
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::UnknownIncarnation,
                    incarnation_id.to_string(),
                )
            })
    }

    async fn view_for_or_prior(
        &self,
        incarnation_id: &freshell_runtime_protocol::IncarnationId,
        prior_incarnation_id: &freshell_runtime_protocol::IncarnationId,
    ) -> Result<RuntimeView, RuntimeError> {
        let inventory = self.registry.inventory().await.map_err(map_registry)?;
        if let Some(view) = inventory
            .iter()
            .find(|view| &view.incarnation_id == incarnation_id)
        {
            return Ok(view.clone());
        }
        inventory
            .into_iter()
            .find(|view| &view.incarnation_id == prior_incarnation_id)
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::UnknownIncarnation,
                    incarnation_id.to_string(),
                )
            })
    }
}

fn fresh_agent_replay_settings(
    agent: &freshell_runtime_protocol::FreshAgentLaunchSpec,
) -> freshell_runtime_protocol::FreshAgentTurnSettings {
    freshell_runtime_protocol::FreshAgentTurnSettings {
        cwd: Some(agent.cwd.clone()),
        model: agent.model.clone(),
        effort: agent.effort.clone(),
        permission_mode: agent.permission_mode.clone(),
        sandbox: agent.sandbox.clone(),
    }
}

fn after_native_probe(context: &RecoveryContext, probe: RecoveryProbe) -> RecoveryProbe {
    match probe {
        ready @ RecoveryProbe::ResumeReady { .. }
        | ready @ RecoveryProbe::Blocked { .. }
        | ready @ RecoveryProbe::PristineSeedReady { .. }
        | ready @ RecoveryProbe::ReattachReady { .. } => ready,
        RecoveryProbe::DefinitivelyUnavailable {
            reason,
            mut evidence,
            store_state,
            ..
        } => {
            if context.never_dispatched {
                return RecoveryProbe::PristineSeedReady {
                    seed: context.creation_seed_ref.clone(),
                    never_dispatched_proof: format!(
                        "{}:supervisor-and-host-command-journals-empty",
                        context.soul_id
                    ),
                };
            }
            match checkpoints::probe_after_provider(
                context,
                &RecoveryProbe::DefinitivelyUnavailable {
                    path: RecoveryPath::NativeResume,
                    reason: reason.clone(),
                    evidence: evidence.clone(),
                    store_state,
                },
            ) {
                blocked @ RecoveryProbe::Blocked { .. } => blocked,
                RecoveryProbe::DefinitivelyUnavailable {
                    reason: checkpoint_reason,
                    evidence: checkpoint_evidence,
                    ..
                } => {
                    evidence.extend(checkpoint_evidence);
                    RecoveryProbe::DefinitivelyUnavailable {
                        path: RecoveryPath::NativeResume,
                        reason: format!(
                            "native resume unavailable ({reason}); checkpoint unavailable ({checkpoint_reason}); pristine seed forbidden after dispatch"
                        ),
                        evidence,
                        store_state,
                    }
                }
                other => other,
            }
        }
    }
}

fn offline_probe(context: &RecoveryContext) -> Result<RecoveryProbe, RuntimeError> {
    if let Some(spec) = context.resume_spec.clone() {
        return Ok(RecoveryProbe::ResumeReady {
            evidence_revision: spec.evidence_revision,
            resume_spec: Box::new(spec),
        });
    }
    if context.native_session_id.is_some() {
        return Ok(blocked(
            RecoveryPath::NativeResume,
            RecoveryBlockReason::StoreUnreadable,
            "a native identity was allocated, but no verified durable resume evidence was captured",
            None,
        ));
    }
    if context.never_dispatched {
        return Ok(RecoveryProbe::PristineSeedReady {
            seed: context.creation_seed_ref.clone(),
            never_dispatched_proof: format!("{}:supervisor-input-journal-empty", context.soul_id),
        });
    }
    match checkpoints::probe(context) {
        blocked_probe @ RecoveryProbe::Blocked { .. } => Ok(blocked_probe),
        RecoveryProbe::DefinitivelyUnavailable {
            mut evidence,
            reason,
            ..
        } => {
            evidence.push("nativeResume=definitively_unavailable".into());
            Ok(RecoveryProbe::DefinitivelyUnavailable {
                path: RecoveryPath::NativeResume,
                reason: format!("native resume unavailable; {reason}"),
                evidence,
                store_state: freshell_runtime_protocol::EvidenceStoreState::Missing,
            })
        }
        other => Ok(other),
    }
}

fn downtime_bucket(elapsed_ms: u64) -> &'static str {
    match elapsed_ms {
        0..=999 => "lt_1s",
        1_000..=4_999 => "lt_5s",
        5_000..=29_999 => "lt_30s",
        30_000..=299_999 => "lt_5m",
        _ => "ge_5m",
    }
}

fn blocked(
    path: RecoveryPath,
    reason: RecoveryBlockReason,
    message: &str,
    retry_after_ms: Option<u64>,
) -> RecoveryProbe {
    RecoveryProbe::Blocked {
        path,
        reason,
        retry_hint: RetryHint {
            automatic_after_ms: retry_after_ms,
            manual_retry: true,
            repair: Some(message.to_string()),
        },
        evidence: vec![message.to_string()],
    }
}

fn recovery_activation_failure_data(
    soul_id: &SoulId,
    prior_incarnation_id: &freshell_runtime_protocol::IncarnationId,
    replacement_incarnation_id: &freshell_runtime_protocol::IncarnationId,
    attempt_id: &RecoveryAttemptId,
    path: RecoveryPath,
    reason: RecoveryBlockReason,
    error: &RuntimeError,
) -> serde_json::Value {
    serde_json::json!({
        "soulId": soul_id,
        "priorIncarnationId": prior_incarnation_id,
        "replacementIncarnationId": replacement_incarnation_id,
        "attemptId": attempt_id,
        "path": path,
        "blockReason": reason,
        "errorCode": error.code,
        "errorMessage": error.message,
    })
}

fn terminal_without_first_boot_state(
    terminal: Option<TerminalLaunchSpec>,
) -> Option<TerminalLaunchSpec> {
    terminal.map(|mut terminal| {
        // Exact recovery consumes the credential/config copies already named
        // by ResumeSpec::credential_references in the verified provider
        // volume. Source bind mounts are first-boot inputs, not recovery
        // dependencies, and may no longer exist by the time a host fails.
        terminal.provider_bootstrap_files.clear();
        terminal
    })
}

fn map_registry(error: RegistryError) -> RuntimeError {
    let code = match &error {
        RegistryError::Busy => RuntimeErrorCode::RegistryBusy,
        RegistryError::RequestConflict | RegistryError::InputConflict => {
            RuntimeErrorCode::RequestIdConflict
        }
        RegistryError::StaleControlEpoch { .. } => RuntimeErrorCode::StaleControlEpoch,
        RegistryError::StaleIntentRevision { .. } => RuntimeErrorCode::StaleIntentRevision,
        RegistryError::LossCertificationBlocked(_) => RuntimeErrorCode::LossCertificationBlocked,
        RegistryError::IncidentPersistenceFailed(_) | RegistryError::IncidentNotFound(_) => {
            RuntimeErrorCode::IncidentPersistenceFailed
        }
        RegistryError::NoticeNotFound(_) => RuntimeErrorCode::NoticeNotFound,
        RegistryError::MigrationBlocked(_) => RuntimeErrorCode::MigrationBlocked,
        RegistryError::RepairBlocked(_) => RuntimeErrorCode::RepairBlocked,
        RegistryError::UnknownSoul(_) => RuntimeErrorCode::UnknownSoul,
        RegistryError::UnknownIncarnation(_) => RuntimeErrorCode::UnknownIncarnation,
        RegistryError::BlockedResource { .. } => RuntimeErrorCode::BlockedResource,
        RegistryError::RecoveryInProgress(_) => RuntimeErrorCode::RecoveryInProgress,
        RegistryError::RecoveryBlocked { reason, .. } if reason.contains("RETRY_BUDGET") => {
            RuntimeErrorCode::RecoveryRetryBudget
        }
        RegistryError::RecoveryBlocked { .. } => RuntimeErrorCode::RecoveryBlocked,
        RegistryError::NativeIdentityConflict => RuntimeErrorCode::RecoveryWrongIdentity,
        RegistryError::FaultInjected(_) => RuntimeErrorCode::FaultInjected,
        _ => RuntimeErrorCode::RegistryFailure,
    };
    RuntimeError::new(code, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::{FreshAgentLaunchSpec, FreshProvider, IncarnationId};

    #[test]
    fn queued_fresh_prompt_replays_with_the_exact_persisted_turn_profile() {
        let agent = FreshAgentLaunchSpec {
            session_id: "presentation".into(),
            provider: FreshProvider::Codex,
            session_type: "freshcodex".into(),
            runtime_variant: "codex-app-server".into(),
            provider_store_id: "store".into(),
            cwd: "/workspace/nested".into(),
            workspace_path: "/workspace".into(),
            git_common_dir: None,
            run_as_uid: 65_534,
            run_as_gid: 0,
            model: Some("model-exact".into()),
            effort: Some("high".into()),
            permission_mode: Some("ask".into()),
            sandbox: Some("workspace-write".into()),
            native_session_id: Some("thread-exact".into()),
            fixture_transport: None,
            provider_bootstrap_files: Vec::new(),
        };

        let settings = fresh_agent_replay_settings(&agent);
        assert_eq!(settings.cwd.as_deref(), Some("/workspace/nested"));
        assert_eq!(settings.model.as_deref(), Some("model-exact"));
        assert_eq!(settings.effort.as_deref(), Some("high"));
        assert_eq!(settings.permission_mode.as_deref(), Some("ask"));
        assert_eq!(settings.sandbox.as_deref(), Some("workspace-write"));
    }

    #[test]
    fn recovery_activation_diagnostic_links_generic_block_to_exact_failure() {
        let soul_id = SoulId::new();
        let prior = IncarnationId::new();
        let replacement = IncarnationId::new();
        let attempt = RecoveryAttemptId::new();
        let error = RuntimeError::new(
            RuntimeErrorCode::HostUnreachable,
            "prepare provider bootstrap: operation not permitted",
        );

        let data = recovery_activation_failure_data(
            &soul_id,
            &prior,
            &replacement,
            &attempt,
            RecoveryPath::NativeResume,
            RecoveryBlockReason::ProviderUnavailable,
            &error,
        );

        assert_eq!(data["soulId"], soul_id.as_str());
        assert_eq!(data["priorIncarnationId"], prior.as_str());
        assert_eq!(data["replacementIncarnationId"], replacement.as_str());
        assert_eq!(data["attemptId"], attempt.as_str());
        assert_eq!(data["path"], "native_resume");
        assert_eq!(data["blockReason"], "PROVIDER_UNAVAILABLE");
        assert_eq!(data["errorCode"], "HOST_UNREACHABLE");
        assert!(data["errorMessage"]
            .as_str()
            .unwrap()
            .contains("operation not permitted"));
    }

    #[test]
    fn exact_replacement_drops_first_boot_sources_but_keeps_launch_identity() {
        let terminal = TerminalLaunchSpec {
            terminal_id: "terminal-exact".into(),
            stream_id: "stream-exact".into(),
            mode: "opencode".into(),
            program: "opencode".into(),
            args: vec!["--model".into(), "free".into()],
            env: std::collections::BTreeMap::new(),
            cwd: "/workspace".into(),
            run_as_uid: 65_534,
            run_as_gid: 0,
            cols: 80,
            rows: 24,
            project_key: "project-exact".into(),
            workspace_path: "/workspace".into(),
            git_common_dir: None,
            create_request_id: Some("create-exact".into()),
            resume_session_id: None,
            provider_model: Some("free".into()),
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: vec![freshell_runtime_protocol::ProviderBootstrapFile {
                source_path: "/first-boot/auth.json".into(),
                provider_relative_path: ".local/share/opencode/auth.json".into(),
            }],
            provider_secret_references: Vec::new(),
        };

        let replacement = terminal_without_first_boot_state(Some(terminal.clone())).unwrap();

        assert!(replacement.provider_bootstrap_files.is_empty());
        assert_eq!(replacement.terminal_id, terminal.terminal_id);
        assert_eq!(replacement.program, terminal.program);
        assert_eq!(replacement.args, terminal.args);
    }
}
