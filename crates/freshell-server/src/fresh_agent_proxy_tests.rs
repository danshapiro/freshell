use super::*;
use freshell_protocol::{FreshAgentFork, FreshAgentRecoveryStop};
use freshell_runtime_protocol::{
    read_frame, write_frame, AdminCommand, AdminReply, AdminResult, ControlRole, Envelope,
    FreshAgentForkResult, FreshAgentProviderStartDiagnostic, InstallationId, RuntimeDiagnosticCode,
    RuntimeErrorCode,
};
use tokio::net::UnixListener;

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

#[test]
fn hosted_created_frame_uses_the_public_request_identity() {
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
                cwd: Some("/workspace".into()),
                model: Some("opus".into()),
                effort: Some("high".into()),
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
        for index in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
            let result = match request.body {
                AdminCommand::Health if index == 0 => AdminResult::Health {
                    control_epoch: 77,
                    installation_id: InstallationId::new(),
                },
                AdminCommand::FreshAgentReadEvents(read) if index == 1 => {
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
                    assert_eq!(fork.parent_session_id, "public-parent");
                    assert_eq!(fork.input, Some(serde_json::json!({"atTurnId":"turn-4"})));
                    assert_eq!(fork.expected_control_epoch, Some(77));
                    AdminResult::FreshAgentFork(FreshAgentForkResult {
                        claude_fork: None,
                        parent_session_id: "public-parent".into(),
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
    let proxy = Arc::new(HostedFreshAgentProxy {
        client,
        broadcast: Arc::new(broadcast),
        aliases: Mutex::new(HashMap::from([(
            ("codex".into(), "public-parent".into()),
            soul.clone(),
        )])),
        presentation_routes: Mutex::new(HashMap::from([(
            soul.clone(),
            PresentationRoute::initial("public-parent"),
        )])),
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
            session_id: "public-parent".into(),
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
    assert_eq!(forked.parent_session_id, "public-parent");
    assert_eq!(forked.session_id, "native-child");
    assert_eq!(forked.parent_retired_by_runtime, Some(true));
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
    let aliases = proxy.aliases.lock().await;
    assert_eq!(
        aliases.get(&("codex".into(), "native-child".into())),
        Some(&soul)
    );
    assert!(
        !aliases
            .keys()
            .any(|(provider, session)| provider == "codex" && session == "public-parent"),
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
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
    }
    // Exact-looking names cannot substitute for a readable, matching native source.
    let wrong_codex = codex_path.with_file_name("rollout-wrong-native.jsonl");
    std::fs::write(&wrong_codex, std::fs::read(&codex_path).unwrap()).unwrap();
    let unreadable_claude =
        claude_path.with_file_name("55555555-5555-4555-8555-555555555555.jsonl");
    std::fs::write(&unreadable_claude, [0xff, 0xfe]).unwrap();
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
    assert_eq!(settings.effort.as_deref(), Some("high"));
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

#[path = "fresh_agent_proxy_readiness_tests.rs"]
mod readiness_tests;

#[path = "fresh_agent_proxy_materialization_tests.rs"]
mod materialization_tests;
