use super::*;
use crate::{
    admission::AdmissionPolicy,
    registry::{BackendCreatedRecord, LaunchPreparation, Registry},
};
use freshell_runtime_protocol::*;

pub(crate) fn limits() -> RuntimeLimits {
    RuntimeLimits {
        cpu_milli: 500,
        memory_bytes: 64 * 1024 * 1024,
        swap_bytes: 0,
        pids_max: 32,
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
        registry
            .commit_execution_grant(prepared.incarnation_id.clone(), HostBootId::new(), limits())
            .await
            .unwrap();
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
    let connection = rusqlite::Connection::open(&db).unwrap();
    connection
        .execute("CREATE TABLE session(id TEXT PRIMARY KEY)", [])
        .unwrap();
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
