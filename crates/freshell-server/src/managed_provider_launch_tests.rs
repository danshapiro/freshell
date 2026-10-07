//! Closed synthetic native startup qualification. The external sandbox owns
//! the broker, pinned image, shared scratch and every process/container cleanup.
use async_trait::async_trait;
use freshell_runtime_protocol::*;
use freshell_supervisor::{
    backend::{
        BackendCreated, BackendError, BackendInspection, CreateRuntimeSpec, DockerEngineBackend,
        RuntimeBackend,
    },
    registry::{OwnedInputReservation, OwnedRuntimeHandle},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

/// Delegates every lifecycle operation to the actual Docker backend. The only
/// added operation delivers metadata to the closed fixture's trusted broker.
struct BrokerAuthorizedBackend {
    real: DockerEngineBackend,
    control: PathBuf,
    handoff: PathBuf,
}
impl BrokerAuthorizedBackend {
    async fn authorize(&self, spec: &CreateRuntimeSpec) -> Result<(), BackendError> {
        let invalid =
            || BackendError::InvalidConfig("closed native fixture metadata handoff invalid".into());
        let (context, references) = spec
            .terminal
            .as_ref()
            .map(|workload| {
                (
                    &workload.provider_launch_context,
                    &workload.provider_secret_references,
                )
            })
            .or_else(|| {
                spec.fresh_agent.as_ref().map(|workload| {
                    (
                        &workload.provider_launch_context,
                        &workload.provider_secret_references,
                    )
                })
            })
            .ok_or_else(invalid)?;
        let context = context.as_ref().ok_or_else(invalid)?;
        let inputs = context.prepared_inputs.as_ref().ok_or_else(invalid)?;
        inputs
            .validate_references(references)
            .map_err(|_| invalid())?;
        let indexed = references
            .iter()
            .enumerate()
            .filter(|(_, reference)| reference.profile.is_configuration_file())
            .map(|(index, reference)| {
                let source = reference
                    .provider_relative_path
                    .as_deref()
                    .and_then(|path| path.strip_prefix(".freshell/references/"))
                    .and_then(|id| id.parse::<u16>().ok())
                    .ok_or_else(invalid)?;
                Ok(json!({"grantIndex":index,"sourceId":source}))
            })
            .collect::<Result<Vec<_>, BackendError>>()?;
        let value = json!({
            "installationId":spec.installation_id,"soulId":spec.soul_id,"incarnationId":spec.incarnation_id,
            "imageRef":spec.image_ref,"hostBinaryPath":spec.host_binary_path,"providerVolumeName":spec.provider_volume_name,
            "stageRoot":self.control.join("provider-roots").join(&inputs.generation_id),"generationId":inputs.generation_id,
            "initialAuthReservation":inputs.initial_auth_reservation,
            "configurationBinds":inputs.config_binds.iter().map(|bind|json!({"sourceRelativePath":bind.source_relative_path,"effectiveDestination":bind.effective_destination})).collect::<Vec<_>>(),
            "resourceMounts":inputs.resource_mounts.iter().map(|mount|json!({"providerRelativePath":mount.provider_relative_path,"effectiveDestination":mount.effective_destination,"kind":mount.kind})).collect::<Vec<_>>(),
            "indexedFiles":inputs.indexed_files.as_ref().map(|files|json!({"volumeName":files.volume_name,"aliases":files.aliases.iter().map(|alias|json!({"sourceId":alias.source_id,"effectiveDestination":alias.effective_destination})).collect::<Vec<_>>()})),
            "indexedSecretSources":indexed,
        });
        let metadata =
            bounded_json_bytes(&value, MAX_CONTROL_FRAME_BYTES).map_err(|_| invalid())?;
        let path = self.handoff.join(format!("{}.json", spec.incarnation_id));
        let temporary = path.with_extension("pending");
        std::fs::write(&temporary, metadata).map_err(|_| invalid())?;
        std::fs::rename(&temporary, &path).map_err(|_| invalid())?;
        let receipt = path.with_extension("accepted");
        tokio::time::timeout(Duration::from_secs(10), async {
            while !receipt.is_file() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| {
            BackendError::Unavailable("closed native fixture broker authorization timed out".into())
        })?;
        Ok(())
    }
}
#[async_trait]
impl RuntimeBackend for BrokerAuthorizedBackend {
    async fn observe_initial_auth_volume(
        &self,
        reservation: &OwnedInputReservation,
    ) -> Result<InitialAuthVolumeObservation, BackendError> {
        self.real.observe_initial_auth_volume(reservation).await
    }
    async fn commit_prepared_inputs(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<(), BackendError> {
        self.real.commit_prepared_inputs(handle).await
    }
    async fn read_native_auth(
        &self,
        handle: &OwnedRuntimeHandle,
        keys: &[String],
        binary: &Path,
    ) -> Result<BTreeMap<String, String>, BackendError> {
        self.real.read_native_auth(handle, keys, binary).await
    }
    async fn read_native_history(
        &self,
        handle: &OwnedRuntimeHandle,
        provider: &str,
        id: &str,
        binary: &Path,
    ) -> Result<Value, BackendError> {
        self.real
            .read_native_history(handle, provider, id, binary)
            .await
    }
    async fn create_stopped(
        &self,
        spec: &CreateRuntimeSpec,
    ) -> Result<BackendCreated, BackendError> {
        self.authorize(spec).await?;
        self.real.create_stopped(spec).await
    }
    async fn start_host(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        self.real.start_host(handle).await
    }
    async fn inspect(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<BackendInspection, BackendError> {
        self.real.inspect(handle).await
    }
    async fn request_stop(
        &self,
        handle: &OwnedRuntimeHandle,
        grace: u64,
    ) -> Result<(), BackendError> {
        self.real.request_stop(handle, grace).await
    }
    async fn force_stop(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        self.real.force_stop(handle).await
    }
    async fn verify_empty(&self, handle: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
        self.real.verify_empty(handle).await
    }
    async fn list_known(
        &self,
        handles: &[OwnedRuntimeHandle],
    ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
        self.real.list_known(handles).await
    }
    async fn read_limits(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<RuntimeLimits, BackendError> {
        self.real.read_limits(handle).await
    }
    async fn enable_long_lived(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        self.real.enable_long_lived(handle).await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn managed_provider_opencode_terminal_and_fresh_native_startup_consumes_prepared_inputs() {
    use freshell_supervisor::{
        admission::AdmissionPolicy,
        registry::Registry,
        service::{serve_control, Supervisor, SupervisorConfig},
    };
    use freshell_terminal::registry::{ManagedTerminalController, ManagedTerminalLaunch};
    use freshell_ws::hosted_fresh_agent::{HostedFreshAgentCommand, HostedFreshAgentGateway};
    use sha2::{Digest, Sha256};
    use std::sync::Arc;
    let fixture = PathBuf::from(
        std::env::var_os("FRESHELL_PROVIDER_LAUNCH_FIXTURE")
            .expect("run the closed --provider-launches sandbox"),
    );
    assert_eq!(fixture.parent(), Some(Path::new("/tmp")));
    assert!(fixture
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("fln-") && name.len() == 20));
    let control = fixture.join("scenarios/native/control");
    let runtime = fixture.join("scenarios/n/r");
    for directory in [&control, &runtime, &fixture.join("handoff")] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let binary = PathBuf::from(std::env::var_os("FRESHELL_PROVIDER_LAUNCH_HOST_BINARY").unwrap());
    let image = std::env::var("FRESHELL_PROVIDER_LAUNCH_IMAGE").unwrap();
    let installation =
        InstallationId::parse(std::env::var("FRESHELL_PROVIDER_LAUNCH_INSTALLATION").unwrap())
            .unwrap();
    let registry = Registry::open(fixture.join("registry"), Some(installation)).unwrap();
    let backend = Arc::new(BrokerAuthorizedBackend {
        real: DockerEngineBackend::new(fixture.join("broker.sock")),
        control: control.clone(),
        handoff: fixture.join("handoff"),
    });
    let socket = control.join("control.sock");
    let secret_file = control.join("secret");
    std::fs::write(&secret_file, "closed-synthetic-control-secret").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&secret_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    freshell_supervisor::backend::docker::configure_capability_dir(&socket).unwrap();
    let supervisor = Supervisor::new(
        registry.clone(),
        backend,
        SupervisorConfig {
            runtime_root: runtime,
            control_socket_path: socket.clone(),
            host_binary_path: binary,
            image_ref: image,
            test_run_id: std::env::var("FRESHELL_PROVIDER_LAUNCH_RUN_ID").unwrap(),
            control_secret: "closed-synthetic-control-secret".into(),
            lifecycle_log: fixture.join("lifecycle.jsonl"),
            admission: AdmissionPolicy::default(),
        },
    )
    .unwrap();
    let control_task = tokio::spawn({
        let socket = socket.clone();
        async move {
            serve_control(supervisor, &socket).await.unwrap();
        }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !socket.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let web = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
    let port = web.local_addr().unwrap().port();
    // Native well-known authentication fetches configuration from the outer
    // auth-store key before reading local configuration. Keep that dependency
    // inside the same owned synthetic fixture as the launch consumers.
    let well_known_url = format!("http://host.docker.internal:{port}");
    std::fs::write(
        fixture.join("grants/auth.json"),
        serde_json::to_vec(&json!({well_known_url: {
            "type": "wellknown", "key": "OPENAI_API_KEY",
            "token": "AUTH_PREFIX{file:./rules.txt}AUTH_SUFFIX"
        }}))
        .unwrap(),
    )
    .unwrap();
    let web_task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = web.accept().await else {
                break;
            };
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut bytes = [0; 4096];
                let _ = stream.read(&mut bytes).await;
                let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 13\r\nConnection: close\r\n\r\n{\"config\":{}}").await;
            });
        }
    });
    crate::managed_mcp_capability::configure("0.0.0.0", port, &socket, &secret_file).unwrap();
    crate::managed_mcp_capability::spawn_callback_server()
        .await
        .unwrap();
    std::env::set_var("FRESHELL_MANAGED_RUNTIME_V1", "1");
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SOCKET", &socket);
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SECRET_FILE", &secret_file);
    std::env::set_var("FRESHELL_MANAGED_FRESH_AGENT_V1", "1");
    let controller = crate::managed_runtime::ServerManagedRuntimeController::from_env()
        .await
        .unwrap()
        .unwrap();
    let cwd = fixture.join("workspace").to_string_lossy().into_owned();
    let original_config = fixture.join("source-home/.config/opencode/opencode.json");
    let original_bytes = std::fs::read(&original_config).unwrap();
    let explicit_config = fixture.join("workspace/selected-config.json");
    let explicit_bytes = br#"{"agent":{"probe":{"description":"{file:./selected-rule}"}}}"#;
    std::fs::write(&explicit_config, explicit_bytes).unwrap();
    let explicit_rule = fixture.join("workspace/selected-rule");
    std::fs::write(&explicit_rule, "native-explicit-selected-rule").unwrap();
    std::fs::set_permissions(&explicit_rule, std::fs::Permissions::from_mode(0o600)).unwrap();
    let tui_plugin = fixture.join("source-home/.config/opencode/plugins/probe-tui");
    std::fs::create_dir_all(&tui_plugin).unwrap();
    std::fs::write(tui_plugin.join("index.mjs"), r#"import fs from 'node:fs';import crypto from 'node:crypto';
export default {id:'closed-native-tui-fixture',async tui(api,options){
 fs.writeFileSync(options.receipt,JSON.stringify({theme:crypto.createHash('sha256').update(api.tuiConfig.theme).digest('hex')}));
}};
"#).unwrap();
    let selected_tui = fixture.join("workspace/selected-tui.jsonc");
    let tui_receipt = fixture.join("workspace/native-tui-consumed.json");
    let selected_tui_bytes = format!("{{ // selected origin\n\"theme\":\"{{file:./selected-theme}}\",\"plugin\":[[\"file:///home/freshell/provider/.config/opencode/plugins/probe-tui/index.mjs\",{{\"receipt\":{}}}]],}}", serde_json::to_string(&tui_receipt).unwrap());
    std::fs::write(&selected_tui, &selected_tui_bytes).unwrap();
    std::fs::write(fixture.join("workspace/selected-theme"), "  dark\n").unwrap();
    let request: ManagedTerminalLaunch = ManagedTerminalLaunch {
        spec: freshell_platform::spawn::SpawnSpec {
            program: "opencode".into(),
            args: vec![],
            env_overrides: BTreeMap::new(),
            cwd: Some(cwd.clone()),
            cols: 120,
            rows: 30,
        },
        env: BTreeMap::from([
            ("OPENCODE_CONFIG".into(), "selected-config.json".into()),
            ("OPENCODE_TUI_CONFIG".into(), "selected-tui.jsonc".into()),
        ]),
        terminal_id: "closed-native-terminal".into(),
        stream_id: "closed-native-stream".into(),
        mode: "opencode".into(),
        resume_session_id: None,
        provider_model: None,
        provider_reasoning_effort: None,
        provider_sandbox: None,
        provider_permission_mode: None,
        view_tab_id: None,
        view_pane_id: None,
        create_request_id: Some("closed-native-terminal-create".into()),
    };
    let terminal = controller
        .launch(request)
        .await
        .expect("actual terminal controller/supervisor/host launch");
    let receipt = fixture.join("workspace/native-consumed.json");
    async fn read_receipt(path: &Path) -> Result<Value, &'static str> {
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                if let Ok(bytes) = std::fs::read(path) {
                    if let Ok(value) = serde_json::from_slice(&bytes) {
                        return value;
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| "actual pinned provider startup did not consume selected config and closure")
    }
    let expected = json!({"prompt":format!("{:x}",Sha256::digest(b"AUTH_PREFIXnative-ruleAUTH_SUFFIX")),
        "description":format!("{:x}",Sha256::digest(b"native-explicit-selected-rule")),
        "references":(["third","fourth","fifth","sixth"].map(|ordinal|format!("{:x}",Sha256::digest(format!("native-{ordinal}-rule").as_bytes())))),
        "resource":format!("{:x}",Sha256::digest(b"plugin-relative-resource")),
        "dependency":format!("{:x}",Sha256::digest(b"plugin-actual-local-dependency")),"sdk":format!("{:x}",Sha256::digest(b"function"))});
    let client = controller.runtime_client();
    let terminal_receipt = match read_receipt(&receipt).await {
        Ok(value) => value,
        Err(error) => {
            let output = client
                .read_output(
                    SoulId::parse(terminal.soul_id.clone()).unwrap(),
                    0,
                    64 * 1024,
                )
                .await
                .unwrap();
            let text = output
                .frames
                .iter()
                .map(|frame| frame.data.as_str())
                .collect::<String>();
            let classes = [
                "ConfigInvalidError",
                "ConfigJsonError",
                "JSON parsing",
                "SyntaxError",
                "EACCES",
                "ENOENT",
                "Failed to import",
                "plugin",
                "opencode.json",
                "bun install",
                "ModuleNotFound",
            ]
            .into_iter()
            .filter(|class| text.contains(class))
            .collect::<Vec<_>>();
            println!(
                "provider_launch_diagnostic {}",
                json!({"route":"terminal","exited":output.exited,"exitCode":output.exit_code,"outputBytes":text.len(),"classes":classes,"containsAuthSentinel":text.contains("AUTH_PREFIX"),"containsGeneratedName":text.contains("FRESHELL_CONFIG_REFERENCE_0")})
            );
            panic!("{error}");
        }
    };
    assert_eq!(terminal_receipt, expected);
    assert_eq!(
        read_receipt(&tui_receipt)
            .await
            .expect("actual TUI plugin must consume the selected effective TUI configuration"),
        json!({"theme":format!("{:x}",Sha256::digest(b"dark"))})
    );
    assert_eq!(
        std::fs::read_to_string(&selected_tui).unwrap(),
        selected_tui_bytes
    );
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"opencode","route":"terminal-tui","digest":format!("{:x}",Sha256::digest(b"dark"))})
    );
    assert_eq!(std::fs::read(&original_config).unwrap(), original_bytes);
    assert_eq!(std::fs::read(&explicit_config).unwrap(), explicit_bytes);
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"opencode","route":"terminal","digest":format!("{:x}",Sha256::digest(serde_json::to_vec(&expected).unwrap()))})
    );
    client
        .stop(SoulId::parse(terminal.soul_id).unwrap())
        .await
        .unwrap();
    std::fs::remove_file(&receipt).unwrap();
    // Fresh launches use current server controls; the terminal exercised a
    // request-only relative control. Both must activate the explicit layer.
    std::env::set_var("OPENCODE_CONFIG", &explicit_config);
    std::env::set_var("OPENCODE_TUI_CONFIG", &selected_tui);
    let (broadcast, _) = tokio::sync::broadcast::channel(256);
    let mut events = broadcast.subscribe();
    let proxy = crate::fresh_agent_proxy::HostedFreshAgentProxy::from_opt_in(
        Some(client.clone()),
        Arc::new(broadcast),
    )
    .unwrap()
    .unwrap();
    let message:freshell_protocol::FreshAgentCreate=serde_json::from_value(json!({"requestId":"closed-native-fresh-create","sessionType":"freshopencode","provider":"opencode","cwd":cwd,"model":"closed-fixture/unavailable"})).unwrap();
    Arc::clone(&proxy)
        .dispatch(HostedFreshAgentCommand::Create(message))
        .await;
    let created = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let raw = events.recv().await.unwrap();
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.create.failed" {
                panic!("actual fresh launch failed: {}", frame["message"]);
            }
            if frame["type"] == "freshAgent.created" {
                break frame;
            }
        }
    })
    .await
    .expect("actual fresh create response");
    assert!(created["sessionId"].as_str().is_some());
    // OpenCode preserves a zero-turn placeholder until its first send. The
    // synthetic native plugin rejects chat.message before the model/title loop;
    // exercise the real gateway's first-start path without a model request.
    let send = serde_json::from_value(json!({
        "requestId":"closed-native-fresh-startup", "provider":"opencode",
        "sessionType":"freshopencode", "sessionId":created["sessionId"],
        "text":"closed synthetic startup qualification", "cwd":cwd
    }))
    .unwrap();
    Arc::clone(&proxy)
        .dispatch(HostedFreshAgentCommand::Send(send))
        .await;
    assert_eq!(read_receipt(&receipt).await.unwrap(), expected);
    assert_eq!(std::fs::read(&original_config).unwrap(), original_bytes);
    assert_eq!(std::fs::read(&explicit_config).unwrap(), explicit_bytes);
    let stopped = fixture.join("workspace/native-consumed.json.stopped");
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if std::fs::read(&stopped)
                .is_ok_and(|value| value == b"FRESHELL_SYNTHETIC_STARTUP_STOP")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("native plugin must stop the fresh request before the model loop");
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"opencode","route":"fresh","digest":format!("{:x}",Sha256::digest(serde_json::to_vec(&expected).unwrap()))})
    );
    // Scan only run-owned durable/staged surfaces; referenced payloads belong
    // in private indexed files, not ordinary resource/configuration trees.
    fn assert_private_sentinels_absent(root: &Path) {
        for entry in std::fs::read_dir(root).unwrap() {
            let entry = entry.unwrap();
            let metadata = entry.file_type().unwrap();
            if metadata.is_dir() {
                assert_private_sentinels_absent(&entry.path());
            } else if metadata.is_file() {
                let bytes = std::fs::read(entry.path()).unwrap();
                for sentinel in [
                    b"AUTH_PREFIX".as_slice(),
                    b"native-rule".as_slice(),
                    b"native-explicit-selected-rule".as_slice(),
                    b"synthetic-onecli-shadowed".as_slice(),
                ] {
                    assert!(
                        !bytes.windows(sentinel.len()).any(|value| value == sentinel),
                        "private input leaked to an owned durable/staged surface"
                    );
                }
            }
        }
    }
    assert_private_sentinels_absent(&fixture.join("registry"));
    assert_private_sentinels_absent(&control.join("provider-roots"));
    assert_private_sentinels_absent(&fixture.join("handoff"));
    for view in client.inventory().await.unwrap() {
        if view.desired_state == DesiredState::Running {
            client.stop(view.soul_id).await.unwrap();
        }
    }
    web_task.abort();
    control_task.abort();
}
