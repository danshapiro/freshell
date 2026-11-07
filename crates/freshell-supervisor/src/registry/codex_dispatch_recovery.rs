//! Exact current custody for one explicit Codex source-recovery send.

use super::*;
use freshell_runtime_protocol::NativeIdentityLaunch;

/// Only the registry can mint this source. It does not certify native
/// liveness; the authenticated host still owns original-writer verification.
#[derive(Debug, Clone)]
pub(crate) struct OwnedCodexDispatchRecovery {
    pub(super) handle: OwnedRuntimeHandle,
    pub(super) fence: RecoveryWriteFence,
    host_boot_id: HostBootId,
    execution_generation: u64,
    grant_id: GrantId,
    presentation_session_id: String,
    original_native_session_id: String,
    native_launch: NativeIdentityLaunch,
    blocked_recovery: bool,
    receipt_only: bool,
}

impl OwnedCodexDispatchRecovery {
    pub(crate) fn handle(&self) -> &OwnedRuntimeHandle {
        &self.handle
    }

    pub(crate) fn matches_host(&self, boot: &HostBootId, generation: u64) -> bool {
        &self.host_boot_id == boot && self.execution_generation == generation
    }

    pub(crate) fn is_blocked(&self) -> bool {
        self.blocked_recovery
    }

    pub(crate) fn is_receipt_only(&self) -> bool {
        self.receipt_only
    }

    pub(crate) fn matches_context(&self, context: &RecoveryContext) -> bool {
        self.fence == context.write_fence()
            && context.native_session_id.as_deref()
                == Some(self.original_native_session_id.as_str())
            && context.native_identity_launch.as_ref() == Some(&self.native_launch)
            && context.prior_handle.incarnation_id() == self.handle.incarnation_id()
            && context.prior_handle.launch_nonce() == self.handle.launch_nonce()
    }

    fn same_custody(&self, other: &Self) -> bool {
        self.fence == other.fence
            && self.host_boot_id == other.host_boot_id
            && self.execution_generation == other.execution_generation
            && self.grant_id == other.grant_id
            && self.presentation_session_id == other.presentation_session_id
            && self.original_native_session_id == other.original_native_session_id
            && self.native_launch == other.native_launch
            && self.handle.installation_id == other.handle.installation_id
            && self.handle.soul_id == other.handle.soul_id
            && self.handle.provider_store_id == other.handle.provider_store_id
            && self.handle.incarnation_id == other.handle.incarnation_id
            && self.handle.launch_nonce == other.handle.launch_nonce
            && self.handle.daemon_id == other.handle.daemon_id
            && self.handle.container_id == other.handle.container_id
            && self.handle.image_ref == other.handle.image_ref
            && self.handle.runtime_dir == other.handle.runtime_dir
            && self.handle.host_binary_path == other.handle.host_binary_path
            && self.handle.provider_volume_name == other.handle.provider_volume_name
            && self.handle.immutable_config_digest == other.handle.immutable_config_digest
            && self.receipt_only == other.receipt_only
    }
}

impl Registry {
    pub(crate) async fn unresolved_codex_dispatch_recovery_receipt_souls(
        &self,
    ) -> Result<Vec<SoulId>, RegistryError> {
        self.run_blocking(move |conn| {
            let mut statement = conn.prepare(
                "SELECT DISTINCT c.soul_id FROM input_commands c
                 JOIN souls s ON s.soul_id=c.soul_id
                 WHERE s.desired_state='running'
                   AND c.codex_dispatch_recovery_receipt=1
                   AND c.state IN ('dispatching','ambiguous')
                 ORDER BY c.soul_id",
            )?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.map(|row| {
                let raw = row?;
                SoulId::parse(raw)
                    .map_err(|_| RegistryError::Integrity("invalid Codex receipt soul id".into()))
            })
            .collect()
        })
        .await
    }

    pub(crate) async fn codex_dispatch_recovery_source(
        &self,
        soul_id: SoulId,
    ) -> Result<Option<Arc<OwnedCodexDispatchRecovery>>, RegistryError> {
        let installation = self.installation_id().clone();
        let epoch = self.control_epoch();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction()?;
            let source = load_source(&tx, installation, &soul_id, epoch, false)?;
            tx.commit()?;
            Ok(source.map(Arc::new))
        })
        .await
    }

    pub(crate) async fn codex_dispatch_recovery_receipt_source(
        &self,
        soul_id: SoulId,
    ) -> Result<Option<Arc<OwnedCodexDispatchRecovery>>, RegistryError> {
        let installation = self.installation_id().clone();
        let epoch = self.control_epoch();
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction()?;
            let source = load_source(&tx, installation, &soul_id, epoch, true)?;
            tx.commit()?;
            Ok(source.map(Arc::new))
        })
        .await
    }

    /// Retire a receipt lookup only after its original host has durably
    /// recorded an ambiguous terminal result. The input stays ambiguous and
    /// can never be sent again; clearing only the receipt marker lets ordinary
    /// recovery inspect the provider store.
    pub(crate) async fn retire_ambiguous_codex_dispatch_recovery_receipt(
        &self,
        source: Arc<OwnedCodexDispatchRecovery>,
        request_id: RequestId,
    ) -> Result<bool, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            validate_source(&tx, &source)?;
            let changed = tx.execute(
                "UPDATE input_commands SET codex_dispatch_recovery_receipt=0
                 WHERE soul_id=?1 AND incarnation_id=?2 AND request_id=?3
                   AND codex_dispatch_recovery_receipt=1 AND state='ambiguous'",
                params![
                    source.handle.soul_id().as_str(),
                    source.handle.incarnation_id().as_str(),
                    request_id.as_str(),
                ],
            )?;
            if changed > 0 {
                super::clear_command_ambiguous_recovery_block_if_settled(
                    &tx,
                    source.handle.soul_id(),
                    source.handle.incarnation_id(),
                )?;
            }
            tx.commit()?;
            Ok(changed == 1)
        })
        .await
    }

    /// Stop waiting for receipts that never arrive after the bounded original
    /// send budget plus a grace period. These rows remain ambiguous and are
    /// never replayed; only their special recovery hold is retired.
    pub(crate) async fn retire_expired_codex_dispatch_recovery_receipts(
        &self,
        source: Arc<OwnedCodexDispatchRecovery>,
        cutoff_ms: i64,
    ) -> Result<Vec<RequestId>, RegistryError> {
        self.run_blocking(move |mut conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            validate_source(&tx, &source)?;
            let mut statement = tx.prepare(
                "SELECT request_id FROM input_commands
                 WHERE soul_id=?1 AND incarnation_id=?2
                   AND codex_dispatch_recovery_receipt=1 AND state='ambiguous'
                   AND updated_at<=?3
                 ORDER BY updated_at,request_id",
            )?;
            let rows = statement.query_map(
                params![
                    source.handle.soul_id().as_str(),
                    source.handle.incarnation_id().as_str(),
                    cutoff_ms,
                ],
                |row| row.get::<_, String>(0),
            )?;
            let request_ids = rows
                .map(|row| {
                    let raw = row?;
                    RequestId::parse(raw).map_err(|_| {
                        RegistryError::Integrity("invalid Codex receipt request id".into())
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            if !request_ids.is_empty() {
                tx.execute(
                    "UPDATE input_commands SET codex_dispatch_recovery_receipt=0
                     WHERE soul_id=?1 AND incarnation_id=?2
                       AND codex_dispatch_recovery_receipt=1 AND state='ambiguous'
                       AND updated_at<=?3",
                    params![
                        source.handle.soul_id().as_str(),
                        source.handle.incarnation_id().as_str(),
                        cutoff_ms,
                    ],
                )?;
                super::clear_command_ambiguous_recovery_block_if_settled(
                    &tx,
                    source.handle.soul_id(),
                    source.handle.incarnation_id(),
                )?;
            }
            tx.commit()?;
            Ok(request_ids)
        })
        .await
    }
}

fn load_source(
    conn: &Connection,
    installation: InstallationId,
    soul: &SoulId,
    epoch: u64,
    receipt_only: bool,
) -> Result<Option<OwnedCodexDispatchRecovery>, RegistryError> {
    type Custody = (String, String, u64, String, String);
    let row: Option<Custody> = conn.query_row(
        "SELECT i.incarnation_id,i.host_boot_id,i.execution_generation,i.grant_id,s.recovery_state
         FROM incarnations i JOIN souls s ON s.soul_id=i.soul_id
         WHERE s.soul_id=?1 AND s.provider='codex' AND s.desired_state='running'
           AND i.launch_state='running' AND i.cleanup_state='none'
           AND i.host_boot_id IS NOT NULL AND i.grant_id IS NOT NULL AND s.loss_incident_id IS NULL
           AND (s.recovery_state='live'
                OR (s.recovery_state='blocked' AND s.recovery_attempt_id IS NULL AND (s.recovery_reason IN (?2,?3) OR (?4 AND s.recovery_reason IN (?5,?6))))
                OR (?4 AND s.recovery_state='recovering' AND s.recovery_attempt_id IS NOT NULL))
         ORDER BY i.created_at DESC LIMIT 1",
        params![
            soul.as_str(),
            recovery_block_reason_name(RecoveryBlockReason::StoreUnreadable),
            recovery_block_reason_name(RecoveryBlockReason::ImplementationUnavailable),
            receipt_only,
            recovery_block_reason_name(RecoveryBlockReason::CommandAmbiguous),
            recovery_block_reason_name(RecoveryBlockReason::RetryBudget),
        ],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).optional()?;
    let Some((incarnation, boot, generation, grant, state)) = row else {
        return Ok(None);
    };
    let context = load_recovery_context(conn, installation, soul)?;
    if context.control_epoch != epoch {
        return Err(RegistryError::StaleControlEpoch {
            expected: epoch,
            current: context.control_epoch,
        });
    }
    let Some(original) = context.native_session_id.as_ref() else {
        return Ok(None);
    };
    let Some(profile) = context.fresh_agent.as_ref() else {
        return Ok(None);
    };
    let Some(launch) = context.native_identity_launch.as_ref() else {
        return Ok(None);
    };
    if context.prior_handle.incarnation_id().as_str() != incarnation
        || profile.provider != FreshProvider::Codex
        || profile.runtime_variant != "codex-app-server"
        || profile.fixture_transport.is_some()
        || profile.native_session_id.as_ref() != Some(original)
        || profile.provider_store_id != context.provider_store_id
        || original.is_empty()
        || original.chars().any(char::is_control)
        || launch.incarnation_id != *context.prior_handle.incarnation_id()
        || launch.launch_nonce != context.prior_handle.launch_nonce().as_str()
        || launch.execution_generation != generation
        || launch
            .requested_native_session_id
            .as_ref()
            .is_some_and(|root| root != original)
    {
        return Ok(None);
    }
    let writer: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM writer_claims WHERE provider='codex' AND provider_store_id=?1 AND native_session_id=?2 AND soul_id=?3 AND incarnation_id=?4 AND intent_revision=?5)",
        params![context.provider_store_id, original, soul.as_str(), incarnation, context.intent_revision],
        |row| row.get(0),
    )?;
    if !writer {
        return Ok(None);
    }
    let fence = context.write_fence();
    // Reject a newer prepared/starting owner even if an older running row remains.
    let actual = load_recovery_write_fence(conn, soul)?;
    if actual != fence {
        return Ok(None);
    }
    let native_launch = launch.clone();
    let original_native_session_id = original.clone();
    let presentation_session_id = profile.session_id.clone();
    Ok(Some(OwnedCodexDispatchRecovery {
        handle: context.prior_handle,
        fence,
        host_boot_id: HostBootId::parse(boot)
            .map_err(|_| RegistryError::Integrity("invalid recovery host boot".into()))?,
        execution_generation: generation,
        grant_id: GrantId::parse(grant)
            .map_err(|_| RegistryError::Integrity("invalid recovery grant".into()))?,
        presentation_session_id,
        original_native_session_id,
        native_launch,
        blocked_recovery: state == "blocked",
        receipt_only,
    }))
}

pub(super) fn validate_source(
    conn: &Connection,
    source: &OwnedCodexDispatchRecovery,
) -> Result<(), RegistryError> {
    let current = load_source(
        conn,
        source.handle.installation_id.clone(),
        source.handle.soul_id(),
        source.fence.control_epoch,
        source.receipt_only,
    )?;
    if current
        .as_ref()
        .is_none_or(|current| !source.same_custody(current))
    {
        return Err(RegistryError::NativeIdentityConflict);
    }
    Ok(())
}

/// Call only after `validate_source` and typed native acceptance, in the same
/// transaction. A resumed original root and a replacement root settle the same
/// narrow observer refusal; failed or unadmitted sends leave it intact.
pub(super) fn commit_dispatch_acceptance(
    conn: &Connection,
    source: &OwnedCodexDispatchRecovery,
) -> Result<(), RegistryError> {
    if source.receipt_only {
        conn.execute(
            "UPDATE souls SET recovery_state='live',recovery_reason=NULL,updated_at=?1 WHERE soul_id=?2 AND desired_state='running' AND recovery_state='blocked' AND recovery_reason IN (?3,?4,?5,?6) AND NOT EXISTS(SELECT 1 FROM input_commands c WHERE c.soul_id=?2 AND c.incarnation_id=?7 AND c.codex_dispatch_recovery_receipt=1 AND c.state IN ('dispatching','ambiguous'))",
            params![
                now_millis(),
                source.handle.soul_id().as_str(),
                recovery_block_reason_name(RecoveryBlockReason::StoreUnreadable),
                recovery_block_reason_name(RecoveryBlockReason::ImplementationUnavailable),
                recovery_block_reason_name(RecoveryBlockReason::CommandAmbiguous),
                recovery_block_reason_name(RecoveryBlockReason::RetryBudget),
                source.handle.incarnation_id().as_str(),
            ],
        )?;
    } else {
        conn.execute(
            "UPDATE souls SET recovery_state='live',recovery_reason=NULL,updated_at=?1 WHERE soul_id=?2 AND desired_state='running' AND recovery_state='blocked' AND recovery_reason IN (?3,?4)",
            params![
                now_millis(),
                source.handle.soul_id().as_str(),
                recovery_block_reason_name(RecoveryBlockReason::StoreUnreadable),
                recovery_block_reason_name(RecoveryBlockReason::ImplementationUnavailable),
            ],
        )?;
    }
    Ok(())
}
