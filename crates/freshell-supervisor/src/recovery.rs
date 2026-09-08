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
    registry::{OwnedRuntimeHandle, RecoveryContext, RegistryError},
    resume_catalog,
    service::Supervisor,
};
use freshell_agent_runtime::{classify_provider_failure, verify_native_identity};
use freshell_runtime_protocol::{
    CommandState, DesiredState, HostCommand, HostResult, ReattachHandle, RecoverRequest,
    RecoveryBlockReason, RecoveryOutcome, RecoveryPath, RecoveryProbe, RecoveryResult,
    RecoveryTrigger, RetryHint, RuntimeError, RuntimeErrorCode, RuntimeView, SoulId, StopOutcome,
    CONTROL_PROTOCOL_VERSION,
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
                })
            }
            RecoveryProbe::DefinitivelyUnavailable {
                reason, evidence, ..
            } => {
                // Phase 3 deliberately has no authority to declare a soul
                // lost. A definitive-negative provider probe is only one
                // input to Phase 5's complete LostDecision certificate. Until
                // that certificate and incident-before-cleanup path exist,
                // preserve the soul and every retained artifact as blocked.
                let preserved = phase3_preserve_definitive_unavailable(reason, evidence);
                let (blocked_reason, blocked_evidence) = match &preserved {
                    RecoveryProbe::Blocked {
                        reason, evidence, ..
                    } => (*reason, evidence.clone()),
                    _ => unreachable!("phase3 loss preservation always blocks"),
                };
                self.registry
                    .mark_recovery_blocked(
                        request.soul_id.clone(),
                        None,
                        blocked_reason,
                        blocked_evidence,
                    )
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
                    probe: Some(preserved),
                    prior_incarnation_id: None,
                    attempt_id: None,
                    expected_native_session_id: None,
                    observed_native_session_id: None,
                })
            }
            RecoveryProbe::ResumeReady { resume_spec, .. } => {
                self.replace(
                    request.soul_id,
                    request.trigger,
                    RecoveryPath::NativeResume,
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
            });
        }

        let prepared = match self
            .registry
            .prepare_replacement(
                start.clone(),
                start.context.terminal.clone(),
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
                prepared.resume_spec.clone(),
                start.context.requested_limits,
            )
            .await;
        match launch {
            Ok(_) => {}
            Err(error) => {
                self.cleanup_failed_replacement(&prepared.prepared.incarnation_id)
                    .await;
                let reason = classify_provider_failure(&error.message);
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
            });
        }

        self.registry
            .mark_recovery_success(
                soul_id,
                prepared.prepared.incarnation_id.clone(),
                attempt_id.clone(),
            )
            .await
            .map_err(map_registry)?;
        Ok(RecoveryResult {
            outcome: RecoveryOutcome::Replaced,
            view: self.view_for(&prepared.prepared.incarnation_id).await?,
            probe: Some(probe),
            prior_incarnation_id: Some(prior_incarnation_id),
            attempt_id: Some(attempt_id),
            expected_native_session_id,
            observed_native_session_id,
        })
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
            let response = self
                .send_authenticated_host_command(
                    incarnation_id.clone(),
                    handle.runtime_dir(),
                    &host,
                    HostCommand::TerminalInput {
                        incarnation_id: incarnation_id.clone(),
                        request_id: command.request_id.clone(),
                        data: command.data,
                    },
                )
                .await;
            match response {
                Ok(HostResult::TerminalInput {
                    state: CommandState::Completed,
                }) => {
                    self.registry
                        .mark_input_completed(soul_id.clone(), command.request_id)
                        .await
                        .map_err(|error| error.to_string())?;
                }
                Ok(HostResult::TerminalInput { state }) => {
                    self.registry
                        .mark_input_ambiguous(soul_id.clone(), command.request_id)
                        .await
                        .map_err(|error| error.to_string())?;
                    return Err(format!(
                        "queued input reply was {state:?}; the prompt will not be replayed"
                    ));
                }
                Ok(_) => {
                    self.registry
                        .mark_input_ambiguous(soul_id.clone(), command.request_id)
                        .await
                        .map_err(|error| error.to_string())?;
                    return Err(
                        "queued input received an unexpected host reply; the prompt will not be replayed"
                            .into(),
                    );
                }
                Err(error) => {
                    self.registry
                        .mark_input_ambiguous(soul_id.clone(), command.request_id)
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

fn after_native_probe(context: &RecoveryContext, probe: RecoveryProbe) -> RecoveryProbe {
    match probe {
        ready @ RecoveryProbe::ResumeReady { .. }
        | ready @ RecoveryProbe::Blocked { .. }
        | ready @ RecoveryProbe::PristineSeedReady { .. }
        | ready @ RecoveryProbe::ReattachReady { .. } => ready,
        RecoveryProbe::DefinitivelyUnavailable {
            reason,
            mut evidence,
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
            match checkpoints::probe(context) {
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
            })
        }
        other => Ok(other),
    }
}

fn phase3_preserve_definitive_unavailable(
    reason: String,
    mut evidence: Vec<String>,
) -> RecoveryProbe {
    evidence.push("phase3LossAuthority=disabledUntilCertifiedPhase5Decision".into());
    RecoveryProbe::Blocked {
        path: RecoveryPath::NativeResume,
        reason: RecoveryBlockReason::ImplementationUnavailable,
        retry_hint: RetryHint {
            automatic_after_ms: None,
            manual_retry: true,
            repair: Some(format!(
                "all implemented recovery paths reported unavailable ({reason}); preserve the soul until Phase 5 can certify loss"
            )),
        },
        evidence,
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

fn map_registry(error: RegistryError) -> RuntimeError {
    let code = match &error {
        RegistryError::Busy => RuntimeErrorCode::RegistryBusy,
        RegistryError::RequestConflict | RegistryError::InputConflict => {
            RuntimeErrorCode::RequestIdConflict
        }
        RegistryError::StaleControlEpoch { .. } => RuntimeErrorCode::StaleControlEpoch,
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
    use super::phase3_preserve_definitive_unavailable;
    use freshell_runtime_protocol::{RecoveryBlockReason, RecoveryProbe};

    #[test]
    fn phase3_definitive_negative_is_preserved_as_blocked_not_lost() {
        let probe = phase3_preserve_definitive_unavailable(
            "native and checkpoint state absent".into(),
            vec!["native=absent".into(), "checkpoint=absent".into()],
        );
        match probe {
            RecoveryProbe::Blocked {
                reason,
                retry_hint,
                evidence,
                ..
            } => {
                assert_eq!(reason, RecoveryBlockReason::ImplementationUnavailable);
                assert!(retry_hint.manual_retry);
                assert!(evidence
                    .iter()
                    .any(|item| item.contains("phase3LossAuthority")));
            }
            other => panic!("phase 3 must preserve, not finalize: {other:?}"),
        }
    }
}
