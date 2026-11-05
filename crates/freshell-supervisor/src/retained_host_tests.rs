use super::*;
use crate::{
    backend::{
        BackendError, BackendInspection, BackendRuntimeState, CreateRuntimeSpec, RuntimeBackend,
    },
    registry::OwnedRuntimeHandle,
};
use freshell_runtime_protocol::{RecoverRequest, RecoveryOutcome, RecoveryProbe, RecoveryTrigger};
use rusqlite::{params, Connection};
use std::sync::atomic::AtomicUsize;

const SECRET: &[u8] = b"owned-retained-host-secret";

struct RetainedBackend {
    qualifications: AtomicUsize,
}

#[async_trait::async_trait]
impl RuntimeBackend for RetainedBackend {
    async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        Ok(())
    }
    async fn create_stopped(
        &self,
        _: &CreateRuntimeSpec,
    ) -> Result<crate::backend::BackendCreated, BackendError> {
        panic!("retaining a running host must never create a replacement")
    }
    async fn start_host(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        panic!("retaining a running host must never start a replacement")
    }
    async fn inspect(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<BackendInspection, BackendError> {
        Ok(BackendInspection {
            state: BackendRuntimeState::Running,
            configured_limits: handle.requested_limits(),
        })
    }
    async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
        panic!("an uncertain retained host must not be terminated")
    }
    async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        panic!("an uncertain retained host must not be force terminated")
    }
    async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
        Ok(false)
    }
    async fn list_known(
        &self,
        handles: &[OwnedRuntimeHandle],
    ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
        Ok(handles
            .iter()
            .map(|h| {
                (
                    h.incarnation_id().clone(),
                    BackendInspection {
                        state: BackendRuntimeState::Running,
                        configured_limits: h.requested_limits(),
                    },
                )
            })
            .collect())
    }
    async fn read_limits(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<RuntimeLimits, BackendError> {
        Ok(handle.requested_limits())
    }
    async fn qualify_retained_opencode(
        &self,
        _: &OwnedRuntimeHandle,
        _: &freshell_runtime_protocol::RetainedStoreCompatibilityRequest,
        _: &Path,
    ) -> Result<freshell_runtime_protocol::RetainedStoreCompatibilityReceipt, BackendError> {
        self.qualifications.fetch_add(1, Ordering::SeqCst);
        Err(BackendError::Unavailable(
            "a running retained terminal needs no store helper".into(),
        ))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fault {
    None,
    BadProof,
    WrongStatusBoot,
    WrongGeneration,
    NoWorker,
    Exited,
    NonVersionError,
    WrongReplyId,
    StopDuringStatus,
    WrongNativeIdentity,
    OutputNativeIdentity,
    EvidenceChanged,
}

struct Fixture {
    _dir: tempfile::TempDir,
    supervisor: Supervisor,
    backend: Arc<RetainedBackend>,
    soul: SoulId,
    incarnation: IncarnationId,
    runtime: PathBuf,
    boot: HostBootId,
    terminal: TerminalLaunchSpec,
}

impl Fixture {
    fn add_provider_context(&mut self) {
        self.terminal.provider_launch_context =
            Some(freshell_runtime_protocol::ProviderLaunchContext {
                prepared_inputs: None,
                preparation: freshell_runtime_protocol::ProviderPreparation::Opencode {
                    project_config: Vec::new(),
                    tui_config: None,
                    tui_source: None,
                    inline_config: false,
                },
                mcp_capability: Some(freshell_runtime_protocol::McpCapabilityReference {
                    grant_id: "grant-retained".into(),
                    endpoint: "http://host.docker.internal:4000".into(),
                    provider_relative_path: ".freshell/mcp-capability.json".into(),
                    host_gateway_address: None,
                }),
                config: Vec::new(),
            });
        Connection::open(self.supervisor.registry.database_path())
            .unwrap()
            .execute(
                "UPDATE incarnations SET terminal_spec=?1 WHERE incarnation_id=?2",
                params![
                    serde_json::to_string(&self.terminal).unwrap(),
                    self.incarnation.as_str()
                ],
            )
            .unwrap();
    }
    async fn new(provider: &str, recorded_resume: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(dir.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let prepared =
            crate::registry::tests::materialize_test_runtime(&registry, soul.clone()).await;
        let incarnation = prepared.incarnation_id;
        let runtime = dir.path().join("runtime").join(incarnation.as_str());
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), SECRET).unwrap();
        let workspace = dir.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
            "terminalId":"retained-terminal", "streamId":"retained-stream", "mode":provider,
            "program":provider, "cwd":workspace, "workspacePath":workspace, "projectKey":"retained",
            "runAsUid":65534, "runAsGid":0, "cols":80, "rows":24,
        }))
        .unwrap();
        let boot = HostBootId::new();
        let connection = Connection::open(registry.database_path()).unwrap();
        connection.execute("UPDATE souls SET provider=?1,recovery_state='blocked',recovery_reason='OLD_HOST' WHERE soul_id=?2", params![provider,soul.as_str()]).unwrap();
        connection.execute("UPDATE incarnations SET runtime_dir=?1,terminal_spec=?2,terminal_id=?3,host_boot_id=?4,execution_generation=1,grant_id='retained-grant',native_identity_launch=NULL,native_identity_observation=NULL,fixture_kind=NULL WHERE incarnation_id=?5", params![runtime.to_string_lossy(),serde_json::to_string(&terminal).unwrap(),terminal.terminal_id,boot.as_str(),incarnation.as_str()]).unwrap();
        connection
            .execute(
                "UPDATE writer_claims SET provider=?1 WHERE soul_id=?2",
                params![provider, soul.as_str()],
            )
            .unwrap();
        if recorded_resume {
            let resume = serde_json::json!({
                "schemaVersion":1,"providerSession":{"provider":provider,"providerStoreId":"store","nativeSessionId":"ses_retained"},
                "mode":provider,"runtimeVariant":"managed_terminal_pty","program":provider,"resumeArgv":[],
                "providerHome":"/home/freshell/provider","cwd":workspace,"workspacePath":workspace,"environment":{},
                "creationSeedRef":"seed","checkpointRevision":0,"allocationState":"verified_durable",
                "evidenceRevision":1,"neverDispatched":false,
            });
            connection.execute("UPDATE souls SET native_session_id='ses_retained',resume_spec=?1,durability_state='resume_captured' WHERE soul_id=?2",params![resume.to_string(),soul.as_str()]).unwrap();
        }
        drop(connection);
        let backend = Arc::new(RetainedBackend {
            qualifications: AtomicUsize::new(0),
        });
        std::fs::write(
            dir.path().join("host"),
            b"owned framed peer; never executed",
        )
        .unwrap();
        let supervisor = Supervisor::new(
            registry,
            backend.clone(),
            SupervisorConfig {
                runtime_root: dir.path().join("runtime"),
                control_socket_path: dir.path().join("control.sock"),
                host_binary_path: dir.path().join("host"),
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "retained-wire-tests".into(),
                control_secret: "owned-retained-control-secret".into(),
                lifecycle_log: dir.path().join("lifecycle.jsonl"),
                admission: Default::default(),
            },
        )
        .unwrap();
        Self {
            _dir: dir,
            supervisor,
            backend,
            soul,
            incarnation,
            runtime,
            boot,
            terminal,
        }
    }

    async fn peer(
        &self,
        version: u32,
        fault: Fault,
    ) -> (
        tokio::task::JoinHandle<()>,
        Arc<StdMutex<Vec<(u32, String)>>>,
    ) {
        let listener = UnixListener::bind(self.runtime.join("host.sock")).unwrap();
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let observed = requests.clone();
        let incarnation = self.incarnation.clone();
        let boot = self.boot.clone();
        let limits = self
            .supervisor
            .registry
            .owned_handle(incarnation.clone())
            .await
            .unwrap()
            .requested_limits();
        let terminal = self.terminal.clone();
        let database = self.supervisor.registry.database_path().to_owned();
        let soul = self.soul.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let Ok(request) = read_frame::<_, Envelope<HostCommand>>(&mut socket).await else {
                    continue;
                };
                let method = serde_json::to_value(&request.body).unwrap()["method"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                observed
                    .lock()
                    .unwrap()
                    .push((request.protocol_version, method));
                let request_id = if fault == Fault::WrongReplyId {
                    RequestId::new()
                } else {
                    request.request_id
                };
                let result = if fault == Fault::NonVersionError {
                    Err(RuntimeError::new(
                        RuntimeErrorCode::HostAuthenticationFailed,
                        "owned peer refuses authentication",
                    ))
                } else if request.protocol_version != version {
                    Err(RuntimeError::new(
                        RuntimeErrorCode::ProtocolVersionMismatch,
                        "owned peer requires v1",
                    ))
                } else {
                    match request.body {
                        HostCommand::Hello {
                            incarnation_id,
                            challenge,
                        } => {
                            assert_eq!(incarnation_id, incarnation);
                            Ok(HostResult::Hello {
                                host_boot_id: boot.clone(),
                                proof: if fault == Fault::BadProof {
                                    "invalid-owned-proof".into()
                                } else {
                                    host_proof(SECRET, &challenge, &boot, &incarnation)
                                },
                                capabilities: vec![
                                    "terminal-v1".into(),
                                    "output-replay-v1".into(),
                                    "stop-v1".into(),
                                ],
                                effective_limits: limits,
                            })
                        }
                        body => {
                            assert_eq!(
                                request.auth,
                                Some(host_proof(SECRET, "command-auth", &boot, &incarnation))
                            );
                            match body {
                                HostCommand::Status { .. } => {
                                    if fault == Fault::StopDuringStatus {
                                        Connection::open(&database).unwrap().execute("UPDATE souls SET desired_state='stopped',intent_revision=intent_revision+1,recovery_state='stopped' WHERE soul_id=?1",[soul.as_str()]).unwrap();
                                    }
                                    if fault == Fault::EvidenceChanged {
                                        Connection::open(&database).unwrap().execute("UPDATE souls SET evidence_revision=evidence_revision+1 WHERE soul_id=?1",[soul.as_str()]).unwrap();
                                    }
                                    Ok(HostResult::Status {
                                        fresh_agent_recovery_source: None,
                                        host_boot_id: if fault == Fault::WrongStatusBoot {
                                            HostBootId::new()
                                        } else {
                                            boot.clone()
                                        },
                                        worker_pid: (fault != Fault::NoWorker).then_some(4242),
                                        worker_launch_count: 1,
                                        max_control_epoch: 1,
                                        max_execution_generation: if fault == Fault::WrongGeneration
                                        {
                                            2
                                        } else {
                                            1
                                        },
                                        fixture_evidence: serde_json::Value::Null,
                                        exited: fault == Fault::Exited,
                                        native_session_id: (fault == Fault::WrongNativeIdentity)
                                            .then(|| "ses_unrelated".into()),
                                        native_identity_observation: None,
                                        native_readiness_receipt: None,
                                        opencode_adoption: Default::default(),
                                        opencode_transfer_receipt: None,
                                    })
                                }
                                HostCommand::TerminalInput { .. } => {
                                    Ok(HostResult::TerminalInput {
                                        state: CommandState::Completed,
                                    })
                                }
                                HostCommand::TerminalResize { .. } => {
                                    Ok(HostResult::TerminalResize)
                                }
                                HostCommand::TerminalReadOutput { .. } => {
                                    Ok(HostResult::TerminalOutput(RuntimeOutputBatch {
                                        incarnation_id: incarnation.clone(),
                                        terminal_id: terminal.terminal_id.clone(),
                                        stream_epoch: "retained-epoch".into(),
                                        retained_from_seq: 0,
                                        head_seq: 0,
                                        reset_required: false,
                                        truncated: false,
                                        exited: false,
                                        completion: None,
                                        exit_code: None,
                                        native_session_id: (fault == Fault::OutputNativeIdentity)
                                            .then(|| "ses_unqualified".into()),
                                        frames: Vec::new(),
                                        opencode_activity: None,
                                        codex_activity: None,
                                    }))
                                }
                                _ => panic!("legacy continuation must not dispatch this command"),
                            }
                        }
                    }
                };
                let _ = write_frame(&mut socket, &HostReply { request_id, result }).await;
            }
        });
        (task, requests)
    }

    async fn recover(&self) -> Result<freshell_runtime_protocol::RecoveryResult, RuntimeError> {
        self.supervisor
            .recover(RecoverRequest {
                soul_id: self.soul.clone(),
                trigger: RecoveryTrigger::StartupReconcile,
                expected_intent_revision: Some(1),
                expected_control_epoch: Some(self.supervisor.registry.control_epoch()),
            })
            .await
    }
}

#[tokio::test]
async fn retained_v1_terminal_continues_without_native_acceptance_or_replacement() {
    for (provider, recorded, context) in [
        ("shell", false, false),
        ("opencode", false, false),
        ("opencode", true, false),
        ("opencode", false, true),
        ("opencode", true, true),
    ] {
        let mut fixture = Fixture::new(provider, recorded).await;
        if context {
            fixture.add_provider_context();
        }
        let fault = if provider == "opencode" && !recorded {
            Fault::OutputNativeIdentity
        } else {
            Fault::None
        };
        let (peer, requests) = fixture.peer(1, fault).await;
        let before = fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap();
        let report = fixture.supervisor.reconcile_startup().await.unwrap();
        assert!(
            report
                .results
                .iter()
                .any(|r| r.outcome == Some(RecoveryOutcome::Reattached)),
            "{provider}: {report:?}"
        );
        assert!(matches!(
            fixture
                .supervisor
                .probe_recovery(fixture.soul.clone())
                .await
                .unwrap(),
            RecoveryProbe::ReattachReady {
                protocol_version: 1,
                ..
            }
        ));
        assert_eq!(
            fixture
                .supervisor
                .terminal_input(
                    RequestId::new(),
                    fixture.soul.clone(),
                    "owned fixture input".into()
                )
                .await
                .unwrap(),
            CommandState::Completed
        );
        let output = fixture
            .supervisor
            .terminal_read_output(fixture.soul.clone(), 0, 1024, None)
            .await
            .unwrap();
        assert_eq!(output.incarnation_id, fixture.incarnation);
        assert!(
            output.native_session_id.is_none(),
            "v1 output must not become new native identity authority"
        );
        fixture.supervisor.observe_once().await.unwrap();
        let after = fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap();
        assert_eq!(after.native_session_id, before.native_session_id);
        assert_eq!(after.resume_spec, before.resume_spec);
        assert_eq!(after.evidence_revision, before.evidence_revision);
        assert!(after.native_identity_launch.is_none());
        assert_eq!(
            after.prior_handle.incarnation_id(),
            before.prior_handle.incarnation_id()
        );
        assert_eq!(fixture.backend.qualifications.load(Ordering::SeqCst), 0);
        let requests = requests.lock().unwrap().clone();
        assert!(requests
            .iter()
            .any(|(v, m)| *v == 1 && m == "terminal_input"));
        assert!(requests
            .iter()
            .filter(|(_, m)| m != "hello")
            .all(|(v, _)| *v == 1));
        peer.abort();
    }
}

#[tokio::test]
async fn retained_v1_controls_and_observer_reject_drift_after_live_acceptance() {
    for changed_boot in [false, true] {
        for operation in ["input", "resize", "output", "observer"] {
            let mut fixture = Fixture::new("shell", false).await;
            let (peer, _) = fixture.peer(1, Fault::None).await;
            assert_eq!(
                fixture.recover().await.unwrap().outcome,
                RecoveryOutcome::Reattached
            );
            peer.abort();
            let _ = peer.await;
            std::fs::remove_file(fixture.runtime.join("host.sock")).unwrap();
            let fault = if changed_boot {
                fixture.boot = HostBootId::new();
                Fault::None
            } else {
                Fault::WrongGeneration
            };
            let (peer, requests) = fixture.peer(1, fault).await;
            match operation {
                "input" => {
                    let request_id = RequestId::new();
                    assert!(fixture
                        .supervisor
                        .terminal_input(
                            request_id.clone(),
                            fixture.soul.clone(),
                            "do not dispatch".into()
                        )
                        .await
                        .is_err());
                    let state: String = Connection::open(
                        fixture.supervisor.registry.database_path(),
                    )
                    .unwrap()
                    .query_row(
                        "SELECT state FROM input_commands WHERE soul_id=?1 AND request_id=?2",
                        params![fixture.soul.as_str(), request_id.as_str()],
                        |row| row.get(0),
                    )
                    .unwrap();
                    assert_eq!(
                        state, "ambiguous",
                        "guard failure must settle dispatch custody"
                    );
                    assert_eq!(
                        fixture
                            .supervisor
                            .terminal_input(
                                request_id,
                                fixture.soul.clone(),
                                "do not dispatch".into()
                            )
                            .await
                            .unwrap(),
                        CommandState::Ambiguous,
                        "replay must never resend input"
                    );
                }
                "resize" => assert!(fixture
                    .supervisor
                    .terminal_resize(fixture.soul.clone(), 100, 40)
                    .await
                    .is_err()),
                "output" => {
                    let _ = fixture
                        .supervisor
                        .terminal_read_output(fixture.soul.clone(), 0, 1024, None)
                        .await;
                }
                "observer" => {
                    fixture.supervisor.observe_once().await.unwrap();
                    let view = find_view(&fixture.supervisor.registry, &fixture.incarnation)
                        .await
                        .unwrap();
                    assert_ne!(
                        view.recovery_state,
                        freshell_runtime_protocol::RecoveryState::Live,
                        "{operation}, changed_boot={changed_boot}"
                    );
                }
                _ => unreachable!(),
            }
            let requests = requests.lock().unwrap().clone();
            assert!(
                requests
                    .iter()
                    .all(|(_, method)| method == "hello" || method == "status"),
                "{operation}, changed_boot={changed_boot}: {:?}",
                requests
            );
            assert_eq!(fixture.backend.qualifications.load(Ordering::SeqCst), 0);
            peer.abort();
        }
    }
}

#[tokio::test]
async fn retained_v1_authentication_failure_does_not_trigger_store_probe_or_replacement() {
    let fixture = Fixture::new("opencode", true).await;
    let (peer, _) = fixture.peer(1, Fault::BadProof).await;
    let before = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let result = fixture.recover().await.unwrap();
    assert_eq!(result.outcome, RecoveryOutcome::Blocked);
    assert_eq!(fixture.backend.qualifications.load(Ordering::SeqCst), 0);
    let after = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(after.native_session_id, before.native_session_id);
    assert_eq!(after.resume_spec, before.resume_spec);
    peer.abort();
}

#[tokio::test]
async fn retained_v1_continuation_rejects_changed_process_or_stop_intent() {
    for fault in [
        Fault::WrongStatusBoot,
        Fault::WrongGeneration,
        Fault::NoWorker,
        Fault::Exited,
        Fault::StopDuringStatus,
        Fault::WrongNativeIdentity,
        Fault::EvidenceChanged,
    ] {
        let fixture = Fixture::new("opencode", true).await;
        let (peer, _) = fixture.peer(1, fault).await;
        let result = fixture.recover().await;
        assert!(
            !result
                .as_ref()
                .is_ok_and(|r| r.outcome == RecoveryOutcome::Reattached),
            "{fault:?}: {result:?}"
        );
        let view = fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap();
        if fault == Fault::StopDuringStatus {
            assert_eq!(
                view.desired_state,
                freshell_runtime_protocol::DesiredState::Stopped
            );
        }
        assert_eq!(
            fixture.backend.qualifications.load(Ordering::SeqCst),
            0,
            "{fault:?}"
        );
        peer.abort();
    }
}

#[tokio::test]
async fn retained_host_handshake_only_downgrades_after_correlated_version_mismatch() {
    for fault in [Fault::NonVersionError, Fault::WrongReplyId] {
        let fixture = Fixture::new("shell", false).await;
        let (peer, requests) = fixture.peer(1, fault).await;
        assert!(fixture
            .supervisor
            .authenticate_host(&fixture.incarnation, &fixture.runtime)
            .await
            .is_err());
        assert_eq!(
            requests.lock().unwrap().len(),
            1,
            "{fault:?} must not trigger v1 fallback"
        );
        peer.abort();
    }
    let fixture = Fixture::new("shell", false).await;
    let (peer, requests) = fixture.peer(2, Fault::None).await;
    fixture
        .supervisor
        .authenticate_host(&fixture.incarnation, &fixture.runtime)
        .await
        .unwrap();
    assert_eq!(requests.lock().unwrap().as_slice(), [(2, "hello".into())]);
    peer.abort();
}

#[tokio::test]
async fn retained_v1_does_not_receive_native_or_execution_operations() {
    let fixture = Fixture::new("shell", false).await;
    let (peer, requests) = fixture.peer(1, Fault::None).await;
    let host = fixture
        .supervisor
        .authenticate_host(&fixture.incarnation, &fixture.runtime)
        .await
        .unwrap();
    let result = fixture
        .supervisor
        .send_authenticated_host_command(
            fixture.incarnation.clone(),
            &fixture.runtime,
            &host,
            HostCommand::FreshAgentPrepareNative {
                incarnation_id: fixture.incarnation.clone(),
                expected_launch: None,
                source_fence: None,
            },
        )
        .await;
    assert!(matches!(
        result,
        Err(RuntimeError {
            code: RuntimeErrorCode::UnsupportedOperation,
            ..
        })
    ));
    let grant = fixture
        .supervisor
        .send_authenticated_host_command(
            fixture.incarnation.clone(),
            &fixture.runtime,
            &host,
            HostCommand::GrantExecution {
                incarnation_id: fixture.incarnation.clone(),
                soul_id: fixture.soul.clone(),
                host_boot_id: fixture.boot.clone(),
                control_epoch: 1,
                execution_generation: 2,
                grant_id: freshell_runtime_protocol::GrantId::new(),
                fixture: None,
                provider_path_inputs: Default::default(),
                terminal: Some(Box::new(fixture.terminal.clone())),
                fresh_agent: None,
                resume_spec: None,
                dispatch_budget_ms: None,
                native_identity_launch: None,
                native_readiness_recovery: None,
            },
        )
        .await;
    assert!(matches!(
        grant,
        Err(RuntimeError {
            code: RuntimeErrorCode::UnsupportedOperation,
            ..
        })
    ));
    assert!(requests.lock().unwrap().iter().all(|(_, m)| m == "hello"));
    peer.abort();
}

#[tokio::test]
async fn retained_v1_continuation_does_not_qualify_an_unobserved_v2_provider() {
    let fixture = Fixture::new("opencode", false).await;
    let (peer, _) = fixture.peer(2, Fault::None).await;
    assert_eq!(
        fixture.recover().await.unwrap().outcome,
        RecoveryOutcome::Blocked
    );
    assert!(fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap()
        .native_identity_launch
        .is_none());
    peer.abort();
}

#[tokio::test]
async fn retained_v1_acceptance_cannot_bypass_a_modern_native_launch() {
    let fixture = Fixture::new("opencode", false).await;
    let before = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    let native = freshell_runtime_protocol::NativeIdentityLaunch {
        incarnation_id: fixture.incarnation.clone(),
        launch_nonce: before.prior_handle.launch_nonce().as_str().into(),
        evidence_revision: before.evidence_revision,
        execution_generation: 1,
        requested_native_session_id: None,
    };
    Connection::open(fixture.supervisor.registry.database_path())
        .unwrap()
        .execute(
            "UPDATE incarnations SET native_identity_launch=?1 WHERE incarnation_id=?2",
            params![
                serde_json::to_string(&native).unwrap(),
                fixture.incarnation.as_str()
            ],
        )
        .unwrap();
    assert!(fixture
        .supervisor
        .registry
        .mark_retained_terminal_live(
            fixture.soul.clone(),
            fixture.incarnation.clone(),
            fixture.boot.clone(),
            1,
            before.write_fence()
        )
        .await
        .is_err());
    assert!(fixture
        .supervisor
        .registry
        .mark_recovery_live(
            fixture.soul.clone(),
            fixture.incarnation.clone(),
            before.write_fence()
        )
        .await
        .is_err());
    let (peer, _) = fixture.peer(1, Fault::None).await;
    assert_eq!(
        fixture.recover().await.unwrap().outcome,
        RecoveryOutcome::Blocked
    );
    peer.abort();
}
