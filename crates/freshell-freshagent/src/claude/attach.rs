//! A page attaches to a durable conversation, without changing its runtime.

use super::*;
use freshell_terminal::FrameSink;

struct ClaudeAttachCompletion {
    attached_id: String,
    session_type: String,
    guard: crate::ownership_lane::LaneAttachGuard,
}

impl FreshClaudeState {
    /// Produce one typed attach result, then adapt it for this requester. The
    /// legacy attach implementation still owns lifecycle recovery and its
    /// provider-specific event details; its attach-only frames are captured
    /// instead of entering the shared event bus.
    pub async fn handle_attach(&self, msg: FreshAgentAttach, reply: FrameSink) {
        let attach = msg.clone();
        let ((mut messages, completion), captured_messages) =
            crate::attach::capture_attach_messages(async {
                let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
                let target = Arc::clone(&captured);
                let capture_sink: FrameSink = Arc::new(move |message| {
                    target
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(message);
                });
                let completion = self.handle_attach_events(msg, capture_sink).await;
                let messages = {
                    let mut captured = captured
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    std::mem::take(&mut *captured)
                };
                (messages, completion)
            })
            .await;
        messages.extend(captured_messages);
        let outcome = crate::attach::AttachOutcome::from_messages(messages)
            .with_current_owner(self.ownership_snapshot(PROVIDER, &attach.session_id));
        for message in crate::attach::AttachOutcome::requester_messages(&attach, outcome) {
            reply(message);
        }
        if let Some(completion) = completion {
            // The live-runtime claim covers the final requester result too. A
            // handoff cannot commit after the snapshot was captured but before
            // this correlated acknowledgement reaches its socket.
            drop(completion.guard);
            self.notify_turn_interrupted_after_ack(
                &completion.attached_id,
                &completion.session_type,
            )
            .await;
        }
    }

    /// Reply to this page only. Status, content, and attention keep their
    /// ordinary broadcast path and canonical session identity.
    async fn handle_attach_events(
        &self,
        mut msg: FreshAgentAttach,
        reply: FrameSink,
    ) -> Option<ClaudeAttachCompletion> {
        let session_type = session_type_str(msg.session_type);
        let fence =
            match crate::ownership_lane::wire_fence(msg.observed_epoch, msg.observed_generation) {
                Ok(fence) => fence,
                Err(error) => {
                    attach_error(&reply, &msg, &msg.session_id, error.code(), error.message());
                    return None;
                }
            };
        let Some(candidate) = attach_durable_id(&msg) else {
            reply(lost_session_frame(&msg.session_id, msg.session_type));
            return None;
        };
        if !is_canonical_claude_uuid(&msg.session_id)
            && self.identity_sink().is_some_and(|sink| {
                sink.kill_tombstone_at_ms(PROVIDER, &msg.session_id)
                    .is_some()
            })
        {
            attach_error(
                &reply,
                &msg,
                &msg.session_id,
                "SESSION_CLOSED",
                "This pane was closed. Open the conversation again to continue.",
            );
            return None;
        }
        let durable = self
            .identity_sink()
            .and_then(|sink| sink.chain_terminus(PROVIDER, &candidate))
            .unwrap_or_else(|| candidate.clone());
        let mut previous = msg.session_id.clone();
        if durable != candidate && previous != durable {
            // A durable ledger correction remains useful even when the
            // subsequent owner fence refuses this delayed attach.
            reply(
                self.materialized_message(&previous, &durable, session_type)
                    .await,
            );
            previous = durable.clone();
        }
        msg.session_id = durable.clone();
        msg.session_ref = Some(claude_session_ref(&durable));
        msg.resume_session_id = None;

        match self.reply_live_attach(&msg, &previous, fence, &reply).await {
            Ok(Some(completion)) => return Some(completion),
            Err(()) => return None,
            Ok(None) => {}
        }
        let recovery = self
            .resume_shared(
                msg.clone(),
                durable.clone(),
                fence,
                true,
                "freshclaude/attach",
            )
            .await;
        let is_owner_refusal = matches!(
            recovery.result.as_ref(),
            Err(crate::session_recovery::RecoveryFailure::Attempt(error)) if error.is_reserved()
        );
        if recovery.status.exhausted && !is_owner_refusal {
            attach_error(
                &reply,
                &msg,
                &previous,
                "RECOVERY_EXHAUSTED",
                "Claude could not restore this conversation after three failed launches.",
            );
            return None;
        }
        match recovery.result.as_ref() {
            Ok(()) => {
                // This operation advanced its own claim. The incoming
                // pre-launch fence no longer names its committed owner. Each
                // joined view still receives its own owner-guarded snapshot.
                match self.reply_live_attach(&msg, &previous, None, &reply).await {
                    Ok(Some(completion)) => return Some(completion),
                    Err(()) => return None,
                    Ok(None) => attach_error(
                        &reply,
                        &msg,
                        &previous,
                        "CLAUDE_ATTACH_RESUME_FAILED",
                        "Claude stopped while attaching. Try again.",
                    ),
                }
            }
            Err(crate::session_recovery::RecoveryFailure::Attempt(
                recovery::RuntimeResumeError::Lost,
            )) => {
                reply(lost_session_frame(&previous, msg.session_type));
                return None;
            }
            Err(crate::session_recovery::RecoveryFailure::Attempt(
                recovery::RuntimeResumeError::Closed,
            )) => {
                attach_error(
                    &reply,
                    &msg,
                    &previous,
                    "SESSION_CLOSED",
                    "This conversation was closed. Open it again to continue.",
                );
                return None;
            }
            Err(crate::session_recovery::RecoveryFailure::Attempt(
                recovery::RuntimeResumeError::Unavailable { code, message, .. }
                | recovery::RuntimeResumeError::Superseded { code, message, .. },
            )) => {
                attach_error(&reply, &msg, &previous, code, message);
                return None;
            }
            Err(crate::session_recovery::RecoveryFailure::Panicked) => {
                attach_error(
                    &reply,
                    &msg,
                    &previous,
                    "CLAUDE_ATTACH_RESUME_FAILED",
                    "Claude recovery stopped unexpectedly. Try again.",
                );
                return None;
            }
        }
        tracing::debug!(target: "freshell_freshagent::claude", provider = PROVIDER,
            session_id = %durable, session_type, "freshagent.claude.attach_settled");
        None
    }

    /// Hold the coordinator's observation window through the snapshot and
    /// correction. A handoff cannot commit around this acknowledgement.
    async fn reply_live_attach(
        &self,
        msg: &FreshAgentAttach,
        previous: &str,
        fence: Option<freshell_ownership::ObservedFence>,
        reply: &FrameSink,
    ) -> Result<Option<ClaudeAttachCompletion>, ()> {
        let Some(key) = self.resolve_session_key(&msg.session_id).await else {
            return Ok(None);
        };
        let Some(native_id) = self
            .sessions
            .lock()
            .await
            .get(&key)
            .map(|runtime| runtime.identity.current())
        else {
            return Ok(None);
        };
        let operation = format!("claude-attach-{}", uuid::Uuid::new_v4());
        let guard = match fence {
            Some(fence) => crate::ownership_lane::arm_adopt_guard(
                &self.ownership,
                PROVIDER,
                &native_id,
                &operation,
                &freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some(key.clone()),
                    pid: None,
                    ownership_id: None,
                },
                fence,
                "freshclaude/attach",
            ),
            None => crate::ownership_lane::arm_attach_guard(
                &self.ownership,
                PROVIDER,
                &native_id,
                &operation,
                None,
                "freshclaude/attach",
            ),
        };
        if matches!(guard, crate::ownership_lane::LaneAttachGuard::Refused) {
            attach_error(
                reply,
                msg,
                previous,
                "SESSION_RESERVED",
                "A lifecycle operation owns this session; retry after it settles",
            );
            return Err(());
        }
        let status = self
            .sessions
            .lock()
            .await
            .get(&key)
            .filter(|runtime| runtime.identity.current() == native_id)
            .map(ClaudeSession::current_status);
        let Some(status) = status else {
            return Ok(None);
        };
        if previous != native_id {
            reply(
                self.materialized_message(previous, &native_id, session_type_str(msg.session_type))
                    .await,
            );
        }
        reply(status_snapshot_frame(
            &native_id,
            &native_id,
            &status,
            session_type_str(msg.session_type),
        ));
        if let Some(stated) = self.stated_settings(&key).await {
            reply(crate::session_metadata::session_metadata_frame(
                PROVIDER,
                session_type_str(msg.session_type),
                &native_id,
                stated.model.as_deref(),
                stated.effort.as_deref(),
                stated.permission_mode.as_deref(),
            ));
        }
        Ok(Some(ClaudeAttachCompletion {
            attached_id: native_id,
            session_type: session_type_str(msg.session_type).to_string(),
            guard,
        }))
    }
}

#[cfg(test)]
impl FreshClaudeState {
    /// In-crate tests observe replies through their existing capture bus.
    pub(super) async fn attach_for_test(&self, msg: FreshAgentAttach) {
        let bus = self.broadcast_tx.clone();
        self.handle_attach(
            msg,
            Arc::new(move |frame| {
                if let Ok(frame) = serde_json::to_string(&frame) {
                    let _ = bus.send(frame);
                }
            }),
        )
        .await;
    }
}

fn attach_error(
    reply: &FrameSink,
    msg: &FreshAgentAttach,
    session_id: &str,
    code: &str,
    message: &str,
) {
    tracing::warn!(target: "freshell_freshagent::claude", provider = PROVIDER,
        session_id, code, "freshagent.claude.attach_refused");
    reply(ServerMessage::FreshAgentEvent(FreshAgentEvent {
        provider: PROVIDER.into(),
        session_id: session_id.into(),
        session_type: session_type_str(msg.session_type).into(),
        event: json!({"type":"freshAgent.error", "sessionId":session_id, "code":code, "message":message}),
    }));
}
