//! A CLI conversation reset moves one live runtime; it never starts another.

use super::*;

impl FreshClaudeState {
    pub(super) async fn rekey_conversation(
        &self,
        old: &str,
        new: &str,
        session_type: &str,
        expected_pending: &Arc<std::sync::Mutex<ClaudePending>>,
        reason: &str,
    ) -> Result<String, String> {
        if uuid::Uuid::parse_str(new).is_err() {
            return Err("Claude reported an invalid conversation id".into());
        }
        if old == new {
            return Ok(old.into());
        }
        // This is a fact from the consumer. A handler can hold turn_lock
        // while awaiting this consumer's next receipt, so taking that lock
        // here would stop both tasks. The incarnation check and map/owner
        // guards below protect the move while its turn state stays intact.
        let guard_at = self.ownership.as_ref().map(|registry| {
            let observed = registry.observe(PROVIDER, old);
            freshell_ownership::ObservedFence {
                epoch: observed.epoch,
                generation: observed.generation,
            }
        });
        let old_guard = match crate::ownership_lane::arm_reclaimless_op_guard(
            &self.ownership,
            PROVIDER,
            old,
            &format!("claude-reset-{}", uuid::Uuid::new_v4()),
            guard_at,
            "claude/conversation-reset",
        ) {
            crate::ownership_lane::LaneOpGuard::Armed(guard) => Some(guard),
            crate::ownership_lane::LaneOpGuard::Unwired => None,
            crate::ownership_lane::LaneOpGuard::Refused { message, .. } => return Err(message),
        };
        let now = crate::session_lease::now_epoch_ms() as i64;
        let settings = {
            // The map lock serializes close guards and identity moves.
            // Ownership and event identity move before metadata IO starts.
            let mut sessions = self.sessions.lock().await;
            let session = sessions
                .get(old)
                .filter(|session| Arc::ptr_eq(&session.pending, expected_pending))
                .ok_or_else(|| "the conversation runtime was replaced".to_string())?;
            if sessions.contains_key(new) {
                return Err("the new conversation already has a live runtime".into());
            }
            if session.identity.is_closing() {
                return Err("the conversation is closing".into());
            }
            self.commit_lane_claim_rekey_at(
                old,
                &mut None,
                new,
                old,
                new,
                session.child.id(),
                "claude/conversation-reset",
            )
            .map_err(|outcome| format!("conversation ownership could not move: {outcome:?}"))?;
            let mut session = sessions.remove(old).expect("the validated runtime exists");
            if !self
                .leases
                .rekey_binding(PROVIDER, old, new, old, new, &session.ownership_id)
            {
                tracing::error!(target: "freshell_freshagent::claude",
                    event = "freshagent.claude.rekey_lease_conflict", provider = PROVIDER,
                    previous_session_id = old, session_id = new,
                    "the runtime moved but its lease binding could not follow");
            }
            session
                .identity
                .rekey(new)
                .map_err(|error| error.to_string())?;
            session.launch_genesis = Some(crate::identity_sink::RecordedGenesis {
                genesis: crate::identity_sink::ClaudeGenesis::Fresh,
                updated_at_ms: now,
            });
            let settings = session.configuration.settings.clone();
            sessions.insert(new.into(), session);
            self.ownership_stamps
                .lock()
                .expect("ownership stamps lock")
                .remove(old);
            settings
        };
        // rekey_live moves the coordinator to a new generation. Protect the
        // new key during persistence; a concurrent transition may already own
        // it, in which case its authoritative metadata wins.
        drop(old_guard);
        let new_at = self.ownership.as_ref().map(|registry| {
            let observed = registry.observe(PROVIDER, new);
            freshell_ownership::ObservedFence {
                epoch: observed.epoch,
                generation: observed.generation,
            }
        });
        let new_guard = crate::ownership_lane::arm_reclaimless_op_guard(
            &self.ownership,
            PROVIDER,
            new,
            &format!("claude-reset-binding-{}", uuid::Uuid::new_v4()),
            new_at,
            "claude/conversation-reset-binding",
        );
        if !matches!(
            new_guard,
            crate::ownership_lane::LaneOpGuard::Refused { .. }
        ) {
            if let Some(sink) = self.identity_sink() {
                if let Err(error) = sink
                    .record_binding(crate::identity_sink::FreshAgentBindingUpsert {
                        provider: PROVIDER.into(),
                        session_id: new.into(),
                        mode: session_type.into(),
                        create_request_id: None,
                        resolves_pending: None,
                        supersedes: Some(old.into()),
                        name_transition: None,
                        provenance: crate::identity_sink::ProvenanceUpdate::Inherit,
                        observed_epoch: new_at.map(|at| at.epoch),
                        observed_generation: new_at.map(|at| at.generation),
                        authoritative: false,
                        settings,
                        genesis: crate::identity_sink::GenesisUpdate::Set(
                            crate::identity_sink::ClaudeGenesis::Fresh,
                        ),
                    })
                    .await
                {
                    // The CLI already changed its file. Keep following the
                    // healthy runtime and report failed metadata persistence.
                    tracing::error!(target: "freshell_freshagent::claude",
                        event = "freshagent.claude.rekey_binding_failed", provider = PROVIDER,
                        previous_session_id = old, session_id = new, cause = %error,
                        "the conversation reset but its recovery settings could not be saved");
                }
            }
        }
        self.create_dedup
            .clear_for_session(|record| record.session_id == old)
            .await;
        self.broadcast_materialized(old, new, session_type).await;
        tracing::info!(target: "freshell_freshagent::claude",
            event = "freshagent.claude.session_rekeyed", provider = PROVIDER,
            previous_session_id = old, session_id = new, session_type, reason,
            "the live conversation follows its new durable id");
        Ok(new.into())
    }
}
