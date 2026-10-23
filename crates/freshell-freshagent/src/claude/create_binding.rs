//! A create establishes recoverable identity before its acknowledgement. The
//! native transcript may not exist until the first prompt; Fresh genesis and
//! the create-request lineage make that zero-turn identity durable meanwhile.

use super::*;

impl FreshClaudeState {
    pub(super) async fn record_create_binding(
        &self,
        session_id: &str,
        msg: &FreshAgentCreate,
        provenance: Option<&crate::BindProvenance>,
        ticket: &Option<freshell_ownership::OperationTicket>,
    ) -> std::io::Result<()> {
        let Some(sink) = self.identity_sink() else {
            return Ok(());
        };
        let (settings, genesis) = {
            let sessions = self.sessions.lock().await;
            let session = sessions.get(session_id).ok_or_else(|| {
                std::io::Error::other("Claude stopped while recording its create identity")
            })?;
            (
                session.configuration.settings.clone(),
                session.launch_genesis.clone(),
            )
        };
        let generation = ticket.as_ref().map(|ticket| ticket.generation());
        sink.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
            provider: PROVIDER.into(),
            session_id: session_id.into(),
            mode: session_type_str(msg.session_type).into(),
            create_request_id: Some(msg.request_id.clone()),
            resolves_pending: None,
            supersedes: None,
            name_transition: None,
            genesis: genesis.map_or(crate::identity_sink::GenesisUpdate::Keep, |recorded| {
                crate::identity_sink::GenesisUpdate::Set(recorded.genesis)
            }),
            provenance: provenance.cloned().into(),
            observed_epoch: generation.and(
                self.ownership
                    .as_ref()
                    .map(|registry| registry.boot_epoch()),
            ),
            observed_generation: generation,
            authoritative: false,
            settings,
        })
        .await
    }

    /// The persisted binding/genesis verifies durable routing independently of
    /// native transcript flush. Naming can bind to this identity at create.
    pub(super) async fn bind_create_name(
        &self,
        session_id: &str,
        session_type: &str,
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
        let handle = self.naming_handles.lock().await.get(session_id).cloned()?;
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
            handle,
        );
        let update =
            crate::naming::fold_identity_transition(&self.naming(), &transition, target.clone())
                .await?;
        if update.record.name_ref == target {
            self.naming_handles.lock().await.remove(session_id);
        }
        Some((update.record.name_ref.clone(), update.record))
    }
}
