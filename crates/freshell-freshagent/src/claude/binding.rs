//! Establishment binds recoverable identity before its acknowledgement.
//! Later settings updates preserve that identity without claiming or adopting
//! another conversation. Fresh genesis covers the zero-turn transcript window.

use super::*;

impl FreshClaudeState {
    pub(super) async fn record_established_binding(
        &self,
        session_id: &str,
        session_type: &str,
        create_request_id: Option<&str>,
        provenance: Option<&crate::BindProvenance>,
        ticket: &Option<freshell_ownership::OperationTicket>,
        transition_claim: Option<&crate::identity_sink::BindingClaim>,
        settings_update: crate::identity_sink::SettingsUpdate,
    ) -> std::io::Result<()> {
        let Some(sink) = self.identity_sink() else {
            return Ok(());
        };
        let (genesis, owning_generation, pid) = {
            let sessions = self.sessions.lock().await;
            let session = sessions.get(session_id).ok_or_else(|| {
                std::io::Error::other("Claude stopped while recording its create identity")
            })?;
            (
                session.launch_genesis.clone(),
                session.owning_generation,
                session.child.id(),
            )
        };
        let claim = ticket
            .as_ref()
            .and_then(|ticket| {
                crate::identity_sink::BindingClaim::from_ticket(
                    ticket,
                    crate::identity_sink::BindingClaimKind::Starting,
                )
            })
            .or_else(|| transition_claim.cloned())
            .or_else(|| {
                let _registry = self.ownership.as_ref()?;
                let stamp =
                    crate::ownership_lane::peek_retained_stamp(&self.ownership_stamps, session_id)?;
                // A session's sidecar tag is a process-cleanup identity, not
                // the coordinator operation id. Adoption can authorize an
                // identity-only write only from the exact retained stamp for
                // this still-current live runtime.
                if stamp.owner.ownership_id.as_deref() != Some(stamp.operation_id.as_str()) {
                    return None;
                }
                let current = crate::ownership_lane::current_local_snapshot_owner(
                    &self.ownership,
                    &self.ownership_stamps,
                    PROVIDER,
                    session_id,
                    session_id,
                    pid,
                )?;
                Some(crate::identity_sink::BindingClaim::live_fresh_agent(
                    PROVIDER,
                    session_id,
                    &stamp.operation_id,
                    current.epoch,
                    current.generation,
                ))
            });
        // `adopt_live_create` has no start ticket: its only authority is the
        // retained stamp for the already-live runtime. If the wired
        // coordinator cannot prove that exact owner still matches, refuse
        // instead of downgrading to a pair-only/unfenced binding write.
        if self.ownership.is_some()
            && ticket.is_none()
            && transition_claim.is_none()
            && claim.is_none()
        {
            return Err(std::io::Error::other(
                "Claude live adoption has no current exact ownership stamp",
            ));
        }
        let generation = ticket
            .as_ref()
            .map(|ticket| ticket.generation())
            .or(owning_generation);
        sink.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
            provider: PROVIDER.into(),
            session_id: session_id.into(),
            mode: session_type.into(),
            create_request_id: create_request_id.map(str::to_string),
            resolves_pending: None,
            supersedes: None,
            name_transition: None,
            genesis: genesis.map_or(crate::identity_sink::GenesisUpdate::Keep, |recorded| {
                crate::identity_sink::GenesisUpdate::Set(recorded.genesis)
            }),
            provenance: provenance.cloned().into(),
            observed_epoch: claim
                .as_ref()
                .map(|claim| claim.epoch)
                .or_else(|| generation.and(self.ownership.as_ref().map(|r| r.boot_epoch()))),
            observed_generation: claim.as_ref().map(|claim| claim.generation).or(generation),
            claim,
            settings: settings_update,
        })
        .await
    }

    /// The persisted binding/genesis verifies durable routing independently of
    /// native transcript flush. Naming can bind to this identity at create.
    pub(super) async fn bind_create_name(
        &self,
        session_id: &str,
        session_type: &str,
        naming_handle: Option<&str>,
    ) -> Option<(
        freshell_protocol::session_names::SessionNameRef,
        freshell_protocol::session_names::SessionNameRecord,
    )> {
        if session_type == "kilroy"
            || !self.identity_sink().is_some_and(|sink| {
                sink.load_genesis(PROVIDER, session_id).is_some()
                    || sink.was_recorded(PROVIDER, session_id)
            })
        {
            return None;
        }
        let handle = naming_handle?.trim();
        if handle.is_empty() {
            return None;
        }
        let target = freshell_protocol::session_names::SessionNameRef::Session {
            provider: freshell_protocol::session_names::NamedProvider::Claude,
            session_id: session_id.into(),
        };
        let transition = crate::naming::NameTransition::binding(
            crate::naming::NameTransitionReason::InitialMaterialization,
            freshell_protocol::native_location::NativeAcquisition {
                location: freshell_protocol::native_location::NativeLocation::Claude {
                    config_root: self.transcript_roots().first()?.display().to_string(),
                    transcript_path: None,
                    project_directory_key: None,
                    transcript_cwd: None,
                    effective_project_key_override: None,
                },
                evidence: freshell_protocol::native_location::NativeEvidenceKind::PersistedMetadata,
                persistence: freshell_protocol::native_location::NativePersistence::Verified,
            },
            handle.to_string(),
        );
        let update =
            crate::naming::fold_identity_transition(&self.naming(), &transition, target.clone())
                .await?;
        Some((update.record.name_ref.clone(), update.record))
    }

    pub(super) async fn persist_runtime_settings(&self, ownership_id: &str) -> Result<(), String> {
        if let Err(error) = self.write_runtime_settings(ownership_id).await {
            // The SDK may already have applied some setters. Retain that
            // actual state and retry persistence before a later prompt.
            if let Some(session) = self
                .sessions
                .lock()
                .await
                .values_mut()
                .find(|session| session.ownership_id == ownership_id)
            {
                session.configuration.needs_configure = true;
            }
            tracing::error!(target: "freshell_freshagent::claude",
                event = "freshagent.claude.settings_persist_failed",
                provider = PROVIDER, ownership_id, cause = %error,
                "the runtime retained its settings; persistence must be retried");
            return Err("Claude could not save the session settings. Try again.".into());
        }
        Ok(())
    }

    async fn write_runtime_settings(&self, ownership_id: &str) -> std::io::Result<()> {
        let Some(sink) = self.identity_sink() else {
            return Ok(());
        };
        let (session_id, session_type, settings, stamp, _guard) = {
            let sessions = self.sessions.lock().await;
            // The receipt's process tag survives a native reset. Resolve the
            // current UUID from that exact runtime after the control await.
            let (id, session) = sessions
                .iter()
                .find(|(_, session)| session.ownership_id == ownership_id)
                .ok_or_else(|| std::io::Error::other("the configured runtime ended"))?;
            let stamp = match &self.ownership {
                Some(_) => Some(
                    crate::ownership_lane::peek_retained_stamp(&self.ownership_stamps, id)
                        .filter(|stamp| {
                            stamp.owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
                                && stamp.owner.live_session_key.as_deref() == Some(id.as_str())
                                && stamp.owner.pid == session.child.id()
                        })
                        .ok_or_else(|| {
                            std::io::Error::other("the configured runtime's ownership changed")
                        })?,
                ),
                None => None,
            };
            let observed = stamp
                .as_ref()
                .map(|stamp| freshell_ownership::ObservedFence {
                    epoch: stamp.epoch,
                    generation: stamp.generation,
                });
            let guard = match crate::ownership_lane::arm_reclaimless_op_guard(
                &self.ownership,
                PROVIDER,
                id,
                &format!("claude-settings-{}", uuid::Uuid::new_v4()),
                observed,
                "claude/settings-persist",
            ) {
                crate::ownership_lane::LaneOpGuard::Armed(guard) => Some(guard),
                crate::ownership_lane::LaneOpGuard::Unwired => None,
                crate::ownership_lane::LaneOpGuard::Refused { message, .. } => {
                    return Err(std::io::Error::other(message));
                }
            };
            (
                id.clone(),
                session.session_type.clone(),
                session.configuration.settings.clone(),
                stamp,
                guard,
            )
        };
        sink.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
            provider: PROVIDER.into(),
            session_id: session_id.clone(),
            mode: session_type.clone(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            name_transition: None,
            genesis: crate::identity_sink::GenesisUpdate::Keep,
            provenance: crate::identity_sink::ProvenanceUpdate::Inherit,
            observed_epoch: stamp.as_ref().map(|stamp| stamp.epoch),
            observed_generation: stamp.as_ref().map(|stamp| stamp.generation),
            claim: None,
            settings: crate::identity_sink::SettingsUpdate::Replace(settings),
        })
        .await?;
        tracing::debug!(target: "freshell_freshagent::claude",
            event = "freshagent.claude.settings_persisted", provider = PROVIDER,
            session_id, session_type, ownership_id,
            "the established conversation's actual settings were saved");
        Ok(())
    }
}
