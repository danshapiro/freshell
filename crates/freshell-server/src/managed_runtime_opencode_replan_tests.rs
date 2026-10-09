//! Actual initial controller callers with synthetic authenticated control transport.
use super::*;
use freshell_freshagent::hosted_rest::{HostedFreshAgentRestGateway, HostedRestCreate};
use freshell_runtime_protocol::*;
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt};
use tokio::net::UnixListener;

// The actual controller callers, supervisor, durable registry and authenticated
// host protocol participate. Only the daemon/worker is synthetic; no provider
// dispatch is repeated by the lost-reply proxy or the reconciliation probe.
mod uncertain_launch {
    use super::*;
    use async_trait::async_trait;
    use freshell_supervisor::{
        backend::*,
        registry::{OwnedRuntimeHandle, Registry},
        service::{Supervisor, SupervisorConfig},
    };
    use futures_util::FutureExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Default)]
    struct State {
        dispatches: usize,
        fail_completion: bool,
        accepted: Option<LaunchRequest>,
        host_tasks: Vec<tokio::task::JoinHandle<()>>,
        host_shutdowns: Vec<tokio::sync::oneshot::Sender<()>>,
    }
    struct Backend(Arc<std::sync::Mutex<State>>, PathBuf);
    #[async_trait]
    impl RuntimeBackend for Backend {
        async fn observe_initial_auth_volume(
            &self,
            _: &freshell_supervisor::registry::OwnedInputReservation,
        ) -> Result<InitialAuthVolumeObservation, BackendError> {
            Ok(InitialAuthVolumeObservation::Absent {
                daemon_id: DockerDaemonId::parse("fixture-daemon").unwrap(),
            })
        }
        async fn observe_claude_sources(
            &self,
            _: &ClaudeSourceOwner,
            request: &ObserveClaudeSourcesRequest,
            _: &str,
        ) -> Result<freshell_platform::claude_inputs::observation::ObservationReply, BackendError>
        {
            let r = &request.observation_request;
            let mut observation = freshell_platform::claude_inputs::observation::observe(
                &r.cwd,
                &self.1,
                r.native_source_runtime,
                &r.setting_sources,
            )
            .unwrap();
            // Synthetic namespace reports the same fixed provider identity as
            // the managed host; the native source evidence remains finite.
            observation.home = Some(r.home.clone());
            observation.uid = 65534;
            observation.euid = 65534;
            observation.gid = 0;
            observation.egid = 0;
            observation.supplementary_groups = vec![0];
            Ok(
                freshell_platform::claude_inputs::observation::ObservationReply {
                    request_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(r).unwrap())),
                    observation,
                },
            )
        }
        async fn create_stopped(
            &self,
            spec: &CreateRuntimeSpec,
        ) -> Result<BackendCreated, BackendError> {
            Ok(BackendCreated {
                daemon_id: DockerDaemonId::parse("fixture-daemon").unwrap(),
                container_id: format!("{:x}", Sha256::digest(spec.incarnation_id.as_str())),
                immutable_config_digest: "a".repeat(64),
            })
        }
        async fn start_host(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            let listener = UnixListener::bind(handle.runtime_dir().join("host.sock")).unwrap();
            let secret = std::fs::read(handle.runtime_dir().join("secret")).unwrap();
            let limits = handle.requested_limits();
            let state = self.0.clone();
            let (shutdown, mut stopped) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                let boot = HostBootId::new();
                loop {
                    let (mut stream, _) =
                        tokio::select! {v=listener.accept()=>v.unwrap(), _=&mut stopped=>break};
                    let envelope: Envelope<HostCommand> = read_frame(&mut stream).await.unwrap();
                    let result = match envelope.body {
                        HostCommand::Hello {
                            challenge,
                            incarnation_id,
                        } => HostResult::Hello {
                            host_boot_id: boot.clone(),
                            proof: host_proof(&secret, &challenge, &boot, &incarnation_id),
                            capabilities: vec![],
                            effective_limits: limits,
                        },
                        HostCommand::GrantExecution { .. } => {
                            state.lock().unwrap().dispatches += 1;
                            HostResult::GrantAccepted {
                                host_boot_id: boot.clone(),
                                worker_pid: 1234,
                                worker_launch_count: 1,
                                fixture_evidence: serde_json::Value::Null,
                                native_session_id: Some("native-exact-caller".into()),
                            }
                        }
                        HostCommand::Status { .. } => HostResult::Status {
                            host_boot_id: boot.clone(),
                            worker_pid: Some(1234),
                            worker_launch_count: 1,
                            max_control_epoch: 100,
                            max_execution_generation: 100,
                            fixture_evidence: serde_json::Value::Null,
                            exited: false,
                            native_session_id: Some("native-exact-caller".into()),
                        },
                        HostCommand::ProbeRecovery {
                            resume_spec: Some(spec),
                            ..
                        } => HostResult::RecoveryProbe(RecoveryProbe::ResumeReady {
                            evidence_revision: spec.evidence_revision,
                            resume_spec: spec,
                        }),
                        other => panic!("unexpected fixture host command {other:?}"),
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
            let mut s = self.0.lock().unwrap();
            s.host_tasks.push(task);
            s.host_shutdowns.push(shutdown);
            Ok(())
        }
        async fn commit_prepared_inputs(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            let mut s = self.0.lock().unwrap();
            if std::mem::take(&mut s.fail_completion) {
                return Err(BackendError::Unavailable(
                    "synthetic postaccept completion failure".into(),
                ));
            }
            Ok(())
        }
        async fn inspect(&self, h: &OwnedRuntimeHandle) -> Result<BackendInspection, BackendError> {
            Ok(BackendInspection {
                state: BackendRuntimeState::Running,
                configured_limits: h.requested_limits(),
            })
        }
        async fn request_stop(&self, _: &OwnedRuntimeHandle, _: u64) -> Result<(), BackendError> {
            panic!("accepted initial worker must remain running")
        }
        async fn force_stop(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            panic!("accepted initial worker must remain running")
        }
        async fn verify_empty(&self, _: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
            Ok(false)
        }
        async fn list_known(
            &self,
            handles: &[OwnedRuntimeHandle],
        ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
            let mut result = vec![];
            for h in handles {
                result.push((h.incarnation_id().clone(), self.inspect(h).await?));
            }
            Ok(result)
        }
        async fn read_limits(&self, h: &OwnedRuntimeHandle) -> Result<RuntimeLimits, BackendError> {
            Ok(h.requested_limits())
        }
        async fn enable_long_lived(&self, _: &OwnedRuntimeHandle) -> Result<(), BackendError> {
            Ok(())
        }
    }

    #[test]
    fn managed_provider_initial_callers_retain_accepted_inputs_after_uncertain_launch() {
        const CASE: &str = "FRESHELL_TEST_UNCERTAIN_INITIAL_CALLER";
        if std::env::var_os(CASE).is_none() {
            let mut failures = vec![];
            let routes = [
                ("terminal", "codex"),
                ("terminal", "claude"),
                ("terminal", "amplifier"),
                ("fresh", "codex"),
                ("fresh", "claude"),
                ("fresh", "kilroy"),
            ];
            for (route, provider) in routes {
                if route == "terminal" && !cfg!(feature = "managed-provider-qualification") {
                    continue;
                }
                if std::env::var("FRESHELL_TEST_UNCERTAIN_CALLER_ROUTE")
                    .is_ok_and(|selected| selected != route)
                {
                    continue;
                }
                for failure in ["lost-reply", "completion"] {
                    let case = format!("{route}:{provider}:{failure}");
                    let output=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","managed_runtime::opencode_replan_tests::uncertain_launch::managed_provider_initial_callers_retain_accepted_inputs_after_uncertain_launch","--nocapture"]).env(CASE,&case).output().unwrap();
                    print!("{}", String::from_utf8_lossy(&output.stdout));
                    if !output.status.success() {
                        failures.push(format!(
                            "{case}: {}",
                            String::from_utf8_lossy(&output.stderr)
                        ));
                    }
                }
            }
            assert!(failures.is_empty(), "actual caller failures: {failures:?}");
            return;
        }
        let case = std::env::var(CASE).unwrap();
        let parts = case.split(':').collect::<Vec<_>>();
        let (route, provider, failure) = (parts[0], parts[1], parts[2]);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(Box::pin(exercise_case(&case, route, provider, failure)));
    }

    async fn exercise_case(case: &str, route: &str, provider: &str, failure: &str) {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let control = owned.path().join("control");
        for p in [
            &home,
            &workspace,
            &control,
            &home.join(".codex"),
            &home.join(".claude"),
            &home.join(".amplifier"),
        ] {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::write(home.join(".codex/config.toml"), "model='fixture'\n").unwrap();
        std::fs::write(
            home.join(".claude/settings.json"),
            "{\"permissions\":{\"allow\":[\"Read\"]}}",
        )
        .unwrap();
        std::fs::write(
            home.join(".amplifier/settings.yaml"),
            "fixture: ordinary-source\n",
        )
        .unwrap();
        std::env::set_var("HOME", &home);
        std::env::set_var("FRESHELL_MANAGED_FRESH_AGENT_V1", "1");
        std::env::set_var(
            "FRESHELL_MANAGED_PROVIDER_QUALIFICATION",
            "claude,codex,amplifier",
        );
        for name in [
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "FRESHELL_RUNTIME_CAPABILITY_DIR",
            "FRESHELL_MANAGED_CLAUDE_ONECLI_ENV_FILE",
            "FRESHELL_MANAGED_CODEX_ONECLI_ENV_FILE",
            "FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE",
        ] {
            std::env::remove_var(name);
        }
        let socket = control.join("supervisor.sock");
        let secret = "fixture-accepted-caller-control";
        let secret_path = control.join("secret");
        std::fs::write(&secret_path, secret).unwrap();
        crate::managed_mcp_capability::configure("0.0.0.0", 45678, &socket, &secret_path).unwrap();
        let registry_root = owned.path().join("registry");
        let registry = Registry::open(&registry_root, None).unwrap();
        let state = Arc::new(std::sync::Mutex::new(State {
            fail_completion: failure == "completion",
            ..Default::default()
        }));
        let config = SupervisorConfig {
            runtime_root: owned.path().join("runtime"),
            control_socket_path: socket.clone(),
            host_binary_path: owned.path().join("synthetic-host"),
            image_ref: format!("sha256:{}", "a".repeat(64)),
            test_run_id: "caller-uncertainty".into(),
            control_secret: secret.into(),
            lifecycle_log: owned.path().join("lifecycle.jsonl"),
            admission: Default::default(),
        };
        std::fs::write(&config.host_binary_path, "fixture-host-artifact").unwrap();
        let backend = Arc::new(Backend(state.clone(), home.clone()));
        let supervisor =
            Supervisor::new(registry.clone(), backend.clone(), config.clone()).unwrap();
        let callback = UnixListener::bind(control.join("mcp.sock")).unwrap();
        let (callback_shutdown, mut callback_stop) = tokio::sync::oneshot::channel();
        let callback_task = tokio::spawn(async move {
            loop {
                let (mut stream, _) =
                    tokio::select! {v=callback.accept()=>v.unwrap(),_=&mut callback_stop=>break};
                let mut bytes = vec![];
                stream.read_to_end(&mut bytes).await.unwrap();
                let reply =
                    crate::managed_mcp_capability::apply_initial_caller_fixture_callback(&bytes)
                        .await;
                stream
                    .write_all(&reply.unwrap_or_else(|_| b"error".to_vec()))
                    .await
                    .unwrap();
            }
        });
        let listener = UnixListener::bind(&socket).unwrap();
        let control_state = state.clone();
        let owner = supervisor.clone();
        let lose_reply = failure == "lost-reply";
        let (control_shutdown, mut control_stop) = tokio::sync::oneshot::channel();
        let control_task = tokio::spawn(async move {
            loop {
                let (mut stream, _) =
                    tokio::select! {v=listener.accept()=>v.unwrap(),_=&mut control_stop=>break};
                let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                let launch = if let AdminCommand::Launch(request) = &envelope.body {
                    Some(request.clone())
                } else {
                    None
                };
                let reply = Box::pin(owner.dispatch(envelope)).await;
                if let Some(request) = launch {
                    control_state.lock().unwrap().accepted = Some(*request);
                    if lose_reply {
                        assert!(
                            reply.result.is_ok(),
                            "lost reply must follow actual successful launch: {:?}",
                            reply.result
                        );
                        continue;
                    }
                }
                write_frame(&mut stream, &reply).await.unwrap();
            }
        });
        let client = RuntimeClient::new(&socket, secret);
        let controller = ServerManagedRuntimeController {
            client: client.clone(),
            recovery: Arc::new(ManagedRecoveryState::default()),
        };
        let seed = format!("caller-{route}-{provider}-{failure}");
        let result = if route == "fresh" {
            let (broadcast, _receiver) = tokio::sync::broadcast::channel(32);
            let fresh = crate::fresh_agent_proxy::HostedFreshAgentProxy::from_opt_in(
                Some(client.clone()),
                Arc::new(broadcast),
            )
            .unwrap()
            .unwrap();
            fresh
                .create_agent(HostedRestCreate {
                    request_id: seed.clone(),
                    provider: if provider == "kilroy" {
                        "claude"
                    } else {
                        provider
                    }
                    .into(),
                    session_type: if provider == "kilroy" {
                        "kilroy".into()
                    } else {
                        format!("fresh{provider}")
                    },
                    cwd: Some(workspace.to_string_lossy().into_owned()),
                    model: None,
                    effort: None,
                    native_session_id: None,
                    plugins: None,
                    model_selection: None,
                    permission_mode: None,
                    sandbox: None,
                })
                .await
                .map(|_| ())
                .map_err(|_| "fresh refusal".to_string())
        } else {
            controller
                .launch(ManagedTerminalLaunch {
                    spec: freshell_platform::SpawnSpec {
                        program: provider.into(),
                        args: vec![],
                        env_overrides: BTreeMap::new(),
                        cwd: Some(workspace.to_string_lossy().into_owned()),
                        cols: 80,
                        rows: 24,
                    },
                    env: BTreeMap::new(),
                    terminal_id: seed.clone(),
                    stream_id: seed.clone(),
                    mode: provider.into(),
                    resume_session_id: None,
                    provider_model: None,
                    provider_reasoning_effort: None,
                    provider_sandbox: None,
                    provider_permission_mode: None,
                    view_tab_id: None,
                    view_pane_id: None,
                    create_request_id: Some(seed.clone()),
                })
                .await
                .map(|_| ())
        };
        assert!(
            result.is_err(),
            "fixture must reach uncertain caller outcome"
        );
        let launch = state
            .lock()
            .unwrap()
            .accepted
            .clone()
            .expect("real launch reached supervisor");
        let context = launch
            .terminal
            .as_ref()
            .and_then(|s| s.provider_launch_context.as_ref())
            .or_else(|| {
                launch
                    .fresh_agent
                    .as_ref()
                    .and_then(|s| s.provider_launch_context.as_ref())
            })
            .unwrap();
        let grant = &context.mcp_capability.as_ref().unwrap().grant_id;
        let journal = control
            .join("mcp-capabilities")
            .join(format!("{grant}.json"));
        let stage = control.join("provider-roots").join(grant);
        println!("initial_caller_accepted {{\"case\":\"{case}\",\"dispatches\":{},\"journalRetained\":{},\"stageRetained\":{}}}",state.lock().unwrap().dispatches,journal.is_file(),stage.is_dir());
        // Preserve every assertion failure until all exact owned tasks join.
        let retained = journal.is_file() && stage.is_dir();
        let before = registry.inventory().await.unwrap();
        // Registry ownership is exclusive. Join and drop the old control
        // owner before opening SQLite through a fresh supervisor.
        control_shutdown.send(()).unwrap();
        control_task.await.unwrap();
        drop(supervisor);
        drop(registry);
        let mut cold_control = None;
        let mut cold_shutdown = None;
        let verification = std::panic::AssertUnwindSafe(async {
            let mut proof = None;
            if retained {
                let manifest = std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap();
                let config_binds = context
                    .prepared_inputs
                    .as_ref()
                    .unwrap()
                    .config_binds
                    .iter()
                    .map(|bind| {
                        let path = stage.join(&bind.source_relative_path);
                        let bytes = std::fs::read(&path).unwrap();
                        (path, bytes)
                    })
                    .collect::<Vec<_>>();
                assert!(
                    !config_binds.is_empty(),
                    "fixture must protect real config-bind sources"
                );
                let stored: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
                assert!(
                    crate::managed_mcp_capability::initial_caller_fixture_authenticates(
                        stored["scope"].as_str().unwrap()
                    )
                );
                assert_eq!(before.len(), 1);
                assert_eq!(
                    before[0].native_session_id.as_deref(),
                    Some("native-exact-caller")
                );
                // Cold supervisor+SQLite reopen retries accepted completion and
                // adopts the current host through Recover, never Launch again.
                let cold = Supervisor::new(
                    Registry::open(&registry_root, None).unwrap(),
                    backend,
                    config,
                )
                .unwrap();
                std::fs::remove_file(&socket).unwrap();
                let listener = UnixListener::bind(&socket).unwrap();
                let owner = cold.clone();
                let (stop, mut stopped) = tokio::sync::oneshot::channel();
                cold_shutdown = Some(stop);
                cold_control = Some(tokio::spawn(async move {
                    loop {
                        let (mut stream, _) =
                            tokio::select! {v=listener.accept()=>v.unwrap(),_=&mut stopped=>break};
                        let envelope: Envelope<AdminCommand> =
                            read_frame(&mut stream).await.unwrap();
                        write_frame(&mut stream, &Box::pin(owner.dispatch(envelope)).await)
                            .await
                            .unwrap();
                    }
                }));
                let mut envelope = Envelope::new(
                    RequestId::new(),
                    ControlRole::Web,
                    AdminCommand::Recover(RecoverRequest {
                        soul_id: launch.soul_id.clone(),
                        trigger: RecoveryTrigger::StartupReconcile,
                        expected_intent_revision: None,
                        expected_control_epoch: None,
                    }),
                );
                envelope.auth = Some(secret.into());
                let reply = Box::pin(cold.dispatch(envelope)).await;
                assert!(
                    matches!(
                        reply.result,
                        Ok(AdminResult::Recovery(RecoveryResult {
                            outcome: RecoveryOutcome::AlreadyLive | RecoveryOutcome::Reattached,
                            ..
                        }))
                    ),
                    "current healthy native reconciliation: {:?}",
                    reply.result
                );
                crate::managed_mcp_capability::rehydrate_running_capabilities(&client)
                    .await
                    .unwrap();
                let after = cold.registry().inventory().await.unwrap();
                assert_eq!(after[0].incarnation_id, before[0].incarnation_id);
                assert_eq!(after[0].native_session_id, before[0].native_session_id);
                assert_eq!(
                    std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap(),
                    manifest
                );
                assert!(
                    crate::managed_mcp_capability::initial_caller_fixture_authenticates(
                        stored["scope"].as_str().unwrap()
                    )
                );
                for (path, bytes) in config_binds {
                    assert_eq!(
                        std::fs::read(path).unwrap(),
                        bytes,
                        "reconciliation preserves immutable config-bind sources"
                    );
                }
                proof = Some(after[0].incarnation_id.clone());
            }
            proof
        })
        .catch_unwind()
        .await;
        if let Some(shutdown) = cold_shutdown {
            shutdown.send(()).unwrap();
        }
        if let Some(task) = cold_control {
            task.await.unwrap();
        }
        callback_shutdown.send(()).unwrap();
        callback_task.await.unwrap();
        let (tasks, shutdowns) = {
            let mut s = state.lock().unwrap();
            (
                std::mem::take(&mut s.host_tasks),
                std::mem::take(&mut s.host_shutdowns),
            )
        };
        for shutdown in shutdowns {
            let _ = shutdown.send(());
        }
        let mut task_failures = vec![];
        for task in tasks {
            if let Err(error) = task.await {
                task_failures.push(error);
            }
        }
        let proof = verification.unwrap_or_else(|panic| std::panic::resume_unwind(panic));
        assert!(
            task_failures.is_empty(),
            "owned host tasks failed after join: {task_failures:?}"
        );
        assert!(
            retained,
            "actual {case} caller deleted accepted preparation journal/stage"
        );
        assert!(proof.is_some());
        assert_eq!(state.lock().unwrap().dispatches, 1);
        println!("initial_caller_reconciled {{\"case\":\"{case}\",\"sameNativeIdentity\":true,\"dispatches\":1,\"allFixtureTasksJoined\":true}}");
    }
}

#[test]
fn managed_provider_initial_opencode_callers_replan_changed_selection_with_two_retry_bound() {
    const CHILD: &str = "FRESHELL_TEST_INITIAL_OPENCODE_REPLAN_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "managed_runtime::opencode_replan_tests::managed_provider_initial_opencode_callers_replan_changed_selection_with_two_retry_bound", "--nocapture"])
            .env(CHILD, "1").output().unwrap();
        assert!(
            output.status.success(),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        print!("{}", String::from_utf8_lossy(&output.stdout));
        return;
    }
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let control = owned.path().join("control");
        for directory in [&home.join(".config/opencode"), &workspace, &control] { std::fs::create_dir_all(directory).unwrap(); }
        let config = home.join(".config/opencode/opencode.json");
        let raw = r#"{"agent":{"probe":{"prompt":"{file:{env:RULE_FILE}}"}}}"#;
        std::fs::write(&config, raw).unwrap();
        let files = (0..4).map(|index| {
            let path = workspace.join(format!("rules-{index}.txt"));
            std::fs::write(&path, format!("approved-consumption-{index}")).unwrap(); path
        }).collect::<Vec<_>>();
        let auth = owned.path().join("auth.json");
        let write_auth = |path: &Path| {
            std::fs::write(&auth, serde_json::to_vec(&serde_json::json!({"fixture":{"type":"wellknown","key":"RULE_FILE","token":path}})).unwrap()).unwrap();
            std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o600)).unwrap();
        };
        write_auth(&files[0]);
        std::env::set_var("HOME", &home);
        std::env::remove_var("XDG_CONFIG_HOME");
        std::env::remove_var("OPENCODE_CONFIG");
        std::env::remove_var("OPENCODE_CONFIG_DIR");
        std::env::remove_var("OPENCODE_CONFIG_CONTENT");
        std::env::set_var("FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE", &auth);
        std::env::remove_var("FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE");
        std::env::remove_var("FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE");
        std::env::set_var("FRESHELL_MANAGED_FRESH_AGENT_V1", "1");
        let socket = control.join("supervisor.sock");
        let secret = "fixture-opencode-control-secret";
        let secret_path = control.join("secret");
        std::fs::write(&secret_path, secret).unwrap();
        crate::managed_mcp_capability::configure("0.0.0.0", 45678, &socket, &secret_path).unwrap();
        let listener = UnixListener::bind(&socket).unwrap();
        let attempts = Arc::new(Mutex::new(BTreeMap::<String, usize>::new()));
        let consumed = Arc::new(Mutex::new(Vec::<String>::new()));
        let (shutdown, mut shutdown_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn({
            let auth=auth.clone(); let files=files.clone(); let attempts=attempts.clone(); let consumed=consumed.clone(); let control=control.clone();
            async move { loop {
                let (mut stream, _) = tokio::select! { accepted=listener.accept() => accepted.unwrap(), _=&mut shutdown_rx => break };
                let envelope: Envelope<AdminCommand> = read_frame(&mut stream).await.unwrap();
                assert_eq!(envelope.auth.as_deref(), Some(secret));
                let result = match envelope.body {
                    AdminCommand::Health => Ok(AdminResult::Health {control_epoch:1,installation_id:InstallationId::parse("fixture-installation").unwrap()}),
                    AdminCommand::Inventory => Ok(AdminResult::Inventory(vec![])),
                    AdminCommand::ReserveProviderInputs(request) => Ok(AdminResult::ProviderInputReservation(ProviderInputReservation {
                        reservation_id:uuid::Uuid::new_v4().to_string(),installation_id:InstallationId::parse("fixture-installation").unwrap(),soul_id:request.soul_id,provider:request.provider,creation_seed_ref:request.creation_seed_ref,intent_revision:1,provider_volume_name:"fixture-volume".into(),image_ref:"fixture-image".into(),host_binary_path:"/fixture/host".into(),host_binary_sha256:"a".repeat(64),observation:InitialAuthVolumeObservation::Absent {daemon_id:DockerDaemonId::parse("fixture-daemon").unwrap()},
                    })),
                    AdminCommand::BindProviderPathInputs(_) => Ok(AdminResult::ProviderPathInputsBound),
                    AdminCommand::Launch(request) => {
                        let soul=request.creation_seed_ref.clone();
                        let mut all=attempts.lock().await; let count=all.entry(soul).or_default(); *count+=1;
                        let changing=request.creation_seed_ref.contains("changing");
                        let uncertain=request.creation_seed_ref.contains("uncertain");
                        let references=request.terminal.as_ref().map(|s| &s.provider_secret_references).or_else(|| request.fresh_agent.as_ref().map(|s| &s.provider_secret_references)).unwrap();
                        let selected=references.iter().find(|r| r.profile==ProviderSecretProfile::OpencodeConfigurationFile).expect("approved file selection");
                        assert_eq!(Path::new(&selected.source_path), files[if changing {*count-1} else {usize::from(*count>1)}]);
                        let stages=std::fs::read_dir(control.join("mcp-capabilities")).unwrap().filter_map(Result::ok).filter_map(|e| std::fs::read(e.path()).ok()).filter_map(|b|serde_json::from_slice::<serde_json::Value>(&b).ok()).filter(|v|v["soulId"]==request.soul_id.as_str()).count();
                        assert!(stages<=2,"initial retry must not accumulate pending stages: {stages}");
                        if changing || *count==1 {
                            let next=if changing {*count} else {1};
                            std::fs::write(&auth, serde_json::to_vec(&serde_json::json!({"fixture":{"type":"wellknown","key":"RULE_FILE","token":files[next]}})).unwrap()).unwrap();
                            Err(RuntimeError::new(if uncertain {RuntimeErrorCode::HostUnreachable} else {RuntimeErrorCode::ProviderInputsChanged},"configuration reference selection changed before dispatch"))
                        } else {
                            consumed.lock().await.push(std::fs::read_to_string(&selected.source_path).unwrap());
                            let view:RuntimeView=serde_json::from_value(serde_json::json!({"soulId":request.soul_id,"incarnationId":IncarnationId::new(),"launchState":"running","cleanupState":"none","intentRevision":1,"executionGeneration":1,"desiredState":"running","recoveryState":"live","durabilityState":"unknown","allocationState":"allocated","evidenceRevision":0,"successfulRecoveriesInWindow":0})).unwrap();
                            Ok(AdminResult::Launch(LaunchResult {view,worker_pid:123,worker_launch_count:1,host_boot_id:HostBootId::new(),effective_limits:request.limits,fixture_evidence:serde_json::Value::Null}))
                        }
                    },
                    AdminCommand::FreshAgentReadEvents(_) => Err(RuntimeError::new(RuntimeErrorCode::HostUnreachable,"fixture poll completed")),
                    _=>panic!("unexpected control fixture operation"),
                };
                write_frame(&mut stream,&AdminReply {request_id:envelope.request_id,result}).await.unwrap();
            }}
        });
        let client=RuntimeClient::new(&socket, secret);
        let controller=ServerManagedRuntimeController {client:client.clone(), recovery:Arc::new(ManagedRecoveryState::default())};
        let (broadcast,_receiver)=tokio::sync::broadcast::channel(32);
        let fresh=crate::fresh_agent_proxy::HostedFreshAgentProxy::from_opt_in(Some(client),Arc::new(broadcast)).unwrap().unwrap();
        let routes = if std::env::var("FRESHELL_TEST_INITIAL_OPENCODE_REPLAN_ROUTE").ok().as_deref()==Some("fresh") {vec![true]} else {vec![false,true]};
        for fresh_route in routes {
            for outcome in ["stable","changing","uncertain"] {
                let changing=outcome=="changing";
                let uncertain=outcome=="uncertain";
                write_auth(&files[0]);
                let seed=format!("{}-{}",if fresh_route {"fresh"} else {"terminal"},outcome);
                let soul=if fresh_route {SoulId::parse(format!("soul-fresh-opencode-{}",&format!("{:x}",Sha256::digest(seed.as_bytes()))[..32])).unwrap()} else {stable_soul_id(&seed).unwrap()};
                let prior=crate::managed_provider_references::prepare_managed_opencode(crate::managed_provider_references::OpencodePreparation {
                    client:&controller.client,soul:&soul,creation_seed:&seed,home:&home,cwd:&workspace,workspace:&workspace,
                    original:&|name|std::env::var(name).ok(),references:crate::managed_provider_bootstrap::named_provider_onecli_references("opencode").unwrap(),auth_authority:None,selected_sources:None,accepted_global_root:None,selected_resource_roots:None,native_source_flags:None,rebind_enabled:None,inherited_inline:None,inline_edits:None,
                }).await.unwrap();
                crate::managed_mcp_capability::accept_initial_replan_fixture_preparation(&soul, &prior.context).unwrap();
                let prior_grant=prior.context.mcp_capability.as_ref().unwrap().grant_id.clone();
                let prior_stage=control.join("provider-roots").join(&prior_grant);
                let prior_manifest=std::fs::read(prior_stage.join(".freshell/input-manifest.json")).unwrap();
                let result=if fresh_route {
                    fresh.clone().create_agent(HostedRestCreate {request_id:seed.clone(),provider:"opencode".into(),session_type:"freshopencode".into(),cwd:Some(workspace.to_string_lossy().into_owned()),model:None,effort:None,native_session_id:None,plugins:None,model_selection:None,permission_mode:None,sandbox:None}).await.map(|_|()).map_err(|_|"fresh refusal".to_string())
                } else {
                    controller.launch(ManagedTerminalLaunch {spec:freshell_platform::SpawnSpec {program:"opencode".into(),args:vec![],env_overrides:BTreeMap::new(),cwd:Some(workspace.to_string_lossy().into_owned()),cols:80,rows:24},env:BTreeMap::new(),terminal_id:seed.clone(),stream_id:seed.clone(),mode:"opencode".into(),resume_session_id:None,provider_model:None,provider_reasoning_effort:None,provider_sandbox:None,provider_permission_mode:None,view_tab_id:None,view_pane_id:None,create_request_id:Some(seed.clone())}).await.map(|_|())
                };
                assert_eq!(result.is_ok(),!changing && !uncertain,"actual initial caller fresh={fresh_route} changing={changing}: {result:?}");
                assert_eq!(attempts.lock().await[&seed],if uncertain {1} else if changing {3} else {2});
                assert_eq!(std::fs::read(prior_stage.join(".freshell/input-manifest.json")).unwrap(),prior_manifest,"prior usable preparation is preserved");
                assert!(control.join("mcp-capabilities").join(format!("{prior_grant}.json")).is_file());
                assert_eq!(std::fs::read_to_string(&prior.references.iter().find(|r|r.profile.is_configuration_file()).unwrap().source_path).unwrap(),"approved-consumption-0");
                if uncertain { // Both current and prior ownership remain available for reconciliation.
                    let grants=std::fs::read_dir(control.join("mcp-capabilities")).unwrap().filter_map(Result::ok).filter_map(|e|std::fs::read(e.path()).ok()).filter_map(|b|serde_json::from_slice::<serde_json::Value>(&b).ok()).filter(|v|v["soulId"]==soul.as_str()).count();
                    assert_eq!(grants,2);
                }
                println!("initial_opencode_caller {{\"route\":\"{}\",\"outcome\":\"{}\",\"attempts\":{}}}",if fresh_route {"fresh"} else {"terminal"},outcome,attempts.lock().await[&seed]);
                assert_eq!(std::fs::read_to_string(&config).unwrap(),raw);
            }
        }
        assert!(consumed.lock().await.iter().all(|v|v=="approved-consumption-1"));
        assert_eq!(consumed.lock().await.len(),if std::env::var("FRESHELL_TEST_INITIAL_OPENCODE_REPLAN_ROUTE").ok().as_deref()==Some("fresh") {1} else {2});
        // Polling receives an error then empty inventory and settles on the same runtime.
        tokio::task::yield_now().await;
        shutdown.send(()).unwrap(); server.await.unwrap();
    });
}
