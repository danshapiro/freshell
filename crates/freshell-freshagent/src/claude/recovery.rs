//! Recover a known conversation through the existing attach/establish path.

use super::*;

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

#[derive(Debug)]
pub(super) enum RuntimeResumeError {
    Lost,
    Closed,
    Unavailable {
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
        }
    }
}

impl FreshClaudeState {
    /// The cold attach path, also used by send/compact recovery. Its caller
    /// owns the shared resume flight. All launches still go through
    /// resume_for_attach -> establish_runtime, with the same lease and fence.
    pub(super) async fn resume_untracked(
        &self,
        msg: &FreshAgentAttach,
        durable: &str,
        fence: Option<freshell_ownership::ObservedFence>,
        reopen_closed: bool,
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
            "freshclaude/attach",
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
            )
            .await;
        if let Some(mut remaining) = lease.take() {
            remaining.fail();
        }
        drop(ticket);
        outcome.map_err(Into::into)
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
        let _flight = self.wait_resume_flight(&durable).await;
        if let Some(key) = self.resolve_session_key(&durable).await {
            return Ok(key);
        }
        let dead = self.dead_sessions.find(&durable);
        tracing::info!(target: "freshell_freshagent::claude",
            event = "freshagent.claude.runtime_recovery_started", provider = PROVIDER,
            session_id = %durable, previous_ownership_id = ?dead.as_ref().map(|dead| dead.ownership_id.as_str()),
            previous_end_reason = ?dead.as_ref().map(|dead| dead.reason.as_str()),
            "recovering the conversation through the attach runtime path");
        let msg = FreshAgentAttach {
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
        self.resume_untracked(&msg, &durable, fence, false).await?;
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
            } => {
                self.send_error(request_id, code, &message);
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
    fn recovery_durable_id(&self, wire_id: &str) -> Option<String> {
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
            self.resume_untracked(&attach, &durable, None, false)
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
                    authoritative: false,
                    settings: next.clone(),
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
        let (code, message) = match error {
            RuntimeResumeError::Lost => (
                "INVALID_SESSION_ID",
                "The Claude conversation for this session could not be found.".into(),
            ),
            RuntimeResumeError::Closed => (
                "SESSION_CLOSED",
                "This Claude session was closed. Reopen the saved session to continue.".into(),
            ),
            RuntimeResumeError::Unavailable { code, message, .. } => (code, message),
        };
        self.emit_control_error(session_id, session_type, request_id, code, &message);
    }

    pub(super) fn emit_control_error(
        &self,
        session_id: &str,
        session_type: SessionType,
        request_id: &Option<String>,
        code: &str,
        message: &str,
    ) {
        let mut event = json!({"type":"freshAgent.error", "sessionId":session_id, "code":code, "message":message});
        if let Some(request_id) = request_id {
            event["requestId"] = json!(request_id);
        }
        self.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
            provider: PROVIDER.into(),
            session_id: session_id.into(),
            session_type: session_type_str(session_type).into(),
            event,
        }));
    }
}
