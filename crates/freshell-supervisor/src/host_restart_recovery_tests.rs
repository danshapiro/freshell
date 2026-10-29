// An authenticated restarted host can inspect its owned store without
// claiming that a worker survived. Probe/recovery uses the real registry/IPC.

async fn unconfirmed_codex_supervisor(
    root: &std::path::Path,
    native: Option<&str>,
) -> (Supervisor, RecoveryContext) {
    use crate::registry::{BackendCreatedRecord, LaunchPreparation, Registry};
    use freshell_runtime_protocol::*;
    let registry = Registry::open(root.join("registry"), None).unwrap();
    let soul = SoulId::new();
    let launch: FreshAgentLaunchSpec = serde_json::from_value(serde_json::json!({
        "sessionId":"managed-codex-stable", "provider":"codex", "sessionType":"freshcodex",
        "runtimeVariant":"codex-app-server", "providerStoreId":"restart-store",
        "cwd":root, "workspacePath":root, "runAsUid":65534, "runAsGid":0,
        "nativeSessionId":native, "model":"catalog-model", "effort":"xhigh",
        "permissionMode":"untrusted", "sandbox":"workspace-write", "collaborationMode":"plan"
    }))
    .unwrap();
    let prepared = registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul.clone(),
            provider: "codex".into(),
            provider_store_id: "restart-store".into(),
            native_session_id: native.map(str::to_owned),
            creation_seed_ref: "original-seed".into(),
            request_id: RequestId::new(),
            payload_digest: "restart-fixture".into(),
            requested_limits: checkpoints::tests::limits(),
            profile: RuntimeProfile::Custom,
            project_key: "fixture".into(),
            fixture: None,
            terminal: None,
            fresh_agent: Some(launch),
            view_intent: None,
            admission: crate::admission::AdmissionPolicy::default(),
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
    registry
        .commit_execution_grant(
            prepared.incarnation_id.clone(),
            HostBootId::new(),
            checkpoints::tests::limits(),
        )
        .await
        .unwrap();
    registry
        .mark_running(prepared.incarnation_id)
        .await
        .unwrap();
    let context = registry.recovery_context(soul).await.unwrap();
    recovery_supervisor(root, registry, context, BackendRuntimeState::Running).await
}

#[tokio::test]
async fn authenticated_unconfirmed_worker_probes_exact_saved_codex_before_recovery() {
    use freshell_runtime_protocol::*;
    for outcome in [
        "ready",
        "unavailable",
        "negative",
        "wrong-native",
        "superseded",
        "unknown-native",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let (supervisor, context) = unconfirmed_codex_supervisor(
            temp.path(),
            (outcome != "unknown-native").then_some("native-saved"),
        )
        .await;
        assert!(context.resume_spec.is_none());
        let original = context.fresh_agent.clone();
        let expected = crate::resume_catalog::exact_resume_candidate(&context, None).unwrap();
        let runtime = context.prior_handle.runtime_dir();
        let secret = b"synthetic-host-secret";
        std::fs::write(runtime.join("secret"), secret).unwrap();
        let listener = tokio::net::UnixListener::bind(runtime.join("host.sock")).unwrap();
        let boot = HostBootId::new();
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        let (shutdown, mut stopping) = tokio::sync::oneshot::channel();
        let host = tokio::spawn({
            let expected = expected.clone();
            let entered = entered.clone();
            let release = release.clone();
            let incarnation = context.prior_handle.incarnation_id().clone();
            async move {
                let mut probes = 0;
                loop {
                    let mut socket = tokio::select! { _=&mut stopping => break, result=listener.accept()=>result.unwrap().0 };
                    let envelope: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                    let result = match envelope.body {
                        HostCommand::Hello {
                            incarnation_id,
                            challenge,
                        } => Ok(HostResult::Hello {
                            host_boot_id: boot.clone(),
                            proof: host_proof(secret, &challenge, &boot, &incarnation_id),
                            capabilities: vec![],
                            effective_limits: checkpoints::tests::limits(),
                        }),
                        command => {
                            assert_eq!(
                                envelope.auth,
                                Some(host_proof(secret, "command-auth", &boot, &incarnation))
                            );
                            match command {
                                HostCommand::Status { incarnation_id } => {
                                    assert_eq!(incarnation_id, incarnation);
                                    Err(RuntimeError::new(RuntimeErrorCode::HostUnreachable,"initialization was recorded but worker liveness is unconfirmed"))
                                }
                                HostCommand::ProbeRecovery {
                                    incarnation_id,
                                    resume_spec,
                                    run_as_uid,
                                    run_as_gid,
                                    ..
                                } => {
                                    assert_eq!(incarnation_id, incarnation);
                                    assert_eq!((run_as_uid, run_as_gid), (65534, 0));
                                    assert_eq!(
                                        resume_spec.as_deref().map(|s| &s.provider_session),
                                        expected.as_ref().map(|s| &s.provider_session)
                                    );
                                    probes += 1;
                                    if outcome == "superseded" {
                                        entered.notify_one();
                                        release.notified().await;
                                    }
                                    if outcome == "unavailable" {
                                        Ok(HostResult::RecoveryProbe(RecoveryProbe::Blocked {
                                            path: RecoveryPath::NativeResume,
                                            reason: RecoveryBlockReason::AmbiguousIdentity,
                                            retry_hint: RetryHint {
                                                automatic_after_ms: None,
                                                manual_retry: true,
                                                repair: None,
                                            },
                                            evidence: vec!["no exact readable positive".into()],
                                        }))
                                    } else if outcome == "negative" {
                                        Ok(HostResult::RecoveryProbe(
                                            RecoveryProbe::DefinitivelyUnavailable {
                                                path: RecoveryPath::NativeResume,
                                                reason: "no matching file".into(),
                                                evidence: vec!["partial store no-match".into()],
                                                store_state: EvidenceStoreState::PresentReadable,
                                                negative_paths: vec![],
                                            },
                                        ))
                                    } else {
                                        let mut resume = expected.clone().expect("unknown native identity must never reach a store probe");
                                        if outcome == "wrong-native" {
                                            resume.provider_session.native_session_id =
                                                "foreign-native".into();
                                        }
                                        Ok(HostResult::RecoveryProbe(RecoveryProbe::ResumeReady {
                                            evidence_revision: 0,
                                            resume_spec: Box::new(resume),
                                        }))
                                    }
                                }
                                other => panic!(
                                    "probe must not start, send, stop or configure: {other:?}"
                                ),
                            }
                        }
                    };
                    write_frame(
                        &mut socket,
                        &HostReply {
                            request_id: envelope.request_id,
                            result,
                        },
                    )
                    .await
                    .unwrap();
                }
                probes
            }
        });
        let pending = tokio::spawn({
            let supervisor = supervisor.clone();
            let soul = context.soul_id.clone();
            async move { supervisor.probe_recovery(soul).await }
        });
        let newer = if outcome == "superseded" {
            tokio::time::timeout(Duration::from_secs(3), entered.notified())
                .await
                .unwrap();
            let mut newer = expected.clone().unwrap();
            newer.durable_position.provider_cursor = Some("newer-proof".into());
            let stored = supervisor
                .registry
                .store_verified_resume_spec(context.soul_id.clone(), newer)
                .await
                .unwrap();
            release.notify_one();
            Some(stored)
        } else {
            None
        };
        let result = tokio::time::timeout(Duration::from_secs(3), pending)
            .await
            .unwrap()
            .unwrap();
        shutdown.send(()).unwrap();
        let probes = host.await.unwrap();
        let after = supervisor
            .registry
            .recovery_context(context.soul_id.clone())
            .await
            .unwrap();
        assert_eq!(
            after.fresh_agent, original,
            "probe must preserve settings/presentation identity"
        );
        assert_eq!(
            after.prior_handle.incarnation_id(),
            context.prior_handle.incarnation_id()
        );
        assert_eq!(probes,usize::from(outcome!="unknown-native"),"{outcome}: an authenticated host must inspect the recorded exact native store despite unconfirmed worker liveness");
        match outcome {
            "ready" => {
                assert!(
                    matches!(result, Ok(RecoveryProbe::ResumeReady { .. })),
                    "{result:?}"
                );
                assert_eq!(
                    after.resume_spec.unwrap().provider_session,
                    expected.unwrap().provider_session
                );
                assert!(after.evidence_revision > 0);
            }
            "superseded" => {
                assert!(
                    matches!(result, Ok(RecoveryProbe::Blocked { .. })),
                    "{result:?}"
                );
                assert_eq!(after.resume_spec, newer);
            }
            _ => {
                assert!(
                    !matches!(
                        result,
                        Ok(RecoveryProbe::ResumeReady { .. } | RecoveryProbe::ReattachReady { .. })
                    ),
                    "{outcome}: {result:?}"
                );
                assert!(after.resume_spec.is_none());
                assert_eq!(after.evidence_revision, 0);
                assert!(matches!(result,Ok(RecoveryProbe::Blocked{..})|Err(_)),"an unconfirmed worker permits only a positive exact resume proof, never absence/loss authority: {result:?}");
            }
        }
    }
}
