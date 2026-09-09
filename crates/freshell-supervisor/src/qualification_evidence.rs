use freshell_runtime_protocol::{
    QualificationWriterClaimEvidence, QualificationWriterClaimRequest,
};
use rusqlite::params;

use crate::registry::{Registry, RegistryError};

/// Read-only evidence endpoint compiled into the supervisor but usable only
/// by an explicitly selected qualification provider. It exposes counts and
/// identifiers, never launch payloads or credential material.
pub async fn writer_claim_evidence(
    registry: &Registry,
    request: QualificationWriterClaimRequest,
) -> Result<QualificationWriterClaimEvidence, RegistryError> {
    if !freshell_agent_runtime::managed_provider_enabled(&request.provider) {
        return Err(RegistryError::Integrity(format!(
            "provider {} is not selected by the qualification-only policy",
            request.provider
        )));
    }
    registry
        .run_blocking(move |conn| {
            let (stored_provider, provider_store_id, stored_native): (
                String,
                String,
                Option<String>,
            ) = conn.query_row(
                "SELECT provider,provider_store_id,native_session_id FROM souls WHERE soul_id=?1",
                params![request.soul_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            if stored_provider != request.provider
                || stored_native.as_deref() != Some(request.native_session_id.as_str())
            {
                return Err(RegistryError::Integrity(
                    "qualification writer-claim identity does not match the durable soul".into(),
                ));
            }
            let active_claim_count: u64 = conn.query_row(
                "SELECT COUNT(*) FROM writer_claims WHERE provider=?1 AND provider_store_id=?2 AND native_session_id=?3 AND soul_id=?4 AND incarnation_id=?5",
                params![request.provider, provider_store_id, request.native_session_id, request.soul_id.as_str(), request.incarnation_id.as_str()],
                |row| row.get(0),
            )?;
            let global_claim_count: u64 = conn.query_row(
                "SELECT COUNT(*) FROM writer_claims WHERE provider=?1 AND provider_store_id=?2 AND native_session_id=?3",
                params![request.provider, provider_store_id, request.native_session_id],
                |row| row.get(0),
            )?;
            Ok(QualificationWriterClaimEvidence {
                provider: request.provider,
                provider_store_id,
                native_session_id: request.native_session_id,
                soul_id: request.soul_id,
                incarnation_id: request.incarnation_id,
                active_claim_count,
                global_conflicting_claim_count: global_claim_count.saturating_sub(active_claim_count),
            })
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::admission::AdmissionPolicy;
    use crate::registry::LaunchPreparation;
    use freshell_runtime_protocol::{RequestId, RuntimeLimits, RuntimeProfile, SoulId};

    #[tokio::test]
    async fn proves_the_exact_global_tuple_owner_then_its_release() {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(root.path(), None).unwrap();
        let soul = SoulId::parse("soul-qualification-claim").unwrap();
        let native = "ses_exact_claim".to_string();
        let prepared = registry
            .prepare_launch(LaunchPreparation {
                soul_id: soul.clone(),
                provider: "opencode".into(),
                provider_store_id: "store-exact-claim".into(),
                native_session_id: Some(native.clone()),
                creation_seed_ref: "seed".into(),
                request_id: RequestId::parse("request-qualification-claim").unwrap(),
                payload_digest: "digest".into(),
                requested_limits: RuntimeLimits {
                    cpu_milli: 100,
                    memory_bytes: 1024,
                    swap_bytes: 0,
                    pids_max: 2,
                },
                profile: RuntimeProfile::DefaultAgent,
                project_key: "project".into(),
                fixture: None,
                terminal: None,
                view_intent: None,
                admission: AdmissionPolicy::default(),
            })
            .await
            .unwrap();
        let request = QualificationWriterClaimRequest {
            provider: "opencode".into(),
            native_session_id: native,
            soul_id: soul,
            incarnation_id: prepared.incarnation_id.clone(),
        };
        let live = writer_claim_evidence(&registry, request.clone())
            .await
            .unwrap();
        assert_eq!(live.active_claim_count, 1);
        assert_eq!(live.global_conflicting_claim_count, 0);

        let incarnation = prepared.incarnation_id;
        registry
            .run_blocking(move |conn| {
                conn.execute(
                    "DELETE FROM writer_claims WHERE incarnation_id=?1",
                    params![incarnation.as_str()],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let stopped = writer_claim_evidence(&registry, request).await.unwrap();
        assert_eq!(stopped.active_claim_count, 0);
        assert_eq!(stopped.global_conflicting_claim_count, 0);
    }
}
