//! Recover a known conversation through the existing attach/establish path.

use super::*;

/// Settings supplied by a cold create-with-resume request. Persisted settings
/// remain authoritative when available; this snapshot supplies the initial
/// hosted launch when the caller has no identity ledger to restore from.
#[derive(Clone)]
pub(super) struct CreateResumeSettings {
    pub(super) settings: crate::identity_sink::FreshAgentSettings,
    pub(super) model_selection: Option<serde_json::Value>,
}

impl FreshClaudeState {
    pub(super) fn try_resume_flight(&self, durable: &str) -> Option<ResumingFlagGuard> {
        let mut active = self.resuming.lock().expect("resuming lock");
        if !active.insert(durable.to_string()) {
            return None;
        }
        Some(ResumingFlagGuard {
            resuming: self.resuming.clone(),
            changed: self.resuming_changed.clone(),
            session_id: durable.to_string(),
        })
    }

    pub(super) async fn wait_resume_flight(&self, durable: &str) -> ResumingFlagGuard {
        loop {
            let changed = self.resuming_changed.notified();
            tokio::pin!(changed);
            // Register before inspecting the active set: a fast owner or an
            // aborted future can finish between that inspection and the await.
            changed.as_mut().enable();
            if let Some(flight) = self.try_resume_flight(durable) {
                return flight;
            }
            changed.await;
        }
    }
}

#[derive(Debug, Clone)]
pub(super) enum RuntimeResumeError {
    Lost,
    Closed,
    Unavailable {
        code: &'static str,
        message: String,
        owner: Option<crate::ownership_lane::TerminalOwnerFields>,
    },
    /// The provider started, but a newer lifecycle invalidated publication.
    Superseded {
        code: &'static str,
        message: String,
        owner: Option<crate::ownership_lane::TerminalOwnerFields>,
    },
}

impl RuntimeResumeError {
    fn reserved(owner: Option<crate::ownership_lane::TerminalOwnerFields>) -> Self {
        Self::Unavailable {
            code: "SESSION_RESERVED",
            message: "Another resume for this session is in flight".into(),
            owner,
        }
    }

    pub(super) fn is_reserved(&self) -> bool {
        matches!(
            self,
            Self::Unavailable {
                code: "SESSION_RESERVED",
                ..
            }
        )
    }

    fn counts_as_failed_launch(&self) -> bool {
        match self {
            Self::Lost => false,
            Self::Closed => false,
            Self::Superseded { .. } => false,
            Self::Unavailable { code, .. } => {
                *code != "SESSION_RESERVED" && *code != "SESSION_CLOSED"
            }
        }
    }
}

impl From<ResumeClaudeError> for RuntimeResumeError {
    fn from(error: ResumeClaudeError) -> Self {
        match error {
            ResumeClaudeError::NotFound => Self::Lost,
            ResumeClaudeError::Transient(message) => Self::Unavailable {
                code: "CLAUDE_ATTACH_RESUME_FAILED",
                message,
                owner: None,
            },
            ResumeClaudeError::Superseded(message) => Self::Superseded {
                code: "CLAUDE_ATTACH_RESUME_FAILED",
                message,
                owner: None,
            },
        }
    }
}

impl FreshClaudeState {
    fn recovery_admission_refusal(&self, durable: &str) -> Option<RuntimeResumeError> {
        let snapshot = self.ownership_snapshot(PROVIDER, durable);
        let coordinator_blocks_claim = match &snapshot.state {
            freshell_ownership::OwnershipState::Live { owner, .. } => {
                owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
            }
            freshell_ownership::OwnershipState::Starting { .. }
            | freshell_ownership::OwnershipState::Handoff { .. }
            | freshell_ownership::OwnershipState::Stopping { .. }
            | freshell_ownership::OwnershipState::Fenced { .. } => true,
            freshell_ownership::OwnershipState::Vacant
            | freshell_ownership::OwnershipState::Aliased { .. } => false,
        };
        if coordinator_blocks_claim || (self.terminal_liveness)(PROVIDER, durable) {
            Some(RuntimeResumeError::reserved(
                crate::ownership_lane::terminal_owner_fields_from_snapshot(&snapshot),
            ))
        } else {
            None
        }
    }

    /// Join or start the one provider recovery for this canonical Claude id.
    /// The provider-specific launch still owns its ticket, lease, cleanup and
    /// sidecar bounds; the holder only owns the cohort result and budget.
    pub(super) async fn resume_shared(
        &self,
        msg: FreshAgentAttach,
        durable: String,
        fence: Option<freshell_ownership::ObservedFence>,
        reopen_closed: bool,
        initiator: &'static str,
    ) -> crate::session_recovery::RecoveryAnswer<(), RuntimeResumeError> {
        self.resume_shared_with_settings(msg, durable, fence, reopen_closed, initiator, None)
            .await
    }

    pub(super) async fn resume_shared_with_settings(
        &self,
        msg: FreshAgentAttach,
        durable: String,
        fence: Option<freshell_ownership::ObservedFence>,
        reopen_closed: bool,
        initiator: &'static str,
        create_settings: Option<CreateResumeSettings>,
    ) -> crate::session_recovery::RecoveryAnswer<(), RuntimeResumeError> {
        let state = self.clone();
        let operation_durable = durable.clone();
        let preflight_durable = durable.clone();
        self.session_recovery
            .run_with_requester_preflight(
                durable,
                msg.request_id.clone(),
                {
                    let state = self.clone();
                    move || state.recovery_admission_refusal(&preflight_durable)
                },
                move || async move {
                    if state.has_live_session(&operation_durable).await {
                        return Ok(());
                    }
                    state
                        .resume_untracked(
                            &msg,
                            &operation_durable,
                            fence,
                            reopen_closed,
                            initiator,
                            create_settings,
                        )
                        .await
                        .map_err(|error| {
                            if matches!(error, RuntimeResumeError::Superseded { .. }) {
                                crate::session_recovery::RecoveryAttemptFailure::superseded(error)
                            } else if error.counts_as_failed_launch() {
                                crate::session_recovery::RecoveryAttemptFailure::launch(error)
                            } else {
                                crate::session_recovery::RecoveryAttemptFailure::refusal(error)
                            }
                        })
                },
            )
            .await
    }

    /// Read the shared provider recovery status for a durable id or alias.
    /// Status reads never admit a launch or consume retry budget.
    pub async fn recovery_status(
        &self,
        session_id: &str,
    ) -> Option<freshell_agent_runtime::RecoveryStatus> {
        let canonical = self
            .recovery_durable_id(session_id)
            .unwrap_or_else(|| session_id.to_string());
        self.session_recovery.status(&canonical).await
    }

    /// The cold attach path, also used by send/compact recovery. Its caller
    /// requests the shared operation. All launches still go through
    /// resume_for_attach -> establish_runtime, with the same lease and fence.
    pub(super) async fn resume_untracked(
        &self,
        msg: &FreshAgentAttach,
        durable: &str,
        fence: Option<freshell_ownership::ObservedFence>,
        reopen_closed: bool,
        initiator: &str,
        create_settings: Option<CreateResumeSettings>,
    ) -> Result<(), RuntimeResumeError> {
        let claim_dead_state = self.claim_dead_state_snapshot(durable);
        if !reopen_closed && claim_dead_state.is_some() {
            return Err(RuntimeResumeError::Closed);
        }
        if (self.terminal_liveness)(PROVIDER, durable) {
            return Err(RuntimeResumeError::reserved(
                crate::ownership_lane::terminal_owner_fields_from_snapshot(
                    &self.ownership_snapshot(PROVIDER, durable),
                ),
            ));
        }
        let mut ticket = match self.begin_lane_claim_at(
            durable,
            &format!("attach-{}", uuid::Uuid::new_v4()),
            fence,
            initiator,
        ) {
            crate::ownership_lane::LaneClaim::Granted(ticket) => Some(ticket),
            crate::ownership_lane::LaneClaim::Unwired => None,
            crate::ownership_lane::LaneClaim::Adopt => {
                return if self.resolve_session_key(durable).await.is_some() {
                    Ok(())
                } else {
                    Err(RuntimeResumeError::reserved(None))
                };
            }
            crate::ownership_lane::LaneClaim::Refused(outcome) => {
                tracing::warn!(target: "freshell_freshagent::claude",
                    session_id = %durable, outcome = ?outcome,
                    "fresh_agent_attach_refused: the ownership coordinator refused the claim");
                return Err(RuntimeResumeError::reserved(
                    crate::ownership_lane::fresh_agent_owner_fields_from_outcome(
                        &self.ownership,
                        &outcome,
                    ),
                ));
            }
        };
        let request_id = format!("attach-{}", uuid::Uuid::new_v4());
        let mut lease = match self.claim_launch_lease(durable, &request_id).await {
            LaunchLease::Acquired(lease) => Some(lease),
            refused => {
                return if matches!(refused, LaunchLease::BoundLive { .. })
                    && self.resolve_session_key(durable).await.is_some()
                {
                    Ok(())
                } else {
                    Err(RuntimeResumeError::reserved(None))
                };
            }
        };
        let outcome = self
            .resume_for_attach(
                msg,
                DurableClaim {
                    durable: durable.to_string(),
                    dead_state: claim_dead_state,
                },
                &mut lease,
                &mut ticket,
                None,
                None,
                create_settings,
            )
            .await;
        if let Some(mut remaining) = lease.take() {
            remaining.fail();
        }
        drop(ticket);
        outcome.map_err(|error| {
            let mut error = RuntimeResumeError::from(error);
            if let RuntimeResumeError::Superseded { owner, .. } = &mut error {
                *owner = crate::ownership_lane::terminal_owner_fields_from_snapshot(
                    &self.ownership_snapshot(PROVIDER, durable),
                );
            }
            error
        })
    }

    pub(super) async fn ensure_runtime(
        &self,
        wire_id: &str,
        session_type: SessionType,
        cwd: Option<&str>,
        fence: Option<freshell_ownership::ObservedFence>,
    ) -> Result<String, RuntimeResumeError> {
        if let Some(key) = self.resolve_session_key(wire_id).await {
            return Ok(key);
        }
        let durable = self
            .recovery_durable_id(wire_id)
            .ok_or(RuntimeResumeError::Lost)?;
        let dead = self.dead_sessions.find(&durable);
        tracing::info!(target: "freshell_freshagent::claude",
            event = "freshagent.claude.runtime_recovery_started", provider = PROVIDER,
            session_id = %durable, previous_ownership_id = ?dead.as_ref().map(|dead| dead.ownership_id.as_str()),
            previous_end_reason = ?dead.as_ref().map(|dead| dead.reason.as_str()),
            "recovering the conversation through the attach runtime path");
        let msg = FreshAgentAttach {
            request_id: None,
            view_id: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: if is_canonical_claude_uuid(wire_id) {
                durable.clone()
            } else {
                wire_id.to_string()
            },
            session_type,
            cwd: cwd.map(str::to_string),
            observed_epoch: fence.map(|fence| fence.epoch),
            observed_generation: fence.map(|fence| fence.generation),
            resume_session_id: None,
            session_ref: Some(claude_session_ref(&durable)),
            tab_id: None,
            pane_id: None,
        };
        let recovery = self
            .resume_shared(
                msg.clone(),
                durable.clone(),
                fence,
                false,
                "freshclaude/attach",
            )
            .await;
        let is_owner_refusal = matches!(
            recovery.result.as_ref(),
            Err(crate::session_recovery::RecoveryFailure::Attempt(error)) if error.is_reserved()
        );
        if recovery.status.exhausted && !is_owner_refusal {
            return Err(RuntimeResumeError::Unavailable {
                code: "RECOVERY_EXHAUSTED",
                message: "Claude recovery exhausted three failed launches. Retry after reviewing the provider runtime.".into(),
                owner: None,
            });
        }
        match recovery.result.as_ref() {
            Ok(()) => {}
            Err(crate::session_recovery::RecoveryFailure::Attempt(error)) => {
                return Err(error.clone());
            }
            Err(crate::session_recovery::RecoveryFailure::Panicked) => {
                return Err(RuntimeResumeError::Unavailable {
                    code: "CLAUDE_ATTACH_RESUME_FAILED",
                    message: "Claude recovery stopped unexpectedly. Try again.".into(),
                    owner: None,
                });
            }
        }
        self.resolve_session_key(&msg.session_id)
            .await
            .ok_or_else(|| RuntimeResumeError::Unavailable {
                code: "CLAUDE_ATTACH_RESUME_FAILED",
                message: "Claude stopped while recovering the session. Try again.".into(),
                owner: None,
            })
    }

    pub(super) fn refuse_runtime_resume(
        &self,
        request_id: &Option<String>,
        session_id: &str,
        session_type: SessionType,
        error: RuntimeResumeError,
    ) -> ClaudeSendOutcome {
        match error {
            RuntimeResumeError::Lost => {
                let message = "The Claude conversation for this session could not be found.";
                self.broadcast(&lost_session_frame(session_id, session_type));
                self.send_request_error(request_id, ErrorCode::InvalidSessionId, message);
                ClaudeSendOutcome::Refused {
                    code: "INVALID_SESSION_ID".into(),
                    message: message.into(),
                    retryable: None,
                    owner: None,
                }
            }
            RuntimeResumeError::Closed => {
                let message =
                    "This Claude session was closed. Reopen the saved session to continue.";
                self.send_error(request_id, "SESSION_CLOSED", message);
                ClaudeSendOutcome::Refused {
                    code: "SESSION_CLOSED".into(),
                    message: message.into(),
                    retryable: Some(false),
                    owner: None,
                }
            }
            RuntimeResumeError::Unavailable {
                code,
                message,
                owner,
            }
            | RuntimeResumeError::Superseded {
                code,
                message,
                owner,
            } => {
                self.send_request_error_with_owner(
                    request_id,
                    ErrorCode::InternalError,
                    &format!("{code}: {message}"),
                    owner.as_ref(),
                );
                ClaudeSendOutcome::Refused {
                    code: code.into(),
                    message,
                    retryable: Some(true),
                    owner,
                }
            }
        }
    }
}

pub(super) enum ConfigurationTarget {
    Live(String),
    Stored,
}

pub(super) fn updated_settings(
    current: &crate::identity_sink::FreshAgentSettings,
    requested: &freshell_protocol::FreshAgentSendSettings,
    runtime_cwd: Option<&str>,
) -> crate::identity_sink::FreshAgentSettings {
    let mut next = current.clone();
    if let Some(model) = &requested.model {
        if next.model.as_ref() != Some(model) && requested.effort.is_none() {
            next.effort = None;
        }
        next.model = Some(model.clone());
    }
    if let Some(effort) = &requested.effort {
        next.effort = effort.clone();
    }
    if let Some(permission_mode) = &requested.permission_mode {
        next.permission_mode = Some(permission_mode.clone());
    }
    if let Some(cwd) = &requested.cwd {
        if next.cwd.is_some() || runtime_cwd != Some(cwd.as_str()) {
            next.cwd = Some(cwd.clone());
        }
    }
    next
}

impl FreshClaudeState {
    pub(super) fn recovery_durable_id(&self, wire_id: &str) -> Option<String> {
        let sink = self.identity_sink();
        let candidate = sink
            .as_ref()
            .and_then(|sink| sink.chain_terminus(PROVIDER, wire_id))
            .or_else(|| self.dead_sessions.find(wire_id).map(|dead| dead.session_id))
            .or_else(|| is_canonical_claude_uuid(wire_id).then(|| wire_id.to_string()))?;
        Some(
            sink.and_then(|sink| sink.chain_terminus(PROVIDER, &candidate))
                .unwrap_or(candidate),
        )
    }

    /// Configure an ended or not-yet-running conversation without launching a
    /// process just to save preferences. The shared flight and provider lease
    /// serialize it with recovery and explicit create/resume launches.
    pub(super) async fn configure_without_runtime(
        &self,
        msg: &FreshAgentConfigure,
    ) -> Result<ConfigurationTarget, RuntimeResumeError> {
        if let Some(key) = self.resolve_session_key(&msg.session_id).await {
            return Ok(ConfigurationTarget::Live(key));
        }
        let durable = self
            .recovery_durable_id(&msg.session_id)
            .ok_or(RuntimeResumeError::Lost)?;
        let _flight = self.wait_resume_flight(&durable).await;
        if let Some(key) = self.resolve_session_key(&durable).await {
            return Ok(ConfigurationTarget::Live(key));
        }
        let sink = self.identity_sink();
        self.decide_attach_boot(&durable, sink.as_ref())?;
        if sink
            .as_ref()
            .is_some_and(|sink| sink.kill_tombstone_at_ms(PROVIDER, &durable).is_some())
        {
            return Err(RuntimeResumeError::Closed);
        }
        let dead = self.dead_sessions.find(&durable);
        if sink.is_none() && dead.is_none() {
            // An uncached disk-only lane has nowhere to retain preferences.
            // Establish the existing conversation, then configure that runtime.
            let attach = FreshAgentAttach {
                request_id: None,
                view_id: None,
                provider: freshell_protocol::AgentProvider::Claude,
                session_id: durable.clone(),
                session_type: msg.session_type,
                cwd: msg.settings.cwd.clone(),
                observed_epoch: None,
                observed_generation: None,
                resume_session_id: None,
                session_ref: Some(claude_session_ref(&durable)),
                tab_id: None,
                pane_id: None,
            };
            self.resume_untracked(
                &attach,
                &durable,
                None,
                false,
                "freshclaude/configure",
                None,
            )
            .await?;
            return self
                .resolve_session_key(&durable)
                .await
                .map(ConfigurationTarget::Live)
                .ok_or_else(|| RuntimeResumeError::Unavailable {
                    code: "CLAUDE_SETTINGS_FAILED",
                    message: "Claude stopped while restoring settings. Try again.".into(),
                    owner: None,
                });
        }
        let mut lease = match self
            .claim_launch_lease(&durable, &format!("configure-{}", uuid::Uuid::new_v4()))
            .await
        {
            LaunchLease::Acquired(lease) => lease,
            _ => return Err(RuntimeResumeError::reserved(None)),
        };
        let turn_lock = dead
            .as_ref()
            .map(|dead| dead.turn_lock.clone())
            .unwrap_or_else(|| Arc::new(TokioMutex::new(())));
        let _turn = turn_lock.lock().await;
        let current = sink
            .as_ref()
            .and_then(|sink| sink.load_settings(PROVIDER, &durable))
            .or_else(|| dead.as_ref().map(|dead| dead.settings.clone()))
            .unwrap_or_default();
        let next = updated_settings(&current, &msg.settings, None);
        if current != next {
            if let Some(sink) = sink.as_ref() {
                sink.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
                    provider: PROVIDER.into(),
                    session_id: durable.clone(),
                    mode: session_type_str(msg.session_type).into(),
                    create_request_id: None,
                    resolves_pending: None,
                    supersedes: None,
                    name_transition: None,
                    genesis: crate::identity_sink::GenesisUpdate::Keep,
                    provenance: crate::identity_sink::ProvenanceUpdate::Inherit,
                    observed_epoch: None,
                    observed_generation: None,
                    claim: None,
                    settings: crate::identity_sink::SettingsUpdate::Replace(next.clone()),
                })
                .await
                .map_err(|error| RuntimeResumeError::Unavailable {
                    code: "CLAUDE_SETTINGS_FAILED",
                    message: error.to_string(),
                    owner: None,
                })?;
                if sink.kill_tombstone_at_ms(PROVIDER, &durable).is_some() {
                    return Err(RuntimeResumeError::Closed);
                }
            }
            if let Some(dead) = dead.as_ref() {
                if !self.dead_sessions.set_settings_if_matches(
                    &durable,
                    &dead.ownership_id,
                    next.clone(),
                ) {
                    return Err(RuntimeResumeError::Unavailable {
                        code: "CLAUDE_SETTINGS_FAILED",
                        message: "Claude changed while saving settings. Try again.".into(),
                        owner: None,
                    });
                }
            }
            tracing::info!(target: "freshell_freshagent::claude", provider = PROVIDER,
                session_id = %durable, request_id = ?msg.request_id,
                event = "freshagent.claude.settings_stored_for_recovery",
                "settings saved for the next Claude runtime");
            self.broadcast_stated_settings(
                session_type_str(msg.session_type),
                &msg.session_id,
                StatedSettings {
                    model: next.model,
                    effort: next.effort,
                    permission_mode: next.permission_mode,
                },
            );
        }
        lease.fail();
        Ok(ConfigurationTarget::Stored)
    }

    pub(super) fn emit_resume_control_error(
        &self,
        session_id: &str,
        session_type: SessionType,
        request_id: &Option<String>,
        error: RuntimeResumeError,
    ) {
        let (code, message, owner) = match error {
            RuntimeResumeError::Lost => (
                "INVALID_SESSION_ID",
                "The Claude conversation for this session could not be found.".into(),
                None,
            ),
            RuntimeResumeError::Closed => (
                "SESSION_CLOSED",
                "This Claude session was closed. Reopen the saved session to continue.".into(),
                None,
            ),
            RuntimeResumeError::Unavailable {
                code,
                message,
                owner,
            }
            | RuntimeResumeError::Superseded {
                code,
                message,
                owner,
            } => (code, message, owner),
        };
        self.emit_control_error_with_owner(
            session_id,
            session_type,
            request_id,
            code,
            &message,
            owner.as_ref(),
        );
    }

    pub(super) fn emit_control_error(
        &self,
        session_id: &str,
        session_type: SessionType,
        request_id: &Option<String>,
        code: &str,
        message: &str,
    ) {
        self.emit_control_error_with_owner(
            session_id,
            session_type,
            request_id,
            code,
            message,
            None,
        );
    }

    fn emit_control_error_with_owner(
        &self,
        session_id: &str,
        session_type: SessionType,
        request_id: &Option<String>,
        code: &str,
        message: &str,
        owner: Option<&crate::ownership_lane::TerminalOwnerFields>,
    ) {
        let mut event = json!({"type":"freshAgent.error", "sessionId":session_id, "code":code, "message":message});
        if let Some(owner) = owner {
            event["ownerKind"] = json!(owner.owner_kind);
            event["ownerEpoch"] = json!(owner.owner_epoch);
            event["ownerGeneration"] = json!(owner.owner_generation);
        }
        if let Some(request_id) = request_id {
            event["requestId"] = json!(request_id);
            event["operationReceipt"] = json!(true);
        }
        self.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
            provider: PROVIDER.into(),
            session_id: session_id.into(),
            session_type: session_type_str(session_type).into(),
            event,
        }));
    }
}
