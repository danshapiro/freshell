use super::*;
use freshell_protocol::{FreshAgentFork, FreshAgentRecoveryStop};
use freshell_runtime_protocol::{
    read_frame, write_frame, AdminCommand, AdminReply, AdminResult, ControlRole, Envelope,
    FreshAgentForkResult, FreshAgentProviderStartDiagnostic, InstallationId, RuntimeDiagnosticCode,
    RuntimeErrorCode,
};
use tokio::net::UnixListener;

#[tokio::test]
async fn task010_hosted_new_conversation_admits_only_its_verified_current_name() {
    use freshell_freshagent::naming::{
        HostedCodexNamingFact, NameActivity, NameActivityReason, RenameNameInput,
    };
    use freshell_protocol::native_location::{
        NativeAcquisition, NativeEvidenceKind, NativeLocation, NativePersistence,
    };
    use freshell_protocol::session_names::{NameIntent, SessionNameRef};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("new-name.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let switch_after = Arc::new(AtomicUsize::new(0));
    let switch = switch_after.clone();
    let server = tokio::spawn(async move {
        let changed = AtomicBool::new(false);
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            let result = match request.body {
                AdminCommand::Health => AdminResult::Health {
                    control_epoch: 7,
                    installation_id: InstallationId::new(),
                },
                AdminCommand::Inventory => {
                    if switch.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                        remaining.checked_sub(1)
                    }) == Ok(1)
                    {
                        changed.store(true, Ordering::SeqCst);
                    }
                    AdminResult::Inventory(vec![serde_json::from_value(serde_json::json!({
                    "soulId":"name-soul","incarnationId":"name-incarnation","hostBootId":if changed.load(Ordering::SeqCst) {"new-boot"} else {"name-boot"},
                    "launchState":"running","cleanupState":"none","intentRevision":3,"executionGeneration":2,
                    "desiredState":"running","recoveryState":"live","durabilityState":"unknown","allocationState":"allocated",
                    "evidenceRevision":0,"successfulRecoveriesInWindow":0,"provider":"codex",
                    "nativeSessionId":"new-native","freshAgentSessionId":"same-opaque-ref","freshAgentSessionType":"freshcodex"
                })).unwrap()])
                }
                other => panic!("name admission must perform no provider work: {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
    });
    let proxy = snapshot_outage_proxy(&socket);
    let names = crate::session_names::SessionNames::open(dir.path().join("names")).unwrap();
    proxy.set_session_naming(names.clone());
    let target = |id: &str| SessionNameRef::Session {
        provider: NamedProvider::Codex,
        session_id: id.into(),
    };
    let old = target("old-native");
    let new = target("new-native");
    names.ensure_session(old.clone(), None).await.unwrap();
    let old_record = names
        .rename(RenameNameInput {
            target: old.clone(),
            name: "Protected old manual name".into(),
            intent: NameIntent::User,
            if_revision: None,
            cwd: None,
        })
        .await
        .unwrap()
        .record;
    let acquisition = |id: &str, persistence| HostedCodexNamingFact::Acquisition {
        target: target(id),
        cwd: Some("/work/recovery".into()),
        acquisition: NativeAcquisition {
            location: NativeLocation::Codex {
                codex_home: "/owning/codex".into(),
                native_thread_id: Some(id.into()),
                rollout_path: Some(format!("/owning/codex/sessions/rollout-{id}.jsonl")),
                persistence_evidence: Some("verified header".into()),
            },
            evidence: NativeEvidenceKind::PersistedMetadata,
            persistence,
        },
    };
    for (id, persistence) in [
        ("old-native", NativePersistence::Verified),
        ("new-native", NativePersistence::Prospective),
    ] {
        proxy
            .fold_hosted_codex_naming(
                "same-opaque-ref",
                id,
                serde_json::to_value(acquisition(id, persistence)).unwrap(),
            )
            .await;
    }
    assert!(
        names.get(vec![new.clone()]).await.unwrap().is_empty(),
        "stale or prospective facts cannot admit a name"
    );
    let fact =
        serde_json::to_value(acquisition("new-native", NativePersistence::Verified)).unwrap();
    proxy
        .fold_hosted_codex_naming("same-opaque-ref", "new-native", fact.clone())
        .await;
    let admitted = names.get(vec![new.clone()]).await.unwrap();
    assert_eq!(
        admitted.len(),
        1,
        "a verified new conversation must have its own saved name"
    );
    assert_eq!(admitted[0].record.name_ref, new);
    assert_ne!(admitted[0].record.name, old_record.name);
    assert!(names.current_location_revision(&new).await.unwrap() > 0);
    assert_eq!(names.get(vec![old]).await.unwrap()[0].record, old_record);
    // The accepted input can now upgrade this record without transferring
    // the old conversation's protected name or redirecting either native ref.
    names
        .activity(NameActivity {
            target: new.clone(),
            mode: "freshcodex".into(),
            event_id: "recovery-input".into(),
            reason: NameActivityReason::AcceptedUserMessage,
            first_user_message: Some("New recovery subject".into()),
            cwd: Some("/work/recovery".into()),
        })
        .await
        .unwrap();
    assert_eq!(
        names.get(vec![new]).await.unwrap()[0].record.name,
        "New recovery subject"
    );
    let manual = names
        .rename(RenameNameInput {
            target: target("new-native"),
            name: "New protected manual name".into(),
            intent: NameIntent::User,
            if_revision: None,
            cwd: None,
        })
        .await
        .unwrap();
    proxy
        .fold_hosted_codex_naming("same-opaque-ref", "new-native", fact)
        .await;
    assert_eq!(
        names.get(vec![target("new-native")]).await.unwrap()[0].record,
        manual.record,
        "replayed acquisition must preserve the new conversation's own manual name"
    );
    let location_revision = names
        .current_location_revision(&target("new-native"))
        .await
        .unwrap();
    let mut stale_location =
        serde_json::to_value(acquisition("new-native", NativePersistence::Verified)).unwrap();
    stale_location["data"]["acquisition"]["location"]["rolloutPath"] =
        serde_json::json!("/changed-during-admission.jsonl");
    switch_after.store(2, Ordering::SeqCst);
    proxy
        .fold_hosted_codex_naming("same-opaque-ref", "new-native", stale_location)
        .await;
    assert_eq!(
        names
            .current_location_revision(&target("new-native"))
            .await
            .unwrap(),
        location_revision,
        "a host source change across admission cannot authorize a new native location"
    );
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn hosted_native_name_reads_pin_the_source_and_preserve_typed_delivery_failures() {
    use crate::session_name_native::{NativeCallResult, NativeNameTarget};
    use freshell_runtime_protocol::{
        FreshAgentNativeNameError as Error, FreshAgentNativeNameReply as Reply,
    };
    let dir = tempfile::tempdir().unwrap();
    for scenario in [
        "ok",
        "missing",
        "source-changes",
        "unavailable",
        "unsupported",
        "refused",
        "timeout",
        "closed",
        "transport",
        "invalid-response",
    ] {
        let socket = dir.path().join(format!("native-name-{scenario}.sock"));
        let listener = UnixListener::bind(&socket).unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let server = tokio::spawn(async move {
            let mut inventories = 0;
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                let result = match envelope.body {
                    AdminCommand::Health => AdminResult::Health {
                        control_epoch: 7,
                        installation_id: InstallationId::new(),
                    },
                    AdminCommand::Inventory => {
                        inventories += 1;
                        AdminResult::Inventory(vec![serde_json::from_value(serde_json::json!({
                            "soulId":"name-soul","incarnationId":"name-incarnation","hostBootId":if scenario=="source-changes"&&inventories>1 {"replaced-boot"}else{"name-boot"},
                            "launchState":"running","cleanupState":"none","intentRevision":3,"executionGeneration":2,
                            "desiredState":"running","recoveryState":"live","durabilityState":"unknown","allocationState":"allocated",
                            "evidenceRevision":0,"successfulRecoveriesInWindow":0,"provider":"codex",
                            "nativeSessionId":if scenario=="missing" {"foreign-native"}else{"name-native"},"freshAgentSessionId":"public-name-session","freshAgentSessionType":"freshcodex"
                        })).unwrap()])
                    }
                    AdminCommand::FreshAgentNativeName(request) => {
                        assert_eq!(request.soul_id.as_str(), "name-soul");
                        assert_eq!(request.codex_home, "/owning/codex");
                        assert_eq!(request.source.native_session_id, "name-native");
                        assert_eq!(request.source.incarnation_id.as_str(), "name-incarnation");
                        assert_eq!(request.source.host_boot_id.as_str(), "name-boot");
                        assert_eq!(
                            (
                                request.source.execution_generation,
                                request.source.intent_revision
                            ),
                            (2, 3)
                        );
                        assert_eq!(request.expected_control_epoch, Some(7));
                        assert_eq!(
                            request.operation,
                            freshell_runtime_protocol::FreshAgentNativeNameOperation::Read
                        );
                        seen.lock().await.push(request);
                        AdminResult::FreshAgentNativeName(match scenario {
                            "ok" | "source-changes" => Reply::Title(Some("Native title".into())),
                            "unavailable" => Reply::Failed(Error::Unavailable {
                                message: "current connection absent".into(),
                            }),
                            "unsupported" => Reply::Failed(Error::Rpc {
                                code: -32601,
                                message: "method unavailable".into(),
                            }),
                            "refused" => Reply::Failed(Error::Rpc {
                                code: -32602,
                                message: "invalid name input".into(),
                            }),
                            "timeout" => Reply::Failed(Error::Timeout { timeout_ms: 20_000 }),
                            "closed" => Reply::Failed(Error::Closed),
                            "transport" => Reply::Failed(Error::Transport {
                                message: "send refused".into(),
                            }),
                            "invalid-response" => Reply::Failed(Error::InvalidResponse {
                                detail: "malformed metadata".into(),
                            }),
                            _ => unreachable!(),
                        })
                    }
                    other => panic!("native naming attempted unrelated operation: {other:?}"),
                };
                write_frame(
                    &mut stream,
                    &AdminReply {
                        request_id: envelope.request_id,
                        result: Ok(result),
                    },
                )
                .await
                .unwrap();
            }
        });
        let backend = snapshot_outage_proxy(&socket).native_name_backend();
        let reply = backend
            .read(NativeNameTarget {
                name_ref: freshell_protocol::session_names::SessionNameRef::Session {
                    provider: NamedProvider::Codex,
                    session_id: "name-native".into(),
                },
                location: freshell_protocol::native_location::NativeLocation::Codex {
                    codex_home: "/owning/codex".into(),
                    native_thread_id: Some("name-native".into()),
                    rollout_path: None,
                    persistence_evidence: None,
                },
                location_revision: 1,
            })
            .await;
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
        match scenario {
            "ok" => assert!(
                matches!(reply,NativeCallResult::Confirmed(value) if value.title.as_deref()==Some("Native title"))
            ),
            "missing" | "unavailable" | "refused" | "transport" => assert!(
                matches!(reply, NativeCallResult::Undelivered(_)),
                "{scenario}: {reply:?}"
            ),
            "unsupported" => assert!(matches!(reply, NativeCallResult::Unsupported(_))),
            _ => assert!(
                matches!(reply, NativeCallResult::Ambiguous(_)),
                "{scenario}: {reply:?}"
            ),
        }
        assert_eq!(calls.lock().await.len(), usize::from(scenario != "missing"));
    }
}

#[tokio::test]
async fn codex_model_catalog_routes_only_to_current_root_and_discards_changed_sources() {
    use tower::ServiceExt;
    let mut env = crate::test_env_lock::TestEnv::lock().await;
    let dir = tempfile::tempdir().unwrap();
    isolate_snapshot_env(&mut env, dir.path());
    for scenario in ["same", "incarnation", "native", "boot", "generation"] {
        let socket = dir.path().join(format!("catalog-{scenario}.sock"));
        let listener = UnixListener::bind(&socket).unwrap();
        let calls = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let seen = calls.clone();
        let server = tokio::spawn(async move {
            let mut inventories = 0;
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let envelope: Envelope<serde_json::Value> = read_frame(&mut stream).await.unwrap();
                let result = match envelope.body["method"].as_str().unwrap() {
                    "health" => serde_json::to_value(AdminResult::Health {
                        control_epoch: 7,
                        installation_id: InstallationId::new(),
                    })
                    .unwrap(),
                    "inventory" => {
                        inventories += 1;
                        let changed = inventories >= 2;
                        serde_json::json!({"kind":"inventory","data":[{
                            "soulId":"current-root-soul","incarnationId":if changed && scenario=="incarnation" {"replacement"} else {"original"},
                            "hostBootId":if changed && scenario=="boot" {"new-boot"} else {"original-boot"},
                            "launchState":"running","cleanupState":"none","intentRevision":1,
                            "executionGeneration":if changed && scenario=="generation" {2} else {1},
                            "desiredState":"running","recoveryState":"live","durabilityState":"unknown","allocationState":"allocated",
                            "evidenceRevision":0,"successfulRecoveriesInWindow":0,"provider":"codex",
                            "nativeSessionId":if changed && scenario=="native" {"new-native"} else {"current-native"},
                            "freshAgentSessionId":"public-conversation","freshAgentSessionType":"freshcodex"
                        }]})
                    }
                    "fresh_agent_model_catalog" => {
                        seen.lock().await.push(envelope.body["params"].clone());
                        serde_json::json!({"kind":"fresh_agent_model_catalog","data":[{
                            "id":"managed-current","displayName":"Managed Current","supportedEffortLevels":["ultra"],"defaultEffort":"ultra","inputModalities":["text","image"]
                        }]})
                    }
                    other => panic!("catalog attempted unrelated operation: {other}"),
                };
                write_frame(
                    &mut stream,
                    &serde_json::json!({"requestId":envelope.request_id,"result":{"Ok":result}}),
                )
                .await
                .unwrap();
            }
        });
        let (broadcast, _) = broadcast::channel(16);
        let owner =
            freshell_freshagent::FreshAgentState::new(Arc::new("tok".into()), Arc::new(broadcast));
        owner
            .set_hosted_rest_gateway(snapshot_outage_proxy(&socket))
            .unwrap();
        let app = freshell_freshagent::model_capabilities::router(owner);
        let response = app.oneshot(axum::http::Request::builder().uri("/api/fresh-agent/model-capabilities/freshcodex?sessionId=public-conversation&cwd=/managed/project&soulId=stale-frontend-soul").header("x-auth-token","tok").body(axum::body::Body::empty()).unwrap()).await.unwrap();
        let status = response.status();
        let body: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
        if scenario == "same" {
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            assert_eq!(body["models"][0]["id"], "managed-current");
            assert_eq!(
                body["models"][0]["supportedEffortLevels"],
                serde_json::json!(["ultra"])
            );
        } else {
            assert_eq!(
                status,
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "{scenario}: {body}"
            );
            assert_eq!(body["models"], serde_json::json!([]));
        }
        let calls = calls.lock().await;
        assert_eq!(calls.len(), 1, "only the current host is queried");
        assert_eq!(calls[0]["soulId"], "current-root-soul");
        assert_eq!(calls[0]["cwd"], "/managed/project");
        assert_eq!(calls[0]["expectedControlEpoch"], 7);
    }
}

#[tokio::test]
async fn child_route_reads_only_the_parent_provider_volume_and_fences_replaced_sources_and_ephemeral_history(
) {
    use tower::ServiceExt;
    let mut env = crate::test_env_lock::TestEnv::lock().await;
    let dir = tempfile::tempdir().unwrap();
    isolate_snapshot_env(&mut env, dir.path());
    let local = dir
        .path()
        .join("configured-codex/sessions/rollout-child-native.jsonl");
    std::fs::create_dir_all(local.parent().unwrap()).unwrap();
    let gateway_history = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"child-native\",\"cwd\":\"/gateway\"}}\n{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Wrong gateway child\"}]}}\n";
    std::fs::write(&local, gateway_history).unwrap();
    for scenario in [
        "saved",
        "live",
        "ephemeral",
        "replaced-owner",
        "wrong-child",
        "unrelated",
    ] {
        let socket = dir.path().join(format!("child-{scenario}.sock"));
        let listener = UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let mut inventories = 0;
            let mut methods = vec![];
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                let mut done = false;
                let result = match envelope.body {
                    AdminCommand::Health => Ok(AdminResult::Health {
                        control_epoch: 7,
                        installation_id: InstallationId::new(),
                    }),
                    AdminCommand::Inventory => {
                        inventories += 1;
                        done = inventories == 2;
                        Ok(AdminResult::Inventory(vec![serde_json::from_value(serde_json::json!({
                            "soulId":"parent-root-soul","incarnationId":if scenario == "replaced-owner" && inventories == 2 {"new-owner"} else {"original-owner"},
                            "launchState":"running","cleanupState":"none","intentRevision":1,"executionGeneration":1,"desiredState":"running","recoveryState":"live","durabilityState":"unknown","allocationState":"allocated","evidenceRevision":0,"successfulRecoveriesInWindow":0,
                            "provider":"codex","nativeSessionId":"parent-native","freshAgentSessionId":"parent-alias","freshAgentSessionType":"freshcodex"
                        })).unwrap()]))
                    }
                    AdminCommand::FreshAgentReadChild(request) => {
                        methods.push("read_child");
                        assert_eq!(request.soul_id.as_str(), "parent-root-soul");
                        assert_eq!(request.child_thread_id, "child-native");
                        assert_eq!(request.expected_control_epoch, Some(7));
                        if scenario == "unrelated" {
                            done = true;
                            Err(freshell_runtime_protocol::RuntimeError::new(
                                RuntimeErrorCode::InvalidRequest,
                                "child is unrelated",
                            ))
                        } else {
                            Ok(AdminResult::FreshAgentChildSnapshot(
                                if scenario == "ephemeral" {
                                    serde_json::json!({"parentThreadId":"parent-native","childThreadId":"child-native","status":"unavailable","reason":"ephemeral_history_unavailable","retryable":false})
                                } else {
                                    serde_json::json!({"parentThreadId":"parent-native","childThreadId":if scenario == "wrong-child" {"foreign-child"} else {"child-native"},"status":if scenario == "live" {"live"} else {"saved"},"snapshot":{"threadId":"child-native","provider":"codex","sessionType":"freshcodex","turns":[{"text":"Provider volume child"}],"capabilities":{"send":true,"interrupt":true,"fork":true,"undo":true},"pendingApprovals":[],"pendingQuestions":[],"extensions":{}}})
                                },
                            ))
                        }
                    }
                    other => panic!("observer attempted an unexpected root operation: {other:?}"),
                };
                write_frame(
                    &mut stream,
                    &AdminReply {
                        request_id: envelope.request_id,
                        result,
                    },
                )
                .await
                .unwrap();
                if done {
                    return methods;
                }
            }
        });
        let (broadcast, _) = broadcast::channel(16);
        let broadcast = Arc::new(broadcast);
        let owner =
            freshell_freshagent::FreshAgentState::new(Arc::new("tok".into()), broadcast.clone());
        owner
            .set_hosted_rest_gateway(snapshot_outage_proxy(&socket))
            .unwrap();
        let app = freshell_freshagent::snapshot::router(
            freshell_freshagent::snapshot::SnapshotState::new(
                Arc::new("tok".into()),
                freshell_freshagent::FreshCodexState::new(
                    Arc::new("tok".into()),
                    broadcast.clone(),
                    serde_json::json!({}),
                ),
                owner,
                freshell_freshagent::FreshClaudeState::new(broadcast),
            ),
        );
        let response = app.oneshot(axum::http::Request::builder().uri("/api/fresh-agent/threads/freshcodex/codex/parent-alias/children/child-native").header("x-auth-token","tok").body(axum::body::Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 32 * 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        let methods = tokio::time::timeout(Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(methods, vec!["read_child"]);
        if matches!(scenario, "saved" | "live") {
            assert_eq!(
                body["snapshot"]["turns"][0]["text"],
                "Provider volume child"
            );
            assert_eq!(body["parentThreadId"], "parent-native");
            assert_eq!(body["status"], scenario);
            assert_eq!(body["snapshot"]["capabilities"]["send"], false);
            assert_eq!(body["snapshot"]["capabilities"]["fork"], false);
        } else if scenario == "ephemeral" {
            assert_eq!(body["parentThreadId"], "parent-native");
            assert_eq!(body["childThreadId"], "child-native");
            assert_eq!(body["status"], "unavailable");
            assert_eq!(body["reason"], "ephemeral_history_unavailable");
            assert_eq!(body["retryable"], false);
            assert!(body.get("snapshot").is_none());
        } else {
            assert_eq!(body["reason"], "source_unavailable");
            assert!(body.get("snapshot").is_none());
        }
        assert!(!body.to_string().contains("Wrong gateway child"));
    }
    assert_eq!(std::fs::read_to_string(local).unwrap(), gateway_history);
}

#[cfg(feature = "managed-fresh-agent-fixtures")]
#[path = "managed_launch_preparation_tests.rs"]
mod launch_preparation;

#[cfg(feature = "managed-fresh-agent-fixtures")]
mod initial_grant_reference_tests {
    use super::*;
    use async_trait::async_trait;
    use freshell_runtime_protocol::*;
    use freshell_supervisor::{
        admission::AdmissionPolicy,
        backend::{
            BackendCreated, BackendError, BackendInspection, CreateRuntimeSpec, RuntimeBackend,
        },
        registry::{OwnedRuntimeHandle, Registry},
        service::{serve_control, Supervisor, SupervisorConfig},
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex as StdMutex,
    };

    // This replaces only the enclosure and host reply. Registry activation,
    // grant consumption, RuntimeClient, and the server's wire ACK remain real.
    // Actual host/actor publication has separate session-host grant coverage.
    #[derive(Default)]
    struct GrantBackend {
        allocations: AtomicUsize,
        grants: Arc<AtomicUsize>,
        statuses: Arc<AtomicUsize>,
        host_task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
        shutdown: StdMutex<Option<tokio::sync::oneshot::Sender<()>>>,
        native_root: Option<String>,
    }

    impl GrantBackend {
        async fn close(&self) {
            self.shutdown
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .send(())
                .unwrap();
            let task = self.host_task.lock().unwrap().take().unwrap();
            tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap();
        }
    }

    #[async_trait]
    impl RuntimeBackend for GrantBackend {
        async fn observe_initial_auth_volume(
            &self,
            _: &freshell_supervisor::registry::OwnedInputReservation,
        ) -> Result<InitialAuthVolumeObservation, BackendError> {
            Ok(InitialAuthVolumeObservation::Absent {
                daemon_id: DockerDaemonId::parse("initial-grant-fixture-daemon").unwrap(),
            })
        }

        async fn observe_claude_sources(
            &self,
            _: &freshell_supervisor::backend::ClaudeSourceOwner,
            request: &ObserveClaudeSourcesRequest,
            _: &str,
            _: tokio::time::Instant,
        ) -> Result<freshell_platform::claude_inputs::observation::ObservationReply, BackendError>
        {
            Ok(fixture_claude_observation(request))
        }

        async fn create_stopped(
            &self,
            _: &CreateRuntimeSpec,
        ) -> Result<BackendCreated, BackendError> {
            self.allocations.fetch_add(1, Ordering::SeqCst);
            Ok(BackendCreated {
                daemon_id: DockerDaemonId::new(),
                container_id: "a".repeat(64),
                immutable_config_digest: format!("sha256:{}", "c".repeat(64)),
            })
        }

        async fn start_host(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            let handle = handle.clone();
            let listener = UnixListener::bind(handle.runtime_dir().join("host.sock")).unwrap();
            let secret = std::fs::read(handle.runtime_dir().join("secret")).unwrap();
            let native_root = self.native_root.clone();
            let grants = self.grants.clone();
            let statuses = self.statuses.clone();
            let (shutdown, mut stopped) = tokio::sync::oneshot::channel();
            *self.shutdown.lock().unwrap() = Some(shutdown);
            *self.host_task.lock().unwrap() = Some(tokio::spawn(async move {
                let boot = HostBootId::new();
                let mut generation = 0;
                let mut epoch = 0;
                loop {
                    let accepted = tokio::select! {
                        _ = &mut stopped => break,
                        accepted = listener.accept() => accepted.unwrap(),
                    };
                    let (mut socket, _) = accepted;
                    let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                    assert_eq!(request.role, ControlRole::Supervisor);
                    if !matches!(&request.body, HostCommand::Hello { .. }) {
                        assert_eq!(
                            request.auth.as_deref(),
                            Some(
                                host_proof(&secret, "command-auth", &boot, handle.incarnation_id())
                                    .as_str()
                            )
                        );
                    }
                    let result = match request.body {
                        HostCommand::Hello {
                            incarnation_id,
                            challenge,
                        } => {
                            assert_eq!(&incarnation_id, handle.incarnation_id());
                            HostResult::Hello {
                                proof: host_proof(&secret, &challenge, &boot, &incarnation_id),
                                host_boot_id: boot.clone(),
                                capabilities: vec![],
                                effective_limits: handle.requested_limits(),
                            }
                        }
                        HostCommand::GrantExecution {
                            incarnation_id,
                            soul_id,
                            host_boot_id,
                            control_epoch,
                            execution_generation,
                            fresh_agent,
                            native_identity_launch,
                            ..
                        } => {
                            assert_eq!(&incarnation_id, handle.incarnation_id());
                            assert_eq!(&soul_id, handle.soul_id());
                            assert_eq!(host_boot_id, boot);
                            assert_eq!(fresh_agent.as_deref(), handle.fresh_agent());
                            let binding = native_identity_launch.unwrap();
                            assert_eq!(binding.incarnation_id, incarnation_id);
                            assert_eq!(binding.launch_nonce, handle.launch_nonce().as_str());
                            assert_eq!(binding.execution_generation, execution_generation);
                            assert!(execution_generation > 0 && control_epoch > 0);
                            generation = execution_generation;
                            epoch = control_epoch;
                            grants.fetch_add(1, Ordering::SeqCst);
                            HostResult::GrantAccepted {
                                host_boot_id: boot.clone(),
                                worker_pid: 123,
                                worker_launch_count: 1,
                                fixture_evidence: serde_json::json!({}),
                                native_session_id: native_root.clone(),
                                native_identity_observation: None,
                                opencode_transfer_receipt: None,
                                opencode_adoption: Default::default(),
                            }
                        }
                        HostCommand::FreshAgentReadEvents { incarnation_id, .. } => {
                            assert_eq!(&incarnation_id, handle.incarnation_id());
                            // Started never enriches the registry before the first ACK.
                            HostResult::FreshAgentEvents(AgentEventBatch {
                                accepted_native_dispatch: None,
                                native_dispatch_in_flight: false,
                                retained_state: None,
                                retained_from: 0,
                                head: 0,
                                reset_required: false,
                                events: vec![],
                            })
                        }
                        HostCommand::Status { incarnation_id } => {
                            assert_eq!(&incarnation_id, handle.incarnation_id());
                            statuses.fetch_add(1, Ordering::SeqCst);
                            HostResult::Status {
                                host_boot_id: boot.clone(),
                                worker_pid: Some(123),
                                worker_launch_count: 1,
                                max_control_epoch: epoch,
                                max_execution_generation: generation,
                                fixture_evidence: serde_json::json!({}),
                                exited: false,
                                native_session_id: native_root.clone(),
                                native_identity_observation: None,
                                opencode_transfer_receipt: None,
                                opencode_adoption: Default::default(),
                            }
                        }
                        _ => panic!(
                            "creation must not dispatch input, completion or recovery probes"
                        ),
                    };
                    write_frame(
                        &mut socket,
                        &HostReply {
                            request_id: request.request_id,
                            result: Ok(result),
                        },
                    )
                    .await
                    .unwrap();
                }
            }));
            Ok(())
        }
        async fn inspect(&self, _: &OwnedRuntimeHandle) -> Result<BackendInspection, BackendError> {
            unreachable!()
        }
        async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
            unreachable!()
        }
        async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            unreachable!()
        }
        async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
            unreachable!()
        }
        async fn list_known(
            &self,
            _: &[OwnedRuntimeHandle],
        ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
            unreachable!()
        }
        async fn read_limits(
            &self,
            handle: &OwnedRuntimeHandle,
        ) -> Result<RuntimeLimits, BackendError> {
            Ok(handle.requested_limits())
        }
        async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn initial_fixture_grant_reaches_canonical_ack_all_four_modes() {
        let test = "fresh_agent_proxy::tests::initial_grant_reference_tests::initial_fixture_grant_reaches_canonical_ack_all_four_modes";
        let cases = [
            "freshclaude",
            "kilroy",
            "freshcodex",
            "freshopencode",
            "absent",
        ];
        let child_case = std::env::var("FRESHELL_CREATE_FAILURE_TRACE_CHILD").ok();
        let Some(case) = child_case.as_deref().filter(|case| cases.contains(case)) else {
            for case in cases {
                assert!(create_failure_trace_child(case, test));
                eprintln!("initial-grant child {case}: passed");
            }
            return;
        };
        let mode = if case == "absent" {
            "freshclaude"
        } else {
            case
        };
        let provider = match mode {
            "kilroy" => "kilroy",
            "freshcodex" => "codex",
            "freshopencode" => "opencode",
            _ => "claude",
        };
        let public_provider = if provider == "kilroy" {
            "claude"
        } else {
            provider
        };
        let trace = crate::test_trace_capture::captured_trace_events();
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("owned-workspace");
        std::fs::create_dir(&workspace).unwrap();
        let registry = Registry::open(root.path().join("registry"), None).unwrap();
        let host_binary = root.path().join("owned-host-artifact");
        std::fs::write(&host_binary, "owned immutable synthetic host").unwrap();
        let socket = root.path().join("control.sock");
        let secret = root.path().join("control-secret");
        std::fs::write(&secret, "0123456789abcdef").unwrap();
        crate::managed_mcp_capability::configure("0.0.0.0", 39483, &socket, &secret).unwrap();
        crate::managed_mcp_capability::spawn_callback_server()
            .await
            .unwrap();
        let backend = Arc::new(GrantBackend {
            native_root: (case != "absent").then(|| "owned-current-fixture-root".into()),
            ..Default::default()
        });
        let supervisor = Supervisor::new(
            registry.clone(),
            backend.clone(),
            SupervisorConfig {
                runtime_root: root.path().join("runtimes"),
                control_socket_path: socket.clone(),
                host_binary_path: host_binary,
                image_ref: format!("sha256:{}", "b".repeat(64)),
                test_run_id: "initial-grant-reference".into(),
                control_secret: "0123456789abcdef".into(),
                lifecycle_log: root.path().join("lifecycle.jsonl"),
                admission: AdmissionPolicy::default(),
            },
        )
        .unwrap();
        let control_socket = socket.clone();
        let control =
            tokio::spawn(async move { serve_control(supervisor, &control_socket).await.unwrap() });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !socket.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let unrelated = UnixListener::bind(root.path().join("unrelated.sock")).unwrap();
        let mut proxy = snapshot_outage_proxy(&socket);
        Arc::get_mut(&mut proxy)
            .unwrap()
            .fixture_modes
            .insert(mode.into());
        let mut frames = proxy.broadcast.subscribe();
        let message = serde_json::json!({"requestId":"initial-grant-reference-owned", "provider":public_provider,
            "sessionType":mode, "cwd":workspace, "model":"owned-fixture-model", "effort":"low"});
        let created = tokio::time::timeout(
            Duration::from_secs(5),
            proxy.create(serde_json::from_value(message.clone()).unwrap()),
        )
        .await
        .unwrap();
        if created.is_err() {
            control.abort();
            assert!(control.await.unwrap_err().is_cancelled());
            let reasons = trace
                .snapshot()
                .into_iter()
                .flat_map(|event| {
                    [
                        event.fields.get("reason").cloned(),
                        event.fields.get("runtime_code").cloned(),
                    ]
                })
                .flatten()
                .collect::<Vec<_>>();
            panic!("controlled launch setup failed with finite reasons: {reasons:?}");
        }
        let first: serde_json::Value = serde_json::from_str(&frames.try_recv().unwrap()).unwrap();
        let initial = registry.inventory().await.unwrap().remove(0);
        let context = registry
            .recovery_context(initial.soul_id.clone())
            .await
            .unwrap();
        let initial_statuses = backend.statuses.load(Ordering::SeqCst);
        std::fs::rename(&workspace, root.path().join("moved-workspace")).unwrap();
        let replayed = tokio::time::timeout(
            Duration::from_secs(5),
            proxy.create(serde_json::from_value(message).unwrap()),
        )
        .await
        .unwrap();
        let replay = frames.try_recv();
        let replay_view = registry.inventory().await.unwrap().remove(0);
        // Join only our host/control tasks even on the causal assertion failure.
        control.abort();
        assert!(control.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(5), async {
            while !proxy.pollers.lock().await.is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        backend.close().await;
        assert!(
            tokio::net::UnixStream::connect(root.path().join("unrelated.sock"))
                .await
                .is_ok()
        );
        assert!(tokio::time::timeout(
            Duration::from_millis(100),
            tokio::net::UnixStream::connect(context.prior_handle.runtime_dir().join("host.sock"))
        )
        .await
        .unwrap()
        .is_err());
        drop(unrelated);
        created.unwrap();
        replayed.expect("lost creation ACK retry must reuse the accepted running launch");
        let replay: serde_json::Value = serde_json::from_str(&replay.unwrap()).unwrap();
        assert_eq!(
            initial_statuses, 0,
            "Status must not enrich the initial view"
        );
        assert_eq!(first["type"], "freshAgent.created");
        assert_eq!(first["requestId"], "initial-grant-reference-owned");
        assert_eq!(first["provider"], public_provider);
        assert_eq!(first["runtimeProvider"], provider);
        assert_eq!(first["sessionType"], mode);
        assert_eq!(
            first["sessionId"],
            initial.fresh_agent_session_id.as_deref().unwrap()
        );
        let expected = backend
            .native_root
            .as_ref()
            .map(|root| serde_json::json!({"provider":public_provider,"sessionId":root}));
        assert_eq!(
            first.get("sessionRef"),
            expected.as_ref(),
            "initial canonical ACK must carry the accepted fixture root"
        );
        assert_eq!(initial.native_session_id, backend.native_root);
        assert_eq!(initial.native_identity_observation, None);
        assert_eq!(initial.provider.as_deref(), Some(provider));
        assert_eq!(initial.launch_state, LaunchState::Running);
        assert_eq!(
            context.fresh_agent.as_ref().unwrap().model.as_deref(),
            Some("owned-fixture-model")
        );
        assert_eq!(
            context.fresh_agent.as_ref().unwrap().effort.as_deref(),
            Some("low")
        );
        assert_eq!(replay, first);
        assert_eq!(replay_view.incarnation_id, initial.incarnation_id);
        assert_eq!(replay_view.native_session_id, initial.native_session_id);
        assert_eq!(backend.allocations.load(Ordering::SeqCst), 1);
        assert_eq!(backend.grants.load(Ordering::SeqCst), 1);
    }
}

// The MCP controller is process-global. Run these refusal paths in exact
// isolated test children so their owned HOME/controller cannot affect peers.
fn create_failure_trace_child(case: &str, test: &str) -> bool {
    if std::env::var("FRESHELL_CREATE_FAILURE_TRACE_CHILD")
        .ok()
        .as_deref()
        == Some(case)
    {
        return false;
    }
    let home = tempfile::tempdir().unwrap();
    // CODEX_HOME below is an explicit selector; the real preparer correctly
    // requires that selected directory to exist, even for an empty fixture.
    std::fs::create_dir(home.path().join(".codex")).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child
        .args(["--exact", test, "--nocapture", "--test-threads=1"])
        .env("FRESHELL_CREATE_FAILURE_TRACE_CHILD", case)
        .env("HOME", home.path())
        .env("CLAUDE_CONFIG_DIR", home.path().join(".claude"))
        .env("CLAUDE_HOME", home.path().join(".claude"))
        .env("CODEX_HOME", home.path().join(".codex"))
        .env("XDG_CONFIG_HOME", home.path().join(".config"))
        .env("XDG_DATA_HOME", home.path().join(".local/share"))
        .env(
            "FRESHELL_RUNTIME_CAPABILITY_DIR",
            home.path().join("owned-capabilities"),
        );
    for provider in ["CLAUDE", "CODEX", "OPENCODE", "AMPLIFIER"] {
        for suffix in ["ENV_FILE", "AUTH_FILE", "CA_FILE"] {
            child.env_remove(format!("FRESHELL_MANAGED_{provider}_ONECLI_{suffix}"));
        }
    }
    child.env_remove("FRESHELL_MANAGED_CLAUDE_CREDENTIAL_FILE");
    let output = child.output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

fn fixture_claude_observation(
    request: &freshell_runtime_protocol::ObserveClaudeSourcesRequest,
) -> freshell_platform::claude_inputs::observation::ObservationReply {
    use freshell_platform::claude_inputs::{
        observation::{LocalDecision, NativeObservation, ObservationReply, MAX_REQUEST_BYTES},
        ClaudeSettingSource,
    };
    // Only the namespace reader is synthetic. Real request binding, source
    // selection, publication and candidate validation still run in the caller.
    let selected = &request.observation_request;
    selected.validate().unwrap();
    let local = selected
        .setting_sources
        .contains(&ClaudeSettingSource::Local);
    ObservationReply {
        request_sha256: format!(
            "{:x}",
            Sha256::digest(
                freshell_runtime_protocol::bounded_json_bytes(selected, MAX_REQUEST_BYTES).unwrap(),
            )
        ),
        observation: NativeObservation {
            version: 1,
            native_source_runtime: selected.native_source_runtime,
            setting_sources: selected.setting_sources.clone(),
            uid: 65534,
            euid: 65534,
            gid: 0,
            egid: 0,
            supplementary_groups: vec![],
            cwd: selected.cwd.clone(),
            home: Some(selected.home.clone()),
            roots: None,
            local_decision: if local {
                LocalDecision::NoRoot
            } else {
                LocalDecision::Disabled
            },
            root_uid: None,
            git_uid: None,
            claude_uid: None,
            local_settings: if local {
                vec![selected.cwd.join(".claude/settings.local.json")]
            } else {
                vec![]
            },
        },
    }
}

async fn reply_to_create_preparation(
    stream: &mut tokio::net::UnixStream,
    request: &Envelope<AdminCommand>,
) -> bool {
    use freshell_runtime_protocol::{
        DockerDaemonId, InitialAuthVolumeObservation, NativeAuthValues, ProviderInputReservation,
    };
    let result = match &request.body {
        AdminCommand::Inventory => AdminResult::Inventory(vec![]),
        AdminCommand::ReserveProviderInputs(reservation) => {
            assert_eq!(reservation.expected_control_epoch, Some(77));
            AdminResult::ProviderInputReservation(ProviderInputReservation {
                reservation_id: uuid::Uuid::new_v4().to_string(),
                installation_id: InstallationId::parse("prepared-create-fixture").unwrap(),
                soul_id: reservation.soul_id.clone(),
                provider: reservation.provider.clone(),
                creation_seed_ref: reservation.creation_seed_ref.clone(),
                intent_revision: 1,
                provider_volume_name: "owned-create-volume".into(),
                image_ref: "owned-create-image".into(),
                host_binary_path: "/owned/fixture/session-host".into(),
                host_binary_sha256: "a".repeat(64),
                observation: InitialAuthVolumeObservation::Absent {
                    daemon_id: DockerDaemonId::parse("prepared-create-fixture-daemon").unwrap(),
                },
            })
        }
        AdminCommand::ObserveClaudeSources(observation) => {
            assert_eq!(observation.expected_control_epoch, Some(77));
            observation.validate().unwrap();
            AdminResult::ClaudeSourceObservation(fixture_claude_observation(observation))
        }
        AdminCommand::NativeAuthLookup(lookup) => {
            assert_eq!(lookup.expected_control_epoch, Some(77));
            AdminResult::NativeAuthLookup(NativeAuthValues(Default::default()))
        }
        AdminCommand::BindProviderPathInputs(binding) => {
            assert_eq!(binding.expected_control_epoch, Some(77));
            AdminResult::ProviderPathInputsBound
        }
        _ => return false,
    };
    write_frame(
        stream,
        &AdminReply {
            request_id: request.request_id.clone(),
            result: Ok(result),
        },
    )
    .await
    .unwrap();
    true
}

#[tokio::test]
async fn create_failure_trace_missing_cwd() {
    if create_failure_trace_child(
        "cwd",
        "fresh_agent_proxy::tests::create_failure_trace_missing_cwd",
    ) {
        return;
    }
    let events = crate::test_trace_capture::captured_trace_events();
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("empty-inventory.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let supervisor = tokio::spawn(async move {
        for _ in 0..3 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            assert!(matches!(request.body, AdminCommand::Inventory));
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result: Ok(AdminResult::Inventory(vec![])),
                },
            )
            .await
            .unwrap();
        }
    });
    let proxy = snapshot_outage_proxy(&socket);
    for (provider, mode) in [
        ("claude", "freshclaude"),
        ("codex", "freshcodex"),
        ("opencode", "freshopencode"),
    ] {
        let request_id = format!("trace-cwd-owned-{provider}");
        let message = serde_json::from_value(
            serde_json::json!({"requestId":request_id, "provider":provider, "sessionType":mode,
        "cwd":root.path().join("missing-private-workspace")}),
        )
        .unwrap();
        assert!(proxy.create(message).await.is_err());
        let captured = events.snapshot();
        let event = captured
            .iter()
            .find(|event| {
                event.fields.get("request_id").map(String::as_str) == Some(request_id.as_str())
            })
            .expect("executed cwd refusal must emit its finite create observation");
        assert_eq!(event.level, tracing::Level::WARN);
        assert_eq!(
            event.fields.get("event").map(String::as_str),
            Some("fresh_agent.create.preparation_failed")
        );
        assert_eq!(
            event.fields.get("reason").map(String::as_str),
            Some("cwd_unavailable")
        );
        assert_eq!(
            event.fields.get("provider").map(String::as_str),
            Some(provider)
        );
        assert_eq!(
            event.fields.get("session_type").map(String::as_str),
            Some(mode)
        );
        assert!(!format!("{event:?}").contains("missing-private-workspace"));
        assert!(!event.fields.contains_key("error"));
    }
    tokio::time::timeout(Duration::from_secs(5), supervisor)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn create_failure_trace_excluded_native_mode_before_bootstrap() {
    if create_failure_trace_child(
        "excluded-native",
        "fresh_agent_proxy::tests::create_failure_trace_excluded_native_mode_before_bootstrap",
    ) {
        return;
    }
    let events = crate::test_trace_capture::captured_trace_events();
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("never-contacted.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let proxy = snapshot_outage_proxy(&socket);
    let message = serde_json::from_value(serde_json::json!({"requestId":"excluded-native-kilroy", "provider":"claude", "sessionType":"kilroy", "cwd":root.path().join("missing-workspace")})).unwrap();
    assert!(proxy.create(message).await.is_err());
    let message = serde_json::from_value(serde_json::json!({"requestId":"excluded-native-kilroy-resume", "provider":"claude", "sessionType":"kilroy",
        "sessionRef":{"provider":"claude", "sessionId":"owned-never-resumed"}, "cwd":root.path()})).unwrap();
    assert!(proxy.create(message).await.is_err());
    for (provider, mode) in [
        ("codex", "freshclaude"),
        ("opencode", "freshcodex"),
        ("claude", "freshopencode"),
    ] {
        let message = serde_json::from_value(
            serde_json::json!({"requestId":format!("invalid-pair-{provider}"),
            "provider":provider, "sessionType":mode, "cwd":root.path()}),
        )
        .unwrap();
        assert!(proxy.create(message).await.is_err());
    }
    let observed = events.snapshot();
    assert!(
        observed
            .iter()
            .any(|event| event.fields.get("reason").map(String::as_str)
                == Some("mode_not_release_qualified")),
        "{observed:?}"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
    assert!(proxy.aliases.lock().await.is_empty());
    assert!(proxy.pollers.lock().await.is_empty());
}

#[tokio::test]
async fn create_failure_trace_launch_rejection() {
    if create_failure_trace_child(
        "launch",
        "fresh_agent_proxy::tests::create_failure_trace_launch_rejection",
    ) {
        return;
    }
    let events = crate::test_trace_capture::captured_trace_events();
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("typed-supervisor.sock");
    let secret = root.path().join("control-secret");
    std::fs::write(&secret, "0123456789abcdef").unwrap();
    crate::managed_mcp_capability::configure("0.0.0.0", 39481, &socket, &secret).unwrap();
    let listener = UnixListener::bind(&socket).unwrap();
    let expected_soul = stable_soul_id("claude", "trace-launch-owned").unwrap();
    let supervisor = tokio::spawn(async move {
        let mut index = 0;
        while index < 2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            if reply_to_create_preparation(&mut stream, &request).await {
                continue;
            }
            let result = match request.body {
                AdminCommand::Health if index == 0 => Ok(AdminResult::Health {
                    control_epoch: 77,
                    installation_id: InstallationId::new(),
                }),
                AdminCommand::Launch(launch) if index == 1 => {
                    assert_eq!(launch.soul_id, expected_soul);
                    assert_eq!(launch.provider, "claude");
                    Err(freshell_runtime_protocol::RuntimeError::new(
                        RuntimeErrorCode::BackendUnavailable,
                        "private-launch-failure-body",
                    ))
                }
                other => panic!("unexpected create request {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result,
                },
            )
            .await
            .unwrap();
            index += 1;
        }
    });
    let proxy = snapshot_outage_proxy(&socket);
    let message = serde_json::from_value(serde_json::json!({"requestId":"trace-launch-owned", "provider":"claude", "sessionType":"freshclaude",
        "cwd":root.path()})).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), proxy.create(message))
            .await
            .unwrap()
            .is_err()
    );
    tokio::time::timeout(Duration::from_secs(5), supervisor)
        .await
        .expect("typed supervisor must receive Launch")
        .unwrap();
    let captured = events.snapshot();
    let event = captured
        .iter()
        .find(|event| {
            event.fields.get("event").map(String::as_str)
                == Some("fresh_agent.create.launch_failed")
        })
        .expect("executed typed Launch refusal must emit a finite observation");
    assert_eq!(event.level, tracing::Level::WARN);
    assert_eq!(
        event.fields.get("request_id").map(String::as_str),
        Some("trace-launch-owned")
    );
    assert_eq!(
        event.fields.get("provider").map(String::as_str),
        Some("claude")
    );
    assert_eq!(
        event.fields.get("session_type").map(String::as_str),
        Some("freshclaude")
    );
    assert_eq!(
        event.fields.get("soul_id").map(String::as_str),
        Some(
            stable_soul_id("claude", "trace-launch-owned")
                .unwrap()
                .as_str()
        )
    );
    assert_eq!(
        event.fields.get("reason").map(String::as_str),
        Some("runtime_rejection")
    );
    assert_eq!(
        event.fields.get("runtime_code").map(String::as_str),
        Some("BACKEND_UNAVAILABLE")
    );
    assert!(!format!("{event:?}").contains("private-launch-failure-body"));
    assert!(!event.fields.contains_key("error"));
}

#[tokio::test]
async fn create_provider_start_failure_keeps_only_the_safe_category_on_the_wire() {
    if create_failure_trace_child(
        "provider-start-frame",
        "fresh_agent_proxy::tests::create_provider_start_failure_keeps_only_the_safe_category_on_the_wire",
    ) {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("typed-supervisor.sock");
    let secret = root.path().join("control-secret");
    std::fs::write(&secret, "0123456789abcdef").unwrap();
    crate::managed_mcp_capability::configure("0.0.0.0", 39483, &socket, &secret).unwrap();
    let listener = UnixListener::bind(&socket).unwrap();
    let supervisor = tokio::spawn(async move {
        let mut index = 0;
        while index < 2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            if reply_to_create_preparation(&mut stream, &request).await {
                continue;
            }
            let result = match request.body {
                AdminCommand::Health if index == 0 => Ok(AdminResult::Health {
                    control_epoch: 77,
                    installation_id: InstallationId::new(),
                }),
                AdminCommand::Launch(_) if index == 1 => {
                    Err(freshell_runtime_protocol::RuntimeError::new(
                        RuntimeErrorCode::HostUnreachable,
                        "private-launch-failure-body",
                    )
                    .with_diagnostic_code(RuntimeDiagnosticCode::FreshAgentProviderStartFailed)
                    .with_fresh_agent_provider_start_diagnostic(
                        FreshAgentProviderStartDiagnostic::Authentication,
                    ))
                }
                other => panic!("unexpected provider-start test request {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result,
                },
            )
            .await
            .unwrap();
            index += 1;
        }
    });
    let (broadcast, mut receiver) = broadcast::channel(8);
    let proxy = Arc::new(HostedFreshAgentProxy {
        checkpoint_barrier: std::sync::OnceLock::new(),
        ownership: std::sync::OnceLock::new(),
        client: RuntimeClient::new(&socket, "0123456789abcdef"),
        broadcast: Arc::new(broadcast),
        aliases: Mutex::new(HashMap::new()),
        presentation_routes: Mutex::new(HashMap::new()),
        pollers: Mutex::new(HashSet::new()),
        fixture_modes: HashSet::from(["freshclaude".to_string()]),
        naming: OnceLock::new(),
    });
    let create = serde_json::from_value(serde_json::json!({
        "requestId": "provider-start-auth-owned",
        "provider": "claude",
        "sessionType": "freshclaude",
        "cwd": root.path(),
    }))
    .unwrap();
    proxy.handle(HostedFreshAgentCommand::Create(create)).await;
    tokio::time::timeout(Duration::from_secs(5), supervisor)
        .await
        .expect("supervisor should receive the failed launch")
        .unwrap();

    let frame: serde_json::Value = serde_json::from_str(&receiver.try_recv().unwrap()).unwrap();
    assert_eq!(frame["type"], "freshAgent.create.failed");
    assert_eq!(frame["code"], "FRESH_AGENT_PROVIDER_START_FAILED");
    assert_eq!(
        frame["message"],
        "hosted fresh-agent provider failed to start (startup diagnostic: authentication)"
    );
    assert!(!frame.to_string().contains("private-launch-failure-body"));
}

#[cfg(feature = "managed-fresh-agent-fixtures")]
#[tokio::test]
async fn kilroy_create_uses_claude_native_dependencies_without_changing_runtime_identity() {
    if create_failure_trace_child("kilroy-family", "fresh_agent_proxy::tests::kilroy_create_uses_claude_native_dependencies_without_changing_runtime_identity") { return; }
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("kilroy-supervisor.sock");
    let secret = root.path().join("control-secret");
    std::fs::write(&secret, "0123456789abcdef").unwrap();
    crate::managed_mcp_capability::configure("0.0.0.0", 39482, &socket, &secret).unwrap();
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::write(
        home.join(".claude/settings.json"),
        r#"{"permissions":{"deny":["Bash"]}}"#,
    )
    .unwrap();
    let selected_environment = root.path().join("owned-provider.env");
    std::fs::write(
        &selected_environment,
        "CLAUDE_CODE_OAUTH_TOKEN=owned-test-reference\n",
    )
    .unwrap();
    std::fs::set_permissions(
        &selected_environment,
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    std::env::set_var(
        "FRESHELL_MANAGED_CLAUDE_ONECLI_ENV_FILE",
        &selected_environment,
    );
    let listener = UnixListener::bind(&socket).unwrap();
    let supervisor = tokio::spawn(async move {
        let mut index = 0;
        while index < 2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            if reply_to_create_preparation(&mut stream, &request).await {
                continue;
            }
            let result = match request.body {
                AdminCommand::Health if index == 0 => Ok(AdminResult::Health {
                    control_epoch: 77,
                    installation_id: InstallationId::new(),
                }),
                AdminCommand::Launch(launch) if index == 1 => {
                    assert_eq!(launch.provider, "kilroy");
                    assert_eq!(
                        launch.soul_id,
                        stable_soul_id("kilroy", "owned-kilroy-create").unwrap()
                    );
                    let fresh = launch.fresh_agent.unwrap();
                    assert_eq!(fresh.provider, FreshProvider::Kilroy);
                    assert_eq!(fresh.session_type, "kilroy");
                    assert_eq!(fresh.runtime_variant, "kilroy-claude-agent-sdk");
                    assert_eq!(
                        fresh.fixture_transport,
                        Some(FreshAgentFixtureTransport::Deterministic)
                    );
                    assert_eq!(fresh.provider_secret_references.len(), 1);
                    assert_eq!(
                        fresh.provider_secret_references[0].source_path,
                        selected_environment.to_string_lossy()
                    );
                    assert_eq!(
                        fresh.provider_secret_references[0].profile,
                        freshell_runtime_protocol::ProviderSecretProfile::ClaudeOnecliEnvironment
                    );
                    let context = fresh.provider_launch_context.unwrap();
                    assert!(matches!(
                        context.preparation,
                        freshell_runtime_protocol::ProviderPreparation::Claude { .. }
                    ));
                    let settings_bind = context
                        .prepared_inputs
                        .as_ref()
                        .expect("Kilroy must use the current prepared Claude namespace")
                        .config_binds
                        .iter()
                        .find(|bind| {
                            bind.logical_destination
                                == "/home/freshell/provider/.claude/settings.json"
                        })
                        .expect("selected settings must reach native Claude HOME");
                    let capability = context.mcp_capability.unwrap();
                    let directory =
                        PathBuf::from(std::env::var_os("FRESHELL_RUNTIME_CAPABILITY_DIR").unwrap());
                    let grant: serde_json::Value = serde_json::from_slice(
                        &std::fs::read(directory.join(format!("{}.json", capability.grant_id)))
                            .unwrap(),
                    )
                    .unwrap();
                    assert_eq!(
                        grant["soulId"],
                        stable_soul_id("kilroy", "owned-kilroy-create")
                            .unwrap()
                            .to_string()
                    );
                    let staged_settings: serde_json::Value = serde_json::from_slice(
                        &std::fs::read(
                            directory
                                .parent()
                                .unwrap()
                                .join("provider-roots")
                                .join(&capability.grant_id)
                                .join(&settings_bind.source_relative_path),
                        )
                        .unwrap(),
                    )
                    .unwrap();
                    assert_eq!(
                        staged_settings["permissions"]["deny"],
                        serde_json::json!(["Bash"])
                    );
                    Err(freshell_runtime_protocol::RuntimeError::new(
                        RuntimeErrorCode::BackendUnavailable,
                        "owned no-provider launch rejection",
                    ))
                }
                other => panic!("unexpected Kilroy create request {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result,
                },
            )
            .await
            .unwrap();
            index += 1;
        }
    });
    let mut proxy = snapshot_outage_proxy(&socket);
    Arc::get_mut(&mut proxy)
        .unwrap()
        .fixture_modes
        .insert("kilroy".into());
    let message = serde_json::from_value(serde_json::json!({"requestId":"owned-kilroy-create", "provider":"claude", "sessionType":"kilroy", "cwd":root.path()})).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), proxy.create(message))
            .await
            .unwrap()
            .is_err()
    );
    tokio::time::timeout(Duration::from_secs(5), supervisor)
        .await
        .expect("native-family Kilroy create must reach the typed Launch boundary")
        .unwrap();
}

#[test]
fn managed_provider_fresh_claude_retains_validated_mcp_recipe() {
    let args = vec!["--mcp-config".into(), ".claude/freshell-mcp.json".into()];
    let context = freshell_runtime_protocol::ProviderLaunchContext {
        preparation: freshell_runtime_protocol::ProviderPreparation::Claude {
            mcp_args: args.clone(),
        },
        mcp_capability: None,
        config: vec![],
        prepared_inputs: None,
    };
    let context = context_for_fresh_provider(Some(context)).unwrap();
    let freshell_runtime_protocol::ProviderPreparation::Claude { mcp_args } = context.preparation
    else {
        panic!("Claude preparation missing")
    };
    assert_eq!(
        mcp_args, args,
        "fresh Claude must retain the selected MCP recipe"
    );
}

#[test]
fn managed_provider_fresh_codex_retains_terminal_and_native_sidecar_arguments() {
    let args = crate::managed_provider_bootstrap::managed_codex_mcp_args().unwrap();
    let context = freshell_runtime_protocol::ProviderLaunchContext {
        preparation: freshell_runtime_protocol::ProviderPreparation::Codex {
            approval_default: None,
            tui_args: args.clone(),
            sidecar_args: args.clone(),
        },
        mcp_capability: None,
        config: vec![],
        prepared_inputs: None,
    };
    let context = context_for_fresh_provider(Some(context)).unwrap();
    let freshell_runtime_protocol::ProviderPreparation::Codex {
        tui_args,
        sidecar_args,
        ..
    } = context.preparation
    else {
        panic!("Codex preparation missing")
    };
    assert_eq!(
        tui_args, args,
        "terminal arguments must remain in accepted fresh context"
    );
    assert_eq!(
        sidecar_args, args,
        "the actual native app-server receives the retained configuration pairs"
    );
}

#[tokio::test]
async fn hosted_created_frame_uses_the_public_request_identity() {
    let (broadcast, mut receiver) = broadcast::channel(8);
    let proxy = HostedFreshAgentProxy {
        client: RuntimeClient::new("/tmp/unopened-fresh-agent-proxy.sock", "fixture"),
        broadcast: Arc::new(broadcast),
        aliases: Mutex::new(HashMap::new()),
        presentation_routes: Mutex::new(HashMap::new()),
        pollers: Mutex::new(HashSet::new()),
        fixture_modes: HashSet::new(),
        naming: OnceLock::new(),
        checkpoint_barrier: OnceLock::new(),
        ownership: OnceLock::new(),
    };
    proxy.forward_host_event(
        AgentEvent::Provider {
            payload: serde_json::json!({
                "type":"freshAgent.created", "requestId":"host-internal", "sessionId":"native"
            }),
        },
        "claude",
        "public",
        "freshclaude",
    );
    assert!(
        receiver.try_recv().is_err(),
        "internal create ID must not reach the client"
    );
}

#[tokio::test]
async fn managed_ordinary_stop_eof_broadcasts_one_failed_ack_to_both_receivers() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let soul = SoulId::parse("owned-stop-soul").unwrap();
    let expected_soul = soul.clone();
    let supervisor = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let health: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
        assert!(matches!(health.body, AdminCommand::Health));
        assert_eq!(health.role, ControlRole::Web);
        assert_eq!(health.auth.as_deref(), Some("0123456789abcdef"));
        write_frame(
            &mut stream,
            &AdminReply {
                request_id: health.request_id.clone(),
                result: Ok(AdminResult::Health {
                    control_epoch: 77,
                    installation_id: InstallationId::new(),
                }),
            },
        )
        .await
        .unwrap();
        drop(stream);

        let (mut stream, _) = listener.accept().await.unwrap();
        let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
        assert_eq!(request.role, ControlRole::Web);
        assert_eq!(request.auth.as_deref(), Some("0123456789abcdef"));
        assert_ne!(request.request_id, health.request_id);
        let AdminCommand::Stop(stop) = request.body else {
            panic!("ordinary kill must issue exactly one Stop")
        };
        assert_eq!(stop.soul_id, expected_soul);
        assert_eq!(stop.expected_control_epoch, Some(77));
        assert_eq!(stop.expected_intent_revision, None);
        // Model the crashed supervisor's real UDS EOF, not a typed refusal.
        drop(stream);
        listener
    });
    let (broadcast, mut first) = broadcast::channel(16);
    let mut second = broadcast.subscribe();
    let proxy = Arc::new(HostedFreshAgentProxy {
        checkpoint_barrier: std::sync::OnceLock::new(),
        ownership: std::sync::OnceLock::new(),
        client: RuntimeClient::new(&socket, "0123456789abcdef"),
        broadcast: Arc::new(broadcast),
        aliases: Mutex::new(HashMap::from([
            (
                ("codex".into(), "presentation-stop-session".into()),
                soul.clone(),
            ),
            (
                ("codex".into(), "different-native-root".into()),
                soul.clone(),
            ),
        ])),
        presentation_routes: Mutex::new(HashMap::from([(
            soul,
            PresentationRoute::initial("presentation-stop-session"),
        )])),
        pollers: Mutex::new(HashSet::new()),
        fixture_modes: HashSet::new(),
        naming: OnceLock::new(),
    });
    tokio::time::timeout(
        Duration::from_secs(5),
        proxy.dispatch(HostedFreshAgentCommand::Kill(
            freshell_protocol::FreshAgentKill {
                provider: AgentProvider::Codex,
                session_id: "presentation-stop-session".into(),
                session_type: SessionType::Freshcodex,
                cwd: None,
                observed_epoch: Some(77),
                observed_generation: Some(9),
            },
        )),
    )
    .await
    .expect("UDS EOF must settle the actual gateway dispatch");
    let first_frame = first.try_recv().expect("first connected receiver gets ACK");
    assert_eq!(second.try_recv().unwrap(), first_frame);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&first_frame).unwrap(),
        serde_json::json!({
            "type":"freshAgent.killed", "provider":"codex",
            "sessionId":"presentation-stop-session", "sessionType":"freshcodex",
            "success":false
        })
    );
    assert!(first.try_recv().is_err());
    assert!(second.try_recv().is_err());
    let listener = tokio::time::timeout(Duration::from_secs(5), supervisor)
        .await
        .unwrap()
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err(),
        "EOF must not cause another Stop, retry, or other control effect"
    );
}

#[tokio::test]
async fn managed_recovery_stop_refuses_without_contacting_the_host() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let soul = SoulId::parse("managed-codex-soul").unwrap();
    let (broadcast, mut receiver) = broadcast::channel(16);
    let proxy = Arc::new(HostedFreshAgentProxy {
        client: RuntimeClient::new(&socket, "0123456789abcdef"),
        broadcast: Arc::new(broadcast),
        aliases: Mutex::new(HashMap::from([(("codex".into(), "thread-1".into()), soul)])),
        presentation_routes: Mutex::new(HashMap::new()),
        pollers: Mutex::new(HashSet::new()),
        fixture_modes: HashSet::new(),
        naming: OnceLock::new(),
        checkpoint_barrier: OnceLock::new(),
        ownership: OnceLock::new(),
    });

    proxy
        .handle(HostedFreshAgentCommand::RecoveryStop(
            FreshAgentRecoveryStop {
                request_id: "stop-123".into(),
                provider: AgentProvider::Codex,
                session_id: "thread-1".into(),
                session_type: SessionType::Freshcodex,
                observed_epoch: None,
                observed_generation: None,
            },
        ))
        .await;

    let frame = receiver.try_recv().unwrap();
    let ServerMessage::FreshAgentRecoveryStopped(stopped) = serde_json::from_str(&frame).unwrap()
    else {
        panic!("expected recovery refusal")
    };
    assert_eq!(stopped.request_id, "stop-123");
    assert_eq!(stopped.code.as_deref(), Some("UNSUPPORTED_CAPABILITY"));
    assert!(!stopped.success);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err(),
        "recovery refusal must not contact the host"
    );
}

fn configure_proxy(
    socket: &Path,
    aliases: HashMap<(String, String), SoulId>,
) -> (Arc<HostedFreshAgentProxy>, broadcast::Receiver<String>) {
    let (broadcast, receiver) = broadcast::channel(16);
    let proxy = Arc::new(HostedFreshAgentProxy {
        client: RuntimeClient::new(socket, "0123456789abcdef"),
        broadcast: Arc::new(broadcast),
        aliases: Mutex::new(aliases),
        presentation_routes: Mutex::new(HashMap::new()),
        pollers: Mutex::new(HashSet::new()),
        fixture_modes: HashSet::new(),
        naming: OnceLock::new(),
        checkpoint_barrier: OnceLock::new(),
        ownership: OnceLock::new(),
    });
    (proxy, receiver)
}

async fn hosted_codex_preparation_refusal_case(rest: bool, operational: bool) {
    let mut environment = crate::test_env_lock::TestEnv::lock().await;
    let owned = tempfile::tempdir().unwrap();
    let home = owned.path().join("home");
    let workspace = owned.path().join("workspace");
    std::fs::create_dir_all(home.join(".codex")).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let source = home.join(".codex/config.toml");
    std::fs::write(
        &source,
        if operational {
            "approval_policy = 'never'\n"
        } else {
            "profile = 'legacy'\n"
        },
    )
    .unwrap();
    environment.set("HOME", &home);
    environment.set("CODEX_HOME", home.join(".codex"));
    let socket = owned.path().join("supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let observed = calls.clone();
    let (stop, mut stopping) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        loop {
            let accepted = tokio::select! { _ = &mut stopping => break, accepted = listener.accept() => accepted };
            let (mut stream, _) = accepted.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            observed.lock().await.push(request.body.clone());
            let result = match request.body {
                AdminCommand::Health => Ok(AdminResult::Health { control_epoch: 1, installation_id: InstallationId::new() }),
                AdminCommand::ReserveProviderInputs(_input) if operational => {
                    Err(freshell_runtime_protocol::RuntimeError::new(RuntimeErrorCode::BackendUnavailable, "owned supervisor unavailable"))
                }
                AdminCommand::ReserveProviderInputs(input) => Ok(AdminResult::ProviderInputReservation(serde_json::from_value(serde_json::json!({
                    "reservationId":"owned-config-reservation", "installationId":InstallationId::new(),
                    "soulId":input.soul_id,"provider":input.provider,"creationSeedRef":input.creation_seed_ref,
                    "intentRevision":0,"providerVolumeName":"owned-provider-volume","imageRef":"fixture-image",
                    "hostBinaryPath":"/opt/freshell-session-host","hostBinarySha256":"a".repeat(64),
                    "observation":{"kind":"absent","daemonId":"owned-test-daemon"}
                })).unwrap())),
                other => panic!("configuration refusal must not launch or mutate runtime ownership: {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result,
                },
            )
            .await
            .unwrap();
        }
    });
    let (proxy, mut receiver) = configure_proxy(&socket, HashMap::new());
    let request_id = "codex-configuration-refusal";
    if rest {
        let error = proxy
            .clone()
            .create_agent(RestLaneCreate {
                request_id: request_id.into(),
                provider: "codex".into(),
                session_type: "freshcodex".into(),
                cwd: Some(workspace.to_str().unwrap().into()),
                model: Some("original-model".into()),
                effort: Some(Some("high".into())),
                permission_mode: Some("untrusted".into()),
                ..Default::default()
            })
            .await
            .expect_err("unsupported native source must refuse before launch");
        assert_eq!(
            error.kind,
            freshell_freshagent::rest_lane::RestLaneErrorKind::BadRequest
        );
        assert_eq!(error.code, "INVALID_REQUEST");
        assert_eq!(error.retryable, Some(false));
        assert!(
            error.message.contains("profile") && error.message.contains(source.to_str().unwrap()),
            "{}",
            error.message
        );
    } else {
        let message = serde_json::from_value(serde_json::json!({
            "requestId":request_id,"sessionType":"freshcodex","provider":"codex", "cwd":workspace,
            "model":"original-model","effort":"high","permissionMode":"untrusted","sandbox":"read-only"
        })).unwrap();
        proxy
            .clone()
            .handle(HostedFreshAgentCommand::Create(message))
            .await;
        let frame: serde_json::Value = serde_json::from_str(&receiver.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.create.failed");
        assert_eq!(frame["requestId"], request_id);
        if operational {
            assert_ne!(
                frame["code"], "INVALID_REQUEST",
                "a supervisor outage is not invalid user configuration"
            );
            assert_eq!(frame["retryable"], true);
            assert!(frame["message"]
                .as_str()
                .unwrap()
                .contains("owned supervisor unavailable"));
        } else {
            assert_eq!(frame["code"], "INVALID_REQUEST");
            assert_eq!(frame["retryable"], false);
            let message = frame["message"].as_str().unwrap();
            assert!(
                message.contains("profile") && message.contains(source.to_str().unwrap()),
                "{message}"
            );
        }
        assert!(
            receiver.try_recv().is_err(),
            "one initiating-request failure, no created event"
        );
    }
    stop.send(()).unwrap();
    settled(server).await;
    assert!(!calls
        .lock()
        .await
        .iter()
        .any(|command| matches!(command, AdminCommand::Launch(_))));
    assert!(proxy.aliases.lock().await.is_empty());
    assert!(proxy.pollers.lock().await.is_empty());
}

#[tokio::test]
async fn hosted_codex_preparation_refusal_reaches_the_initiating_request() {
    hosted_codex_preparation_refusal_case(false, false).await;
}
#[tokio::test]
async fn hosted_codex_preparation_refusal_keeps_rest_configuration_diagnostics() {
    hosted_codex_preparation_refusal_case(true, false).await;
}
#[tokio::test]
async fn hosted_codex_preparation_refusal_distinguishes_control_outage() {
    hosted_codex_preparation_refusal_case(false, true).await;
}

/// The fake supervisor must have served every expected request by now; a
/// proxy that never called it fails here instead of hanging the suite.
async fn settled<T>(server: tokio::task::JoinHandle<T>) -> T {
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .expect("the proxy did not make the expected runtime calls")
        .unwrap()
}

fn configure_command(session_id: &str) -> HostedFreshAgentCommand {
    HostedFreshAgentCommand::Configure(
        serde_json::from_value(serde_json::json!({
            "provider":"claude","sessionId":session_id,"sessionType":"freshclaude",
            "cwd":"/workspace","requestId":"configure-ui-request",
            "settings":{"model":"opus","effort":"high","permissionMode":"acceptEdits",
                "sandbox":"workspace-write"}
        }))
        .unwrap(),
    )
}

async fn abandon_hosted_create(stale_intent: bool) {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let owned = SoulId::parse("newly-created-hosted-soul").unwrap();
    let expected = owned.clone();
    let server = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            let result = match request.body {
                AdminCommand::Health => Ok(AdminResult::Health {
                    control_epoch: 77,
                    installation_id: InstallationId::new(),
                }),
                AdminCommand::Stop(stop) => {
                    assert_eq!(stop.soul_id, expected);
                    assert_eq!(stop.expected_intent_revision, Some(9));
                    if stale_intent {
                        Err(freshell_runtime_protocol::RuntimeError::new(
                            RuntimeErrorCode::StaleIntentRevision,
                            "another intent now owns this soul",
                        ))
                    } else {
                        Ok(AdminResult::Stop { outcome: StopOutcome::VerifiedEmpty, view: serde_json::from_value(serde_json::json!({
                            "soulId":expected, "incarnationId":"created-incarnation", "launchState":"stopped", "cleanupState":"none",
                            "intentRevision":9, "executionGeneration":1,
                        })).unwrap() })
                    }
                }
                other => {
                    panic!("abandon must use its captured receipt without re-resolving: {other:?}")
                }
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result,
                },
            )
            .await
            .unwrap();
        }
    });
    let (proxy, _) = configure_proxy(
        &socket,
        HashMap::from([(
            ("claude".into(), "public-created".into()),
            SoulId::parse("replacement-alias-target").unwrap(),
        )]),
    );
    proxy
        .abandon_create(
            &RestLaneCreate::default(),
            &RestLaneCreated {
                session_id: "public-created".into(),
                cleanup_token: Some(serde_json::to_string(&(owned, 9_u64)).unwrap()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    settled(server).await;
}

#[tokio::test]
async fn hosted_rest_abandon_stops_only_the_captured_created_soul_and_intent() {
    abandon_hosted_create(false).await;
}

#[tokio::test]
async fn hosted_rest_abandon_does_not_stop_a_replacement_intent() {
    abandon_hosted_create(true).await;
}

#[tokio::test]
async fn hosted_rest_abandon_preserves_an_adopted_existing_writer_without_a_host_call() {
    let dir = tempfile::tempdir().unwrap();
    let (proxy, _) = configure_proxy(&dir.path().join("no-supervisor.sock"), HashMap::new());
    proxy
        .abandon_create(
            &RestLaneCreate::default(),
            &RestLaneCreated {
                session_id: "adopted-writer".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
}

/// Answers Health and then one configure the way `answer` decides, and
/// returns the admin methods it saw.
fn configure_supervisor(
    listener: UnixListener,
    answer: impl Fn(
            freshell_runtime_protocol::FreshAgentConfigureRequest,
            RequestId,
        ) -> Result<AdminResult, freshell_runtime_protocol::RuntimeError>
        + Send
        + 'static,
) -> tokio::task::JoinHandle<Vec<&'static str>> {
    tokio::spawn(async move {
        let mut methods = Vec::new();
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            assert_eq!(request.role, ControlRole::Web);
            let result = match request.body {
                AdminCommand::Health => {
                    methods.push("health");
                    Ok(AdminResult::Health {
                        control_epoch: 77,
                        installation_id: InstallationId::new(),
                    })
                }
                AdminCommand::FreshAgentConfigure(configure) => {
                    methods.push("fresh_agent_configure");
                    answer(configure, request.request_id.clone())
                }
                other => panic!("configure must not send {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result,
                },
            )
            .await
            .unwrap();
        }
        methods
    })
}

#[tokio::test]
async fn hosted_configure_calls_the_runtime_with_the_mapped_settings() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let soul = SoulId::parse("managed-claude-soul").unwrap();
    let expected_soul = soul.clone();
    let server = configure_supervisor(listener, move |configure, request_id| {
        assert_eq!(request_id.as_str(), "configure-ui-request");
        assert_eq!(configure.soul_id, expected_soul);
        assert_eq!(configure.expected_control_epoch, Some(77));
        assert_eq!(
            configure.settings,
            freshell_runtime_protocol::FreshAgentTurnSettings {
                collaboration_mode: None,
                cwd: Some("/workspace".into()),
                model: Some("opus".into()),
                effort: Some(Some("high".into())),
                permission_mode: Some("acceptEdits".into()),
                sandbox: Some("workspace-write".into()),
            }
        );
        Ok(AdminResult::FreshAgentCommand {
            state: freshell_runtime_protocol::CommandState::ProviderAcked,
        })
    });
    let (proxy, mut receiver) = configure_proxy(
        &socket,
        HashMap::from([(("claude".into(), "public-1".into()), soul)]),
    );

    proxy.handle(configure_command("public-1")).await;

    assert_eq!(
        settled(server).await,
        vec!["health", "fresh_agent_configure"]
    );
    assert!(
        receiver.try_recv().is_err(),
        "an accepted configure converges through the provider's own metadata frame"
    );
}

#[tokio::test]
async fn hosted_configure_rpc_failure_answers_a_typed_nested_error() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let soul = SoulId::parse("managed-claude-soul").unwrap();
    let server = configure_supervisor(listener, |_, _| {
        Err(freshell_runtime_protocol::RuntimeError::new(
            RuntimeErrorCode::UnsupportedOperation,
            "redacted",
        ))
    });
    let (proxy, mut receiver) = configure_proxy(
        &socket,
        HashMap::from([(("claude".into(), "public-1".into()), soul)]),
    );

    proxy.handle(configure_command("public-1")).await;
    settled(server).await;

    let frame = receiver.try_recv().expect("a refused configure is visible");
    let ServerMessage::FreshAgentEvent(event) = serde_json::from_str(&frame).unwrap() else {
        panic!("expected a nested fresh-agent event: {frame}")
    };
    assert_eq!(event.session_id, "public-1");
    assert_eq!(event.session_type, "freshclaude");
    assert_eq!(event.event["type"], "freshAgent.error");
    assert_eq!(event.event["code"], "UNSUPPORTED_CAPABILITY");
}

#[tokio::test]
async fn hosted_configure_for_an_unknown_soul_answers_a_nested_error_not_a_lost_session() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
        assert!(
            matches!(request.body, AdminCommand::Inventory),
            "an unknown soul is looked up, never configured: {:?}",
            request.body
        );
        write_frame(
            &mut stream,
            &AdminReply {
                request_id: request.request_id,
                result: Ok(AdminResult::Inventory(Vec::new())),
            },
        )
        .await
        .unwrap();
    });
    let (proxy, mut receiver) = configure_proxy(&socket, HashMap::new());

    proxy.handle(configure_command("public-unknown")).await;
    settled(server).await;

    let frame = receiver.try_recv().expect("an unknown soul is visible");
    let ServerMessage::FreshAgentEvent(event) = serde_json::from_str(&frame).unwrap() else {
        panic!("expected a nested fresh-agent event: {frame}")
    };
    assert_eq!(event.session_id, "public-unknown");
    assert_eq!(event.event["type"], "freshAgent.error");
    assert_eq!(event.event["code"], "MANAGED_FRESH_AGENT_ERROR");
    assert_ne!(
        event.event["code"], "INVALID_SESSION_ID",
        "a hosted configure miss must not mark the pane lost"
    );
}

#[test]
fn presentation_rewrite_keeps_materialized_native_identity() {
    let mut created = serde_json::json!({
        "type":"freshAgent.created",
        "sessionId":"internal",
        "sessionRef":{"provider":"opencode","sessionId":"internal"}
    });
    rewrite_presentation_id(&mut created, "public");
    assert_eq!(created["sessionId"], "public");
    assert_eq!(created["sessionRef"]["sessionId"], "public");

    let mut materialized = serde_json::json!({
        "type":"freshAgent.session.materialized",
        "previousSessionId":"internal",
        "sessionId":"native"
    });
    rewrite_presentation_id(&mut materialized, "public");
    assert_eq!(materialized["previousSessionId"], "public");
    assert_eq!(materialized["sessionId"], "native");
}

#[tokio::test]
async fn materialization_keeps_following_transcript_invalidations_on_the_native_route() {
    let (broadcast, mut receiver) = broadcast::channel(8);
    let soul = SoulId::parse("soul-materialization-route").unwrap();
    let proxy = HostedFreshAgentProxy {
        checkpoint_barrier: std::sync::OnceLock::new(),
        ownership: std::sync::OnceLock::new(),
        client: RuntimeClient::new("/unused/supervisor.sock", "0123456789abcdef"),
        broadcast: Arc::new(broadcast),
        aliases: Mutex::new(HashMap::new()),
        presentation_routes: Mutex::new(HashMap::from([(
            soul.clone(),
            PresentationRoute::initial("managed-public"),
        )])),
        pollers: Mutex::new(HashSet::new()),
        fixture_modes: HashSet::new(),
        naming: OnceLock::new(),
    };
    let events = [
        serde_json::json!({
            "type":"freshAgent.session.materialized",
            "provider":"opencode",
            "sessionType":"freshopencode",
            "previousSessionId":"managed-public",
            "sessionId":"ses_native"
        }),
        serde_json::json!({
            "type":"freshAgent.send.accepted",
            "provider":"opencode",
            "sessionType":"freshopencode",
            "sessionId":"ses_native",
            "requestId":"materialized-send"
        }),
        serde_json::json!({
            "type":"freshAgent.event",
            "provider":"opencode",
            "sessionType":"freshopencode",
            "sessionId":"ses_native",
            "event":{"type":"freshAgent.session.changed","sessionId":"ses_native"}
        }),
        serde_json::json!({
            "type":"freshAgent.event",
            "provider":"opencode",
            "sessionType":"freshopencode",
            "sessionId":"ses_native",
            "event":{"type":"freshAgent.turn.complete","sessionId":"ses_native","at":42}
        }),
    ];

    for event in events {
        proxy
            .forward_polled_event(
                &soul,
                AgentEvent::Provider { payload: event },
                "opencode",
                "managed-public",
                "freshopencode",
                Some(0),
            )
            .await;
    }

    let frames: Vec<serde_json::Value> = (0..4)
        .map(|_| serde_json::from_str(&receiver.try_recv().unwrap()).unwrap())
        .collect();
    assert_eq!(frames[0]["previousSessionId"], "managed-public");
    assert_eq!(frames[0]["sessionId"], "ses_native");
    assert_eq!(frames[1]["type"], "freshAgent.send.accepted");
    assert_eq!(frames[1]["sessionId"], "ses_native");
    assert_eq!(frames[1]["requestId"], "materialized-send");
    for (frame, event_type) in frames[2..]
        .iter()
        .zip(["freshAgent.session.changed", "freshAgent.turn.complete"])
    {
        assert_eq!(frame["event"]["type"], event_type);
        assert_eq!(
            frame["sessionId"], "ses_native",
            "{event_type} must follow the pane's materialized native session key"
        );
    }
    assert_eq!(
        proxy
            .presentation_routes
            .lock()
            .await
            .get(&soul)
            .map(|route| route.session_id.as_str()),
        Some("ses_native"),
    );
}

async fn codex_route_inventory(
    native: &'static str,
) -> (
    tempfile::TempDir,
    Arc<HostedFreshAgentProxy>,
    broadcast::Receiver<String>,
    tokio::task::JoinHandle<()>,
) {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("codex-route.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            let result = match request.body {
                AdminCommand::Health => AdminResult::Health {
                    control_epoch: 1,
                    installation_id: InstallationId::new(),
                },
                AdminCommand::Inventory => AdminResult::Inventory(vec![
                    serde_json::from_value(serde_json::json!({
                        "soulId":"soul-codex-replacement-route", "incarnationId":"owned-incarnation",
                        "hostBootId":"owned-boot", "launchState":"running", "cleanupState":"none",
                        "intentRevision":1, "executionGeneration":1, "desiredState":"running",
                        "recoveryState":"live", "durabilityState":"unknown", "allocationState":"allocated",
                        "evidenceRevision":0, "successfulRecoveriesInWindow":0, "provider":"codex",
                        "nativeSessionId":native, "freshAgentSessionId":"managed-public",
                        "freshAgentSessionType":"freshcodex"
                    })).unwrap(),
                ]),
                other => panic!("unexpected Codex route request: {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
    });
    let (proxy, receiver) = configure_proxy(&socket, HashMap::new());
    (dir, proxy, receiver, server)
}

#[tokio::test]
async fn codex_replacement_events_follow_the_materialized_pane() {
    let (_dir, proxy, mut receiver, server) = codex_route_inventory("native-b").await;
    let soul = SoulId::parse("soul-codex-replacement-route").unwrap();
    let at = chrono::Utc::now().timestamp_millis();
    let events = [
        serde_json::json!({"type":"freshAgent.session.materialized", "provider":"codex",
            "sessionType":"freshcodex", "previousSessionId":"native-a", "sessionId":"native-b",
            "sessionRef":{"provider":"codex","sessionId":"native-b"}}),
        serde_json::json!({"type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"native-b", "event":{"type":"freshAgent.error", "sessionId":"native-b",
                "code":"THREAD_MEMORY_LOST", "message":"Thread memory lost"}}),
        serde_json::json!({"type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"native-b", "event":{"type":"freshAgent.turn.complete", "sessionId":"native-b",
                "at":at, "outcome":"completed"}}),
    ];
    for event in events {
        proxy
            .forward_polled_event(
                &soul,
                AgentEvent::Provider { payload: event },
                "codex",
                "managed-public",
                "freshcodex",
                Some(0),
            )
            .await;
    }
    let frames: Vec<serde_json::Value> = (0..3)
        .map(|_| serde_json::from_str(&receiver.try_recv().unwrap()).unwrap())
        .collect();
    assert_eq!(frames[0]["previousSessionId"], "managed-public");
    assert_eq!(frames[0]["sessionRef"]["sessionId"], "native-b");
    let pane_id = frames[0]["sessionId"].as_str().unwrap();
    for (frame, event_type) in frames[1..]
        .iter()
        .zip(["freshAgent.error", "freshAgent.turn.complete"])
    {
        assert_eq!(frame["event"]["type"], event_type);
        assert_eq!(
            frame["sessionId"], pane_id,
            "{event_type} must reach the materialized pane"
        );
        assert_eq!(frame["event"]["sessionId"], pane_id);
    }
    assert_eq!(frames[1]["event"]["code"], "THREAD_MEMORY_LOST");
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn codex_unaccepted_replacement_does_not_rekey_or_deliver_its_warning() {
    let (_dir, proxy, mut receiver, server) = codex_route_inventory("native-a").await;
    let soul = SoulId::parse("soul-codex-replacement-route").unwrap();
    for payload in [
        serde_json::json!({"type":"freshAgent.session.materialized", "provider":"codex",
            "sessionType":"freshcodex", "previousSessionId":"native-a", "sessionId":"native-b",
            "sessionRef":{"provider":"codex","sessionId":"native-b"}}),
        serde_json::json!({"type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"native-b", "event":{"type":"freshAgent.error", "sessionId":"native-b",
                "code":"THREAD_MEMORY_LOST", "message":"Thread memory lost"}}),
    ] {
        proxy
            .forward_polled_event(
                &soul,
                AgentEvent::Provider { payload },
                "codex",
                "managed-public",
                "freshcodex",
                Some(0),
            )
            .await;
    }
    assert!(
        receiver.try_recv().is_err(),
        "unaccepted native B must not rekey the pane or publish its warning"
    );

    proxy.forward_polled_event(&soul, AgentEvent::Provider { payload: serde_json::json!({
        "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
        "sessionId":"native-a", "event":{"type":"freshAgent.status", "sessionId":"native-a", "status":"idle"}
    }) }, "codex", "managed-public", "freshcodex", Some(0)).await;
    let frame: serde_json::Value = serde_json::from_str(&receiver.try_recv().unwrap()).unwrap();
    assert_eq!(frame["sessionId"], "managed-public");
    assert_eq!(frame["event"]["status"], "idle");
    assert!(receiver.try_recv().is_err());
    server.abort();
    let _ = server.await;
}

async fn codex_journal_fixture(
    native: &'static str,
    public: &'static str,
    batch: freshell_runtime_protocol::AgentEventBatch,
) -> (
    tempfile::TempDir,
    Arc<HostedFreshAgentProxy>,
    broadcast::Receiver<String>,
    tokio::task::JoinHandle<()>,
) {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("codex-journal.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let server = tokio::spawn(async move {
        let mut presentations: Vec<String> = Vec::new();
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            let result = match request.body {
                AdminCommand::Health => AdminResult::Health { control_epoch: 1, installation_id: InstallationId::new() },
                AdminCommand::Inventory => AdminResult::Inventory(vec![serde_json::from_value(serde_json::json!({
                    "soulId":"codex-journal-soul", "incarnationId":"journal-incarnation", "hostBootId":"journal-boot",
                    "launchState":"running", "cleanupState":"none", "intentRevision":1, "executionGeneration":1,
                    "desiredState":"running", "recoveryState":"live", "durabilityState":"unknown", "allocationState":"allocated",
                    "evidenceRevision":1, "successfulRecoveriesInWindow":0, "provider":"codex",
                    "nativeSessionId":native, "freshAgentSessionId":public,
                    "freshAgentPresentationIds":presentations, "freshAgentSessionType":"freshcodex"
                })).unwrap()]),
                AdminCommand::FreshAgentClaimPresentation(claim) => {
                    assert_eq!(claim.native_session_id, native);
                    if !presentations.contains(&claim.native_session_id) {
                        presentations.push(claim.native_session_id);
                    }
                    AdminResult::FreshAgentPresentationClaimed
                }
                AdminCommand::FreshAgentReadEvents(read) => {
                    let mut page = batch.clone();
                    page.events.retain(|row| row.sequence > read.after_sequence);
                    if read.after_sequence != 0 { page.retained_state = None; page.reset_required = false; }
                    AdminResult::FreshAgentEvents(page)
                }
                other => panic!("unexpected Codex journal request: {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
    });
    let (proxy, receiver) = configure_proxy(&socket, HashMap::new());
    (dir, proxy, receiver, server)
}

fn accepted_codex_journal_proof() -> freshell_runtime_protocol::AcceptedNativeDispatch {
    freshell_runtime_protocol::AcceptedNativeDispatch {
        request_id: RequestId::parse("journal-replacement").unwrap(),
        prior_native_session_ids: Vec::new(),
        identity: freshell_runtime_protocol::NativeDispatchIdentity {
            previous_native_session_id: "native-a".into(),
            native_session_id: "native-b".into(),
            pending_naming_handle: None,
        },
    }
}

#[tokio::test]
async fn review_codex_replay_and_live_each_announce_before_their_output() {
    use futures_util::FutureExt;

    for replay_first in [true, false] {
        let batch = freshell_runtime_protocol::AgentEventBatch {
            accepted_native_dispatch: Some(accepted_codex_journal_proof()),
            native_dispatch_in_flight: false,
            retained_from: 1,
            head: 1,
            reset_required: false,
            retained_state: None,
            events: vec![freshell_runtime_protocol::AgentJournalEvent {
                sequence: 1,
                event: AgentEvent::Provider {
                    payload: serde_json::json!({
                        "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
                        "sessionId":"native-b", "event":{"type":"freshAgent.status", "sessionId":"native-b", "status":"after-acceptance"}
                    }),
                },
            }],
        };
        let (_dir, proxy, mut frames, server) =
            codex_journal_fixture("native-b", "managed-public", batch).await;
        let soul = SoulId::parse("codex-journal-soul").unwrap();
        let mut route = PresentationRoute::initial("managed-public");
        route.resumed_session_ids.insert("native-b".into());
        proxy
            .presentation_routes
            .lock()
            .await
            .insert(soul.clone(), route);
        let scenario = std::panic::AssertUnwindSafe(async {
            let mut replay_frames = Vec::new();
            let mut live_frames = Vec::new();
            if replay_first {
                proxy.replay_once(soul.clone(), "codex", "native-b", "freshcodex").await;
                while let Ok(frame) = frames.try_recv() {
                    replay_frames.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap());
                }
            }
            assert!(proxy.start_poller(soul.clone(), "codex".into(), "managed-public".into(), "freshcodex".into(), 0).await);
            tokio::time::timeout(Duration::from_secs(5), async {
                while ["managed-public", "native-b"].iter().any(|id| !live_frames.iter().any(|frame: &serde_json::Value| {
                    frame["sessionId"] == *id && frame["event"]["status"] == "after-acceptance"
                })) {
                    live_frames.push(serde_json::from_str::<serde_json::Value>(&frames.recv().await.unwrap()).unwrap());
                }
            }).await.expect("live output must reach both presentations");
            if !replay_first {
                proxy.replay_once(soul.clone(), "codex", "native-b", "freshcodex").await;
                while let Ok(frame) = frames.try_recv() {
                    replay_frames.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap());
                }
            }
            proxy.replay_once(soul.clone(), "codex", "native-b", "freshcodex").await;
            let mut repeated = Vec::new();
            while let Ok(frame) = frames.try_recv() {
                repeated.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap());
            }
            for output in [&replay_frames, &repeated] {
                assert!(output.iter().any(|frame| frame["type"] == "freshAgent.session.materialized"
                    && frame["sessionId"] == "native-b" && frame["sessionRef"]["sessionId"] == "native-b"), "{output:?}");
                assert!(output.iter().all(|frame| frame["sessionId"] == "native-b"), "targeted replay must not send to other presentations: {output:?}");
            }
            for id in ["managed-public", "native-b"] {
                let announced = live_frames.iter().position(|frame| frame["type"] == "freshAgent.session.materialized" && frame["sessionId"] == id);
                let prior_replay = id == "native-b" && replay_first && replay_frames.iter().any(|frame| frame["type"] == "freshAgent.session.materialized" && frame["sessionId"] == id);
                let output = live_frames.iter().position(|frame| frame["sessionId"] == id && frame["event"]["status"] == "after-acceptance").unwrap();
                assert!(prior_replay || announced.is_some_and(|index| index < output), "{id} needs its own B announcement before live output; replay_first={replay_first}; replay={replay_frames:?}; live={live_frames:?}");
            }
        }).catch_unwind().await;
        server.abort();
        let _ = server.await;
        let settled = tokio::time::timeout(Duration::from_secs(5), async {
            while proxy.pollers.lock().await.contains(&soul) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        if let Err(panic) = scenario {
            std::panic::resume_unwind(panic);
        }
        assert!(settled.is_ok(), "owned poller must settle");
    }
}

#[tokio::test]
async fn codex_native_resume_keeps_an_existing_unmaterialized_pane_live() {
    let batch = freshell_runtime_protocol::AgentEventBatch {
        accepted_native_dispatch: None,
        native_dispatch_in_flight: false,
        retained_from: 0,
        head: 0,
        reset_required: false,
        events: Vec::new(),
        retained_state: None,
    };
    let (dir, proxy, mut frames, server) =
        codex_journal_fixture("native-a", "managed-public", batch).await;
    let soul = SoulId::parse("codex-journal-soul").unwrap();
    assert!(
        proxy
            .start_poller(
                soul.clone(),
                "codex".into(),
                "managed-public".into(),
                "freshcodex".into(),
                0
            )
            .await
    );
    let create = serde_json::from_value(serde_json::json!({
        "requestId":"resume-before-replacement", "provider":"codex", "sessionType":"freshcodex",
        "cwd":dir.path(), "sessionRef":{"provider":"codex", "sessionId":"native-a"}
    }))
    .unwrap();
    proxy
        .clone()
        .handle(HostedFreshAgentCommand::Create(create))
        .await;
    let created: serde_json::Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(3), frames.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(created["type"], "freshAgent.created");
    assert_eq!(created["sessionId"], "native-a");
    assert_eq!(created["sessionRef"]["sessionId"], "native-a");
    proxy.forward_polled_event(&soul, AgentEvent::Provider { payload: serde_json::json!({
        "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex", "sessionId":"native-a",
        "event":{"type":"freshAgent.status", "sessionId":"native-a", "status":"both-live"}
    }) }, "codex", "managed-public", "freshcodex", Some(0)).await;
    let mut delivered = HashSet::new();
    for _ in 0..2 {
        let frame: serde_json::Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(3), frames.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(frame["event"]["status"], "both-live");
        assert_eq!(frame["event"]["sessionId"], frame["sessionId"]);
        delivered.insert(frame["sessionId"].as_str().unwrap().to_owned());
    }
    assert_eq!(
        delivered,
        HashSet::from(["managed-public".to_owned(), "native-a".to_owned()])
    );
    server.abort();
    let _ = server.await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while proxy.pollers.lock().await.contains(&soul) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("owned poller must settle after its socket closes");
}

#[tokio::test]
async fn codex_accepted_replacement_is_presented_after_journal_eviction() {
    for replay in [false, true] {
        let batch = freshell_runtime_protocol::AgentEventBatch {
            accepted_native_dispatch: Some(accepted_codex_journal_proof()),
            native_dispatch_in_flight: false,
            retained_from: 10,
            head: 10,
            reset_required: true,
            events: Vec::new(),
            retained_state: Some(serde_json::json!({
                "source":{"soulId":"codex-journal-soul","incarnationId":"journal-incarnation","hostBootId":"journal-boot","projectionId":"owned","ownerEpoch":0,"ownerGeneration":0},
                "snapshot":{"provider":"codex","sessionType":"freshcodex","threadId":"native-b","turns":[]},
                "attentionMarks":[],"pendingControls":[]
            })),
        };
        let (_dir, proxy, mut frames, server) =
            codex_journal_fixture("native-b", "managed-public", batch).await;
        let soul = SoulId::parse("codex-journal-soul").unwrap();
        if replay {
            proxy
                .replay_once(soul.clone(), "codex", "managed-public", "freshcodex")
                .await;
        } else {
            assert!(
                proxy
                    .start_poller(
                        soul.clone(),
                        "codex".into(),
                        "managed-public".into(),
                        "freshcodex".into(),
                        0
                    )
                    .await
            );
        }
        let first: serde_json::Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(3), frames.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let second: serde_json::Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(3), frames.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(first["type"], "freshAgent.session.materialized");
        assert_eq!(first["previousSessionId"], "managed-public");
        assert_eq!(first["sessionId"], "managed-public");
        assert_eq!(first["sessionRef"]["sessionId"], "native-b");
        assert!(matches!(
            second["event"]["type"].as_str(),
            Some("freshAgent.host.journal.reset" | "freshAgent.host.backpressure")
        ));
        assert_eq!(
            second["event"]["retainedState"]["snapshot"]["threadId"],
            "native-b"
        );
        server.abort();
        let _ = server.await;
        if !replay {
            tokio::time::timeout(Duration::from_secs(3), async {
                while proxy.pollers.lock().await.contains(&soul) {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("owned poller must settle after its socket closes");
        }
    }
}

#[tokio::test]
async fn codex_resumed_presentation_receives_retained_state_and_controls() {
    for replay in [false, true] {
        let batch = freshell_runtime_protocol::AgentEventBatch {
            accepted_native_dispatch: Some(accepted_codex_journal_proof()),
            native_dispatch_in_flight: false,
            retained_from: 10,
            head: 10,
            reset_required: true,
            events: Vec::new(),
            retained_state: Some(serde_json::json!({
                "source":{"soulId":"codex-journal-soul","incarnationId":"journal-incarnation","hostBootId":"journal-boot","projectionId":"owned","ownerEpoch":0,"ownerGeneration":0},
                "snapshot":{"provider":"codex","sessionType":"freshcodex","threadId":"native-b","turns":[{"id":"retained-turn"}]},
                "attentionMarks":[],
                "pendingControls":[
                    {"type":"freshAgent.permission.request","sessionId":"native-b","requestId":"pending-control"},
                    {"type":"freshAgent.question.request","sessionId":"native-b","requestId":"pending-question"},
                    {"type":"freshAgent.elicitation.request","sessionId":"native-b","requestId":"pending-elicitation"}
                ]
            })),
        };
        let (_dir, proxy, mut frames, server) =
            codex_journal_fixture("native-b", "managed-public", batch).await;
        let soul = SoulId::parse("codex-journal-soul").unwrap();
        let mut route = PresentationRoute::initial("managed-public");
        route.resumed_session_ids.insert("native-b".into());
        proxy
            .presentation_routes
            .lock()
            .await
            .insert(soul.clone(), route);
        if replay {
            proxy
                .replay_once(soul.clone(), "codex", "native-b", "freshcodex")
                .await;
        } else {
            assert!(
                proxy
                    .start_poller(
                        soul.clone(),
                        "codex".into(),
                        "managed-public".into(),
                        "freshcodex".into(),
                        0
                    )
                    .await
            );
        }
        let expected: &[&str] = if replay {
            &["native-b"]
        } else {
            &["managed-public", "native-b"]
        };
        let mut received = Vec::<serde_json::Value>::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            while received.len() < expected.len() * 5 {
                received.push(serde_json::from_str(&frames.recv().await.unwrap()).unwrap());
            }
        }).await.expect("every selected presentation must receive materialization, retained state and pending controls");
        for id in expected {
            assert!(received.iter().any(|frame| frame["type"]
                == "freshAgent.session.materialized"
                && frame["previousSessionId"] == *id
                && frame["sessionId"] == *id
                && frame["sessionRef"]["sessionId"] == "native-b"));
            assert!(received.iter().any(|frame| frame["sessionId"] == *id
                && frame["event"]["retainedState"]["snapshot"]["threadId"] == "native-b"
                && frame["event"]["retainedState"]["snapshot"]["turns"][0]["id"]
                    == "retained-turn"
                && frame["event"]["retainedState"]["snapshot"]
                    .get("pendingApprovals")
                    .is_none()));
            assert!(
                received.iter().any(|frame| frame["sessionId"] == *id
                    && frame["event"]["type"] == "freshAgent.permission.request"
                    && frame["event"]["sessionId"] == *id
                    && frame["event"]["requestId"] == "pending-control"),
                "the pending control must address its presentation {id}"
            );
            for (kind, request) in [
                ("question", "pending-question"),
                ("elicitation", "pending-elicitation"),
            ] {
                assert!(
                    received.iter().any(|frame| frame["sessionId"] == *id
                        && frame["event"]["type"] == format!("freshAgent.{kind}.request")
                        && frame["event"]["sessionId"] == *id
                        && frame["event"]["requestId"] == request),
                    "the accepted {kind} must address its presentation {id}"
                );
            }
        }
        assert!(received
            .iter()
            .all(|frame| expected.contains(&frame["sessionId"].as_str().unwrap())));
        assert!(
            received
                .iter()
                .all(|frame| frame["event"]["type"] != "freshAgent.turn.complete"),
            "reattachment must not repeat completion attention"
        );
        server.abort();
        let _ = server.await;
        if !replay {
            tokio::time::timeout(Duration::from_secs(3), async {
                while proxy.pollers.lock().await.contains(&soul) {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("owned poller must settle after its socket closes");
        }
    }
}

#[tokio::test]
async fn codex_replay_does_not_restore_a_retired_replacement_after_fork() {
    let payloads = [
        serde_json::json!({"type":"freshAgent.session.materialized","provider":"codex","sessionType":"freshcodex","previousSessionId":"native-a","sessionId":"native-b","sessionRef":{"provider":"codex","sessionId":"native-b"}}),
        serde_json::json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-b","event":{"type":"freshAgent.error","sessionId":"native-b","code":"THREAD_MEMORY_LOST"}}),
        serde_json::json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-c","event":{"type":"freshAgent.status","sessionId":"native-c","status":"idle"}}),
    ];
    let batch = freshell_runtime_protocol::AgentEventBatch {
        retained_state: None,
        accepted_native_dispatch: Some(accepted_codex_journal_proof()),
        native_dispatch_in_flight: false,
        retained_from: 1,
        head: 3,
        reset_required: false,
        events: payloads
            .into_iter()
            .enumerate()
            .map(
                |(index, payload)| freshell_runtime_protocol::AgentJournalEvent {
                    sequence: index as u64 + 1,
                    event: AgentEvent::Provider { payload },
                },
            )
            .collect(),
    };
    let (_dir, proxy, mut frames, server) =
        codex_journal_fixture("native-c", "native-c", batch).await;
    let soul = SoulId::parse("codex-journal-soul").unwrap();
    proxy
        .presentation_routes
        .lock()
        .await
        .insert(soul.clone(), PresentationRoute::materialized("native-c"));
    proxy
        .replay_once(soul, "codex", "native-c", "freshcodex")
        .await;
    let frame: serde_json::Value = serde_json::from_str(&frames.try_recv().unwrap()).unwrap();
    assert_eq!(frame["sessionId"], "native-c");
    assert_eq!(frame["event"]["status"], "idle");
    assert!(
        frames.try_recv().is_err(),
        "the old replacement and warning must stay retired"
    );
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn replayed_materialization_does_not_rekey_a_forked_pane_to_its_retired_parent() {
    let (broadcast, mut receiver) = broadcast::channel(8);
    let soul = SoulId::parse("soul-materialization-fork-route").unwrap();
    let current_at = chrono::Utc::now().timestamp_millis() + 1;
    // Model the fork route retained after a poller exits; its next poller
    // starts at cursor zero and sees the parent's old materialization again.
    let proxy = HostedFreshAgentProxy {
        checkpoint_barrier: std::sync::OnceLock::new(),
        ownership: std::sync::OnceLock::new(),
        client: RuntimeClient::new("/unused/supervisor.sock", "0123456789abcdef"),
        broadcast: Arc::new(broadcast),
        aliases: Mutex::new(HashMap::new()),
        presentation_routes: Mutex::new(HashMap::from([(
            soul.clone(),
            PresentationRoute::materialized("ses_child"),
        )])),
        pollers: Mutex::new(HashSet::new()),
        fixture_modes: HashSet::new(),
        naming: OnceLock::new(),
    };
    let events = [
        serde_json::json!({
            "type":"freshAgent.session.materialized",
            "provider":"opencode",
            "sessionType":"freshopencode",
            "previousSessionId":"managed-public",
            "sessionId":"ses_parent"
        }),
        serde_json::json!({
            "type":"freshAgent.event",
            "provider":"opencode",
            "sessionType":"freshopencode",
            "sessionId":"ses_parent",
            "event":{"type":"freshAgent.session.changed","sessionId":"ses_parent"}
        }),
        serde_json::json!({
            "type":"freshAgent.event",
            "provider":"opencode",
            "sessionType":"freshopencode",
            "sessionId":"ses_parent",
            "event":{"type":"freshAgent.turn.complete","sessionId":"ses_parent","at":current_at}
        }),
    ];

    for event in events {
        proxy
            .forward_polled_event(
                &soul,
                AgentEvent::Provider { payload: event },
                "opencode",
                "managed-public",
                "freshopencode",
                Some(current_at),
            )
            .await;
    }

    let frames: Vec<serde_json::Value> = std::iter::from_fn(|| {
        receiver
            .try_recv()
            .ok()
            .map(|frame| serde_json::from_str(&frame).unwrap())
    })
    .collect();
    assert_eq!(
        frames.len(),
        1,
        "retired-parent attention must not become a child completion"
    );
    assert_eq!(frames[0]["event"]["type"], "freshAgent.session.changed");
    assert_eq!(frames[0]["sessionId"], "ses_child");
    assert_eq!(
        proxy
            .presentation_routes
            .lock()
            .await
            .get(&soul)
            .map(|route| route.session_id.as_str()),
        Some("ses_child"),
    );
    assert!(proxy
        .presentation_routes
        .lock()
        .await
        .get(&soul)
        .is_some_and(|route| route.materialized));
}

#[tokio::test]
async fn historical_attention_is_silent_while_status_transcript_and_permissions_rebuild() {
    let root = tempfile::tempdir().unwrap();
    let proxy = snapshot_outage_proxy(&root.path().join("never-contacted.sock"));
    let soul = SoulId::new();
    proxy.presentation_routes.lock().await.insert(
        soul.clone(),
        PresentationRoute::materialized("native-current"),
    );
    let mut receiver = proxy.broadcast.subscribe();
    let current_at = chrono::Utc::now().timestamp_millis() + 1;
    let frame = |event: serde_json::Value| {
        serde_json::json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
            "sessionId":"native-current", "event": event,
        })
    };
    for payload in [
        frame(
            serde_json::json!({"type":"freshAgent.turn.complete", "sessionId":"native-current", "at":0}),
        ),
        frame(
            serde_json::json!({"type":"freshAgent.turn.waiting", "sessionId":"native-current", "at":0}),
        ),
        frame(
            serde_json::json!({"type":"freshAgent.status", "sessionId":"native-current", "status":"waiting"}),
        ),
        frame(
            serde_json::json!({"type":"freshAgent.session.changed", "sessionId":"native-current"}),
        ),
        frame(
            serde_json::json!({"type":"freshAgent.permission.request", "sessionId":"native-current", "requestId":"pending-tool", "tool":{"name":"exec_command", "input":{"cmd":"pwd"}}}),
        ),
        frame(
            serde_json::json!({"type":"freshAgent.turn.complete", "sessionId":"native-current", "at":current_at}),
        ),
        frame(
            serde_json::json!({"type":"freshAgent.turn.waiting", "sessionId":"native-current", "at":current_at+1}),
        ),
    ] {
        proxy
            .forward_polled_event(
                &soul,
                AgentEvent::Provider { payload },
                "codex",
                "native-current",
                "freshcodex",
                Some(current_at),
            )
            .await;
    }
    let frames: Vec<serde_json::Value> = std::iter::from_fn(|| receiver.try_recv().ok())
        .map(|frame| serde_json::from_str(&frame).unwrap())
        .collect();
    assert_eq!(
        frames
            .iter()
            .map(|frame| frame["event"]["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "freshAgent.status",
            "freshAgent.session.changed",
            "freshAgent.permission.request",
            "freshAgent.turn.complete",
            "freshAgent.turn.waiting",
        ],
        "old attention edges must be silent without suppressing state or live edges"
    );
    assert_eq!(frames[2]["event"]["requestId"], "pending-tool");
    assert_eq!(frames[2]["event"]["tool"]["input"]["cmd"], "pwd");
}

#[tokio::test]
async fn claude_live_attention_keeps_public_sidecar_ids_after_native_materialization() {
    let root = tempfile::tempdir().unwrap();
    let proxy = snapshot_outage_proxy(&root.path().join("never-contacted.sock"));
    let soul = SoulId::new();
    proxy
        .observe_native_session(&soul, "native-claude-root")
        .await;
    let mut receiver = proxy.broadcast.subscribe();
    proxy
        .forward_polled_event(
            &soul,
            AgentEvent::Provider {
                payload: serde_json::json!({
                    "type":"freshAgent.event", "provider":"claude", "sessionType":"freshclaude",
                    "sessionId":"sidecar-public", "event":{
                        "type":"freshAgent.turn.complete", "sessionId":"sidecar-public", "at":42,
                    },
                }),
            },
            "claude",
            "native-claude-root",
            "freshclaude",
            Some(42),
        )
        .await;
    let frame: serde_json::Value = serde_json::from_str(&receiver.try_recv().unwrap()).unwrap();
    assert_eq!(frame["sessionId"], "native-claude-root");
    assert_eq!(frame["event"]["type"], "freshAgent.turn.complete");
    assert_eq!(frame["event"]["at"], 42);
}

#[tokio::test]
async fn replay_once_rebuilds_pending_state_without_repeating_even_recent_attention() {
    use freshell_runtime_protocol::{AgentEventBatch, AgentJournalEvent};
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("state-replay.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let proxy = snapshot_outage_proxy(&socket);
    let soul = SoulId::new();
    proxy.observe_native_session(&soul, "native-current").await;
    proxy.pollers.lock().await.insert(soul.clone());
    let expected_soul = soul.clone();
    let supervisor = tokio::spawn(async move {
        for index in 0..3 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            let result = match request.body {
                AdminCommand::Health if index == 0 => AdminResult::Health {
                    control_epoch: 77,
                    installation_id: InstallationId::new(),
                },
                AdminCommand::Inventory if index == 1 => {
                    AdminResult::Inventory(vec![serde_json::from_value(serde_json::json!({
                        "soulId": expected_soul,
                        "incarnationId": "state-replay-incarnation",
                        "hostBootId": "state-replay-boot",
                        "launchState": "running", "cleanupState": "none",
                        "intentRevision": 1, "executionGeneration": 1,
                        "desiredState": "running", "recoveryState": "live",
                        "durabilityState": "unknown", "allocationState": "allocated",
                        "evidenceRevision": 0, "successfulRecoveriesInWindow": 0,
                        "provider": "codex", "nativeSessionId": "native-current",
                        "freshAgentSessionId": "native-current",
                        "freshAgentSessionType": "freshcodex"
                    }))
                    .unwrap()])
                }
                AdminCommand::FreshAgentReadEvents(read) if index == 2 => {
                    assert_eq!(read.soul_id, expected_soul);
                    assert_eq!(read.after_sequence, 0);
                    assert_eq!(read.max_events, 4096);
                    let recent = chrono::Utc::now().timestamp_millis() + 10_000;
                    let payloads = [
                        serde_json::json!({"type":"freshAgent.turn.complete", "at":recent}),
                        serde_json::json!({"type":"freshAgent.turn.waiting", "at":recent+1}),
                        serde_json::json!({"type":"freshAgent.status", "status":"waiting"}),
                        serde_json::json!({"type":"freshAgent.session.changed"}),
                        serde_json::json!({"type":"freshAgent.permission.request", "requestId":"pending-tool"}),
                    ];
                    AdminResult::FreshAgentEvents(AgentEventBatch {
                        accepted_native_dispatch: None,
                        native_dispatch_in_flight: false,
                        retained_state: None,
                        retained_from:1, head:payloads.len() as u64, reset_required:false,
                        events:payloads.into_iter().enumerate().map(|(index,event)| AgentJournalEvent {
                            sequence:index as u64 + 1,
                            event:AgentEvent::Provider { payload:serde_json::json!({
                                "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
                                "sessionId":"native-current", "event":event,
                            }) },
                        }).collect(),
                    })
                }
                other => panic!("unexpected state replay request {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
    });
    let mut receiver = proxy.broadcast.subscribe();
    tokio::time::timeout(
        Duration::from_secs(5),
        proxy.replay_once(soul, "codex", "native-current", "freshcodex"),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), supervisor)
        .await
        .unwrap()
        .unwrap();
    let frames: Vec<serde_json::Value> = std::iter::from_fn(|| receiver.try_recv().ok())
        .map(|frame| serde_json::from_str(&frame).unwrap())
        .collect();
    assert_eq!(
        frames
            .iter()
            .map(|frame| frame["event"]["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "freshAgent.status",
            "freshAgent.session.changed",
            "freshAgent.permission.request",
        ]
    );
    assert_eq!(frames[2]["event"]["requestId"], "pending-tool");
}

#[tokio::test]
async fn first_create_preserves_completion_generated_before_the_launch_reply() {
    use freshell_runtime_protocol::{AgentEventBatch, AgentJournalEvent};
    if create_failure_trace_child(
        "creation-attention", "fresh_agent_proxy::tests::first_create_preserves_completion_generated_before_the_launch_reply",
    ) { return; }
    let root = tempfile::tempdir().unwrap();
    let socket = root.path().join("creation-attention.sock");
    let secret = root.path().join("control-secret");
    std::fs::write(&secret, "0123456789abcdef").unwrap();
    crate::managed_mcp_capability::configure("0.0.0.0", 39484, &socket, &secret).unwrap();
    let listener = UnixListener::bind(&socket).unwrap();
    let request_id = "creation-attention-owned";
    let public_session_id = presentation_id_for_create(&FreshProvider::Claude, request_id, None);
    let expected_session_id = public_session_id.clone();
    let supervisor = tokio::spawn(async move {
        let mut completion_at = None;
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            if reply_to_create_preparation(&mut stream, &request).await {
                continue;
            }
            let result = match request.body {
                AdminCommand::Health => AdminResult::Health {
                    control_epoch: 77,
                    installation_id: InstallationId::new(),
                },
                AdminCommand::Launch(launch) => {
                    assert!(completion_at.is_none());
                    // The provider has finished, but the creation request is
                    // still waiting for its launch acknowledgement.
                    completion_at = Some(chrono::Utc::now().timestamp_millis());
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    AdminResult::Launch(
                        serde_json::from_value(serde_json::json!({
                            "view":{
                                "soulId":launch.soul_id, "incarnationId":"creation-incarnation",
                                "launchState":"running", "cleanupState":"none",
                                "intentRevision":1, "executionGeneration":1, "provider":"claude",
                            },
                            "workerPid":42, "workerLaunchCount":1,
                            "hostBootId":"creation-boot", "effectiveLimits":launch.limits,
                        }))
                        .unwrap(),
                    )
                }
                AdminCommand::FreshAgentReadEvents(read) => {
                    AdminResult::FreshAgentEvents(AgentEventBatch {
                        accepted_native_dispatch: None,
                        native_dispatch_in_flight: false,
                        retained_state: None,
                        retained_from: 1,
                        head: 1,
                        reset_required: false,
                        events: if read.after_sequence == 0 {
                            vec![AgentJournalEvent {
                                sequence: 1,
                                event: AgentEvent::Provider {
                                    payload: serde_json::json!({
                                        "type":"freshAgent.event", "provider":"claude", "sessionType":"freshclaude",
                                        "sessionId":expected_session_id,
                                        "event":{"type":"freshAgent.turn.complete", "sessionId":expected_session_id, "at":completion_at.unwrap()},
                                    }),
                                },
                            }]
                        } else {
                            vec![]
                        },
                    })
                }
                other => panic!("unexpected creation request {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
    });
    let mut proxy = snapshot_outage_proxy(&socket);
    Arc::get_mut(&mut proxy)
        .unwrap()
        .fixture_modes
        .insert("freshclaude".into());
    let mut receiver = proxy.broadcast.subscribe();
    tokio::time::timeout(Duration::from_secs(5), proxy.create(serde_json::from_value(serde_json::json!({
        "requestId":request_id, "provider":"claude", "sessionType":"freshclaude", "cwd":root.path(),
    })).unwrap())).await.unwrap().unwrap();
    let first: serde_json::Value = serde_json::from_str(&receiver.recv().await.unwrap()).unwrap();
    let completed = tokio::time::timeout(Duration::from_secs(5), receiver.recv()).await;
    supervisor.abort();
    assert!(supervisor.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(5), async {
        while !proxy.pollers.lock().await.is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(first["type"], "freshAgent.created");
    let completed: serde_json::Value = serde_json::from_str(
        &completed
            .expect("completion during creation must remain live")
            .unwrap(),
    )
    .unwrap();
    assert_eq!(completed["event"]["type"], "freshAgent.turn.complete");
    assert_eq!(completed["sessionId"], public_session_id);
}

#[test]
fn stable_ids_are_provider_scoped_and_do_not_contain_input() {
    let claude = stable_soul_id("claude", "private-request-content").unwrap();
    let codex = stable_soul_id("codex", "private-request-content").unwrap();
    assert_ne!(claude, codex);
    assert!(!claude.as_str().contains("private-request-content"));
}

#[test]
fn kilroy_keeps_claude_public_routing_distinct_from_its_runtime_identity() {
    assert_eq!(fresh_provider_wire(&FreshProvider::Kilroy), "claude");
    assert_eq!(FreshProvider::Kilroy.as_str(), "kilroy");
    assert_eq!(
        rest_agent_identity("claude", "kilroy"),
        Ok((AgentProvider::Claude, SessionType::Kilroy))
    );
    assert!(resume_identity_matches(
        DesiredState::Running,
        Some("kilroy"),
        Some("kilroy-native"),
        Some("managed-kilroy-public"),
        "kilroy",
        "managed-kilroy-public",
    ));
}

#[test]
fn rest_and_hosted_create_use_the_same_kilroy_presentation_identity() {
    let (public_provider, session_type) = rest_agent_identity("claude", "kilroy").unwrap();
    let runtime_provider = fresh_provider(&Some(public_provider), session_type).unwrap();
    let request_id = "kilroy-rest-request";
    let expected = format!("managed-kilroy-{}", stable_hex(request_id));
    assert_eq!(
        presentation_id_for_create(&runtime_provider, request_id, None),
        expected
    );
    assert_eq!(
        presentation_id_for_create(&runtime_provider, request_id, Some("native-42")),
        "native-42"
    );
}

#[test]
fn fixture_mode_selection_is_exact_and_rejects_duplicates() {
    assert_eq!(
        parse_fixture_modes("freshclaude,kilroy,freshcodex,freshopencode")
            .unwrap()
            .len(),
        4
    );
    for invalid in [
        "",
        "all",
        "claude",
        "freshclaude, freshcodex",
        "freshcodex,freshcodex",
        "freshopencode,",
    ] {
        assert!(
            parse_fixture_modes(invalid).is_err(),
            "accepted {invalid:?}"
        );
    }
}

#[test]
fn resume_reuses_only_the_exact_running_soul_identity() {
    assert!(resume_identity_matches(
        DesiredState::Running,
        Some("codex"),
        Some("thread-7"),
        Some("managed-codex-public"),
        "codex",
        "thread-7",
    ));
    assert!(resume_identity_matches(
        DesiredState::Running,
        Some("codex"),
        Some("thread-7"),
        Some("managed-codex-public"),
        "codex",
        "managed-codex-public",
    ));
    assert!(!resume_identity_matches(
        DesiredState::Running,
        Some("claude"),
        Some("thread-7"),
        None,
        "codex",
        "thread-7",
    ));
    assert!(!resume_identity_matches(
        DesiredState::Stopped,
        Some("codex"),
        Some("thread-7"),
        None,
        "codex",
        "thread-7",
    ));
}

#[test]
fn only_provider_terminal_edges_complete_a_rest_turn() {
    assert!(provider_event_completes_turn(&AgentEvent::Provider {
        payload: serde_json::json!({
            "type":"freshAgent.event",
            "event":{"type":"freshAgent.turn.complete"}
        }),
    }));
    assert!(provider_event_completes_turn(&AgentEvent::Provider {
        payload: serde_json::json!({
            "type":"freshAgent.event",
            "event":{"type":"freshAgent.status","status":"idle"}
        }),
    }));
    assert!(!provider_event_completes_turn(&AgentEvent::Provider {
        payload: serde_json::json!({
            "type":"freshAgent.event",
            "event":{"type":"freshAgent.status","status":"busy"}
        }),
    }));
}

#[test]
fn provider_child_threads_remain_snapshot_topology_not_runtime_creation_intents() {
    let mut payload = serde_json::json!({
        "type":"freshAgent.event",
        "sessionId":"native-parent",
        "provider":"codex",
        "sessionType":"freshcodex",
        "event":{
            "type":"freshAgent.session.snapshot",
            "sessionId":"native-parent",
            "capabilities":{"fork":true,"childThreads":true},
            "childThreads":[
                {"id":"provider-child-1","status":"running"},
                {"id":"provider-child-2","status":"completed"}
            ]
        }
    });
    rewrite_presentation_id(&mut payload, "public-parent");
    assert_eq!(payload["sessionId"], "public-parent");
    // Routing alias is outer-envelope state; provider snapshot identity remains
    // native so nested provider topology is not rewritten into Freshell lifecycle IDs.
    assert_eq!(
        payload["event"]["sessionId"], "public-parent",
        "the gateway rewrites only the containing session to its presentation id",
    );
    assert_eq!(payload["event"]["capabilities"]["childThreads"], true);
    assert_eq!(
        payload["event"]["childThreads"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        payload["event"]["childThreads"][0]["id"],
        "provider-child-1"
    );
    assert!(payload.get("soulId").is_none());
    assert!(payload["event"]["childThreads"][0].get("soulId").is_none());
}

#[tokio::test]
async fn managed_provider_fork_rekeys_the_same_soul_without_launch_or_stop() {
    for parent in ["public-parent", "native-resumed"] {
        managed_provider_fork_from_presentation(parent).await;
    }
}

async fn managed_provider_fork_from_presentation(parent: &'static str) {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let soul = SoulId::parse("soul-same-fork").unwrap();
    let expected_soul = soul.clone();
    let server = tokio::spawn(async move {
        let mut methods = Vec::new();
        for index in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            assert_eq!(request.role, ControlRole::Web);
            assert_eq!(request.auth.as_deref(), Some("0123456789abcdef"));
            let result = match request.body {
                AdminCommand::Health if index == 0 => {
                    methods.push("health");
                    AdminResult::Health {
                        control_epoch: 77,
                        installation_id: InstallationId::parse("installation-fork-test").unwrap(),
                    }
                }
                AdminCommand::FreshAgentFork(fork) if index == 1 => {
                    methods.push("fresh_agent_fork");
                    assert_eq!(fork.soul_id, expected_soul);
                    assert_eq!(fork.parent_session_id, parent);
                    assert_eq!(fork.input, Some(serde_json::json!({"atTurnId":"turn-4"})));
                    assert_eq!(fork.expected_control_epoch, Some(77));
                    AdminResult::FreshAgentFork(FreshAgentForkResult {
                        claude_fork: None,
                        parent_session_id: parent.into(),
                        child_session_id: "native-child".into(),
                        parent_retired_by_runtime: true,
                    })
                }
                other => panic!("fork gateway must not launch or stop a soul: {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
        methods
    });
    let client = RuntimeClient::new(&socket, "0123456789abcdef");
    let (broadcast, mut receiver) = broadcast::channel(16);
    let mut route = PresentationRoute::initial("public-parent");
    route.resumed_session_ids.insert("native-resumed".into());
    let proxy = Arc::new(HostedFreshAgentProxy {
        client,
        broadcast: Arc::new(broadcast),
        aliases: Mutex::new(HashMap::from([
            (("codex".into(), "public-parent".into()), soul.clone()),
            (("codex".into(), "native-resumed".into()), soul.clone()),
        ])),
        presentation_routes: Mutex::new(HashMap::from([(soul.clone(), route)])),
        pollers: Mutex::new(HashSet::new()),
        fixture_modes: HashSet::new(),
        naming: std::sync::OnceLock::new(),
        checkpoint_barrier: std::sync::OnceLock::new(),
        ownership: std::sync::OnceLock::new(),
    });
    Arc::clone(&proxy)
        .handle(HostedFreshAgentCommand::Fork(FreshAgentFork {
            observed_epoch: None,
            observed_generation: None,
            provider: AgentProvider::Codex,
            session_id: parent.into(),
            session_type: SessionType::Freshcodex,
            input: Some(serde_json::json!({"atTurnId":"turn-4"})),
            request_id: Some("fork-request-1".into()),
            cwd: Some("/workspace".into()),
            tab_id: Some("tab-one".into()),
        }))
        .await;

    let frame = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    let message: ServerMessage = serde_json::from_str(&frame).unwrap();
    let ServerMessage::FreshAgentForked(forked) = message else {
        panic!("expected forked reply")
    };
    assert_eq!(forked.parent_session_id, parent);
    assert_eq!(forked.session_id, "native-child");
    assert_eq!(forked.parent_retired_by_runtime, Some(true));
    let resumed_frame = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .expect("a fork that retires the soul must notify its resumed pane")
        .unwrap();
    let resumed: ServerMessage = serde_json::from_str(&resumed_frame).unwrap();
    let ServerMessage::FreshAgentForked(resumed_fork) = resumed else {
        panic!("expected a forked reply for the resumed pane")
    };
    let other = if parent == "public-parent" {
        "native-resumed"
    } else {
        "public-parent"
    };
    assert_eq!(resumed_fork.parent_session_id, other);
    assert_eq!(resumed_fork.session_id, "native-child");
    assert_eq!(resumed_fork.parent_retired_by_runtime, Some(true));
    assert_eq!(
        proxy
            .resolve_soul(
                &AgentProvider::Codex,
                SessionType::Freshcodex,
                "native-child"
            )
            .await,
        Some(soul.clone())
    );
    assert_eq!(
        proxy
            .presentation_routes
            .lock()
            .await
            .get(&soul)
            .map(|route| route.session_id.as_str()),
        Some("native-child")
    );
    assert!(proxy
        .presentation_routes
        .lock()
        .await
        .get(&soul)
        .is_some_and(|route| route.materialized));
    assert!(
        proxy
            .presentation_routes
            .lock()
            .await
            .get(&soul)
            .unwrap()
            .resumed_session_ids
            .is_empty(),
        "retired presentations must not receive child events"
    );
    let aliases = proxy.aliases.lock().await;
    assert_eq!(
        aliases.get(&("codex".into(), "native-child".into())),
        Some(&soul)
    );
    assert!(
        !aliases.keys().any(|(provider, session)| provider == "codex"
            && ["public-parent", "native-resumed"].contains(&session.as_str())),
        "retired parent aliases must not remain command-authoritative after an in-soul fork",
    );
    drop(aliases);
    assert_eq!(server.await.unwrap(), vec!["health", "fresh_agent_fork"]);
}

#[test]
fn semantic_operation_failures_keep_typed_public_codes() {
    use freshell_runtime_client::ClientError;
    assert_eq!(
        operation_error_code(&ClientError::Runtime {
            code: RuntimeErrorCode::UnsupportedOperation,
            message: "redacted".into(),
            diagnostic_code: None,
            fresh_agent_provider_start_diagnostic: None,
        }),
        "UNSUPPORTED_CAPABILITY"
    );
    assert_eq!(
        operation_error_code(&ClientError::Runtime {
            code: RuntimeErrorCode::CommandAmbiguous,
            message: "redacted".into(),
            diagnostic_code: None,
            fresh_agent_provider_start_diagnostic: None,
        }),
        "COMMAND_AMBIGUOUS"
    );
    assert_eq!(
        operation_error_code(&ClientError::Runtime {
            code: RuntimeErrorCode::OperationImplementationUnavailable,
            message: "redacted".into(),
            diagnostic_code: None,
            fresh_agent_provider_start_diagnostic: None,
        }),
        "IMPLEMENTATION_UNAVAILABLE"
    );
}

fn advertised_capabilities() -> serde_json::Value {
    serde_json::json!({
        "send": true,
        "interrupt": true,
        "approvals": true,
        "questions": true,
        "fork": true,
        "worktrees": true,
        "diffs": true,
        "childThreads": true,
        "undo": true,
        "redo": true,
        "settingScopes": {
            "model": "per-send",
            "effort": "per-send",
            "sandbox": "per-send",
            "permissionMode": "per-send"
        }
    })
}

#[test]
fn hosted_snapshot_capabilities_are_intersected_for_every_provider_and_envelope_shape() {
    let providers = [
        ("claude", "freshclaude", true, false),
        ("claude", "kilroy", true, false),
        ("codex", "freshcodex", false, true),
        ("opencode", "freshopencode", true, true),
    ];

    for (provider, session_type, redo_supported, fork_supported) in providers {
        for (snapshot_type, nested) in [
            ("freshAgent.session.snapshot", false),
            ("freshAgent.session.snapshot", true),
            ("freshAgent.snapshot", false),
            ("freshAgent.snapshot", true),
            ("rest", false),
        ] {
            let snapshot = serde_json::json!({
                "type": snapshot_type,
                "provider": provider,
                "sessionType": session_type,
                "sessionId": "native-session",
                "threadId": "native-session",
                "capabilities": advertised_capabilities(),
                "rollback": {
                    "canRedo": true,
                    "undoneDepth": 1,
                    "redoableTurnIds": ["turn-1"]
                }
            });
            let mut payload = if nested {
                serde_json::json!({
                    "type": "freshAgent.event",
                    "provider": provider,
                    "sessionType": session_type,
                    "sessionId": "native-session",
                    "event": snapshot
                })
            } else {
                snapshot
            };

            rewrite_presentation_id(&mut payload, "public-session");
            if snapshot_type == "rest" {
                payload.as_object_mut().unwrap().remove("type");
                freshell_agent_runtime::snapshot_projection::project_hosted_rest_snapshot(
                    &mut payload,
                    provider,
                    session_type,
                );
            } else {
                freshell_agent_runtime::snapshot_projection::project_hosted_snapshot(
                    &mut payload,
                    provider,
                    session_type,
                );
            }
            let projected = if nested { &payload["event"] } else { &payload };
            let capabilities = &projected["capabilities"];

            assert_eq!(capabilities["send"], true, "{provider}/{session_type}");
            assert_eq!(capabilities["interrupt"], true, "{provider}/{session_type}");
            assert_eq!(capabilities["approvals"], true, "{provider}/{session_type}");
            assert_eq!(capabilities["questions"], true, "{provider}/{session_type}");
            assert_eq!(
                capabilities["fork"], fork_supported,
                "{provider}/{session_type}"
            );
            assert_eq!(
                capabilities["worktrees"], false,
                "{provider}/{session_type}"
            );
            assert_eq!(
                capabilities["childThreads"], true,
                "nested provider child topology stays visible without lifecycle promotion"
            );
            assert_eq!(capabilities["diffs"], true, "{provider}/{session_type}");
            assert_eq!(capabilities["undo"], true, "{provider}/{session_type}");
            assert_eq!(
                capabilities["redo"], redo_supported,
                "{provider}/{session_type}"
            );
            assert_eq!(
                projected["rollback"]["canRedo"], redo_supported,
                "{provider}/{session_type}"
            );
            if redo_supported {
                assert_eq!(
                    projected["rollback"]["redoableTurnIds"],
                    serde_json::json!(["turn-1"])
                );
            } else {
                assert!(
                    projected["rollback"].get("redoableTurnIds").is_none(),
                    "redo targets must disappear when redo cannot dispatch"
                );
            }
            assert_eq!(projected["threadId"], "native-session");
            assert_eq!(
                projected["sessionId"],
                if snapshot_type == "rest" {
                    "native-session"
                } else {
                    "public-session"
                }
            );
        }
    }
}

#[test]
fn hosted_snapshot_unknown_capability_payloads_fail_closed_without_falsifying_known_truth() {
    for capabilities in [
        serde_json::Value::Null,
        serde_json::json!({}),
        serde_json::json!({"send":"yes","interrupt":1,"fork":true,"undo":true,"redo":true}),
    ] {
        let mut payload = serde_json::json!({
            "type": "freshAgent.event",
            "provider": "opencode",
            "sessionType": "freshopencode",
            "sessionId": "native-session",
            "event": {
                "type": "freshAgent.session.snapshot",
                "sessionId": "native-session",
                "capabilities": capabilities,
                "rollback": {"canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["turn-1"]}
            }
        });

        rewrite_presentation_id(&mut payload, "public-session");
        freshell_agent_runtime::snapshot_projection::project_hosted_snapshot(
            &mut payload,
            "opencode",
            "freshopencode",
        );
        let projected = &payload["event"];
        for capability in [
            "send",
            "interrupt",
            "approvals",
            "questions",
            "fork",
            "worktrees",
            "diffs",
            "childThreads",
            "undo",
            "redo",
        ] {
            assert_eq!(
                projected["capabilities"][capability], false,
                "unknown {capability} must fail closed"
            );
        }
        assert_eq!(projected["rollback"]["canRedo"], false);
        assert!(projected["rollback"].get("redoableTurnIds").is_none());
    }
}

#[tokio::test]
async fn rollback_commands_keep_direction_target_and_request_fences() {
    for direction in [
        FreshAgentRollbackDirection::Undo,
        FreshAgentRollbackDirection::Redo,
    ] {
        let root = tempfile::tempdir().unwrap();
        let socket = root.path().join("rollback.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let soul = SoulId::new();
        let expected_soul = soul.clone();
        let server = tokio::spawn(async move {
            for index in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                let result = match request.body {
                    AdminCommand::Health if index == 0 => AdminResult::Health {
                        control_epoch: 77,
                        installation_id: InstallationId::new(),
                    },
                    AdminCommand::FreshAgentRollback(rollback) if index == 1 => {
                        assert_eq!(request.request_id.as_str(), "rollback-ui-request");
                        assert_eq!(rollback.soul_id, expected_soul);
                        assert_eq!(rollback.direction, direction);
                        assert_eq!(rollback.mode, FreshAgentRollbackMode::ToTurn);
                        assert_eq!(rollback.turn_id.as_deref(), Some("turn-selected"));
                        assert_eq!(rollback.cwd.as_deref(), Some("/workspace"));
                        assert_eq!(rollback.expected_control_epoch, Some(77));
                        AdminResult::FreshAgentCommand {
                            state: freshell_runtime_protocol::CommandState::Completed,
                        }
                    }
                    other => panic!("unexpected rollback request {other:?}"),
                };
                write_frame(
                    &mut stream,
                    &AdminReply {
                        request_id: request.request_id,
                        result: Ok(result),
                    },
                )
                .await
                .unwrap();
            }
        });
        let (broadcast, _) = broadcast::channel(16);
        let proxy = Arc::new(HostedFreshAgentProxy {
            client: RuntimeClient::new(&socket, "0123456789abcdef"),
            broadcast: Arc::new(broadcast),
            aliases: Mutex::new(HashMap::from([(
                ("codex".into(), "public-thread".into()),
                soul,
            )])),
            presentation_routes: Mutex::new(HashMap::new()),
            pollers: Mutex::new(HashSet::new()),
            fixture_modes: HashSet::new(),
            naming: OnceLock::new(),
            checkpoint_barrier: OnceLock::new(),
            ownership: OnceLock::new(),
        });
        let message = serde_json::json!({"provider":"codex","sessionId":"public-thread","sessionType":"freshcodex",
            "requestId":"rollback-ui-request","mode":"toTurn","turnId":"turn-selected","cwd":"/workspace"});
        let command = match direction {
            FreshAgentRollbackDirection::Undo => {
                HostedFreshAgentCommand::Undo(serde_json::from_value(message).unwrap())
            }
            FreshAgentRollbackDirection::Redo => {
                HostedFreshAgentCommand::Redo(serde_json::from_value(message).unwrap())
            }
        };
        proxy.handle(command).await;
        server.await.unwrap();
    }
}

/// Point every provider home at `root` (and keep a real provider from
/// starting) for the rest of the test, through the crate-wide `TestEnv`.
fn isolate_snapshot_env(env: &mut crate::test_env_lock::TestEnv, root: &Path) {
    env.set("HOME", root.join("empty-home"));
    env.set("CODEX_HOME", root.join("configured-codex"));
    env.set("CLAUDE_CONFIG_DIR", root.join("configured-claude"));
    env.remove("CLAUDE_HOME");
    env.set("XDG_DATA_HOME", root.join("configured-xdg"));
    env.set("CODEX_CMD", "/never-start-a-provider-for-saved-history");
}

fn snapshot_outage_proxy(socket: &Path) -> Arc<HostedFreshAgentProxy> {
    Arc::new(HostedFreshAgentProxy {
        client: RuntimeClient::new(socket, "0123456789abcdef"),
        broadcast: Arc::new(broadcast::channel(16).0),
        aliases: Mutex::new(HashMap::new()),
        presentation_routes: Mutex::new(HashMap::new()),
        pollers: Mutex::new(HashSet::new()),
        fixture_modes: HashSet::new(),
        naming: OnceLock::new(),
        checkpoint_barrier: OnceLock::new(),
        ownership: OnceLock::new(),
    })
}

async fn snapshot_route_value(
    app: &axum::Router,
    session_type: &str,
    provider: &str,
    native: &str,
) -> (axum::http::StatusCode, serde_json::Value) {
    use tower::ServiceExt;
    let reply = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri(format!(
                    "/api/fresh-agent/threads/{session_type}/{provider}/{native}"
                ))
                .header("x-auth-token", "tok")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = reply.status();
    let bytes = axum::body::to_bytes(reply.into_body(), 32 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn real_gateway_pre_native_opencode_projects_only_current_empty_owned_registration() {
    use freshell_freshagent::rest_lane::RestLaneSnapshot;
    for scenario in [
        "empty",
        "nonempty",
        "wrong-provider",
        "materialized",
        "owner-changed",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("owned.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let mut server = tokio::spawn(async move {
            let mut inventories = 0;
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                let result = match request.body {
                    AdminCommand::Health => AdminResult::Health {
                        control_epoch: 7,
                        installation_id: InstallationId::new(),
                    },
                    AdminCommand::Inventory => {
                        inventories += 1;
                        AdminResult::Inventory(vec![serde_json::from_value(serde_json::json!({
                            "soulId":"owned-soul", "incarnationId":if scenario == "owner-changed" && inventories == 2 {"new-owner"} else {"owned-owner"},
                            "launchState":"running", "cleanupState":"none", "intentRevision":1, "executionGeneration":1,
                            "desiredState":"running", "recoveryState":"live", "durabilityState":"unknown", "allocationState":"allocated",
                            "evidenceRevision":0, "successfulRecoveriesInWindow":0, "provider":"opencode", "freshAgentSessionId":"managed-opencode-public",
                            "nativeSessionId":if scenario == "materialized" && inventories == 2 {Some("ses_new")} else {None}
                        })).unwrap()])
                    }
                    AdminCommand::FreshAgentReadSnapshot(read) => {
                        assert_eq!(read.soul_id.as_str(), "owned-soul");
                        AdminResult::FreshAgentSnapshot(
                            serde_json::json!({"threadId":"freshopencode-host-registered", "provider":if scenario == "wrong-provider" {"codex"} else {"opencode"},
                            "sessionType":"freshopencode", "status":"idle", "turns":if scenario == "nonempty" {serde_json::json!([{"turnId":"native"}])} else {serde_json::json!([])},
                            "capabilities":{"send":true,"interrupt":false,"approvals":false,"questions":false,"fork":false}, "extensions":{"opencode":{"statusFromLiveState":true}}}),
                        )
                    }
                    other => panic!("unexpected zero-turn read {other:?}"),
                };
                write_frame(
                    &mut stream,
                    &AdminReply {
                        request_id: request.request_id,
                        result: Ok(result),
                    },
                )
                .await
                .unwrap();
                if inventories == 2 {
                    break;
                }
            }
        });
        let proxy = snapshot_outage_proxy(&socket);
        let result = proxy
            .snapshot(RestLaneSnapshot {
                session_id: "managed-opencode-public".into(),
                provider: "opencode".into(),
                session_type: "freshopencode".into(),
            })
            .await;
        let joined = tokio::time::timeout(Duration::from_secs(1), &mut server).await;
        if joined.is_err() {
            server.abort();
            let _ = server.await;
        }
        joined
            .expect("owned socket fixture must finish")
            .expect("owned socket fixture protocol must succeed");
        assert_eq!(result.is_ok(), scenario == "empty", "{scenario}");
        if let Ok(Some(snapshot)) = result {
            assert_eq!(snapshot["threadId"], "managed-opencode-public");
            assert_eq!(snapshot["capabilities"]["send"], true);
        }
    }
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Global HOME lock spans set/use/restore.
async fn real_gateway_managed_snapshot_failure_reads_owned_history_and_refuses_wrong_local_store() {
    let mut env = crate::test_env_lock::TestEnv::lock().await;
    let dir = tempfile::tempdir().unwrap();
    isolate_snapshot_env(&mut env, dir.path());
    let local_path = dir
        .path()
        .join("configured-codex/sessions/rollout-session-activity.jsonl");
    std::fs::create_dir_all(local_path.parent().unwrap()).unwrap();
    std::fs::write(
        &local_path,
        include_str!("../../../test/fixtures/coding-cli/codex/task-events.sanitized.jsonl"),
    )
    .unwrap();
    let local_opencode_path = dir.path().join("configured-xdg/opencode/opencode.db");
    std::fs::create_dir_all(local_opencode_path.parent().unwrap()).unwrap();
    let db = rusqlite::Connection::open(&local_opencode_path).unwrap();
    db.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT); INSERT INTO session VALUES('ses_owned','Wrong local',2);").unwrap();
    db.execute("INSERT INTO message VALUES('wrong-message','ses_owned',1,?1)", [serde_json::json!({"id":"wrong-message","role":"assistant","time":{"created":1,"completed":2}}).to_string()]).unwrap();
    db.execute("INSERT INTO part VALUES('wrong-part','ses_owned','wrong-message',1,?1)", [serde_json::json!({"id":"wrong-part","type":"text","text":"Wrong local OpenCode source"}).to_string()]).unwrap();
    drop(db);
    let local_before = std::fs::read(&local_path).unwrap();
    let opencode_before = std::fs::read(&local_opencode_path).unwrap();
    for (provider, session_type, native, history_available) in [
        ("codex", "freshcodex", "session-activity", true),
        ("codex", "freshcodex", "session-activity", false),
        ("opencode", "freshopencode", "ses_owned", true),
        ("opencode", "freshopencode", "ses_owned", false),
    ] {
        let socket = dir
            .path()
            .join(format!("owned-{provider}-{history_available}.sock"));
        let listener = UnixListener::bind(&socket).unwrap();
        let mut server = tokio::spawn(async move {
            let mut read_history = false;
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                let mut done = false;
                let result = match request.body {
                    AdminCommand::Health => Ok(AdminResult::Health {
                        control_epoch: 7,
                        installation_id: InstallationId::new(),
                    }),
                    AdminCommand::Inventory => {
                        done = read_history;
                        Ok(AdminResult::Inventory(vec![serde_json::from_value(serde_json::json!({
                        "soulId":"owned-soul", "incarnationId":"owned-incarnation", "launchState":"running", "cleanupState":"none",
                        "intentRevision":1, "executionGeneration":1, "desiredState":"running", "recoveryState":"live",
                        "durabilityState":"unknown", "allocationState":"allocated", "evidenceRevision":0, "successfulRecoveriesInWindow":0,
                        "provider":provider, "nativeSessionId":native, "freshAgentSessionId":"managed-public",
                        "freshAgentSessionType":session_type
                    })).unwrap()]))
                    }
                    AdminCommand::FreshAgentReadSnapshot(read) => {
                        assert_eq!(read.soul_id.as_str(), "owned-soul");
                        Err(freshell_runtime_protocol::RuntimeError::new(
                            RuntimeErrorCode::HostUnreachable,
                            "hosted fresh-agent command failed",
                        ))
                    }
                    AdminCommand::FreshAgentReadHistory(read) => {
                        assert_eq!(read.soul_id.as_str(), "owned-soul");
                        read_history = true;
                        done = !history_available;
                        if history_available {
                            Ok(AdminResult::FreshAgentHistory(serde_json::json!({
                                "threadId":native, "provider":provider, "sessionType":session_type, "status":"idle",
                                "turns":[{"turnId":"owned-volume-answer"}], "capabilities":{"send":false},
                                "extensions":{(provider):{"ownerKind":"vacant", "nativeHistoryAvailable":true}}
                            })))
                        } else {
                            Err(freshell_runtime_protocol::RuntimeError::new(
                                RuntimeErrorCode::HostUnreachable,
                                "owned history unavailable",
                            ))
                        }
                    }
                    other => panic!("unexpected read {other:?}"),
                };
                write_frame(
                    &mut stream,
                    &AdminReply {
                        request_id: request.request_id,
                        result,
                    },
                )
                .await
                .unwrap();
                if done {
                    break;
                }
            }
        });
        let (broadcast, _) = broadcast::channel(16);
        let broadcast = Arc::new(broadcast);
        let owner =
            freshell_freshagent::FreshAgentState::new(Arc::new("tok".into()), broadcast.clone());
        owner
            .set_hosted_rest_gateway(snapshot_outage_proxy(&socket))
            .unwrap();
        let app = freshell_freshagent::snapshot::router(
            freshell_freshagent::snapshot::SnapshotState::new(
                Arc::new("tok".into()),
                freshell_freshagent::FreshCodexState::new(
                    Arc::new("tok".into()),
                    broadcast.clone(),
                    serde_json::json!({}),
                ),
                owner,
                freshell_freshagent::FreshClaudeState::new(broadcast),
            ),
        );
        let (status, value) = snapshot_route_value(&app, session_type, provider, native).await;
        // Join only the owned fixture; old behavior never requests history.
        let joined = tokio::time::timeout(Duration::from_millis(500), &mut server).await;
        if joined.is_err() {
            server.abort();
            let _ = server.await;
        }
        joined
            .expect("gateway must request history from the same owned soul")
            .expect("owned history fixture protocol must succeed");
        assert_eq!(
            status,
            if history_available {
                axum::http::StatusCode::OK
            } else {
                axum::http::StatusCode::SERVICE_UNAVAILABLE
            }
        );
        if history_available {
            assert_eq!(value["turns"][0]["turnId"], "owned-volume-answer");
            assert_eq!(value["threadId"], native);
            assert_eq!(value["provider"], provider);
            assert_eq!(value["sessionType"], session_type);
            assert_eq!(value["extensions"][provider]["ownerKind"], "vacant");
            assert_eq!(
                value["extensions"][provider]["nativeHistoryAvailable"],
                true
            );
            assert_eq!(value["extensions"][provider]["statusFromLiveState"], false);
            assert_eq!(value["capabilities"]["send"], false);
            assert!(!value.to_string().contains("Wrong local OpenCode source"));
        }
    }
    assert_eq!(std::fs::read(&local_path).unwrap(), local_before);
    assert_eq!(
        std::fs::read(&local_opencode_path).unwrap(),
        opencode_before
    );
    let proxy = snapshot_outage_proxy(&dir.path().join("absent-supervisor.sock"));
    proxy.aliases.lock().await.insert(
        ("codex".into(), "session-activity".into()),
        SoulId::parse("owned-soul").unwrap(),
    );
    let (broadcast, _) = broadcast::channel(16);
    let broadcast = Arc::new(broadcast);
    let owner =
        freshell_freshagent::FreshAgentState::new(Arc::new("tok".into()), broadcast.clone());
    owner.set_hosted_rest_gateway(proxy).unwrap();
    let app =
        freshell_freshagent::snapshot::router(freshell_freshagent::snapshot::SnapshotState::new(
            Arc::new("tok".into()),
            freshell_freshagent::FreshCodexState::new(
                Arc::new("tok".into()),
                broadcast.clone(),
                serde_json::json!({}),
            ),
            owner,
            freshell_freshagent::FreshClaudeState::new(broadcast),
        ));
    assert_eq!(
        snapshot_route_value(&app, "freshcodex", "codex", "session-activity")
            .await
            .0,
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Global HOME lock spans set/use/restore.
async fn real_gateway_outage_preserves_exact_cold_native_history_without_live_authority() {
    let mut env = crate::test_env_lock::TestEnv::lock().await;
    let dir = tempfile::tempdir().unwrap();
    isolate_snapshot_env(&mut env, dir.path());
    let socket = dir.path().join("owned-supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    drop(listener);
    std::fs::remove_file(&socket).unwrap(); // Only this fixture's socket becomes unavailable.
    let codex_path = dir
        .path()
        .join("configured-codex/sessions/rollout-session-activity.jsonl");
    let claude_path = dir
        .path()
        .join("configured-claude/projects/fixture/44444444-4444-4444-8444-444444444444.jsonl");
    let db_path = dir.path().join("configured-xdg/opencode/opencode.db");
    for path in [&codex_path, &claude_path, &db_path] {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    }
    std::fs::write(
        &codex_path,
        include_str!("../../../test/fixtures/coding-cli/codex/task-events.sanitized.jsonl"),
    )
    .unwrap();
    std::fs::write(
        &claude_path,
        include_str!("../../../test/fixtures/managed-native-history/claude.jsonl"),
    )
    .unwrap();
    let db = rusqlite::Connection::open(&db_path).unwrap();
    db.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT); INSERT INTO session VALUES('ses_saved','Saved',2);").unwrap();
    db.execute("INSERT INTO message VALUES('message-one','ses_saved',1,?1)", [serde_json::json!({"id":"message-one","role":"assistant","time":{"created":1,"completed":2}}).to_string()]).unwrap();
    db.execute("INSERT INTO part VALUES('part-one','ses_saved','message-one',1,?1)", [serde_json::json!({"id":"part-one","type":"text","text":"Saved native OpenCode answer"}).to_string()]).unwrap();
    drop(db);
    let paths = [&codex_path, &claude_path, &db_path];
    let before: Vec<_> = paths
        .iter()
        .map(|path| {
            (
                std::fs::read(path).unwrap(),
                std::fs::metadata(path).unwrap().modified().unwrap(),
            )
        })
        .collect();
    let broadcast = Arc::new(broadcast::channel(64).0);
    let codex = freshell_freshagent::FreshCodexState::new(
        Arc::new("tok".into()),
        broadcast.clone(),
        serde_json::json!({}),
    );
    let claude = freshell_freshagent::FreshClaudeState::new(broadcast.clone());
    let opencode = freshell_freshagent::FreshAgentState::new(Arc::new("tok".into()), broadcast);
    let proxy = snapshot_outage_proxy(&socket);
    opencode.set_hosted_rest_gateway(proxy.clone()).unwrap();
    let app =
        freshell_freshagent::snapshot::router(freshell_freshagent::snapshot::SnapshotState::new(
            Arc::new("tok".into()),
            codex.clone(),
            opencode,
            claude.clone(),
        ));
    for (kind, provider, native, text) in [
        (
            "freshcodex",
            "codex",
            "session-activity",
            "Sanitized completion",
        ),
        (
            "freshclaude",
            "claude",
            "44444444-4444-4444-8444-444444444444",
            "Saved native Claude answer",
        ),
        (
            "kilroy",
            "claude",
            "44444444-4444-4444-8444-444444444444",
            "Saved native Claude answer",
        ),
        (
            "freshopencode",
            "opencode",
            "ses_saved",
            "Saved native OpenCode answer",
        ),
    ] {
        let (status, value) = snapshot_route_value(&app, kind, provider, native).await;
        assert_eq!(status, axum::http::StatusCode::OK, "{kind}: {value}");
        assert_eq!(value["threadId"], native);
        assert_eq!(value["sessionType"], kind);
        assert_eq!(value["provider"], provider);
        assert!(
            value["turns"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|turn| turn["items"].as_array().unwrap())
                .any(|item| item["text"] == text),
            "{kind}: {value}"
        );
        assert_eq!(
            value["extensions"][provider]["nativeHistoryAvailable"],
            true
        );
        assert_ne!(value["extensions"][provider]["statusFromLiveState"], true);
        assert!(value["capabilities"]
            .as_object()
            .unwrap()
            .values()
            .filter(|v| v.is_boolean())
            .all(|v| v == false));
    }
    for (kind, provider, id) in [
        ("freshcodex", "codex", "managed-freshcodex-unresolved"),
        ("freshcodex", "codex", "foreign-session"),
        ("freshclaude", "claude", "missing-native"),
        ("freshopencode", "opencode", "ses_missing"),
    ] {
        assert_eq!(
            snapshot_route_value(&app, kind, provider, id).await.0,
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "{kind}/{id} must have unavailable exact native source"
        );
    }
    // Exact-looking names cannot substitute for a readable, matching native source.
    let wrong_codex = codex_path.with_file_name("rollout-wrong-native.jsonl");
    std::fs::write(&wrong_codex, std::fs::read(&codex_path).unwrap()).unwrap();
    let unreadable_claude =
        claude_path.with_file_name("55555555-5555-4555-8555-555555555555.jsonl");
    std::fs::write(&unreadable_claude, [0xff, 0xfe, b'\n']).unwrap();
    for (kind, provider, id) in [
        ("freshcodex", "codex", "wrong-native"),
        (
            "freshclaude",
            "claude",
            "55555555-5555-4555-8555-555555555555",
        ),
    ] {
        let (status, value) = snapshot_route_value(&app, kind, provider, id).await;
        assert_eq!(
            status,
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "unreadable {kind}/{id} must not become available saved history: {value}"
        );
    }
    for (path, (bytes, modified)) in paths.iter().zip(before) {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert_eq!(
            std::fs::metadata(path).unwrap().modified().unwrap(),
            modified
        );
    }
    std::fs::write(&db_path, b"not a SQLite database").unwrap();
    assert_eq!(
        snapshot_route_value(&app, "freshopencode", "opencode", "ses_saved")
            .await
            .0,
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(std::fs::read(&db_path).unwrap(), b"not a SQLite database");
    assert!(!codex.has_live_session("session-activity").await);
    assert!(
        !claude
            .has_live_session("44444444-4444-4444-8444-444444444444")
            .await
    );
    assert!(proxy.pollers.lock().await.is_empty());
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Global HOME lock spans set/use/restore.
async fn real_gateway_outage_keeps_a_registered_local_provider_snapshot_live() {
    let mut env = crate::test_env_lock::TestEnv::lock().await;
    let dir = tempfile::tempdir().unwrap();
    isolate_snapshot_env(&mut env, dir.path());
    env.set(
        "CODEX_CMD",
        format!(
            "node {}/../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs",
            env!("CARGO_MANIFEST_DIR")
        ),
    );
    env.set(
        "FAKE_CODEX_APP_SERVER_BEHAVIOR",
        r#"{"threadStartThreadId":"local-owned-thread"}"#,
    );
    env.set("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");
    let (tx, mut rx) = broadcast::channel(64);
    let broadcast = Arc::new(tx);
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let mut codex = freshell_freshagent::FreshCodexState::new(
        Arc::new("tok".into()),
        broadcast.clone(),
        serde_json::json!({"freshAgent":{"enabled":true}}),
    );
    codex.set_ownership(ownership.clone());
    codex.handle_create(serde_json::from_value(serde_json::json!({"requestId":"local-provider-start","sessionType":"freshcodex","provider":"codex"})).unwrap(), None).await;
    let created: serde_json::Value = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let frame: serde_json::Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
            if frame["type"] == "freshAgent.created" || frame["type"] == "freshAgent.create.failed"
            {
                break frame;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(created["type"], "freshAgent.created", "{created}");
    let native = created["sessionId"].as_str().unwrap();
    let saved_path = dir
        .path()
        .join("configured-codex/sessions")
        .join(format!("rollout-{native}.jsonl"));
    std::fs::create_dir_all(saved_path.parent().unwrap()).unwrap();
    let saved = include_str!("../../../test/fixtures/coding-cli/codex/task-events.sanitized.jsonl")
        .replace("session-activity", native);
    std::fs::write(&saved_path, &saved).unwrap();
    let before = ownership.observe("codex", native);
    let socket = dir.path().join("owned-supervisor.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    drop(listener);
    std::fs::remove_file(&socket).unwrap();
    let opencode =
        freshell_freshagent::FreshAgentState::new(Arc::new("tok".into()), broadcast.clone());
    opencode
        .set_hosted_rest_gateway(snapshot_outage_proxy(&socket))
        .unwrap();
    let app =
        freshell_freshagent::snapshot::router(freshell_freshagent::snapshot::SnapshotState::new(
            Arc::new("tok".into()),
            codex.clone(),
            opencode,
            freshell_freshagent::FreshClaudeState::new(broadcast),
        ));
    let (status, value) = snapshot_route_value(&app, "freshcodex", "codex", native).await;
    let after = ownership.observe("codex", native);
    // Park the real read after its local runtime capture, then change ownership.
    let reached = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    codex.set_snapshot_pause_after_capture_for_tests(Arc::new({
        let reached = reached.clone();
        let release = release.clone();
        move |_| {
            let reached = reached.clone();
            let release = release.clone();
            Box::pin(async move {
                reached.notify_one();
                release.notified().await;
            })
        }
    }));
    let held = tokio::spawn({
        let app = app.clone();
        let native = native.to_owned();
        async move { snapshot_route_value(&app, "freshcodex", "codex", &native).await }
    });
    tokio::time::timeout(Duration::from_secs(10), reached.notified())
        .await
        .unwrap();
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_handoff(
        "codex",
        native,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        "snapshot-outage-handoff",
        None,
        "test",
        freshell_ownership::now_epoch_ms(),
    ) else {
        panic!("expected owned handoff")
    };
    release.notify_one();
    let (held_status, held_value) = tokio::time::timeout(Duration::from_secs(10), held)
        .await
        .unwrap()
        .unwrap();
    codex.clear_snapshot_pause_after_capture_for_tests();
    // The captured runtime is still registered but its retained generation is stale.
    ownership.fail(
        "codex",
        native,
        "snapshot-outage-handoff",
        generation,
        false,
    );
    let (stale_status, stale_value) =
        snapshot_route_value(&app, "freshcodex", "codex", native).await;
    // Always join teardown of the one provider this fixture created, including RED.
    codex.handle_kill(serde_json::from_value(serde_json::json!({"sessionId":native,"sessionType":"freshcodex","provider":"codex"})).unwrap()).await;
    assert!(!codex.has_live_session(native).await);
    assert_eq!(std::fs::read_to_string(&saved_path).unwrap(), saved);
    assert_eq!(status, axum::http::StatusCode::OK, "{value}");
    assert_eq!(before, after);
    assert_eq!(value["threadId"], native);
    assert_eq!(value["capabilities"]["send"], true);
    assert_ne!(value["extensions"]["codex"]["nativeHistoryAvailable"], true);
    assert!(
        value["turns"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|turn| turn["items"].as_array().unwrap())
            .any(|item| item["text"] == "Fixture turn"),
        "{value}"
    );
    // A provider's typed handoff refusal stays authoritative even when saved history exists.
    assert_eq!(
        held_status,
        axum::http::StatusCode::CONFLICT,
        "{held_value}"
    );
    assert_eq!(held_value["code"], "RESTORE_UNAVAILABLE");
    assert_eq!(held_value["ownerGeneration"], generation);
    assert!(held_value.get("ownerKind").is_none());
    assert!(held_value.get("turns").is_none());
    assert!(held_value.get("capabilities").is_none());
    // An unconfirmed runtime without a provider refusal still reads only saved history.
    assert_eq!(stale_status, axum::http::StatusCode::OK, "{stale_value}");
    assert_eq!(stale_value["threadId"], native);
    assert_eq!(
        stale_value["extensions"]["codex"]["nativeHistoryAvailable"],
        true
    );
    assert_ne!(
        stale_value["extensions"]["codex"]["statusFromLiveState"],
        true
    );
    assert_eq!(stale_value["capabilities"]["send"], false);
}

/// The real supervisor never creates or stops a runtime for a configure.
struct ConfigureOnlyBackend;

#[async_trait::async_trait]
impl freshell_supervisor::backend::RuntimeBackend for ConfigureOnlyBackend {
    async fn create_stopped(
        &self,
        _: &freshell_supervisor::backend::CreateRuntimeSpec,
    ) -> Result<
        freshell_supervisor::backend::BackendCreated,
        freshell_supervisor::backend::BackendError,
    > {
        unreachable!("configure must not create a runtime")
    }
    async fn start_host(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
    ) -> Result<(), freshell_supervisor::backend::BackendError> {
        unreachable!("configure must not start a host")
    }
    async fn inspect(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
    ) -> Result<
        freshell_supervisor::backend::BackendInspection,
        freshell_supervisor::backend::BackendError,
    > {
        unreachable!("configure must not inspect the runtime")
    }
    async fn request_stop(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
        _: u64,
    ) -> Result<(), freshell_supervisor::backend::BackendError> {
        unreachable!("configure must not stop the runtime")
    }
    async fn force_stop(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
    ) -> Result<(), freshell_supervisor::backend::BackendError> {
        unreachable!("configure must not stop the runtime")
    }
    async fn verify_empty(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
    ) -> Result<bool, freshell_supervisor::backend::BackendError> {
        unreachable!("configure must not verify the runtime")
    }
    async fn list_known(
        &self,
        _: &[freshell_supervisor::registry::OwnedRuntimeHandle],
    ) -> Result<
        Vec<(
            freshell_runtime_protocol::IncarnationId,
            freshell_supervisor::backend::BackendInspection,
        )>,
        freshell_supervisor::backend::BackendError,
    > {
        unreachable!("configure must not list runtimes")
    }
    async fn read_limits(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
    ) -> Result<RuntimeLimits, freshell_supervisor::backend::BackendError> {
        unreachable!("configure must not read limits")
    }
    async fn enable_long_lived(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
    ) -> Result<(), freshell_supervisor::backend::BackendError> {
        unreachable!("configure must not change the runtime")
    }
}

#[tokio::test]
async fn hosted_configure_reaches_the_owning_host_through_the_real_supervisor() {
    use freshell_runtime_protocol::{HostCommand, HostReply, HostResult};
    let root = tempfile::tempdir().unwrap();
    let workspace = std::fs::canonicalize(root.path()).unwrap();
    let limits = RuntimeLimits {
        cpu_milli: 500,
        memory_bytes: 64 * 1024 * 1024,
        swap_bytes: 0,
        pids_max: 32,
    };
    let registry =
        freshell_supervisor::registry::Registry::open(root.path().join("registry"), None).unwrap();
    let soul = SoulId::new();
    let fresh_agent: freshell_runtime_protocol::FreshAgentLaunchSpec =
        serde_json::from_value(serde_json::json!({
            "sessionId":"public-1", "provider":"claude", "sessionType":"freshclaude",
            "runtimeVariant":"claude-agent-sdk", "providerStoreId":"store-configure",
            "cwd":workspace, "workspacePath":workspace, "runAsUid":65534, "runAsGid":0,
            "model":"sonnet", "effort":"low", "permissionMode":"default"
        }))
        .unwrap();
    let prepared = registry
        .prepare_launch(freshell_supervisor::registry::LaunchPreparation {
            soul_id: soul.clone(),
            provider: "claude".into(),
            provider_store_id: "store-configure".into(),
            native_session_id: None,
            creation_seed_ref: "seed-configure".into(),
            request_id: RequestId::new(),
            payload_digest: "payload-configure".into(),
            requested_limits: limits,
            profile: RuntimeProfile::Custom,
            project_key: "workspace".into(),
            fixture: None,
            terminal: None,
            fresh_agent: Some(fresh_agent),
            view_intent: None,
            admission: freshell_supervisor::admission::AdmissionPolicy::default(),
        })
        .await
        .unwrap();
    let runtime_dir = root.path().join("runtime");
    std::fs::create_dir_all(&runtime_dir).unwrap();
    registry
        .commit_created(
            prepared.incarnation_id.clone(),
            freshell_supervisor::registry::BackendCreatedRecord {
                launch_policy: None,
                daemon_id: freshell_runtime_protocol::DockerDaemonId::new(),
                container_id: "a".repeat(64),
                image_ref: format!("sha256:{}", "b".repeat(64)),
                runtime_dir: runtime_dir.clone(),
                host_binary_path: std::env::current_exe().unwrap(),
                immutable_config_digest: format!("sha256:{}", "c".repeat(64)),
            },
        )
        .await
        .unwrap();
    let grant = registry
        .commit_execution_grant(
            prepared.incarnation_id.clone(),
            freshell_runtime_protocol::HostBootId::new(),
            limits,
        )
        .await
        .unwrap();
    let current = registry.recovery_context(soul.clone()).await.unwrap();
    let launch = registry
        .bind_native_identity_launch(freshell_runtime_protocol::NativeIdentityLaunch {
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: prepared.launch_nonce.as_str().into(),
            evidence_revision: current.evidence_revision,
            execution_generation: grant.execution_generation,
            requested_native_session_id: Some("native-claude".into()),
        })
        .await
        .unwrap();
    registry
        .record_native_session(
            soul.clone(),
            prepared.incarnation_id.clone(),
            "native-claude".into(),
        )
        .await
        .unwrap();
    let current = registry.recovery_context(soul.clone()).await.unwrap();
    registry
        .record_native_identity_observation(
            soul.clone(),
            freshell_runtime_protocol::NativeIdentityObservation {
                native_session_id: "native-claude".into(),
                incarnation_id: prepared.incarnation_id.clone(),
                launch_nonce: launch.launch_nonce.clone(),
                evidence_revision: launch.evidence_revision,
                source: freshell_runtime_protocol::NativeIdentitySource::FreshProviderHandshake,
                evidence_digest: "a".repeat(64),
            },
            current.write_fence(),
        )
        .await
        .unwrap();
    registry
        .mark_running(prepared.incarnation_id.clone())
        .await
        .unwrap();

    // The owning session host: authenticates, then records the configure.
    let host_secret = b"configure-host-secret";
    std::fs::write(runtime_dir.join("secret"), host_secret).unwrap();
    let host_listener = UnixListener::bind(runtime_dir.join("host.sock")).unwrap();
    let host_commands = Arc::new(std::sync::Mutex::new(Vec::<HostCommand>::new()));
    let host_log = Arc::clone(&host_commands);
    let host = tokio::spawn(async move {
        let boot = freshell_runtime_protocol::HostBootId::new();
        loop {
            let Ok((mut stream, _)) = host_listener.accept().await else {
                return;
            };
            let envelope: Envelope<HostCommand> = read_frame(&mut stream).await.unwrap();
            host_log.lock().unwrap().push(envelope.body.clone());
            let result = match envelope.body {
                HostCommand::Hello {
                    incarnation_id,
                    challenge,
                } => HostResult::Hello {
                    host_boot_id: boot.clone(),
                    proof: freshell_runtime_protocol::host_proof(
                        host_secret,
                        &challenge,
                        &boot,
                        &incarnation_id,
                    ),
                    capabilities: vec![],
                    effective_limits: limits,
                },
                HostCommand::FreshAgentConfigure { .. } => HostResult::FreshAgentCommand {
                    native_identity: None,
                    claude_fork: None,
                    state: freshell_runtime_protocol::CommandState::ProviderAcked,
                    native_session_id: None,
                },
                other => panic!("configure sent an unexpected host command {other:?}"),
            };
            write_frame(
                &mut stream,
                &HostReply {
                    request_id: envelope.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
    });

    let control_socket = root.path().join("control.sock");
    let supervisor = freshell_supervisor::service::Supervisor::new(
        registry.clone(),
        Arc::new(ConfigureOnlyBackend),
        freshell_supervisor::service::SupervisorConfig {
            runtime_root: root.path().into(),
            control_socket_path: control_socket.clone(),
            host_binary_path: std::env::current_exe().unwrap(),
            image_ref: format!("sha256:{}", "b".repeat(64)),
            test_run_id: "hosted-configure".into(),
            control_secret: "0123456789abcdef".into(),
            lifecycle_log: root.path().join("lifecycle.jsonl"),
            admission: freshell_supervisor::admission::AdmissionPolicy::default(),
        },
    )
    .unwrap();
    let served_socket = control_socket.clone();
    let control = tokio::spawn(async move {
        freshell_supervisor::service::serve_control(supervisor, &served_socket)
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while !control_socket.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();

    let (proxy, mut receiver) = configure_proxy(
        &control_socket,
        HashMap::from([(("claude".into(), "public-1".into()), soul.clone())]),
    );
    proxy
        .handle(HostedFreshAgentCommand::Configure(
            serde_json::from_value(serde_json::json!({
                "provider":"claude","sessionId":"public-1","sessionType":"freshclaude",
                "cwd":workspace,"requestId":"configure-through-supervisor",
                "settings":{"model":"opus","effort":"high"}
            }))
            .unwrap(),
        ))
        .await;
    host.abort();
    control.abort();

    assert!(
        receiver.try_recv().is_err(),
        "an accepted hosted configure answers no error"
    );
    let configures: Vec<HostCommand> = host_commands
        .lock()
        .unwrap()
        .iter()
        .filter(|command| matches!(command, HostCommand::FreshAgentConfigure { .. }))
        .cloned()
        .collect();
    assert_eq!(configures.len(), 1, "the owning host applies it once");
    let HostCommand::FreshAgentConfigure {
        incarnation_id,
        request_id,
        settings,
    } = &configures[0]
    else {
        unreachable!()
    };
    assert_eq!(incarnation_id, &prepared.incarnation_id);
    assert_eq!(request_id.as_str(), "configure-through-supervisor");
    assert_eq!(settings.model.as_deref(), Some("opus"));
    assert_eq!(settings.effort, Some(Some("high".into())));
    let recovered = registry
        .recovery_context(soul)
        .await
        .unwrap()
        .fresh_agent
        .expect("fresh-agent recovery spec");
    assert_eq!(recovered.model.as_deref(), Some("opus"));
    assert_eq!(recovered.effort.as_deref(), Some("high"));
    assert_eq!(recovered.permission_mode.as_deref(), Some("default"));
}

#[tokio::test]
async fn task5_hosted_elicitation_for_other_providers_is_explicitly_unsupported() {
    let dir = tempfile::tempdir().unwrap();
    let (proxy, mut receiver) = configure_proxy(
        &dir.path().join("absent-host.sock"),
        HashMap::from([(
            ("claude".into(), "claude-thread".into()),
            SoulId::parse("claude-soul").unwrap(),
        )]),
    );
    proxy.handle(HostedFreshAgentCommand::Elicitation(serde_json::from_value(serde_json::json!({"provider":"claude","sessionType":"freshclaude","sessionId":"claude-thread","requestId":"41","action":"decline","content":null})).unwrap())).await;
    let frame: serde_json::Value = serde_json::from_str(&receiver.try_recv().unwrap()).unwrap();
    assert_eq!(frame["event"]["code"], "UNSUPPORTED_CAPABILITY");
    assert!(frame["event"]["message"]
        .as_str()
        .unwrap()
        .contains("elicitation"));
}

#[tokio::test]
async fn task5_hosted_elicitation_reuses_resolve_with_tagged_typed_content_and_opaque_ids() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("elicitation.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let server = tokio::spawn(async move {
        let mut ids = Vec::new();
        while ids.len() < 2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            let result = match request.body {
                AdminCommand::Health => AdminResult::Health {
                    control_epoch: 77,
                    installation_id: InstallationId::new(),
                },
                AdminCommand::FreshAgentResolve(resolve) => {
                    assert_eq!(resolve.soul_id.as_str(), "codex-soul");
                    assert_eq!(resolve.expected_control_epoch, Some(77));
                    assert_eq!(
                        resolve.decision,
                        serde_json::json!({"elicitation":{"action":"accept","content":{"count":3,"enabled":false}}})
                    );
                    ids.push(resolve.decision_id);
                    AdminResult::FreshAgentCommand {
                        state: freshell_runtime_protocol::CommandState::ProviderAcked,
                    }
                }
                other => panic!("unexpected control opcode: {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: request.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
        ids
    });
    let (proxy, mut receiver) = configure_proxy(
        &socket,
        HashMap::from([(
            ("codex".into(), "public-thread".into()),
            SoulId::parse("codex-soul").unwrap(),
        )]),
    );
    for id in ["41", "\"41\""] {
        proxy.clone().handle(HostedFreshAgentCommand::Elicitation(serde_json::from_value(serde_json::json!({"provider":"codex","sessionType":"freshcodex","sessionId":"public-thread","requestId":id,"action":"accept","content":{"count":3,"enabled":false}})).unwrap())).await;
    }
    assert_eq!(settled(server).await, vec!["41", "\"41\""]);
    assert!(receiver.try_recv().is_err());
}

async fn task6_gateway_source_scenario(scenario: &'static str) {
    let replaced = scenario != "current" && scenario != "ready-current";
    let ready = scenario.starts_with("ready-");
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("retained-gateway.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let read_started = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let server_read_started = read_started.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            let result = match envelope.body {
                AdminCommand::Health => AdminResult::Health { control_epoch:7, installation_id:InstallationId::new() },
                AdminCommand::Inventory => AdminResult::Inventory(vec![serde_json::from_value(serde_json::json!({
                    "soulId":"retained-soul", "incarnationId":if scenario == "before-incarnation" || matches!(scenario,"after-incarnation" | "ready-after-incarnation") && server_read_started.load(std::sync::atomic::Ordering::SeqCst) {"replacement-incarnation"} else {"original-incarnation"},
                    "hostBootId":if scenario == "after-boot" && server_read_started.load(std::sync::atomic::Ordering::SeqCst) {"replacement-boot"} else {"original-boot"}, "launchState":"running","cleanupState":"none","intentRevision":1,"executionGeneration":1,"desiredState":"running","recoveryState":"live","durabilityState":"unknown","allocationState":"allocated","evidenceRevision":0,"successfulRecoveriesInWindow":0,
                    "provider":"codex","nativeSessionId":if scenario == "before-native" {"replacement-native"} else {"native-owned"},"freshAgentSessionId":"public-owned","freshAgentSessionType":"freshcodex"
                })).unwrap()]),
                AdminCommand::FreshAgentReadEvents(_) => {
                    server_read_started.store(true,std::sync::atomic::Ordering::SeqCst);
                    AdminResult::FreshAgentEvents(serde_json::from_value(serde_json::json!({
                        "retainedFrom":10,"head":10,"resetRequired":true,
                        "retainedState":{"source":{"soulId":"retained-soul","incarnationId":"original-incarnation","hostBootId":"original-boot","projectionId":"source-projection","ownerEpoch":0,"ownerGeneration":0},
                        "snapshot":{"provider":"codex","sessionType":"freshcodex","threadId":"native-owned","turns":[{"text":"Latest retained body"}]},
                        "attentionMarks":[{"provider":"codex","sessionType":"freshcodex","sessionId":"native-owned","lastTurnCompleteAt":100}],"pendingControls":[]},
                        "events":if replaced {serde_json::json!([{"sequence":10,"event":{"kind":"provider","data":{"payload":{"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-owned","event":{"type":"freshAgent.notice","message":"stale native source"}}}}}])} else {serde_json::json!([])}
                    })).unwrap())
                }
                other => panic!("recovery must read retained source, never native history or resume: {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: envelope.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
    });
    let proxy = snapshot_outage_proxy(&socket);
    if ready {
        let marks = proxy.attention_marks().await;
        server.abort();
        let _ = server.await;
        if replaced {
            assert!(marks.is_empty(), "ready must reject a replaced source");
        } else {
            assert_eq!(marks.len(), 1);
            assert_eq!(marks[0].session_id, "public-owned");
            assert_eq!(marks[0].last_turn_complete_at, Some(100));
        }
        return;
    }
    let mut frames = proxy.broadcast.subscribe();
    proxy
        .start_poller(
            SoulId::parse("retained-soul").unwrap(),
            "codex".into(),
            "public-owned".into(),
            "freshcodex".into(),
            chrono::Utc::now().timestamp_millis(),
        )
        .await;
    let first = tokio::time::timeout(Duration::from_millis(750), async {
        loop {
            let value: serde_json::Value =
                serde_json::from_str(&frames.recv().await.unwrap()).unwrap();
            if value["event"]["type"] != "freshAgent.host.journal.reset" || !replaced {
                break value;
            }
        }
    })
    .await;
    server.abort();
    let _ = server.await;
    assert!(
        read_started.load(std::sync::atomic::Ordering::SeqCst),
        "actual controller event read must run"
    );
    if replaced {
        assert!(
            first.is_err(),
            "a source replaced during the read must not forward its old events: {first:?}"
        );
    } else {
        let first =
            first.expect("journal reset must independently deliver retained provider state");
        assert_eq!(first["sessionId"], "public-owned");
        assert_eq!(
            first["event"]["retainedState"]["snapshot"]["turns"][0]["text"], "Latest retained body",
            "gateway must apply the authoritative retained source immediately: {first}"
        );
    }
}

#[tokio::test]
async fn task6_gateway_applies_authoritative_source_on_journal_reset() {
    task6_gateway_source_scenario("current").await;
}
#[tokio::test]
async fn task6_gateway_rechecks_source_after_controller_read() {
    task6_gateway_source_scenario("after-incarnation").await;
}

#[tokio::test]
async fn task6_gateway_rejects_an_old_source_at_admission() {
    task6_gateway_source_scenario("before-incarnation").await;
}
#[tokio::test]
async fn task6_gateway_rechecks_host_boot_after_controller_read() {
    task6_gateway_source_scenario("after-boot").await;
}
#[tokio::test]
async fn task6_gateway_rejects_mismatched_native_identity() {
    task6_gateway_source_scenario("before-native").await;
}
#[tokio::test]
async fn task6_gateway_ready_uses_current_provider_retained_attention() {
    task6_gateway_source_scenario("ready-current").await;
}
#[tokio::test]
async fn task6_gateway_ready_rejects_a_replaced_provider_source() {
    task6_gateway_source_scenario("ready-after-incarnation").await;
}

async fn task6_gateway_recovery_receipts(
    replay: bool,
    replace_on_continuation: bool,
    replace_native: bool,
) {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("recovery-receipts.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let pages = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let server_pages = pages.clone();
    let receipts = vec![
        serde_json::json!({"type":"freshAgent.send.accepted","provider":"codex","sessionType":"freshcodex","sessionId":"native-owned","requestId":"accepted-answer","submittedTurnId":"native-turn"}),
        serde_json::json!({"type":"freshAgent.send.accepted","provider":"codex","sessionType":"freshcodex","sessionId":"native-owned","requestId":"accepted-ordinary","submittedTurnId":"ordinary-turn"}),
        serde_json::json!({"type":"error","code":"INTERNAL_ERROR","message":"CODEX_TURN_START_FAILED: native input refused","timestamp":"2026-10-26T00:00:00.000Z","requestId":"refused-answer"}),
        serde_json::json!({"type":"error","code":"INTERNAL_ERROR","message":"CODEX_DELIVERY_AMBIGUOUS: native response was lost","timestamp":"2026-10-26T00:00:00.000Z","requestId":"ambiguous-answer"}),
        serde_json::json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-owned","event":{"type":"checkpointTurnIdentity","requestId":"accepted-answer","logicalAttemptId":"logical-owned","sessionId":"native-owned","nativeTurnId":"native-turn","displayTurnId":"native-turn:row-0"}}),
        serde_json::json!({"type":"freshAgent.checkpoint.outcome","provider":"codex","sessionType":"freshcodex","sessionId":"native-owned","requestId":"accepted-answer","logicalAttemptId":"logical-owned","status":"available","checkpointId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","nativeTurnId":"native-turn","displayTurnId":"native-turn:row-0"}),
        serde_json::json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-owned","event":{"type":"freshAgent.rolledBack","requestId":"undo-owned","removedPromptText":"restore the exact prompt"}}),
        serde_json::json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-owned","event":{"type":"freshAgent.error","requestId":"undo-refused","code":"BUSY_TURN","message":"The agent is still working."}}),
    ];
    let expected = receipts.clone();
    let server = tokio::spawn(async move {
        let mut payloads = vec![
            AgentEvent::Provider {
                payload: serde_json::json!({"type":"freshAgent.event","provider":"codex","sessionType":"freshcodex","sessionId":"native-owned","event":{"type":"freshAgent.transcript.patch","text":"stale transcript must not replay"}}),
            },
            AgentEvent::PermissionRequested {
                decision_id: "stale-control".into(),
                payload: serde_json::json!({"type":"freshAgent.question.request","requestId":"stale-control"}),
            },
        ];
        payloads.extend(
            receipts
                .into_iter()
                .map(|payload| AgentEvent::Provider { payload }),
        );
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            let result = match envelope.body {
                AdminCommand::Health => AdminResult::Health {
                    control_epoch: 7,
                    installation_id: InstallationId::new(),
                },
                AdminCommand::Inventory => {
                    let current: freshell_runtime_protocol::RuntimeView = serde_json::from_value(serde_json::json!({
                    "soulId":"retained-soul","incarnationId":if replace_on_continuation && !replace_native && server_pages.load(std::sync::atomic::Ordering::SeqCst)>=2 {"replacement-incarnation"} else {"original-incarnation"},"hostBootId":"original-boot","launchState":"running","cleanupState":"none","intentRevision":1,"executionGeneration":1,"desiredState":"running","recoveryState":"live","durabilityState":"unknown","allocationState":"allocated","evidenceRevision":0,"successfulRecoveriesInWindow":0,"provider":"codex","nativeSessionId":if replace_on_continuation && replace_native && server_pages.load(std::sync::atomic::Ordering::SeqCst)>=2 {"replacement-native"} else {"native-owned"},"freshAgentSessionId":"public-owned","freshAgentSessionType":"freshcodex"
                    })).unwrap();
                    // Real inventory retains stopped historical incarnations
                    // before the current running row for the same soul.
                    let mut retired = current.clone();
                    retired.launch_state = freshell_runtime_protocol::LaunchState::Stopped;
                    retired.incarnation_id =
                        freshell_runtime_protocol::IncarnationId::parse("retired-incarnation")
                            .unwrap();
                    retired.host_boot_id =
                        Some(freshell_runtime_protocol::HostBootId::parse("retired-boot").unwrap());
                    AdminResult::Inventory(vec![retired, current])
                }
                AdminCommand::FreshAgentReadEvents(request) => {
                    server_pages.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    AdminResult::FreshAgentEvents(freshell_runtime_protocol::AgentEventBatch {
                    accepted_native_dispatch:None,native_dispatch_in_flight:false,
                    retained_state:(request.after_sequence==0).then(||serde_json::json!({
                        "source":{"soulId":"retained-soul","incarnationId":"original-incarnation","hostBootId":"original-boot","projectionId":"source-projection","ownerEpoch":0,"ownerGeneration":0},
                        "snapshot":{"provider":"codex","sessionType":"freshcodex","threadId":"native-owned","turns":[]},"attentionMarks":[],
                        "pendingControls":[{"type":"freshAgent.question.request","requestId":"current-control"}]
                    })),
                    retained_from:1,head:payloads.len() as u64,reset_required:request.after_sequence==0,
                    // The controller's own bound can be smaller than the requested
                    // page. Receipts deliberately lie beyond the first page.
                    events:payloads.iter().enumerate().filter(|(index,_)|(*index as u64)+1>request.after_sequence).take(request.max_events.min(2) as usize).map(|(index,event)|freshell_runtime_protocol::AgentJournalEvent {sequence:index as u64+1,event:event.clone()}).collect(),
                })
                }
                other => panic!("recovery must only read events and source identity: {other:?}"),
            };
            write_frame(
                &mut stream,
                &AdminReply {
                    request_id: envelope.request_id,
                    result: Ok(result),
                },
            )
            .await
            .unwrap();
        }
    });
    let proxy = snapshot_outage_proxy(&socket);
    let mut frames = proxy.broadcast.subscribe();
    let soul = SoulId::parse("retained-soul").unwrap();
    if replay {
        proxy
            .replay_once(soul, "codex", "public-owned", "freshcodex")
            .await;
    } else {
        proxy
            .start_poller(
                soul,
                "codex".into(),
                "public-owned".into(),
                "freshcodex".into(),
                chrono::Utc::now().timestamp_millis(),
            )
            .await;
    }
    let mut observed = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while observed.len() < expected.len() + 2 {
        let Ok(Ok(frame)) = tokio::time::timeout_at(deadline, frames.recv()).await else {
            break;
        };
        observed.push(serde_json::from_str::<serde_json::Value>(&frame).unwrap());
    }
    server.abort();
    let _ = server.await;
    assert!(
        pages.load(std::sync::atomic::Ordering::SeqCst) >= 2,
        "the real Unix controller must serve continuation pages"
    );
    assert_eq!(observed.len(),if replace_on_continuation {2} else {expected.len()+2},"retained recovery must deliver every request receipt across bounded pages, only under the current owner: {observed:?}");
    assert_eq!(
        observed[0]["event"]["retainedState"]["snapshot"]["threadId"],
        "native-owned"
    );
    assert_eq!(observed[1]["event"]["requestId"], "current-control");
    for (actual, mut expected) in observed.into_iter().skip(2).zip(expected) {
        rewrite_presentation_id(&mut expected, "public-owned");
        assert_eq!(
            actual, expected,
            "keep exact request/attempt/native IDs and refusal/ambiguity reasons"
        );
    }
}

#[tokio::test]
async fn task6_gateway_poller_preserves_request_receipts_beyond_retained_first_page() {
    task6_gateway_recovery_receipts(false, false, false).await;
}

#[tokio::test]
async fn task6_gateway_replay_preserves_request_receipts_beyond_retained_first_page() {
    task6_gateway_recovery_receipts(true, false, false).await;
}

#[tokio::test]
async fn task6_gateway_poller_fences_receipts_after_source_changes_between_pages() {
    task6_gateway_recovery_receipts(false, true, false).await;
}

#[tokio::test]
async fn task6_gateway_replay_fences_receipts_after_source_changes_between_pages() {
    task6_gateway_recovery_receipts(true, true, false).await;
}

#[tokio::test]
async fn task6_gateway_poller_fences_receipts_after_native_changes_between_pages() {
    task6_gateway_recovery_receipts(false, true, true).await;
}

#[tokio::test]
async fn task6_gateway_replay_fences_receipts_after_native_changes_between_pages() {
    task6_gateway_recovery_receipts(true, true, true).await;
}
#[path = "fresh_agent_proxy_readiness_tests.rs"]
mod readiness_tests;

#[path = "fresh_agent_proxy_materialization_tests.rs"]
mod materialization_tests;
#[path = "fresh_agent_proxy_review_repairs_tests.rs"]
mod review_repairs;

// The provider and host socket below are simulated; the actor, supervisor,
// registry, runtime client, and gateway poller are the production paths.
mod codex_replacement_realpath {
    use super::*;
    use freshell_agent_runtime::host_actor::{
        DispatchAck, DispatchFailure, FreshAgentHostActor, FreshAgentProfile, FreshAgentTransport,
        NativeDispatchIdentity, TransportStart,
    };
    use freshell_runtime_protocol::{
        host_proof, AgentEventBatch, CommandState, DockerDaemonId, HostBootId, HostCommand,
        HostReply, HostResult, IncarnationId, NativeIdentityLaunch, NativeIdentityObservation,
        NativeIdentitySource,
    };
    use freshell_supervisor::{
        admission::AdmissionPolicy,
        backend::{
            BackendCreated, BackendError, BackendInspection, CreateRuntimeSpec, RuntimeBackend,
        },
        registry::{BackendCreatedRecord, LaunchPreparation, OwnedRuntimeHandle, Registry},
        service::{Supervisor, SupervisorConfig},
    };
    use futures_util::FutureExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;
    use tokio::{
        sync::{mpsc, oneshot},
        task::JoinSet,
    };

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum NativeOutcome {
        Accepted,
        Refused,
        Ambiguous,
    }

    struct FakeNative {
        source: mpsc::Sender<AgentEvent>,
        stream: StdMutex<Option<mpsc::Receiver<AgentEvent>>>,
        release: Mutex<Option<oneshot::Receiver<()>>>,
        outcome: NativeOutcome,
        resolutions: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl FreshAgentTransport for FakeNative {
        async fn start(&self, _: &FreshAgentProfile) -> Result<TransportStart, String> {
            Ok(TransportStart {
                native_session_id: Some("native-a".into()),
            })
        }

        async fn dispatch(
            &self,
            request: &RequestId,
            _: &str,
            profile: &FreshAgentProfile,
        ) -> Result<DispatchAck, DispatchFailure> {
            if request.as_str() == "second-replacement-through-supervisor" {
                assert_eq!(profile.native_session_id.as_deref(), Some("native-b"));
                return Ok(DispatchAck {
                    provider_ack_id: Some("second-replacement-turn".into()),
                    native_identity: Some(NativeDispatchIdentity {
                        previous_native_session_id: "native-b".into(),
                        native_session_id: "native-c".into(),
                        pending_naming_handle: None,
                    }),
                });
            }
            assert_eq!(request.as_str(), "replacement-through-supervisor");
            assert_eq!(profile.native_session_id.as_deref(), Some("native-a"));
            // The real bridge converts these three raw provider controls to
            // PermissionRequested before they enter the actor journal.
            for kind in ["permission", "question", "elicitation"] {
                let decision_id = format!("{kind}-b");
                self.source
                    .send(AgentEvent::PermissionRequested {
                        decision_id: decision_id.clone(),
                        payload: serde_json::json!({"type":format!("freshAgent.{kind}.request"),
                        "sessionId":"native-b", "requestId":decision_id}),
                    })
                    .await
                    .map_err(|_| DispatchFailure {
                        message: "actor event stream closed".into(),
                        acceptance_ambiguous: false,
                    })?;
            }
            for payload in [
                serde_json::json!({"type":"freshAgent.session.materialized", "provider":"codex",
                    "sessionType":"freshcodex", "previousSessionId":"native-a", "sessionId":"native-b",
                    "sessionRef":{"provider":"codex","sessionId":"native-b"}}),
                serde_json::json!({"type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex",
                    "sessionId":"native-b", "event":{"type":"freshAgent.error", "sessionId":"native-b",
                        "code":"THREAD_MEMORY_LOST", "message":"replacement has no old thread memory"}}),
            ] {
                self.source
                    .send(AgentEvent::Provider { payload })
                    .await
                    .map_err(|_| DispatchFailure {
                        message: "actor event stream closed".into(),
                        acceptance_ambiguous: false,
                    })?;
            }
            let release = self
                .release
                .lock()
                .await
                .take()
                .expect("one native dispatch");
            release.await.map_err(|_| DispatchFailure {
                message: "native acknowledgment not released".into(),
                acceptance_ambiguous: true,
            })?;
            match self.outcome {
                NativeOutcome::Refused => {
                    return Err(DispatchFailure {
                        message: "native dispatch refused".into(),
                        acceptance_ambiguous: false,
                    })
                }
                NativeOutcome::Ambiguous => {
                    return Err(DispatchFailure {
                        message: "native dispatch outcome unknown".into(),
                        acceptance_ambiguous: true,
                    })
                }
                NativeOutcome::Accepted => {}
            }
            Ok(DispatchAck {
                provider_ack_id: Some("replacement-turn".into()),
                native_identity: Some(NativeDispatchIdentity {
                    previous_native_session_id: "native-a".into(),
                    native_session_id: "native-b".into(),
                    pending_naming_handle: None,
                }),
            })
        }

        async fn resolve_permission(
            &self,
            _: &str,
            _: serde_json::Value,
        ) -> Result<(), DispatchFailure> {
            self.resolutions.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        async fn interrupt(&self) -> Result<(), String> {
            unreachable!("no interrupt")
        }
        async fn stop(self: Arc<Self>) -> Result<(), String> {
            Ok(())
        }
        fn take_event_stream(&self) -> Option<mpsc::Receiver<AgentEvent>> {
            self.stream.lock().unwrap().take()
        }
    }

    // The supervisor may probe recovery after a Started event. Its controlled
    // unavailable answer cannot contact Docker or mutate a runtime.
    struct NoRuntime;
    #[async_trait::async_trait]
    impl RuntimeBackend for NoRuntime {
        async fn create_stopped(
            &self,
            _: &CreateRuntimeSpec,
        ) -> Result<BackendCreated, BackendError> {
            unreachable!("no runtime creation")
        }
        async fn start_host(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            unreachable!("no host process")
        }
        async fn inspect(&self, _: &OwnedRuntimeHandle) -> Result<BackendInspection, BackendError> {
            Err(BackendError::Unavailable(
                "in-process test has no runtime".into(),
            ))
        }
        async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
            unreachable!("no runtime stop")
        }
        async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            unreachable!("no runtime force stop")
        }
        async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
            unreachable!("no runtime cleanup")
        }
        async fn list_known(
            &self,
            _: &[OwnedRuntimeHandle],
        ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
            unreachable!("no runtime enumeration")
        }
        async fn read_limits(&self, _: &OwnedRuntimeHandle) -> Result<RuntimeLimits, BackendError> {
            unreachable!("no runtime limits")
        }
        async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            unreachable!("no runtime lease")
        }
    }

    #[derive(Clone)]
    struct HostRead {
        after: u64,
        batch: AgentEventBatch,
    }

    struct HostFixture {
        actor: Arc<FreshAgentHostActor>,
        boot: HostBootId,
        incarnation: IncarnationId,
        observation: NativeIdentityObservation,
        limits: RuntimeLimits,
        epoch: u64,
        generation: u64,
        reads: Arc<StdMutex<Vec<HostRead>>>,
        lose_send_reply: bool,
        dispatches: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    }

    async fn serve_host(
        listener: UnixListener,
        mut stop: oneshot::Receiver<()>,
        host: Arc<HostFixture>,
    ) {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut stop => break,
                Some(done) = connections.join_next(), if !connections.is_empty() => done.unwrap(),
                incoming = listener.accept() => {
                    let (mut stream, _) = incoming.unwrap();
                    let host = host.clone();
                    connections.spawn(async move {
                        let request: Envelope<HostCommand> = read_frame(&mut stream).await.unwrap();
                        assert_eq!(request.role, ControlRole::Supervisor);
                        if !matches!(&request.body, HostCommand::Hello { .. }) {
                            assert_eq!(request.auth.as_deref(), Some(host_proof(
                                b"realpath-host-secret", "command-auth", &host.boot, &host.incarnation).as_str()));
                        }
                        let result = match request.body {
                            HostCommand::Hello { incarnation_id, challenge } => {
                                assert_eq!(incarnation_id, host.incarnation);
                                HostResult::Hello {
                                    proof: host_proof(b"realpath-host-secret", &challenge, &host.boot, &incarnation_id),
                                    host_boot_id: host.boot.clone(),
                                    capabilities: vec!["native-identity-observation-v1".into()],
                                    effective_limits: host.limits,
                                }
                            }
                            HostCommand::Status { incarnation_id } => {
                                assert_eq!(incarnation_id, host.incarnation);
                                let native = host.actor.profile().await.native_session_id;
                                let mut observation = host.observation.clone();
                                if native.as_deref() == Some("native-b") {
                                    // The real host advances its binding when the accepted
                                    // replacement changes the supervisor's launch revision.
                                    observation.native_session_id = "native-b".into();
                                    observation.evidence_revision += 1;
                                } else if native.as_deref() == Some("native-c") {
                                    observation.native_session_id = "native-c".into();
                                    observation.evidence_revision += 2;
                                }
                                HostResult::Status {
                                    host_boot_id: host.boot.clone(), worker_pid: Some(123), worker_launch_count: 1,
                                    max_control_epoch: host.epoch, max_execution_generation: host.generation,
                                    fixture_evidence: serde_json::json!({}), exited: false,
                                    native_session_id: native,
                                    native_identity_observation: Some(observation),
                                    opencode_transfer_receipt: None, opencode_adoption: Default::default(),
                                }
                            }
                            HostCommand::FreshAgentSend { incarnation_id, request_id, text, settings, checkpoint_logical_attempt_id } => {
                                assert_eq!(incarnation_id, host.incarnation);
                                if host.lose_send_reply {
                                    let actor = host.actor.clone();
                                    let dispatch = tokio::spawn(async move {
                                        let _ = actor.dispatch_with_checkpoint_identity(
                                            request_id, text, settings, checkpoint_logical_attempt_id).await;
                                    });
                                    host.dispatches.lock().await.push(dispatch);
                                    let result = Err(freshell_runtime_protocol::RuntimeError::new(
                                        RuntimeErrorCode::HostUnreachable, "owned host reply was lost"));
                                    write_frame(&mut stream, &HostReply { request_id: request.request_id, result })
                                        .await.unwrap();
                                    return;
                                }
                                let before = host.actor.profile().await.native_session_id.unwrap();
                                let state = match host.actor.dispatch_with_checkpoint_identity(
                                    request_id, text, settings, checkpoint_logical_attempt_id).await {
                                    Ok(state) => state,
                                    Err(_) => {
                                        let result = Err(freshell_runtime_protocol::RuntimeError::new(
                                            RuntimeErrorCode::HostUnreachable, "owned fake dispatch did not settle"));
                                        write_frame(&mut stream, &HostReply { request_id: request.request_id, result })
                                            .await.unwrap();
                                        return;
                                    }
                                };
                                let after = host.actor.profile().await;
                                let native = after.native_session_id.clone().unwrap();
                                HostResult::FreshAgentCommand {
                                    state, native_session_id: Some(native.clone()), claude_fork: None,
                                    native_identity: Some(NativeDispatchIdentity {
                                        previous_native_session_id: before, native_session_id: native,
                                        pending_naming_handle: after.naming_handle,
                                    }),
                                }
                            }
                            HostCommand::FreshAgentReadEvents { incarnation_id, after_sequence, max_events } => {
                                assert_eq!(incarnation_id, host.incarnation);
                                let batch = host.actor.read_events(after_sequence, max_events as usize).await;
                                host.reads.lock().unwrap().push(HostRead { after: after_sequence, batch: batch.clone() });
                                HostResult::FreshAgentEvents(batch)
                            }
                            HostCommand::FreshAgentResolve { incarnation_id, decision_id, decision } => {
                                assert_eq!(incarnation_id, host.incarnation);
                                if host.actor.resolve_permission(&decision_id, decision).await.is_err() {
                                    let result = Err(freshell_runtime_protocol::RuntimeError::new(
                                        RuntimeErrorCode::HostUnreachable, "owned fake control was refused"));
                                    write_frame(&mut stream, &HostReply { request_id: request.request_id, result }).await.unwrap();
                                    return;
                                }
                                HostResult::FreshAgentCommand { state:CommandState::Completed, native_session_id:None,
                                    claude_fork:None, native_identity:None }
                            }
                            other => panic!("unexpected in-process host command: {other:?}"),
                        };
                        write_frame(&mut stream, &HostReply { request_id: request.request_id, result: Ok(result) })
                            .await.unwrap();
                    });
                }
            }
        }
        while let Some(done) = connections.join_next().await {
            done.unwrap();
        }
    }

    async fn settle_task(mut task: tokio::task::JoinHandle<()>, name: &str) -> Result<(), String> {
        match tokio::time::timeout(Duration::from_secs(5), &mut task).await {
            Ok(result) => result.map_err(|_| format!("owned {name} failed")),
            Err(_) => {
                task.abort();
                let _ = task.await;
                Err(format!("owned {name} did not settle before its deadline"))
            }
        }
    }

    // The socket adapter only frames requests; Supervisor::dispatch retains
    // production authentication and lifecycle locking, without serve_control's
    // unrelated detached periodic maintenance tasks.
    async fn serve_supervisor(
        listener: UnixListener,
        mut stop: oneshot::Receiver<()>,
        supervisor: Supervisor,
    ) {
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                _ = &mut stop => break,
                Some(done) = connections.join_next(), if !connections.is_empty() => done.unwrap(),
                incoming = listener.accept() => {
                    let (mut stream, _) = incoming.unwrap();
                    let supervisor = supervisor.clone();
                    connections.spawn(async move {
                        let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                        let reply = supervisor.dispatch(request).await;
                        write_frame(&mut stream, &reply).await.unwrap();
                    });
                }
            }
        }
        while let Some(done) = connections.join_next().await {
            done.unwrap();
        }
    }

    #[tokio::test]
    async fn codex_accepted_replacement_crosses_supervisor_actor_poller() {
        replacement_across_realpath(false, NativeOutcome::Accepted, false).await;
    }

    #[tokio::test]
    async fn codex_late_accepted_replacement_reconciles_after_lost_reply() {
        replacement_across_realpath(true, NativeOutcome::Accepted, false).await;
    }

    #[tokio::test]
    async fn review_refused_replacement_controls_remain_hidden_and_unactionable() {
        replacement_across_realpath(true, NativeOutcome::Refused, false).await;
    }

    #[tokio::test]
    async fn review_ambiguous_replacement_controls_remain_hidden_and_unactionable() {
        replacement_across_realpath(true, NativeOutcome::Ambiguous, false).await;
    }

    #[tokio::test]
    async fn codex_two_accepted_replacements_survive_gateway_restart() {
        replacement_across_realpath(false, NativeOutcome::Accepted, true).await;
    }

    async fn replacement_across_realpath(
        lose_send_reply: bool,
        outcome: NativeOutcome,
        two_replacements: bool,
    ) {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().to_string_lossy().into_owned();
        let runtime = root.path().join("runtime");
        std::fs::create_dir(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"realpath-host-secret").unwrap();
        let limits = RuntimeLimits {
            cpu_milli: 500,
            memory_bytes: 64 * 1024 * 1024,
            swap_bytes: 0,
            pids_max: 32,
        };
        let registry = Registry::open(root.path().join("registry"), None).unwrap();
        let soul = SoulId::parse("realpath-codex-soul").unwrap();
        let spec = serde_json::from_value(serde_json::json!({
            "sessionId":"managed-public", "provider":"codex", "sessionType":"freshcodex",
            "runtimeVariant":"codex", "providerStoreId":"realpath-store", "cwd":workspace,
            "workspacePath":workspace, "runAsUid":65534, "runAsGid":0,
            "nativeSessionId":"native-a", "sessionRef":{"provider":"codex","sessionId":"native-a"}
        }))
        .unwrap();
        let prepared = registry
            .prepare_launch(LaunchPreparation {
                soul_id: soul.clone(),
                provider: "codex".into(),
                provider_store_id: "realpath-store".into(),
                native_session_id: Some("native-a".into()),
                creation_seed_ref: "realpath-seed".into(),
                request_id: RequestId::new(),
                payload_digest: "realpath-launch".into(),
                requested_limits: limits,
                profile: RuntimeProfile::Custom,
                project_key: "realpath-workspace".into(),
                fixture: None,
                terminal: None,
                fresh_agent: Some(spec),
                view_intent: None,
                admission: AdmissionPolicy::default(),
            })
            .await
            .unwrap();
        registry
            .commit_created(
                prepared.incarnation_id.clone(),
                BackendCreatedRecord {
                    launch_policy: None,
                    daemon_id: DockerDaemonId::new(),
                    container_id: "a".repeat(64),
                    image_ref: format!("sha256:{}", "b".repeat(64)),
                    runtime_dir: runtime.clone(),
                    host_binary_path: std::env::current_exe().unwrap(),
                    immutable_config_digest: format!("sha256:{}", "c".repeat(64)),
                },
            )
            .await
            .unwrap();
        let boot = HostBootId::new();
        let grant = registry
            .commit_execution_grant(prepared.incarnation_id.clone(), boot.clone(), limits)
            .await
            .unwrap();
        let current = registry.recovery_context(soul.clone()).await.unwrap();
        let launch = registry
            .bind_native_identity_launch(NativeIdentityLaunch {
                incarnation_id: prepared.incarnation_id.clone(),
                launch_nonce: prepared.launch_nonce.as_str().into(),
                evidence_revision: current.evidence_revision,
                execution_generation: grant.execution_generation,
                requested_native_session_id: Some("native-a".into()),
            })
            .await
            .unwrap();
        registry
            .record_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "native-a".into(),
            )
            .await
            .unwrap();
        let observation = NativeIdentityObservation {
            native_session_id: "native-a".into(),
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: launch.launch_nonce.clone(),
            evidence_revision: launch.evidence_revision,
            source: NativeIdentitySource::FreshProviderHandshake,
            evidence_digest: "d".repeat(64),
        };
        let current = registry.recovery_context(soul.clone()).await.unwrap();
        registry
            .record_native_identity_observation(
                soul.clone(),
                observation.clone(),
                current.write_fence(),
            )
            .await
            .unwrap();
        registry
            .mark_running(prepared.incarnation_id.clone())
            .await
            .unwrap();

        let (source, stream) = mpsc::channel(16);
        let (release_tx, release_rx) = oneshot::channel();
        let resolutions = Arc::new(AtomicUsize::new(0));
        let native = Arc::new(FakeNative {
            source: source.clone(),
            stream: StdMutex::new(Some(stream)),
            release: Mutex::new(Some(release_rx)),
            outcome,
            resolutions: resolutions.clone(),
        });
        let profile: FreshAgentProfile = serde_json::from_value(serde_json::json!({
            "provider":"codex", "runtimeVariant":"codex", "cwd":workspace, "providerStoreId":"realpath-store",
            "nativeSessionId":"native-a", "sessionRef":{"provider":"codex","sessionId":"native-a"}
        })).unwrap();
        let actor = FreshAgentHostActor::open(root.path().join("actor"), profile, native)
            .await
            .unwrap();
        source.send(AgentEvent::Provider { payload: serde_json::json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex", "sessionId":"native-a",
            "event":{"type":"freshAgent.status", "sessionId":"native-a", "status":"idle"}
        }) }).await.unwrap();
        let initial = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let batch = actor.read_events(0, 64).await;
                if !batch.events.is_empty() {
                    break batch;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("initial native status must reach the actor");
        assert!(!initial.reset_required);
        let cursor = initial.head;
        assert!(cursor > 0);

        let host_listener = UnixListener::bind(runtime.join("host.sock")).unwrap();
        let reads = Arc::new(StdMutex::new(Vec::new()));
        let dispatches = Arc::new(Mutex::new(Vec::new()));
        let host = Arc::new(HostFixture {
            actor: actor.clone(),
            boot,
            incarnation: prepared.incarnation_id.clone(),
            observation,
            limits,
            epoch: registry.control_epoch(),
            generation: grant.execution_generation,
            reads: reads.clone(),
            lose_send_reply,
            dispatches: dispatches.clone(),
        });
        let (host_stop, host_stop_rx) = oneshot::channel();
        let host_task = tokio::spawn(serve_host(host_listener, host_stop_rx, host));
        let control_path = root.path().join("control.sock");
        let control_listener = UnixListener::bind(&control_path).unwrap();
        let supervisor = Supervisor::new(
            registry.clone(),
            Arc::new(NoRuntime),
            SupervisorConfig {
                runtime_root: root.path().into(),
                control_socket_path: control_path.clone(),
                host_binary_path: std::env::current_exe().unwrap(),
                image_ref: format!("sha256:{}", "b".repeat(64)),
                test_run_id: "codex-replacement-realpath".into(),
                control_secret: "0123456789abcdef".into(),
                lifecycle_log: root.path().join("lifecycle.jsonl"),
                admission: AdmissionPolicy::default(),
            },
        )
        .unwrap();
        let (control_stop, control_stop_rx) = oneshot::channel();
        let control_task = tokio::spawn(serve_supervisor(
            control_listener,
            control_stop_rx,
            supervisor,
        ));
        let (proxy, mut public) = configure_proxy(
            &control_path,
            HashMap::from([(("codex".into(), "managed-public".into()), soul.clone())]),
        );
        let mut release = Some(release_tx);
        let mut send_task = None;
        let mut restarted_proxy = None;
        let scenario = std::panic::AssertUnwindSafe(async {
        assert!(proxy.start_poller(soul.clone(), "codex".into(), "managed-public".into(), "freshcodex".into(), 0).await);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if reads.lock().unwrap().iter().any(|read| read.after == cursor && !read.batch.reset_required) { break; }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("the real poller must advance beyond its initial cursor");
        if two_replacements {
            let create = serde_json::from_value(serde_json::json!({
                "requestId":"resume-native-a", "provider":"codex", "sessionType":"freshcodex",
                "cwd":workspace, "sessionRef":{"provider":"codex", "sessionId":"native-a"}
            })).unwrap();
            proxy.clone().handle(HostedFreshAgentCommand::Create(create)).await;
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let frame: serde_json::Value = serde_json::from_str(&public.recv().await.unwrap()).unwrap();
                    if frame["type"] == "freshAgent.created" && frame["requestId"] == "resume-native-a" {
                        assert_eq!(frame["sessionId"], "native-a");
                        break;
                    }
                }
            }).await.expect("the older A presentation must exist before replacement");
        }
        while public.try_recv().is_ok() {}
        let message = serde_json::from_value(serde_json::json!({
            "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public",
            "requestId":"replacement-through-supervisor", "text":"recover once"
        })).unwrap();
        send_task = Some(tokio::spawn(proxy.clone().handle(HostedFreshAgentCommand::Send(message))));
        let staged = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let batch = actor.read_events(cursor, 64).await;
                if batch.events.iter().filter(|row| matches!(&row.event, AgentEvent::Provider { payload }
                    if payload["type"] == "freshAgent.session.materialized" || payload["event"]["code"] == "THREAD_MEMORY_LOST")).count() == 2
                    && batch.events.iter().filter(|row| matches!(&row.event, AgentEvent::PermissionRequested { .. })).count() == 3 {
                    break batch;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("the real actor must journal both staged provider frames");
        assert!(!staged.reset_required);
        assert_eq!(actor.profile().await.native_session_id.as_deref(), Some("native-a"));
        assert_eq!(registry.recovery_context(soul.clone()).await.unwrap().native_session_id.as_deref(), Some("native-a"));
        // This scenario verifies the public routing after accepted replacement.
        // It does not claim to prove where a concurrent read waits for the lock.
        if lose_send_reply {
            settle_task(send_task.take().unwrap(), "ambiguous gateway send").await.unwrap();
            assert_eq!(registry.recovery_context(soul.clone()).await.unwrap().native_session_id.as_deref(), Some("native-a"));
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if reads.lock().unwrap().iter().filter(|read| read.after == cursor
                        && read.batch.native_dispatch_in_flight
                        && read.batch.events.iter().any(|row| matches!(&row.event,
                            AgentEvent::Provider { payload } if payload["type"] == "freshAgent.session.materialized"))).count() >= 2 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }).await.expect("the real poller must retry the same replacement cursor while acceptance is unresolved");
            while let Ok(frame) = public.try_recv() {
                let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
                assert_ne!(frame["type"], "freshAgent.session.materialized", "an unresolved replacement must not rekey the pane");
                assert_ne!(frame["event"]["code"], "THREAD_MEMORY_LOST", "an unresolved replacement must not publish its warning");
                assert!(!frame["event"]["type"].as_str().is_some_and(|kind| kind.ends_with(".request")), "unaccepted controls must not reach the old pane: {frame}");
            }
        }
        release.take().unwrap().send(()).unwrap();
        if let Some(send) = send_task.take() {
            settle_task(send, "gateway send").await.unwrap();
        }
        if outcome != NativeOutcome::Accepted {
            let last_staged = staged.events.iter().map(|event| event.sequence).max().unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let batch = actor.read_events(cursor, 64).await;
                    if !batch.native_dispatch_in_flight && reads.lock().unwrap().iter().any(|read| read.after >= last_staged) { break; }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }).await.expect("the refused or ambiguous native dispatch must settle and drain its provisional journal");
            assert_eq!(actor.profile().await.native_session_id.as_deref(), Some("native-a"));
            assert_eq!(registry.recovery_context(soul.clone()).await.unwrap().native_session_id.as_deref(), Some("native-a"));
            while let Ok(frame) = public.try_recv() {
                let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
                assert!(!frame["event"]["type"].as_str().is_some_and(|kind| kind.ends_with(".request")), "refused/ambiguous controls must stay hidden: {frame}");
            }
            for kind in ["permission", "question", "elicitation"] {
                proxy.resolve_decision(AgentProvider::Codex, "managed-public".into(), SessionType::Freshcodex,
                    format!("{kind}-b"), serde_json::json!({"decision":"accept"})).await;
            }
            assert_eq!(resolutions.load(Ordering::SeqCst), 0, "refused/ambiguous B controls must not be actionable under A");
            return;
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if actor.profile().await.native_session_id.as_deref() == Some("native-b") { break; }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("the host actor must durably accept B");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if registry.recovery_context(soul.clone()).await.unwrap().native_session_id.as_deref() == Some("native-b") { break; }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("the supervisor must reconcile an accepted native B after a lost reply");
        if lose_send_reply {
            let replay = proxy.client.fresh_agent_send(
                RequestId::parse("replacement-through-supervisor").unwrap(), soul.clone(),
                "recover once".into(), None, None,
            ).await.unwrap();
            assert_eq!(replay, CommandState::Completed, "replay must not dispatch the accepted turn twice");
        }
        source.send(AgentEvent::Provider { payload: serde_json::json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex", "sessionId":"native-b",
            "event":{"type":"freshAgent.turn.complete", "sessionId":"native-b", "at":chrono::Utc::now().timestamp_millis(), "outcome":"completed"}
        }) }).await.unwrap();
        let mut frames = Vec::<serde_json::Value>::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !frames.iter().any(|frame| frame["type"] == "freshAgent.session.materialized")
                || !frames.iter().any(|frame| frame["event"]["code"] == "THREAD_MEMORY_LOST")
                || !frames.iter().any(|frame| frame["event"]["type"] == "freshAgent.turn.complete")
            {
                let frame = public.recv().await.unwrap();
                frames.push(serde_json::from_str(&frame).unwrap());
            }
        }).await.expect("real poller must deliver replacement, warning, and completion");
        let host_reads = reads.lock().unwrap().clone();

        let staged_sequences: Vec<_> = staged.events.iter().filter_map(|row| match &row.event {
            AgentEvent::Provider { payload } if payload["type"] == "freshAgent.session.materialized"
                || payload["event"]["code"] == "THREAD_MEMORY_LOST" => Some(row.sequence),
            _ => None,
        }).collect();
        assert_eq!(staged_sequences.len(), 2);
        assert!(host_reads.iter().filter(|read| read.after >= cursor).all(|read| !read.batch.reset_required && read.batch.retained_state.is_none()));
        for sequence in staged_sequences {
            assert!(host_reads.iter().any(|read| read.after >= cursor && read.batch.events.iter().any(|row| row.sequence == sequence)),
                "the real supervisor read must carry journal sequence {sequence}");
        }
        let materialized_index = frames.iter().position(|frame| frame["type"] == "freshAgent.session.materialized").unwrap();
        let warning_index = frames.iter().position(|frame| frame["event"]["code"] == "THREAD_MEMORY_LOST").unwrap();
        let completion_index = frames.iter().position(|frame| frame["event"]["type"] == "freshAgent.turn.complete").unwrap();
        assert!(materialized_index < warning_index && warning_index < completion_index,
            "the pane must be told about B before its warning and completion");
        let materialized = &frames[materialized_index];
        assert_eq!(materialized["previousSessionId"], "managed-public");
        assert_eq!(materialized["sessionRef"]["sessionId"], "native-b");
        let pane = materialized["sessionId"].as_str().unwrap();
        assert_eq!(pane, "managed-public", "accepted recovery preserves the public presentation key");
        for kind in ["permission", "question", "elicitation"] {
            let index = frames.iter().position(|frame| frame["sessionId"] == pane
                && frame["event"]["requestId"] == format!("{kind}-b"))
                .unwrap_or_else(|| panic!("accepted {kind} control must reach the original pane: {frames:?}"));
            assert!(materialized_index < index, "the original pane must see B before its controls");
        }
        for (index, frame) in frames.iter().enumerate().filter(|(_, frame)| frame["event"]["code"] == "THREAD_MEMORY_LOST"
            || frame["event"]["type"] == "freshAgent.turn.complete") {
            let presentation = frame["sessionId"].as_str().unwrap();
            if two_replacements && presentation == "native-a" {
                assert!(frames[..index].iter().any(|earlier| earlier["type"] == "freshAgent.session.materialized"
                    && earlier["sessionId"] == "native-a" && earlier["sessionRef"]["sessionId"] == "native-b"),
                    "A must learn B before its own warning or completion: {frames:?}");
            } else {
                assert_eq!(presentation, pane, "warning and completion must address the pane told about B");
            }
            assert_eq!(frame["event"]["sessionId"], presentation);
        }
        if two_replacements {
            assert!(frames.iter().any(|frame| frame["sessionId"] == "native-a" && frame["event"]["code"] == "THREAD_MEMORY_LOST"),
                "the existing A pane must receive its own B warning: {frames:?}");
        }
        for alias in ["managed-public", "native-b"] {
            assert_eq!(proxy.resolve_soul(&AgentProvider::Codex, SessionType::Freshcodex, alias).await, Some(soul.clone()));
        }
        while public.try_recv().is_ok() {}
        let resume = serde_json::from_value(serde_json::json!({
            "requestId":"resume-native-b", "provider":"codex", "sessionType":"freshcodex",
            "cwd":workspace, "sessionRef":{"provider":"codex", "sessionId":"native-b"}
        })).unwrap();
        proxy.clone().handle(HostedFreshAgentCommand::Create(resume)).await;
        let resumed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame: serde_json::Value = serde_json::from_str(&public.recv().await.unwrap()).unwrap();
                if frame["type"] == "freshAgent.created" && frame["requestId"] == "resume-native-b" {
                    break frame;
                }
            }
        }).await.expect("resuming accepted B must create a pane");
        assert_eq!(resumed["sessionRef"]["sessionId"], "native-b");
        let resumed_pane = resumed["sessionId"].as_str().unwrap().to_owned();
        assert_eq!(resumed_pane, "native-b", "native resume retains its public response contract");
        let mut replay = Vec::<serde_json::Value>::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !replay.iter().any(|frame| frame["type"] == "freshAgent.session.materialized"
                && frame["sessionId"] == resumed_pane && frame["sessionRef"]["sessionId"] == "native-b")
                || !replay.iter().any(|frame| frame["sessionId"] == resumed_pane && frame["event"]["code"] == "THREAD_MEMORY_LOST") {
                let frame: serde_json::Value = serde_json::from_str(&public.recv().await.unwrap()).unwrap();
                replay.push(frame);
            }
        }).await.expect("the resumed pane must receive accepted materialization and retained journal events");
        assert!(!replay.iter().any(|frame| frame["sessionId"] == "managed-public"),
            "a resume replay must not replay the old pane's stream");
        for kind in ["permission", "question", "elicitation"] {
            assert!(replay.iter().any(|frame| frame["sessionId"] == resumed_pane
                && frame["event"]["sessionId"] == resumed_pane
                && frame["event"]["requestId"] == format!("{kind}-b")),
                "accepted {kind} control must reach the resumed pane: {replay:?}");
            proxy.resolve_decision(AgentProvider::Codex, resumed_pane.clone(), SessionType::Freshcodex,
                format!("{kind}-b"), serde_json::json!({"decision":"accept"})).await;
        }
        assert_eq!(resolutions.load(Ordering::SeqCst), 3, "accepted B controls remain actionable");
        source.send(AgentEvent::Provider { payload: serde_json::json!({
            "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex", "sessionId":"native-b",
            "event":{"type":"freshAgent.status", "sessionId":"native-b", "status":"resume-marker"}
        }) }).await.unwrap();
        let mut delivered = HashSet::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            while !delivered.contains("managed-public") || !delivered.contains(&resumed_pane) {
                let frame: serde_json::Value = serde_json::from_str(&public.recv().await.unwrap()).unwrap();
                if frame["event"]["status"] == "resume-marker" {
                    delivered.insert(frame["sessionId"].as_str().unwrap().to_owned());
                }
            }
        }).await;
        assert!(delivered.contains("managed-public"), "the existing pane must receive the later event; delivered={delivered:?}");
        assert!(delivered.contains(&resumed_pane), "resumed pane {resumed_pane} must receive the later event; delivered={delivered:?}");
        assert_eq!(proxy.presentation_routes.lock().await.get(&soul).unwrap().session_id, "managed-public");
        if two_replacements {
            let second = serde_json::from_value(serde_json::json!({
                "provider":"codex", "sessionType":"freshcodex", "sessionId":"managed-public",
                "requestId":"second-replacement-through-supervisor", "text":"recover again"
            })).unwrap();
            proxy.clone().handle(HostedFreshAgentCommand::Send(second)).await;
            assert_eq!(actor.profile().await.native_session_id.as_deref(), Some("native-c"));
            assert_eq!(registry.recovery_context(soul.clone()).await.unwrap().native_session_id.as_deref(), Some("native-c"));
            let proof = actor.read_events(0, 128).await.accepted_native_dispatch.unwrap();
            assert_eq!(proof.identity.previous_native_session_id, "native-b");
            assert!(proof.prior_native_session_ids.contains(&"native-a".into()));
            let (restarted, mut after_restart) = configure_proxy(&control_path, HashMap::new());
            restarted_proxy = Some(restarted.clone());
            restarted.clone().handle(HostedFreshAgentCommand::Attach(serde_json::from_value(serde_json::json!({
                "provider":"codex", "sessionType":"freshcodex", "sessionId":"native-a",
                "sessionRef":{"provider":"codex", "sessionId":"native-c"}
            })).unwrap())).await;
            source.send(AgentEvent::Provider { payload:serde_json::json!({
                "type":"freshAgent.event", "provider":"codex", "sessionType":"freshcodex", "sessionId":"native-c",
                "event":{"type":"freshAgent.status", "sessionId":"native-c", "status":"after-second-replacement"}
            }) }).await.unwrap();
            let mut replay = Vec::<serde_json::Value>::new();
            tokio::time::timeout(Duration::from_secs(5), async {
                while !replay.iter().any(|frame| frame["sessionId"] == "native-a" && frame["event"]["status"] == "after-second-replacement") {
                    replay.push(serde_json::from_str(&after_restart.recv().await.unwrap()).unwrap());
                }
            }).await.expect("the restarted real gateway must replay and deliver C to old A");
            let announcement = replay.iter().position(|frame| frame["type"] == "freshAgent.session.materialized" && frame["sessionId"] == "native-a" && frame["sessionRef"]["sessionId"] == "native-c").unwrap();
            let output = replay.iter().position(|frame| frame["sessionId"] == "native-a" && frame["event"]["status"] == "after-second-replacement").unwrap();
            assert!(announcement < output, "A must learn C before its output: {replay:?}");
        }
        }).catch_unwind().await;

        // Settle the owned sockets and poller even when an assertion fails.
        // Dropping an unreleased ACK makes the fake native dispatch ambiguous.
        drop(release.take());
        let mut cleanup_errors = Vec::new();
        if let Some(send) = send_task.take() {
            if let Err(error) = settle_task(send, "gateway send").await {
                cleanup_errors.push(error);
            }
        }
        for dispatch in std::mem::take(&mut *dispatches.lock().await) {
            if let Err(error) = settle_task(dispatch, "owned host dispatch").await {
                cleanup_errors.push(error);
            }
        }
        if control_stop.send(()).is_err() {
            cleanup_errors.push("supervisor socket already stopped".into());
        }
        if let Err(error) = settle_task(control_task, "supervisor socket").await {
            cleanup_errors.push(error);
        }
        if tokio::time::timeout(Duration::from_secs(5), async {
            while proxy.pollers.lock().await.contains(&soul)
                || match restarted_proxy.as_ref() {
                    Some(restarted) => restarted.pollers.lock().await.contains(&soul),
                    None => false,
                }
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .is_err()
        {
            cleanup_errors.push("owned poller did not settle".into());
        }
        if host_stop.send(()).is_err() {
            cleanup_errors.push("host socket already stopped".into());
        }
        if let Err(error) = settle_task(host_task, "host socket").await {
            cleanup_errors.push(error);
        }
        if !matches!(
            tokio::time::timeout(Duration::from_secs(5), actor.clone().stop()).await,
            Ok(Ok(()))
        ) {
            cleanup_errors.push("owned actor did not stop".into());
        }
        if !cleanup_errors.is_empty() {
            eprintln!("owned cleanup failures: {cleanup_errors:?}");
        }
        if let Err(failure) = scenario {
            std::panic::resume_unwind(failure);
        }
        assert!(
            cleanup_errors.is_empty(),
            "owned tasks must settle: {cleanup_errors:?}"
        );
    }
}
