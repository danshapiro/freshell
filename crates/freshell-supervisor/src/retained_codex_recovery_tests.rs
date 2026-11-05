use super::*;
use crate::backend::{
    BackendCreated, BackendInspection, BackendRuntimeState, CreateRuntimeSpec, RuntimeBackend,
};
use crate::registry::OwnedRuntimeHandle;
use freshell_runtime_protocol::{
    FreshProvider, NativeDispatchIdentity, NativeIdentityLaunch, NativeIdentityObservation,
    NativeIdentitySource,
};
use rusqlite::{params, Connection};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use tokio::{net::UnixListener, sync::Notify, task::JoinHandle};

#[derive(Default)]
struct CountedBackend {
    ended: AtomicBool,
    stops: AtomicUsize,
    creates: AtomicUsize,
    hold_inspection: AtomicBool,
    inspecting: Notify,
    release_inspection: Notify,
}

#[async_trait::async_trait]
impl RuntimeBackend for CountedBackend {
    async fn inspect(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<BackendInspection, BackendError> {
        if self.hold_inspection.load(Ordering::SeqCst) {
            self.inspecting.notify_one();
            self.release_inspection.notified().await;
        }
        Ok(BackendInspection {
            state: if self.ended.load(Ordering::SeqCst) {
                BackendRuntimeState::Exited
            } else {
                BackendRuntimeState::Running
            },
            configured_limits: handle.requested_limits(),
        })
    }
    async fn create_stopped(&self, _: &CreateRuntimeSpec) -> Result<BackendCreated, BackendError> {
        self.creates.fetch_add(1, Ordering::SeqCst);
        Err(BackendError::Unavailable(
            "controlled replacement unavailable".into(),
        ))
    }
    async fn start_host(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        panic!("no replacement was created")
    }
    async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        self.ended.store(true, Ordering::SeqCst);
        Ok(())
    }
    async fn force_stop(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        self.request_stop(handle, 0).await
    }
    async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
        Ok(self.ended.load(Ordering::SeqCst))
    }
    async fn list_known(
        &self,
        _: &[OwnedRuntimeHandle],
    ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
        panic!("observer uses exact handles")
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

struct ControlledCodex {
    _root: tempfile::TempDir,
    supervisor: Supervisor,
    soul: SoulId,
    incarnation: IncarnationId,
    backend: Arc<CountedBackend>,
    source: Arc<std::sync::Mutex<NativeIdentityObservation>>,
    exited: Arc<AtomicBool>,
    inputs: Arc<AtomicUsize>,
    prepares: Arc<AtomicUsize>,
    compacts: Arc<AtomicUsize>,
    statuses: Arc<AtomicUsize>,
    hold_ack: Arc<AtomicBool>,
    sending: Arc<Notify>,
    release: Arc<Notify>,
    transient_status: Arc<Notify>,
    worker: Arc<AtomicBool>,
    capability: Arc<AtomicBool>,
    bad_ack: Arc<AtomicBool>,
    prepare_refuse: Arc<AtomicBool>,
    host_epoch: Arc<AtomicU64>,
    peer: JoinHandle<()>,
}

impl ControlledCodex {
    async fn new() -> Self {
        Self::with_registry_reopen(false).await
    }
    async fn with_registry_reopen(reopen: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(root.path().join("registry"), None).unwrap();
        let soul = SoulId::new();
        let prepared =
            crate::registry::tests::materialize_fresh_runtime(&registry, soul.clone(), root.path())
                .await;
        let runtime = root.path().join("host");
        std::fs::create_dir(&runtime).unwrap();
        std::fs::write(runtime.join("secret"), b"synthetic-secret").unwrap();
        let mut agent = registry
            .recovery_context(soul.clone())
            .await
            .unwrap()
            .fresh_agent
            .unwrap();
        agent.provider = FreshProvider::Codex;
        agent.session_type = "freshcodex".into();
        agent.runtime_variant = "codex-app-server-v1".into();
        let boot = HostBootId::new();
        let conn = Connection::open(registry.database_path()).unwrap();
        conn.execute(
            "UPDATE souls SET provider='codex' WHERE soul_id=?1",
            [soul.as_str()],
        )
        .unwrap();
        conn.execute("UPDATE incarnations SET runtime_dir=?1,execution_generation=1,host_boot_id=?2,fresh_agent_spec=?3,fixture_kind=NULL WHERE incarnation_id=?4",params![runtime.to_string_lossy(),boot.as_str(),serde_json::to_string(&agent).unwrap(),prepared.incarnation_id.as_str()]).unwrap();
        registry
            .record_native_session(
                soul.clone(),
                prepared.incarnation_id.clone(),
                "native-parent".into(),
            )
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let launch = NativeIdentityLaunch {
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: context.prior_handle.launch_nonce().as_str().into(),
            evidence_revision: 7,
            execution_generation: 1,
            requested_native_session_id: Some("native-parent".into()),
        };
        registry
            .bind_native_identity_launch(launch.clone())
            .await
            .unwrap();
        let parent = NativeIdentityObservation {
            native_session_id: "native-parent".into(),
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: launch.launch_nonce.clone(),
            evidence_revision: 7,
            source: NativeIdentitySource::FreshProviderHandshake,
            evidence_digest: "a".repeat(64),
        };
        registry
            .record_native_identity_observation(
                soul.clone(),
                parent.clone(),
                registry.recovery_write_fence(soul.clone()).await.unwrap(),
            )
            .await
            .unwrap();
        let context = registry.recovery_context(soul.clone()).await.unwrap();
        let candidate =
            crate::resume_catalog::exact_resume_candidate(&context, Some("native-parent"))
                .unwrap()
                .unwrap();
        registry
            .store_verified_resume_spec(soul.clone(), candidate)
            .await
            .unwrap();
        let source = Arc::new(std::sync::Mutex::new(parent));
        let exited = Arc::new(AtomicBool::new(true));
        let inputs = Arc::new(AtomicUsize::new(0));
        let prepares = Arc::new(AtomicUsize::new(0));
        let compacts = Arc::new(AtomicUsize::new(0));
        let statuses = Arc::new(AtomicUsize::new(0));
        let hold_ack = Arc::new(AtomicBool::new(false));
        let sending = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let transient_status = Arc::new(Notify::new());
        let worker = Arc::new(AtomicBool::new(true));
        let capability = Arc::new(AtomicBool::new(true));
        let bad_ack = Arc::new(AtomicBool::new(false));
        let prepare_refuse = Arc::new(AtomicBool::new(false));
        let host_epoch = Arc::new(AtomicU64::new(registry.control_epoch()));
        let listener = UnixListener::bind(runtime.join("host.sock")).unwrap();
        let peer = {
            let source = source.clone();
            let exited = exited.clone();
            let inputs = inputs.clone();
            let prepares = prepares.clone();
            let compacts = compacts.clone();
            let statuses = statuses.clone();
            let hold_ack = hold_ack.clone();
            let sending = sending.clone();
            let release = release.clone();
            let transient_status = transient_status.clone();
            let worker = worker.clone();
            let capability = capability.clone();
            let bad_ack = bad_ack.clone();
            let prepare_refuse = prepare_refuse.clone();
            let host_epoch = host_epoch.clone();
            tokio::spawn(async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let source = source.clone();
                    let exited = exited.clone();
                    let inputs = inputs.clone();
                    let prepares = prepares.clone();
                    let compacts = compacts.clone();
                    let statuses = statuses.clone();
                    let hold_ack = hold_ack.clone();
                    let sending = sending.clone();
                    let release = release.clone();
                    let boot = boot.clone();
                    let launch = launch.clone();
                    let transient_status = transient_status.clone();
                    let worker = worker.clone();
                    let capability = capability.clone();
                    let bad_ack = bad_ack.clone();
                    let prepare_refuse = prepare_refuse.clone();
                    let host_epoch = host_epoch.clone();
                    tokio::spawn(async move {
                        let request: Envelope<HostCommand> = read_frame(&mut socket).await.unwrap();
                        if !matches!(request.body, HostCommand::Hello { .. }) {
                            assert_eq!(
                                request.auth,
                                Some(host_proof(
                                    b"synthetic-secret",
                                    "command-auth",
                                    &boot,
                                    &launch.incarnation_id
                                ))
                            );
                        }
                        let result = match request.body {
                            HostCommand::Hello {
                                incarnation_id,
                                challenge,
                            } => HostResult::Hello {
                                proof: host_proof(
                                    b"synthetic-secret",
                                    &challenge,
                                    &boot,
                                    &incarnation_id,
                                ),
                                host_boot_id: boot.clone(),
                                capabilities: {
                                    let mut values = vec![
                                        "owned-provider-config-v1".into(),
                                        "provider-store-probe-v1".into(),
                                        "native-identity-observation-v1".into(),
                                    ];
                                    if capability.load(Ordering::SeqCst) {
                                        values.push("fresh-agent-codex-recovery-source-v1".into());
                                        values.push(
                                            "fresh-agent-codex-same-root-readiness-v1".into(),
                                        );
                                    }
                                    values
                                },
                                effective_limits: context.requested_limits,
                            },
                            HostCommand::Status { .. } => {
                                statuses.fetch_add(1, Ordering::SeqCst);
                                let ended = exited.load(Ordering::SeqCst);
                                let observation = source.lock().unwrap().clone();
                                HostResult::Status {
                                    fresh_agent_recovery_source: if hold_ack.load(Ordering::SeqCst)
                                        && inputs.load(Ordering::SeqCst) > 0
                                    {
                                        transient_status.notify_one();
                                        None
                                    } else {
                                        ended.then(|| observation.clone())
                                    },
                                    host_boot_id: boot,
                                    worker_pid: worker.load(Ordering::SeqCst).then_some(123),
                                    worker_launch_count: 1,
                                    max_control_epoch: host_epoch.load(Ordering::SeqCst),
                                    max_execution_generation: 1,
                                    fixture_evidence: serde_json::json!({"workload":"fresh-agent"}),
                                    exited: ended,
                                    native_session_id: (!ended)
                                        .then(|| observation.native_session_id.clone()),
                                    native_identity_observation: (!ended).then_some(observation),
                                    opencode_transfer_receipt: None,
                                    opencode_adoption: Default::default(),
                                }
                            }
                            HostCommand::FreshAgentSend { .. } => {
                                inputs.fetch_add(1, Ordering::SeqCst);
                                sending.notify_one();
                                if hold_ack.load(Ordering::SeqCst) {
                                    release.notified().await;
                                }
                                let previous = source.lock().unwrap().native_session_id.clone();
                                {
                                    let mut observation = source.lock().unwrap();
                                    observation.native_session_id = "native-child".into();
                                    observation.evidence_revision = 8;
                                }
                                exited.store(false, Ordering::SeqCst);
                                HostResult::FreshAgentCommand {
                                    state: CommandState::ProviderAcked,
                                    claude_fork: None,
                                    native_session_id: Some("native-child".into()),
                                    native_identity: Some(NativeDispatchIdentity {
                                        previous_native_session_id: if bad_ack
                                            .load(Ordering::SeqCst)
                                        {
                                            "foreign-ack-source".into()
                                        } else {
                                            previous
                                        },
                                        native_session_id: "native-child".into(),
                                        pending_naming_handle: None,
                                    }),
                                }
                            }
                            HostCommand::FreshAgentPrepareSameRootNative { .. } => {
                                prepares.fetch_add(1, Ordering::SeqCst);
                                if prepare_refuse.load(Ordering::SeqCst) {
                                    write_frame(
                                        &mut socket,
                                        &HostReply {
                                            request_id: request.request_id,
                                            result: Err(RuntimeError::new(
                                                RuntimeErrorCode::RecoveryBlocked,
                                                "same-root history is unavailable",
                                            )),
                                        },
                                    )
                                    .await
                                    .unwrap();
                                    return;
                                }
                                sending.notify_one();
                                if hold_ack.load(Ordering::SeqCst) {
                                    release.notified().await;
                                }
                                exited.store(false, Ordering::SeqCst);
                                HostResult::FreshAgentCommand {
                                    state: CommandState::ProviderAcked,
                                    claude_fork: None,
                                    native_identity: None,
                                    native_session_id: Some(
                                        source.lock().unwrap().native_session_id.clone(),
                                    ),
                                }
                            }
                            HostCommand::FreshAgentCompact { .. } => {
                                assert!(!exited.load(Ordering::SeqCst));
                                compacts.fetch_add(1, Ordering::SeqCst);
                                sending.notify_one();
                                if hold_ack.load(Ordering::SeqCst) {
                                    release.notified().await;
                                }
                                HostResult::FreshAgentCommand {
                                    state: CommandState::ProviderAcked,
                                    claude_fork: None,
                                    native_identity: None,
                                    native_session_id: Some(
                                        source.lock().unwrap().native_session_id.clone(),
                                    ),
                                }
                            }
                            HostCommand::ProbeRecovery {
                                resume_spec: Some(resume_spec),
                                ..
                            } => HostResult::RecoveryProbe(
                                freshell_runtime_protocol::RecoveryProbe::ResumeReady {
                                    evidence_revision: resume_spec.evidence_revision,
                                    resume_spec,
                                },
                            ),
                            HostCommand::Stop { .. } => HostResult::Stopped,
                            other => panic!("unexpected controlled Codex command {other:?}"),
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
                    });
                }
            })
        };
        let registry = if reopen {
            let registry_root = registry.registry_root().to_path_buf();
            drop(registry);
            Registry::open(registry_root, None).unwrap()
        } else {
            registry
        };
        let backend = Arc::new(CountedBackend::default());
        let supervisor = Supervisor::new(
            registry,
            backend.clone(),
            SupervisorConfig {
                runtime_root: root.path().join("runtime"),
                control_socket_path: root.path().join("control.sock"),
                host_binary_path: std::env::current_exe().unwrap(),
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "retained-codex".into(),
                control_secret: "synthetic-secret".into(),
                lifecycle_log: root.path().join("lifecycle.jsonl"),
                admission: crate::admission::AdmissionPolicy::default(),
            },
        )
        .unwrap();
        Self {
            _root: root,
            supervisor,
            soul,
            incarnation: prepared.incarnation_id,
            backend,
            source,
            exited,
            inputs,
            prepares,
            compacts,
            statuses,
            hold_ack,
            sending,
            release,
            transient_status,
            worker,
            capability,
            bad_ack,
            prepare_refuse,
            host_epoch,
            peer,
        }
    }
    async fn send(&self, request_id: RequestId) -> Result<AdminResult, RuntimeError> {
        self.supervisor
            .dispatch(Envelope {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                request_id,
                role: ControlRole::Web,
                auth: Some("synthetic-secret".into()),
                body: AdminCommand::FreshAgentSend(
                    freshell_runtime_protocol::FreshAgentSendRequest {
                        soul_id: self.soul.clone(),
                        text: "original public reference input".into(),
                        settings: None,
                        expected_control_epoch: Some(self.supervisor.registry.control_epoch()),
                        checkpoint_logical_attempt_id: None,
                    },
                ),
            })
            .await
            .result
    }
    async fn compact(&self) -> Result<AdminResult, RuntimeError> {
        self.supervisor
            .dispatch(Envelope {
                protocol_version: CONTROL_PROTOCOL_VERSION,
                request_id: RequestId::new(),
                role: ControlRole::Web,
                auth: Some("synthetic-secret".into()),
                body: AdminCommand::FreshAgentCompact(
                    freshell_runtime_protocol::FreshAgentCompactRequest {
                        soul_id: self.soul.clone(),
                        instructions: None,
                        cwd: None,
                        expected_control_epoch: Some(self.supervisor.registry.control_epoch()),
                    },
                ),
            })
            .await
            .result
    }
    fn attempts(&self) -> u64 {
        Connection::open(self.supervisor.registry.database_path())
            .unwrap()
            .query_row("SELECT COUNT(*) FROM recovery_attempts", [], |row| {
                row.get(0)
            })
            .unwrap()
    }
    async fn assert_retained(&self) {
        let context = self
            .supervisor
            .registry
            .recovery_context(self.soul.clone())
            .await
            .unwrap();
        assert_eq!(context.prior_handle.incarnation_id(), &self.incarnation);
        let writer: (String, String) = Connection::open(self.supervisor.registry.database_path())
            .unwrap()
            .query_row(
                "SELECT native_session_id,incarnation_id FROM writer_claims WHERE soul_id=?1",
                [self.soul.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            Some(writer.0.as_str()),
            context.native_session_id.as_deref()
        );
        assert_eq!(writer.1, self.incarnation.as_str());
        assert_eq!(
            self.backend.stops.load(Ordering::SeqCst),
            0,
            "eligible actor never stops its container"
        );
        assert_eq!(
            self.backend.creates.load(Ordering::SeqCst),
            0,
            "eligible actor never replaces its container"
        );
        assert_eq!(
            self.attempts(),
            0,
            "retained actor classification spends no recovery attempt"
        );
    }
}

#[tokio::test]
async fn registry_reopen_observer_retains_older_live_host() {
    let fixture = ControlledCodex::with_registry_reopen(true).await;
    assert_eq!(
        fixture.host_epoch.load(Ordering::SeqCst) + 1,
        fixture.supervisor.registry.control_epoch()
    );
    fixture.supervisor.observe_once().await.unwrap();
    fixture.assert_retained().await;
}

#[tokio::test]
async fn registry_reopen_public_send_recovers_older_live_host() {
    let fixture = ControlledCodex::with_registry_reopen(true).await;
    fixture.send(RequestId::new()).await.unwrap();
    fixture.send(RequestId::new()).await.unwrap();
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 2);
    fixture.assert_retained().await;
}

#[tokio::test]
async fn registry_reopen_public_compact_prepares_older_live_host() {
    let fixture = ControlledCodex::with_registry_reopen(true).await;
    fixture.compact().await.unwrap();
    assert_eq!(fixture.prepares.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.compacts.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    fixture.assert_retained().await;
}

#[tokio::test]
async fn newer_host_controller_refuses_retained_recovery() {
    let fixture = ControlledCodex::with_registry_reopen(true).await;
    fixture.host_epoch.store(
        fixture.supervisor.registry.control_epoch() + 1,
        Ordering::SeqCst,
    );
    assert!(fixture.send(RequestId::new()).await.is_err());
    assert!(fixture.compact().await.is_err());
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.prepares.load(Ordering::SeqCst), 0);
    fixture.supervisor.observe_once().await.unwrap();
    assert_eq!(fixture.attempts(), 1);
    assert_eq!(fixture.backend.creates.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn backend_inspection_does_not_block_public_send() {
    let fixture = Arc::new(ControlledCodex::new().await);
    fixture
        .backend
        .hold_inspection
        .store(true, Ordering::SeqCst);
    let observer = {
        let fixture = fixture.clone();
        tokio::spawn(async move { fixture.supervisor.observe_once().await })
    };
    fixture.backend.inspecting.notified().await;
    let result = tokio::time::timeout(Duration::from_secs(2), fixture.send(RequestId::new())).await;
    fixture
        .backend
        .hold_inspection
        .store(false, Ordering::SeqCst);
    fixture.backend.release_inspection.notify_one();
    observer.await.unwrap().unwrap();
    result
        .expect("public SEND must complete while backend inspection remains held")
        .unwrap();
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    fixture.assert_retained().await;
}

#[tokio::test]
async fn backend_inspection_rechecks_current_owner_before_host_calls() {
    let fixture = Arc::new(ControlledCodex::new().await);
    fixture
        .backend
        .hold_inspection
        .store(true, Ordering::SeqCst);
    let observer = {
        let fixture = fixture.clone();
        tokio::spawn(async move { fixture.supervisor.observe_once().await })
    };
    fixture.backend.inspecting.notified().await;
    fixture
        .supervisor
        .registry
        .begin_stop(fixture.soul.clone())
        .await
        .unwrap();
    fixture
        .backend
        .hold_inspection
        .store(false, Ordering::SeqCst);
    fixture.backend.release_inspection.notify_one();
    observer.await.unwrap().unwrap();
    assert_eq!(
        fixture.statuses.load(Ordering::SeqCst),
        0,
        "stale backend observation must not contact the revoked owner"
    );
    assert_eq!(fixture.attempts(), 0);
    assert_eq!(fixture.backend.creates.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn observer_logs_retention_transitions_once_per_state() {
    let fixture = ControlledCodex::new().await;
    for _ in 0..3 {
        fixture.supervisor.observe_once().await.unwrap();
    }
    fixture.send(RequestId::new()).await.unwrap();
    for _ in 0..3 {
        fixture.supervisor.observe_once().await.unwrap();
    }
    let events = std::fs::read_to_string(&fixture.supervisor.config.lifecycle_log).unwrap();
    let transitions = events
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|event| event["event"] == "supervisor.runtime_observer.retained_codex_actor")
        .collect::<Vec<_>>();
    assert_eq!(
        transitions.len(),
        2,
        "one entry and one exit, without per-tick repetition"
    );
    assert_eq!(transitions[0]["data"]["retained"], true);
    assert_eq!(transitions[1]["data"]["retained"], false);
    for event in transitions {
        assert_eq!(event["data"]["severity"], "info");
        assert_eq!(event["data"]["soulId"], fixture.soul.as_str());
        assert_eq!(event["data"]["incarnationId"], fixture.incarnation.as_str());
        assert_eq!(event["data"]["nativeSessionId"], "native-parent");
    }
    fixture.assert_retained().await;
}
impl Drop for ControlledCodex {
    fn drop(&mut self) {
        self.peer.abort();
    }
}

#[tokio::test]
async fn public_compact_prepares_retained_codex_same_root_without_input_or_replacement() {
    let fixture = ControlledCodex::new().await;
    fixture.supervisor.observe_once().await.unwrap();
    fixture.assert_retained().await;
    let before = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert!(matches!(
        fixture.compact().await.unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::ProviderAcked
        }
    ));
    fixture.compact().await.unwrap();
    let after = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(before.native_session_id, after.native_session_id);
    assert_eq!(before.write_fence(), after.write_fence());
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.prepares.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.compacts.load(Ordering::SeqCst), 2);
    fixture.assert_retained().await;
}

#[tokio::test]
async fn observer_retains_eligible_codex_actor_without_attempts_then_host_loss_uses_supervisor() {
    let fixture = ControlledCodex::new().await;
    assert!(matches!(
        fixture
            .supervisor
            .probe_recovery_locked(fixture.soul.clone())
            .await
            .unwrap(),
        freshell_runtime_protocol::RecoveryProbe::ReattachReady { .. }
    ));
    for _ in 0..3 {
        fixture.supervisor.observe_once().await.unwrap();
        fixture.assert_retained().await;
    }
    fixture.peer.abort();
    fixture.backend.ended.store(true, Ordering::SeqCst);
    fixture.supervisor.observe_once().await.unwrap();
    assert!(
        fixture.attempts() > 0,
        "whole host loss must return to supervisor recovery"
    );
    assert_eq!(
        fixture.backend.creates.load(Ordering::SeqCst),
        1,
        "one bounded supervisor replacement attempt"
    );
}

#[tokio::test]
async fn public_send_recovers_retained_codex_source_and_commits_before_second_input() {
    let fixture = ControlledCodex::new().await;
    assert!(matches!(
        fixture.send(RequestId::new()).await.unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::ProviderAcked
        }
    ));
    fixture.assert_retained().await;
    let context = fixture
        .supervisor
        .registry
        .recovery_context(fixture.soul.clone())
        .await
        .unwrap();
    assert_eq!(context.native_session_id.as_deref(), Some("native-child"));
    fixture.supervisor.observe_once().await.unwrap();
    fixture.send(RequestId::new()).await.unwrap();
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 2);
    fixture.assert_retained().await;
}

#[tokio::test]
async fn public_send_refuses_uncommitted_child_after_native_exit() {
    let fixture = ControlledCodex::new().await;
    {
        let mut source = fixture.source.lock().unwrap();
        source.native_session_id = "uncommitted-child".into();
        source.evidence_revision = 8;
    }
    assert!(fixture.send(RequestId::new()).await.is_err());
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-parent")
    );
}

#[tokio::test]
async fn observer_does_not_spend_attempt_while_native_ack_is_in_flight() {
    let fixture = Arc::new(ControlledCodex::new().await);
    fixture.hold_ack.store(true, Ordering::SeqCst);
    let send = {
        let fixture = fixture.clone();
        tokio::spawn(async move { fixture.send(RequestId::new()).await })
    };
    fixture.sending.notified().await;
    let mut observer = {
        let fixture = fixture.clone();
        tokio::spawn(async move { fixture.supervisor.observe_once().await })
    };
    tokio::select! {
        result=&mut observer=>{result.unwrap().unwrap();},
        _=fixture.transient_status.notified()=>{fixture.release.notify_one();(&mut observer).await.unwrap().unwrap();}
    }
    fixture.release.notify_one();
    send.await.unwrap().unwrap();
    fixture.hold_ack.store(false, Ordering::SeqCst);
    fixture.assert_retained().await;
    fixture.supervisor.observe_once().await.unwrap();
    fixture.assert_retained().await;
}

#[tokio::test]
async fn public_compact_rechecks_writer_and_generation_after_held_readiness() {
    for case in [
        "writer",
        "generation",
        "source",
        "nonce",
        "revision",
        "host-boot",
        "intent",
        "stopped",
        "capability",
        "future-control-epoch",
    ] {
        let fixture = Arc::new(ControlledCodex::new().await);
        fixture.hold_ack.store(true, Ordering::SeqCst);
        let compact = {
            let fixture = fixture.clone();
            tokio::spawn(async move { fixture.compact().await })
        };
        fixture.sending.notified().await;
        tokio::time::timeout(Duration::from_secs(2), fixture.supervisor.observe_once())
            .await
            .unwrap()
            .unwrap();
        fixture.assert_retained().await;
        let conn = Connection::open(fixture.supervisor.registry.database_path()).unwrap();
        match case {
            "writer" => {
                conn.execute("DELETE FROM writer_claims", []).unwrap();
            }
            "generation" => {
                conn.execute("UPDATE incarnations SET execution_generation=2", [])
                    .unwrap();
            }
            "source" => fixture.source.lock().unwrap().native_session_id = "foreign-root".into(),
            "nonce" => fixture.source.lock().unwrap().launch_nonce = "foreign-nonce".into(),
            "revision" => fixture.source.lock().unwrap().evidence_revision += 1,
            "host-boot" => {
                conn.execute(
                    "UPDATE incarnations SET host_boot_id=?1",
                    [HostBootId::new().as_str()],
                )
                .unwrap();
            }
            "intent" => {
                conn.execute("UPDATE souls SET intent_revision=intent_revision+1", [])
                    .unwrap();
            }
            "stopped" => {
                conn.execute("UPDATE souls SET desired_state='stopped'", [])
                    .unwrap();
            }
            "capability" => fixture.capability.store(false, Ordering::SeqCst),
            "future-control-epoch" => fixture.host_epoch.store(
                fixture.supervisor.registry.control_epoch() + 1,
                Ordering::SeqCst,
            ),
            _ => unreachable!(),
        }
        fixture.release.notify_one();
        assert!(
            compact.await.unwrap().is_err(),
            "changed {case} must refuse before strict Compact"
        );
        assert_eq!(fixture.prepares.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.compacts.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.attempts(), 0);
    }
}

#[tokio::test]
async fn public_compact_refusal_preserves_later_explicit_send_recovery() {
    let fixture = ControlledCodex::new().await;
    fixture.prepare_refuse.store(true, Ordering::SeqCst);
    assert!(fixture.compact().await.is_err());
    fixture.supervisor.observe_once().await.unwrap();
    fixture.assert_retained().await;
    assert_eq!(fixture.compacts.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
    fixture.send(RequestId::new()).await.unwrap();
    fixture.send(RequestId::new()).await.unwrap();
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 2);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-child")
    );
    fixture.assert_retained().await;
}

#[tokio::test]
async fn observer_during_compact_readiness_and_compact_does_not_spend_attempt() {
    for preparing in [false, true] {
        let fixture = Arc::new(ControlledCodex::new().await);
        fixture.exited.store(preparing, Ordering::SeqCst);
        fixture.hold_ack.store(true, Ordering::SeqCst);
        let operation = {
            let fixture = fixture.clone();
            tokio::spawn(async move { fixture.compact().await })
        };
        fixture.sending.notified().await;
        tokio::time::timeout(Duration::from_secs(2), fixture.supervisor.observe_once())
            .await
            .unwrap()
            .unwrap();
        fixture.assert_retained().await;
        fixture.hold_ack.store(false, Ordering::SeqCst);
        fixture.release.notify_one();
        operation.await.unwrap().unwrap();
        fixture.assert_retained().await;
        fixture.peer.abort();
        fixture.backend.ended.store(true, Ordering::SeqCst);
        fixture.supervisor.observe_once().await.unwrap();
        assert_eq!(fixture.backend.creates.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.attempts(), 1);
    }
}

#[tokio::test]
async fn public_send_recovery_keeps_owner_source_and_control_fences() {
    for case in [
        "nonce",
        "revision",
        "incarnation",
        "source",
        "missing-source",
        "worker",
        "capability",
        "writer",
        "foreign-writer-incarnation",
        "foreign-writer-soul",
        "stale-writer-intent",
        "host-boot",
        "generation",
        "db-generation",
        "stopped",
        "provider",
        "fixture",
    ] {
        let fixture = ControlledCodex::new().await;
        let conn = Connection::open(fixture.supervisor.registry.database_path()).unwrap();
        match case {
            "nonce" => fixture.source.lock().unwrap().launch_nonce = "old-launch".into(),
            "revision" => fixture.source.lock().unwrap().evidence_revision += 1,
            "incarnation" => fixture.source.lock().unwrap().incarnation_id = IncarnationId::new(),
            "source" => {
                fixture.source.lock().unwrap().source = NativeIdentitySource::CodexAppServer
            }
            "missing-source" => {
                fixture.hold_ack.store(true, Ordering::SeqCst);
                fixture.inputs.store(1, Ordering::SeqCst);
            }
            "worker" => fixture.worker.store(false, Ordering::SeqCst),
            "capability" => fixture.capability.store(false, Ordering::SeqCst),
            "writer" => {
                conn.execute(
                    "DELETE FROM writer_claims WHERE soul_id=?1",
                    [fixture.soul.as_str()],
                )
                .unwrap();
            }
            "foreign-writer-incarnation" | "foreign-writer-soul" => {
                let foreign_soul = SoulId::new();
                let foreign = crate::registry::tests::materialize_fresh_runtime(
                    &fixture.supervisor.registry,
                    foreign_soul.clone(),
                    fixture._root.path(),
                )
                .await;
                if case == "foreign-writer-incarnation" {
                    conn.execute(
                        "UPDATE writer_claims SET incarnation_id=?1 WHERE soul_id=?2",
                        params![foreign.incarnation_id.as_str(), fixture.soul.as_str()],
                    )
                    .unwrap();
                } else {
                    conn.execute(
                        "UPDATE writer_claims SET soul_id=?1 WHERE soul_id=?2",
                        params![foreign_soul.as_str(), fixture.soul.as_str()],
                    )
                    .unwrap();
                }
            }
            "stale-writer-intent" => {
                conn.execute(
                    "UPDATE writer_claims SET intent_revision=intent_revision+1 WHERE soul_id=?1",
                    [fixture.soul.as_str()],
                )
                .unwrap();
            }
            "host-boot" => {
                conn.execute(
                    "UPDATE incarnations SET host_boot_id=?1 WHERE incarnation_id=?2",
                    params![HostBootId::new().as_str(), fixture.incarnation.as_str()],
                )
                .unwrap();
            }
            "generation" => {
                let mut context = fixture
                    .supervisor
                    .registry
                    .recovery_context(fixture.soul.clone())
                    .await
                    .unwrap()
                    .native_identity_launch
                    .unwrap();
                context.execution_generation += 1;
                conn.execute(
                    "UPDATE incarnations SET native_identity_launch=?1 WHERE incarnation_id=?2",
                    params![
                        serde_json::to_string(&context).unwrap(),
                        fixture.incarnation.as_str()
                    ],
                )
                .unwrap();
            }
            "db-generation" => {
                conn.execute(
                    "UPDATE incarnations SET execution_generation=2 WHERE incarnation_id=?1",
                    [fixture.incarnation.as_str()],
                )
                .unwrap();
            }
            "stopped" => {
                fixture
                    .supervisor
                    .registry
                    .begin_stop(fixture.soul.clone())
                    .await
                    .unwrap();
            }
            "provider" => {
                conn.execute(
                    "UPDATE souls SET provider='claude' WHERE soul_id=?1",
                    [fixture.soul.as_str()],
                )
                .unwrap();
            }
            "fixture" => {
                let mut context = fixture
                    .supervisor
                    .registry
                    .recovery_context(fixture.soul.clone())
                    .await
                    .unwrap()
                    .fresh_agent
                    .unwrap();
                context.fixture_transport =
                    Some(freshell_runtime_protocol::FreshAgentFixtureTransport::Deterministic);
                conn.execute(
                    "UPDATE incarnations SET fresh_agent_spec=?1 WHERE incarnation_id=?2",
                    params![
                        serde_json::to_string(&context).unwrap(),
                        fixture.incarnation.as_str()
                    ],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        let before = fixture.inputs.load(Ordering::SeqCst);
        assert!(fixture.send(RequestId::new()).await.is_err(), "{case}");
        assert!(fixture.compact().await.is_err(), "{case} Compact");
        assert_eq!(
            fixture.prepares.load(Ordering::SeqCst),
            0,
            "{case} never prepares"
        );
        assert_eq!(
            fixture.compacts.load(Ordering::SeqCst),
            0,
            "{case} never compacts"
        );
        assert_eq!(
            fixture.inputs.load(Ordering::SeqCst),
            before,
            "{case} never dispatches"
        );
    }
}

#[tokio::test]
async fn retained_codex_recovery_does_not_admit_native_controls() {
    let fixture = ControlledCodex::new().await;
    assert!(fixture
        .supervisor
        .fresh_agent_resolve(
            fixture.soul.clone(),
            "unobserved-control".into(),
            serde_json::json!({"behavior":"allow"}),
            None,
        )
        .await
        .is_err());
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn bad_native_ack_is_ambiguous_and_cannot_replay_or_admit_uncommitted_source() {
    let fixture = ControlledCodex::new().await;
    fixture.bad_ack.store(true, Ordering::SeqCst);
    let request = RequestId::new();
    assert_eq!(
        fixture.send(request.clone()).await.unwrap_err().code,
        RuntimeErrorCode::OwnershipMismatch
    );
    assert!(matches!(
        fixture.send(request).await.unwrap(),
        AdminResult::FreshAgentCommand {
            state: CommandState::Ambiguous
        }
    ));
    fixture.exited.store(true, Ordering::SeqCst);
    assert!(fixture.send(RequestId::new()).await.is_err());
    assert_eq!(fixture.inputs.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture
            .supervisor
            .registry
            .recovery_context(fixture.soul.clone())
            .await
            .unwrap()
            .native_session_id
            .as_deref(),
        Some("native-parent")
    );
}
