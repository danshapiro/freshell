use super::*;
use crate::{
    admission::AdmissionPolicy,
    registry::{BackendCreatedRecord, LaunchPreparation, Registry},
};
use freshell_runtime_protocol::*;
use sha2::{Digest, Sha256};

pub(crate) fn limits() -> RuntimeLimits {
    RuntimeLimits {
        cpu_milli: 500,
        memory_bytes: 64 * 1024 * 1024,
        swap_bytes: 0,
        pids_max: 32,
    }
}

pub(crate) fn create_empty_opencode_store(path: &std::path::Path) {
    let connection = rusqlite::Connection::open(path).unwrap();
    connection
        .execute_batch(freshell_sessions::opencode_transfer::pinned_destination_schema_sql())
        .unwrap();
    for migration in freshell_sessions::opencode_transfer::pinned_destination_migration_ids() {
        connection
            .execute("INSERT INTO migration VALUES (?1,0)", [migration])
            .unwrap();
    }
}

pub(crate) async fn context(
    root: &std::path::Path,
    provider: &str,
    dispatched: bool,
) -> (Registry, RecoveryContext) {
    context_with_native_identity(
        root,
        provider,
        dispatched,
        (provider != "shell").then_some("exact-session"),
    )
    .await
}

pub(crate) async fn context_with_native_identity(
    root: &std::path::Path,
    provider: &str,
    dispatched: bool,
    native_session_id: Option<&str>,
) -> (Registry, RecoveryContext) {
    let registry = Registry::open(root.join("registry"), None).unwrap();
    let soul = SoulId::new();
    let prepared = registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul.clone(),
            provider: provider.into(),
            provider_store_id: "store".into(),
            native_session_id: native_session_id.map(str::to_owned),
            creation_seed_ref: "original-seed".into(),
            request_id: RequestId::new(),
            payload_digest: "fixture".into(),
            requested_limits: limits(),
            profile: RuntimeProfile::Custom,
            project_key: "fixture".into(),
            fixture: None,
            terminal: None,
            fresh_agent: None,
            view_intent: None,
            admission: AdmissionPolicy::default(),
        })
        .await
        .unwrap();
    let runtime = root.join("runtime");
    std::fs::create_dir_all(&runtime).unwrap();
    std::fs::write(runtime.join("host"), b"synthetic-host").unwrap();
    registry
        .commit_created(
            prepared.incarnation_id.clone(),
            BackendCreatedRecord {
                launch_policy: None,
                daemon_id: DockerDaemonId::new(),
                container_id: "a".repeat(64),
                image_ref: format!("sha256:{}", "b".repeat(64)),
                runtime_dir: runtime.clone(),
                host_binary_path: runtime.join("host"),
                immutable_config_digest: format!("sha256:{}", "c".repeat(64)),
            },
        )
        .await
        .unwrap();
    if dispatched {
        let grant = registry
            .commit_execution_grant(prepared.incarnation_id.clone(), HostBootId::new(), limits())
            .await
            .unwrap();
        if provider == "opencode" {
            // These callers start with a valid observed runtime. Resume and
            // checkpoint evidence remain absent until each test supplies it.
            // The dispatched-false branch deliberately models unobserved
            // legacy state and must not acquire admission evidence here.
            let current = registry.recovery_context(soul.clone()).await.unwrap();
            let native_session_id = current
                .native_session_id
                .clone()
                .expect("dispatched OpenCode checkpoint fixtures require a selected native ID");
            let launch = registry
                .bind_native_identity_launch(NativeIdentityLaunch {
                    incarnation_id: prepared.incarnation_id.clone(),
                    launch_nonce: current.prior_handle.launch_nonce().as_str().into(),
                    evidence_revision: current.evidence_revision,
                    execution_generation: grant.execution_generation,
                    requested_native_session_id: Some(native_session_id.clone()),
                })
                .await
                .unwrap();
            registry
                .record_native_identity_observation(
                    soul.clone(),
                    NativeIdentityObservation {
                        native_session_id,
                        incarnation_id: launch.incarnation_id,
                        launch_nonce: launch.launch_nonce,
                        evidence_revision: launch.evidence_revision,
                        source: NativeIdentitySource::OpencodeTui,
                        evidence_digest: format!(
                            "{:x}",
                            Sha256::digest(b"synthetic checkpoint fixture native admission")
                        ),
                    },
                    current.write_fence(),
                )
                .await
                .unwrap();
        }
        registry
            .mark_running(prepared.incarnation_id)
            .await
            .unwrap();
        let request = RequestId::new();
        registry
            .begin_input(soul.clone(), request.clone(), b"synthetic-input", None)
            .await
            .unwrap();
        registry
            .mark_input_dispatching(soul.clone(), request)
            .await
            .unwrap();
    }
    let context = registry.recovery_context(soul).await.unwrap();
    (registry, context)
}

pub(crate) fn spec(provider: &str) -> ResumeSpec {
    serde_json::from_value(serde_json::json!({
        "providerSession":{"provider":provider,"providerStoreId":"store","nativeSessionId":"exact-session"},
        "mode":provider,"program":provider,"providerHome":"/home/freshell/provider","cwd":"/workspace",
        "workspacePath":"/workspace","creationSeedRef":"original-seed","checkpointRevision":0,
        "allocationState":"verified_durable","evidenceRevision":1,"neverDispatched":false
    })).unwrap()
}

fn negative(reason: &str, evidence: Vec<String>, store_state: EvidenceStoreState) -> RecoveryProbe {
    RecoveryProbe::DefinitivelyUnavailable {
        path: RecoveryPath::NativeResume,
        reason: reason.into(),
        evidence,
        store_state,
        negative_paths: vec![],
    }
}

#[tokio::test]
async fn zero_revision_blocks() {
    let temp = tempfile::tempdir().unwrap();
    let (_, ctx) = context(temp.path(), "opencode", true).await;
    assert!(matches!(probe(&ctx), RecoveryProbe::Blocked { .. }));
}
#[tokio::test]
async fn reason_text_is_not_inspection() {
    let temp = tempfile::tempdir().unwrap();
    let (_, ctx) = context(temp.path(), "opencode", true).await;
    let p = negative(
        "checkpoint missing",
        vec!["/fixture/.freshell/checkpoints/looks-inspected".into()],
        EvidenceStoreState::Missing,
    );
    assert!(matches!(
        probe_after_provider(&ctx, &p),
        RecoveryProbe::Blocked { .. }
    ));
}
#[tokio::test]
async fn legacy_negative_blocks() {
    let temp = tempfile::tempdir().unwrap();
    let (_, ctx) = context(temp.path(), "opencode", true).await;
    assert!(matches!(
        probe_after_provider(
            &ctx,
            &negative("missing", vec![], EvidenceStoreState::Missing)
        ),
        RecoveryProbe::Blocked { .. }
    ));
}

#[tokio::test]
async fn unreadable_unknown_or_empty_inspected_rows_block() {
    let temp = tempfile::tempdir().unwrap();
    let (_, ctx) = context(temp.path(), "opencode", true).await;
    for (store_state, refs) in [
        (EvidenceStoreState::Unknown, vec!["store".into()]),
        (EvidenceStoreState::PresentUnreadable, vec!["store".into()]),
        (EvidenceStoreState::Missing, vec![]),
        (EvidenceStoreState::Missing, vec![String::new()]),
    ] {
        let mut p = negative(
            "missing",
            vec!["aggregate".into()],
            EvidenceStoreState::Missing,
        );
        if let RecoveryProbe::DefinitivelyUnavailable { negative_paths, .. } = &mut p {
            negative_paths.push(RecoveryPathEvidence {
                path: RecoveryPath::CheckpointRestore,
                verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                reason_code: "INSPECTED_ABSENCE".into(),
                evidence_refs: refs,
                store_state,
            });
        }
        assert!(
            matches!(
                probe_after_provider(&ctx, &p),
                RecoveryProbe::Blocked { .. }
            ),
            "{p:?}"
        );
    }
}
#[tokio::test]
async fn conflicting_rows_block() {
    let temp = tempfile::tempdir().unwrap();
    let (_, ctx) = context(temp.path(), "opencode", true).await;
    let mut p = negative(
        "checkpoint missing",
        vec!["checkpoint=missing".into(), "checkpoint=present".into()],
        EvidenceStoreState::Missing,
    );
    if let RecoveryProbe::DefinitivelyUnavailable { negative_paths, .. } = &mut p {
        negative_paths.extend(
            [
                EvidenceStoreState::Missing,
                EvidenceStoreState::PresentReadable,
            ]
            .map(|store_state| RecoveryPathEvidence {
                path: RecoveryPath::CheckpointRestore,
                verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
                reason_code: "INSPECTED_ABSENCE".into(),
                evidence_refs: vec!["synthetic store inspection".into()],
                store_state,
            }),
        );
    }
    assert!(matches!(
        probe_after_provider(&ctx, &p),
        RecoveryProbe::Blocked { .. }
    ));
}
#[tokio::test]
async fn unreadable_store_blocks() {
    let temp = tempfile::tempdir().unwrap();
    let (_, ctx) = context(temp.path(), "native-session-fixture", true).await;
    std::fs::write(temp.path().join("native-session-state.json"), b"malformed").unwrap();
    let p =
        freshell_agent_runtime::probe_provider_store(temp.path(), &spec("native-session-fixture"));
    assert!(matches!(
        p,
        freshell_agent_runtime::ProviderStoreProbe::Blocked {
            reason: RecoveryBlockReason::StoreUnreadable,
            ..
        }
    ));
    assert!(matches!(probe(&ctx), RecoveryProbe::Blocked { .. }));
}
#[tokio::test]
async fn independent_present_checkpoint_restores() {
    let temp = tempfile::tempdir().unwrap();
    let (_, mut ctx) = context(temp.path(), "native-session-fixture", true).await;
    let dir = temp.path().join(".freshell/checkpoints/native-session");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("7.json"),
        br#"{"sessionId":"exact-session","checkpointRevision":7}"#,
    )
    .unwrap();
    let p =
        freshell_agent_runtime::probe_provider_store(temp.path(), &spec("native-session-fixture"));
    let freshell_agent_runtime::ProviderStoreProbe::Ready { evidence } = p else {
        panic!("{p:?}")
    };
    assert!(evidence.iter().any(|e| e == "checkpointRevision=7"));
    let mut spec = spec("native-session-fixture");
    spec.checkpoint_revision = 7;
    spec.checkpoint_references = vec![CheckpointReference {
        kind: "fixture".into(),
        reference: dir.join("7.json").display().to_string(),
        revision: 7,
        verified: true,
    }];
    ctx.checkpoint_revision = 7;
    ctx.resume_spec = Some(spec);
    assert!(matches!(
        probe_after_provider(
            &ctx,
            &RecoveryProbe::Blocked {
                path: RecoveryPath::NativeResume,
                reason: RecoveryBlockReason::StoreMissing,
                retry_hint: RetryHint {
                    automatic_after_ms: None,
                    manual_retry: true,
                    repair: None
                },
                evidence: vec![]
            }
        ),
        RecoveryProbe::ResumeReady { .. }
    ));
}
#[tokio::test]
async fn inspected_shared_store_absence_remains_definitive() {
    let temp = tempfile::tempdir().unwrap();
    let (_, ctx) = context(temp.path(), "opencode", true).await;
    let db = temp.path().join(".local/share/opencode/opencode.db");
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    create_empty_opencode_store(&db);
    let mut effective_spec = spec("opencode");
    effective_spec
        .environment
        .insert("OPENCODE_DB".into(), db.display().to_string());
    let p = freshell_agent_runtime::probe_provider_store(temp.path(), &effective_spec);
    let freshell_agent_runtime::ProviderStoreProbe::DefinitivelyUnavailable {
        reason,
        evidence,
        store_state,
        negative_paths,
    } = p
    else {
        panic!("{p:?}")
    };
    let probe = RecoveryProbe::DefinitivelyUnavailable {
        path: RecoveryPath::NativeResume,
        reason,
        evidence,
        store_state,
        negative_paths,
    };
    assert!(matches!(
        probe_after_provider(&ctx, &probe),
        RecoveryProbe::DefinitivelyUnavailable {
            path: RecoveryPath::CheckpointRestore,
            ..
        }
    ));
}
