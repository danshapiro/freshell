//! A page attaches to a durable conversation, without changing its runtime.

use super::*;
use freshell_terminal::FrameSink;

impl FreshClaudeState {
    /// Reply to this page only. Status, content, and attention keep their
    /// ordinary broadcast path and canonical session identity.
    pub async fn handle_attach(&self, mut msg: FreshAgentAttach, reply: FrameSink) {
        let session_type = session_type_str(msg.session_type);
        let fence =
            match crate::ownership_lane::wire_fence(msg.observed_epoch, msg.observed_generation) {
                Ok(fence) => fence,
                Err(error) => {
                    attach_error(&reply, &msg, &msg.session_id, error.code(), error.message());
                    return;
                }
            };
        let Some(candidate) = attach_durable_id(&msg) else {
            reply(lost_session_frame(&msg.session_id, msg.session_type));
            return;
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
            return;
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
            Ok(Some(attached_id)) => {
                self.notify_turn_interrupted_after_ack(&attached_id, session_type)
                    .await;
                return;
            }
            Err(()) => return,
            Ok(None) => {}
        }
        // A competing attach may already be booting this conversation.
        // Wait for it, then inspect the runtime again before launching.
        let _flight = self.wait_resume_flight(&durable).await;
        match self.reply_live_attach(&msg, &previous, fence, &reply).await {
            Ok(Some(attached_id)) => {
                self.notify_turn_interrupted_after_ack(&attached_id, session_type)
                    .await;
                return;
            }
            Err(()) => return,
            Ok(None) => {}
        }
        match self.resume_untracked(&msg, &durable, fence, true).await {
            Ok(()) => {
                // This operation advanced its own claim. The incoming
                // pre-launch fence no longer names its committed owner.
                match self.reply_live_attach(&msg, &previous, None, &reply).await {
                    Ok(Some(attached_id)) => {
                        self.notify_turn_interrupted_after_ack(&attached_id, session_type)
                            .await;
                    }
                    Err(()) => {}
                    Ok(None) => attach_error(
                        &reply,
                        &msg,
                        &previous,
                        "CLAUDE_ATTACH_RESUME_FAILED",
                        "Claude stopped while attaching. Try again.",
                    ),
                }
            }
            Err(recovery::RuntimeResumeError::Lost) => {
                reply(lost_session_frame(&previous, msg.session_type));
            }
            Err(recovery::RuntimeResumeError::Closed) => attach_error(
                &reply,
                &msg,
                &previous,
                "SESSION_CLOSED",
                "This conversation was closed. Open it again to continue.",
            ),
            Err(recovery::RuntimeResumeError::Unavailable { code, message, .. }) => {
                attach_error(&reply, &msg, &previous, code, &message);
            }
        }
        tracing::debug!(target: "freshell_freshagent::claude", provider = PROVIDER,
            session_id = %durable, session_type, "freshagent.claude.attach_settled");
    }

    /// Hold the coordinator's observation window through the snapshot and
    /// correction. A handoff cannot commit around this acknowledgement.
    async fn reply_live_attach(
        &self,
        msg: &FreshAgentAttach,
        previous: &str,
        fence: Option<freshell_ownership::ObservedFence>,
        reply: &FrameSink,
    ) -> Result<Option<String>, ()> {
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
        drop(guard);
        Ok(Some(native_id))
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
