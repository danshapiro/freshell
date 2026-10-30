use super::*;
use freshell_runtime_protocol::{
    host_proof, AgentEventBatch, AgentJournalEvent, CommandState, HostBootId, HostCommand,
    HostReply, HostResult, NativeIdentityLaunch, NativeIdentityObservation, NativeIdentitySource,
    OpenCodeAdoptionStatus,
};
use std::sync::atomic::{AtomicBool, Ordering};

const NATIVE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// Runtime allocation/Stop are forbidden; a best-effort read-only probe after
// Started may fail without blocking the independently verified live session.
struct ReadinessBackend;
#[async_trait::async_trait]
impl freshell_supervisor::backend::RuntimeBackend for ReadinessBackend {
    async fn create_stopped(
        &self,
        _: &freshell_supervisor::backend::CreateRuntimeSpec,
    ) -> Result<
        freshell_supervisor::backend::BackendCreated,
        freshell_supervisor::backend::BackendError,
    > {
        unreachable!("resume must not allocate")
    }
    async fn start_host(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
    ) -> Result<(), freshell_supervisor::backend::BackendError> {
        unreachable!("resume must not start another host")
    }
    async fn inspect(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
    ) -> Result<
        freshell_supervisor::backend::BackendInspection,
        freshell_supervisor::backend::BackendError,
    > {
        Err(freshell_supervisor::backend::BackendError::Unavailable(
            "owned optional probe unavailable".into(),
        ))
    }
    async fn request_stop(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
        _: u64,
    ) -> Result<(), freshell_supervisor::backend::BackendError> {
        unreachable!("resume must not stop a runtime")
    }
    async fn force_stop(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
    ) -> Result<(), freshell_supervisor::backend::BackendError> {
        unreachable!("resume must not force stop a runtime")
    }
    async fn verify_empty(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
    ) -> Result<bool, freshell_supervisor::backend::BackendError> {
        unreachable!("resume must not replace a runtime")
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
        Err(freshell_supervisor::backend::BackendError::Unavailable(
            "owned optional probe unavailable".into(),
        ))
    }
    async fn read_limits(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
    ) -> Result<RuntimeLimits, freshell_supervisor::backend::BackendError> {
        Err(freshell_supervisor::backend::BackendError::Unavailable(
            "owned optional probe unavailable".into(),
        ))
    }
    async fn enable_long_lived(
        &self,
        _: &freshell_supervisor::registry::OwnedRuntimeHandle,
    ) -> Result<(), freshell_supervisor::backend::BackendError> {
        unreachable!("resume must not mutate runtime limits")
    }
}

struct OwnedTasks(Vec<tokio::task::JoinHandle<()>>);
impl Drop for OwnedTasks {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

pub(super) struct ReadinessFixture {
    pub(super) root: tempfile::TempDir,
    pub(super) workspace: std::path::PathBuf,
    pub(super) registry: freshell_supervisor::registry::Registry,
    pub(super) soul: SoulId,
    pub(super) launch: NativeIdentityLaunch,
    pub(super) ready: Arc<AtomicBool>,
    pub(super) commands: Arc<std::sync::Mutex<Vec<HostCommand>>>,
    pub(super) control_socket: std::path::PathBuf,
    pub(super) native: Arc<std::sync::Mutex<(String, NativeIdentityObservation)>>,
    pub(super) events: Arc<std::sync::Mutex<Vec<AgentJournalEvent>>>,
    pub(super) sent_roots: Arc<std::sync::Mutex<Vec<String>>>,
    _tasks: OwnedTasks,
}

pub(super) async fn readiness_fixture() -> ReadinessFixture {
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
    let agent = serde_json::from_value(serde_json::json!({
        "sessionId":"owned-public-parent", "provider":"claude", "sessionType":"freshclaude",
        "runtimeVariant":"claude-agent-sdk", "providerStoreId":"owned-readiness-store",
        "cwd":workspace, "workspacePath":workspace, "runAsUid":65534, "runAsGid":0,
    }))
    .unwrap();
    let prepared = registry
        .prepare_launch(freshell_supervisor::registry::LaunchPreparation {
            soul_id: soul.clone(),
            provider: "claude".into(),
            provider_store_id: "owned-readiness-store".into(),
            native_session_id: None,
            creation_seed_ref: "owned-readiness-seed".into(),
            request_id: RequestId::new(),
            payload_digest: "owned-readiness-payload".into(),
            requested_limits: limits,
            profile: RuntimeProfile::Custom,
            project_key: "owned-workspace".into(),
            fixture: None,
            terminal: None,
            fresh_agent: Some(agent),
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
    let boot = HostBootId::new();
    let grant = registry
        .commit_execution_grant(prepared.incarnation_id.clone(), boot.clone(), limits)
        .await
        .unwrap();
    let before = registry.recovery_context(soul.clone()).await.unwrap();
    let launch = registry
        .bind_native_identity_launch(NativeIdentityLaunch {
            incarnation_id: prepared.incarnation_id.clone(),
            launch_nonce: prepared.launch_nonce.as_str().into(),
            evidence_revision: before.evidence_revision,
            execution_generation: grant.execution_generation,
            requested_native_session_id: Some(NATIVE.into()),
        })
        .await
        .unwrap();
    registry
        .record_native_session(soul.clone(), prepared.incarnation_id.clone(), NATIVE.into())
        .await
        .unwrap();
    let context = registry.recovery_context(soul.clone()).await.unwrap();
    let generation = launch.execution_generation;
    let observation = NativeIdentityObservation {
        native_session_id: NATIVE.into(),
        incarnation_id: launch.incarnation_id.clone(),
        launch_nonce: launch.launch_nonce.clone(),
        evidence_revision: launch.evidence_revision,
        source: NativeIdentitySource::FreshProviderHandshake,
        evidence_digest: "a".repeat(64),
    };
    registry
        .record_native_identity_observation(
            soul.clone(),
            observation.clone(),
            context.write_fence(),
        )
        .await
        .unwrap();

    registry
        .mark_running(prepared.incarnation_id.clone())
        .await
        .unwrap();

    // Only the native SDK child has ended. The same host, registry, writer and
    // native conversation remain; the preflight may not allocate or release work.
    let ready = Arc::new(AtomicBool::new(false));
    let commands = Arc::new(std::sync::Mutex::new(Vec::<HostCommand>::new()));
    let host_secret = b"owned-readiness-host-secret";
    std::fs::write(runtime_dir.join("secret"), host_secret).unwrap();
    let listener = UnixListener::bind(runtime_dir.join("host.sock")).unwrap();
    let (host_ready, host_commands, host_registry, host_soul) = (
        ready.clone(),
        commands.clone(),
        registry.clone(),
        soul.clone(),
    );
    let epoch = registry.control_epoch();
    let native = Arc::new(std::sync::Mutex::new((
        NATIVE.to_owned(),
        observation.clone(),
    )));
    let events = Arc::new(std::sync::Mutex::new(Vec::<AgentJournalEvent>::new()));
    let sent_roots = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let (host_native, host_events, host_sent_roots, host_launch) = (
        native.clone(),
        events.clone(),
        sent_roots.clone(),
        launch.clone(),
    );
    let host = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let envelope: Envelope<HostCommand> = read_frame(&mut stream).await.unwrap();
            host_commands.lock().unwrap().push(envelope.body.clone());
            let live = host_ready.load(Ordering::SeqCst);
            let (native, current_observation) = host_native.lock().unwrap().clone();
            let result = match envelope.body {
                HostCommand::Hello {
                    incarnation_id,
                    challenge,
                } => HostResult::Hello {
                    host_boot_id: boot.clone(),
                    proof: host_proof(host_secret, &challenge, &boot, &incarnation_id),
                    capabilities: vec![
                        "native-identity-observation-v1".into(),
                        "fresh-agent-native-readiness-v1".into(),
                    ],
                    effective_limits: limits,
                },
                HostCommand::Status { .. } => HostResult::Status {
                    host_boot_id: boot.clone(),
                    worker_pid: live.then_some(123),
                    worker_launch_count: 1,
                    max_control_epoch: epoch,
                    max_execution_generation: generation,
                    fixture_evidence: serde_json::Value::Null,
                    exited: !live,
                    native_session_id: live.then(|| native.clone()),
                    native_identity_observation: live.then(|| current_observation.clone()),
                    opencode_transfer_receipt: None,
                    opencode_adoption: OpenCodeAdoptionStatus::NotRequired,
                },
                HostCommand::FreshAgentPrepareNative { incarnation_id } => {
                    assert_eq!(incarnation_id, host_launch.incarnation_id);
                    assert_eq!(
                        host_registry
                            .recovery_context(host_soul.clone())
                            .await
                            .unwrap()
                            .accepted_command_count,
                        0,
                        "readiness must precede admission of the original input"
                    );
                    host_ready.store(true, Ordering::SeqCst);
                    HostResult::FreshAgentCommand {
                        state: CommandState::ProviderAcked,
                        native_session_id: Some(native.clone()),
                        claude_fork: None,
                    }
                }
                HostCommand::FreshAgentSend { text, .. } => {
                    assert!(live, "the original input cannot reach an ended query");
                    assert_eq!(text, "one original browser input");
                    host_sent_roots.lock().unwrap().push(native.clone());
                    HostResult::FreshAgentCommand {
                        state: CommandState::ProviderAcked,
                        native_session_id: Some(native.clone()),
                        claude_fork: None,
                    }
                }
                HostCommand::FreshAgentReadSnapshot { .. } => {
                    HostResult::FreshAgentSnapshot(serde_json::json!({
                        "threadId":native, "provider":"claude", "sessionType":"freshclaude",
                        "status":if live {"idle"} else {"closed"}, "turns":[], "capabilities":{"send":live},
                    }))
                }
                HostCommand::FreshAgentReadEvents { after_sequence, .. } => {
                    let mut rows = vec![AgentJournalEvent {
                        sequence: 1,
                        event: AgentEvent::Exited {
                            reason: "previous native query ended".into(),
                        },
                    }];
                    rows.push(AgentJournalEvent { sequence:2, event:AgentEvent::Provider { payload:serde_json::json!({
                        "type":"freshAgent.event", "provider":"claude", "sessionType":"freshclaude", "sessionId":NATIVE,
                        "event":{"type":"freshAgent.status", "sessionId":NATIVE, "status":"closed"},
                    }) } });
                    if live {
                        rows.push(AgentJournalEvent { sequence:3, event:AgentEvent::Provider { payload:serde_json::json!({
                        "type":"freshAgent.event", "provider":"claude", "sessionType":"freshclaude", "sessionId":NATIVE,
                        "event":{"type":"freshAgent.status", "sessionId":NATIVE, "status":"idle"},
                    }) } });
                    }
                    rows.extend(host_events.lock().unwrap().iter().cloned());
                    let head = rows.last().map_or(0, |row| row.sequence);
                    HostResult::FreshAgentEvents(AgentEventBatch {
                        retained_from: 1,
                        head,
                        reset_required: false,
                        events: rows
                            .into_iter()
                            .filter(|row| row.sequence > after_sequence)
                            .collect(),
                    })
                }
                other => panic!(
                    "explicit resume must not create, stop or release provider work: {other:?}"
                ),
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
        Arc::new(ReadinessBackend),
        freshell_supervisor::service::SupervisorConfig {
            runtime_root: root.path().into(),
            control_socket_path: control_socket.clone(),
            host_binary_path: std::env::current_exe().unwrap(),
            image_ref: format!("sha256:{}", "b".repeat(64)),
            test_run_id: "owned-browser-readiness".into(),
            control_secret: "0123456789abcdef".into(),
            lifecycle_log: root.path().join("lifecycle.jsonl"),
            admission: freshell_supervisor::admission::AdmissionPolicy::default(),
        },
    )
    .unwrap();
    let served = control_socket.clone();
    let control = tokio::spawn(async move {
        freshell_supervisor::service::serve_control(supervisor, &served)
            .await
            .unwrap();
    });
    let _tasks = OwnedTasks(vec![host, control]);
    tokio::time::timeout(Duration::from_secs(3), async {
        while !control_socket.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    ReadinessFixture {
        root,
        workspace,
        registry,
        soul,
        launch,
        ready,
        commands,
        control_socket,
        native,
        events,
        sent_roots,
        _tasks,
    }
}

#[tokio::test]
async fn hosted_explicit_resume_restores_ended_query_before_created_and_one_original_input() {
    let fixture = readiness_fixture().await;
    let workspace = &fixture.workspace;
    let registry = &fixture.registry;
    let soul = fixture.soul.clone();
    let ready = &fixture.ready;
    let commands = &fixture.commands;
    let control_socket = &fixture.control_socket;
    let (proxy, mut receiver) = configure_proxy(
        &control_socket,
        HashMap::from([(("claude".into(), NATIVE.into()), soul.clone())]),
    );
    Arc::clone(&proxy).handle(HostedFreshAgentCommand::Attach(serde_json::from_value(serde_json::json!({
        "provider":"claude", "sessionId":NATIVE, "sessionType":"freshclaude", "cwd":workspace,
    })).unwrap())).await;
    let saved = proxy
        .client
        .fresh_agent_snapshot(soul.clone())
        .await
        .unwrap();
    assert_eq!(saved["capabilities"]["send"], false);
    assert!(
        !ready.load(Ordering::SeqCst),
        "plain Attach/history stays read-only"
    );
    assert!(!commands
        .lock()
        .unwrap()
        .iter()
        .any(|command| matches!(command, HostCommand::FreshAgentPrepareNative { .. })));
    while receiver.try_recv().is_ok() {}

    Arc::clone(&proxy).handle(HostedFreshAgentCommand::Create(serde_json::from_value(serde_json::json!({
        "provider":"claude", "requestId":"owned-browser-resume", "sessionType":"freshclaude", "cwd":workspace,
        "sessionRef":{"provider":"claude", "sessionId":NATIVE},
    })).unwrap())).await;
    let mut frames = Vec::<serde_json::Value>::new();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let frame: serde_json::Value =
                serde_json::from_str(&receiver.recv().await.unwrap()).unwrap();
            if frame["type"] == "freshAgent.created" {
                assert!(
                    ready.load(Ordering::SeqCst),
                    "explicit Resume must establish the native query before Created"
                );
                assert_eq!(frame["sessionId"], NATIVE);
            }
            frames.push(frame);
            if frames
                .iter()
                .any(|frame| frame["type"] == "freshAgent.created")
                && frames.iter().any(|frame| {
                    frame["event"]["type"] == "freshAgent.status"
                        && frame["event"]["status"] == "idle"
                })
            {
                break;
            }
        }
    })
    .await
    .expect("resumed pane must receive both Created and current usable status");
    let visible_status = frames
        .iter()
        .filter(|frame| frame["event"]["type"] == "freshAgent.status")
        .last()
        .unwrap();
    assert_eq!(
        visible_status["event"]["status"], "idle",
        "retained exit/status replay must not leave the resumed pane closed"
    );
    let live_snapshot = proxy
        .client
        .fresh_agent_snapshot(soul.clone())
        .await
        .unwrap();
    assert_eq!(live_snapshot["threadId"], NATIVE);
    assert_eq!(live_snapshot["status"], "idle");
    assert_eq!(live_snapshot["capabilities"]["send"], true);
    Arc::clone(&proxy).handle(HostedFreshAgentCommand::Send(serde_json::from_value(serde_json::json!({
        "provider":"claude", "sessionId":NATIVE, "sessionType":"freshclaude", "requestId":"original-browser-input",
        "text":"one original browser input", "cwd":workspace,
    })).unwrap())).await;
    let calls = commands.lock().unwrap();
    let sends: Vec<_> = calls
        .iter()
        .filter(|command| matches!(command, HostCommand::FreshAgentSend { .. }))
        .collect();
    assert_eq!(
        sends.len(),
        1,
        "one original input reaches the recovered native owner"
    );
    assert!(!calls
        .iter()
        .any(|command| matches!(command, HostCommand::FreshAgentResumePending { .. })));
    drop(calls);
    let inventory = registry.inventory().await.unwrap();
    assert_eq!(inventory.len(), 1);
    assert_eq!(inventory[0].soul_id, soul);
    assert_eq!(inventory[0].native_session_id.as_deref(), Some(NATIVE));
    assert_eq!(
        registry
            .recovery_context(soul)
            .await
            .unwrap()
            .accepted_command_count,
        1
    );
}
