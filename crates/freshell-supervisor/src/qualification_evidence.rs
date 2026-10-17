use freshell_runtime_protocol::{
    QualificationWriterClaimEvidence, QualificationWriterClaimRequest,
};
use rusqlite::params;

use crate::registry::{Registry, RegistryError};

/// Read-only writer metadata for an exact durable provider/session/soul tuple.
/// Observing existing claims is independent of provider launch admission. It
/// exposes counts and identifiers, never launch payloads or credential material.
pub async fn writer_claim_evidence(
    registry: &Registry,
    request: QualificationWriterClaimRequest,
) -> Result<QualificationWriterClaimEvidence, RegistryError> {
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
    use freshell_runtime_protocol::{
        FreshAgentLaunchSpec, FreshProvider, RequestId, RuntimeLimits, RuntimeProfile, SoulId,
        StopOutcome,
    };

    async fn prepare_fresh_claim(
        registry: &Registry,
        provider: FreshProvider,
        store: &str,
        native: &str,
    ) -> QualificationWriterClaimRequest {
        let (session_type, runtime_variant) = match provider {
            FreshProvider::Claude => ("freshclaude", "claude-sdk-sidecar"),
            FreshProvider::Codex => ("freshcodex", "codex-app-server"),
            _ => unreachable!("this regression exercises Claude and Codex"),
        };
        let provider_name = provider.native_family().to_owned();
        let soul = SoulId::new();
        let prepared = registry
            .prepare_launch(LaunchPreparation {
                soul_id: soul.clone(),
                provider: provider_name.clone(),
                provider_store_id: store.into(),
                native_session_id: None,
                creation_seed_ref: "seed".into(),
                request_id: RequestId::new(),
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
                fresh_agent: Some(FreshAgentLaunchSpec {
                    session_id: soul.as_str().into(),
                    provider,
                    session_type: session_type.into(),
                    runtime_variant: runtime_variant.into(),
                    provider_store_id: store.into(),
                    cwd: "/tmp".into(),
                    workspace_path: "/tmp".into(),
                    git_common_dir: None,
                    run_as_uid: 65_534,
                    run_as_gid: 0,
                    model: None,
                    effort: None,
                    permission_mode: None,
                    sandbox: None,
                    native_session_id: None,
                    plugins: None,
                    model_selection: None,
                    session_ref: None,
                    fixture_transport: None,
                    provider_bootstrap_files: Vec::new(),
                    provider_secret_references: Vec::new(),
                    provider_launch_context: None,
                }),
                view_intent: None,
                admission: AdmissionPolicy::default(),
            })
            .await
            .unwrap();
        registry
            .record_native_session(soul.clone(), prepared.incarnation_id.clone(), native.into())
            .await
            .unwrap();
        QualificationWriterClaimRequest {
            provider: provider_name,
            native_session_id: native.into(),
            soul_id: soul,
            incarnation_id: prepared.incarnation_id,
        }
    }

    async fn proves_fresh_writer_without_terminal_admission(provider: FreshProvider) {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(root.path(), None).unwrap();
        let request = prepare_fresh_claim(&registry, provider, "fresh-store", "native-root").await;
        let live = writer_claim_evidence(&registry, request.clone())
            .await
            .expect("read-only fresh writer metadata must not require terminal launch admission");
        assert_eq!(
            live,
            QualificationWriterClaimEvidence {
                provider: request.provider.clone(),
                provider_store_id: "fresh-store".into(),
                native_session_id: request.native_session_id.clone(),
                soul_id: request.soul_id.clone(),
                incarnation_id: request.incarnation_id.clone(),
                active_claim_count: 1,
                global_conflicting_claim_count: 0,
            }
        );
        registry
            .mark_stop_outcome(request.incarnation_id.clone(), StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let released = writer_claim_evidence(&registry, request).await.unwrap();
        assert_eq!(
            released,
            QualificationWriterClaimEvidence {
                active_claim_count: 0,
                ..live
            }
        );
    }

    #[tokio::test]
    async fn fresh_claude_writer_metadata_does_not_require_terminal_admission() {
        proves_fresh_writer_without_terminal_admission(FreshProvider::Claude).await;
    }

    #[tokio::test]
    async fn fresh_codex_writer_metadata_does_not_require_terminal_admission() {
        proves_fresh_writer_without_terminal_admission(FreshProvider::Codex).await;
    }

    #[tokio::test]
    async fn rejects_a_provider_or_native_root_that_differs_from_the_durable_soul() {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(root.path(), None).unwrap();
        let request = prepare_fresh_claim(
            &registry,
            FreshProvider::Claude,
            "fresh-store",
            "native-root",
        )
        .await;
        for mismatch in [
            QualificationWriterClaimRequest {
                provider: "opencode".into(),
                ..request.clone()
            },
            QualificationWriterClaimRequest {
                native_session_id: "different-root".into(),
                ..request.clone()
            },
        ] {
            assert!(matches!(
                writer_claim_evidence(&registry, mismatch).await,
                Err(RegistryError::Integrity(message))
                    if message == "qualification writer-claim identity does not match the durable soul"
            ));
        }
        let unknown_soul = QualificationWriterClaimRequest {
            soul_id: SoulId::new(),
            ..request
        };
        assert!(writer_claim_evidence(&registry, unknown_soul)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn released_owner_observes_a_successor_as_a_global_conflict() {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(root.path(), None).unwrap();
        let original = prepare_fresh_claim(
            &registry,
            FreshProvider::Claude,
            "shared-store",
            "native-root",
        )
        .await;
        let independent = prepare_fresh_claim(
            &registry,
            FreshProvider::Claude,
            "independent-store",
            "native-root",
        )
        .await;
        let live = writer_claim_evidence(&registry, original.clone())
            .await
            .unwrap();
        assert_eq!(live.active_claim_count, 1);
        assert_eq!(live.global_conflicting_claim_count, 0);
        registry
            .mark_stop_outcome(original.incarnation_id.clone(), StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let released = writer_claim_evidence(&registry, original.clone())
            .await
            .unwrap();
        assert_eq!(released.active_claim_count, 0);
        assert_eq!(released.global_conflicting_claim_count, 0);
        let successor = prepare_fresh_claim(
            &registry,
            FreshProvider::Claude,
            "shared-store",
            "native-root",
        )
        .await;
        let old = writer_claim_evidence(&registry, original.clone())
            .await
            .unwrap();
        assert_eq!(old.active_claim_count, 0);
        assert_eq!(old.global_conflicting_claim_count, 1);
        let current = writer_claim_evidence(&registry, successor.clone())
            .await
            .unwrap();
        assert_eq!(current.active_claim_count, 1);
        assert_eq!(current.global_conflicting_claim_count, 0);
        let wrong_incarnation = QualificationWriterClaimRequest {
            incarnation_id: original.incarnation_id,
            ..successor
        };
        let wrong = writer_claim_evidence(&registry, wrong_incarnation)
            .await
            .unwrap();
        assert_eq!(wrong.active_claim_count, 0);
        assert_eq!(wrong.global_conflicting_claim_count, 1);
        let separate = writer_claim_evidence(&registry, independent).await.unwrap();
        assert_eq!(separate.active_claim_count, 1);
        assert_eq!(separate.global_conflicting_claim_count, 0);
    }

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
                fresh_agent: None,
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

        registry
            .mark_stop_outcome(prepared.incarnation_id, StopOutcome::VerifiedEmpty)
            .await
            .unwrap();
        let stopped = writer_claim_evidence(&registry, request).await.unwrap();
        assert_eq!(stopped.active_claim_count, 0);
        assert_eq!(stopped.global_conflicting_claim_count, 0);
    }
}
