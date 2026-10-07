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

fn assert_private_sentinels_absent(root: &Path, certificate_sentinel: &[u8]) {
    for entry in std::fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        let metadata = entry.file_type().unwrap();
        if metadata.is_dir() {
            assert_private_sentinels_absent(&entry.path(), certificate_sentinel);
        } else if metadata.is_file() {
            let bytes = std::fs::read(entry.path()).unwrap();
            for (ordinal, sentinel) in [
                certificate_sentinel,
                b"AUTH_PREFIX".as_slice(),
                b"native-rule".as_slice(),
                b"native-explicit-selected-rule".as_slice(),
                b"native-inline-selected-rule".as_slice(),
                b"native-shared-root-rule".as_slice(),
                b"native-shared-nested-rule".as_slice(),
                b"shared-home-private-rule".as_slice(),
                b"shared-home-sensitive-file".as_slice(),
                b"INLINE_PREFIX".as_slice(),
                b"AUTH_INLINE_SHADOW_NO_FILE".as_slice(),
                b"synthetic-onecli-shadowed".as_slice(),
            ]
            .into_iter()
            .enumerate()
            {
                assert!(
                    !bytes.windows(sentinel.len()).any(|value| value == sentinel),
                    "private input sentinel {ordinal} leaked to owned surface {}",
                    entry.path().display()
                );
            }
        }
    }
}

/// Delegates every lifecycle operation to the actual Docker backend. The only
/// added operation delivers metadata to the closed fixture's trusted broker.
struct BrokerAuthorizedBackend {
    real: DockerEngineBackend,
    control: PathBuf,
    handoff: PathBuf,
    certificate_sentinel: Vec<u8>,
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
        assert_private_sentinels_absent(
            &self
                .control
                .join("provider-roots")
                .join(&inputs.generation_id),
            &self.certificate_sentinel,
        );
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

fn capture_fresh_launch_failure_classes() -> std::sync::Arc<std::sync::Mutex<Vec<&'static str>>> {
    use tracing_subscriber::prelude::*;
    #[derive(Clone)]
    struct FailureLayer(std::sync::Arc<std::sync::Mutex<Vec<&'static str>>>);
    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for FailureLayer {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _: tracing_subscriber::layer::Context<'_, S>,
        ) {
            if !event.metadata().target().contains("fresh_agent_proxy") {
                return;
            }
            struct Classes(Vec<&'static str>);
            impl tracing::field::Visit for Classes {
                fn record_debug(
                    &mut self,
                    field: &tracing::field::Field,
                    value: &dyn std::fmt::Debug,
                ) {
                    if field.name() != "error" {
                        return;
                    }
                    let text = format!("{value:?}");
                    for label in [
                        "HostUnreachable",
                        "InvalidRequest",
                        "ProviderInputsChanged",
                        "prepare hosted provider config",
                        "prepare hosted fresh-agent provider state",
                        "prepare hosted OneCLI provider files",
                        "open hosted",
                        "OneCLI",
                        "profile",
                        "credential",
                        "unsafe or mismatched",
                        "MCP",
                        "sidecar",
                        "source",
                        "manifest",
                        "copy",
                        "Permission",
                        "unavailable",
                        "initialization",
                        "timed out",
                        "Claude",
                        "kilroy",
                        "environment",
                        "grant",
                        "provider",
                        "configuration",
                        "refresh",
                        "input bind",
                        "trusted uid/group",
                        "provider home",
                        "resource",
                        "destination",
                        "projection",
                        "stage",
                        "metadata",
                        "path",
                        "readable",
                        "preparation",
                        "version",
                        "changed",
                        "rootless",
                        "directory",
                        "filesystem",
                        "temporary",
                        "failed to start",
                        "failed with status",
                    ] {
                        if text.contains(label) {
                            self.0.push(label);
                        }
                    }
                }
            }
            let mut classes = Classes(Vec::new());
            event.record(&mut classes);
            self.0.lock().unwrap().extend(classes.0);
        }
    }
    let classes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    tracing::subscriber::set_global_default(
        tracing_subscriber::registry().with(FailureLayer(classes.clone())),
    )
    .unwrap();
    classes
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn managed_provider_amplifier_terminal_native_startup_consumes_prepared_inputs() {
    use freshell_supervisor::{
        admission::AdmissionPolicy,
        registry::Registry,
        service::{serve_control, Supervisor, SupervisorConfig},
    };
    use freshell_terminal::registry::{ManagedTerminalController, ManagedTerminalLaunch};
    use sha2::{Digest, Sha256};
    use std::{os::unix::fs::PermissionsExt, sync::Arc};
    let fixture = PathBuf::from(std::env::var_os("FRESHELL_PROVIDER_LAUNCH_FIXTURE").unwrap());
    assert_eq!(fixture.parent(), Some(Path::new("/tmp")));
    assert!(fixture
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("fln-"));
    let home = fixture.join("source-home");
    let workspace = fixture.join("workspace");
    let bundle = home.join(".amplifier/bundles/selected");
    let skill = home.join(".amplifier/skills/probe");
    let control = fixture.join("scenarios/native/control");
    let runtime = fixture.join("scenarios/n/r");
    let receipt = workspace.join("amplifier-consumed.json");
    for path in [
        &control,
        &runtime,
        &bundle.join("modules/context-probe/amplifier_module_context_probe"),
        &bundle.join("modules/loop-probe/amplifier_module_loop_probe"),
        &bundle.join("modules/hooks-probe/amplifier_module_hooks_probe"),
        &skill.join("node_modules/probe-dependency"),
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(&workspace)
        .status()
        .unwrap()
        .success());
    std::fs::write(skill.join("resource"), b"closed-amplifier-resource").unwrap();
    std::fs::write(
        skill.join("node_modules/probe-dependency/index.js"),
        "module.exports='closed-amplifier-dependency'",
    )
    .unwrap();
    std::fs::write(skill.join("run"),"#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path');process.stdout.write(fs.readFileSync(path.join(__dirname,'resource'),'utf8')+':'+require('probe-dependency'));").unwrap();
    std::fs::set_permissions(skill.join("run"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let context_module = r#"__amplifier_module_type__='context'
class Context:
    def __init__(self): self.messages=[]; self.factory=None
    async def add_message(self,message): self.messages.append(message)
    async def get_messages(self): return list(self.messages)
    async def get_messages_for_request(self,**kwargs): return list(self.messages)
    async def set_messages(self,messages): self.messages=list(messages)
    async def clear(self): self.messages=[]
    async def set_system_prompt_factory(self,factory): self.factory=factory
    def get_context_info(self): return {'message_count':len(self.messages),'token_count':0}
async def mount(coordinator,config=None): await coordinator.mount('context',Context())
"#;
    let loop_module = r#"__amplifier_module_type__='orchestrator'
class Loop:
    async def execute(self,prompt,context,providers,tools,hooks,**kwargs): raise RuntimeError('model turns are outside this closed startup fixture')
async def mount(coordinator,config=None): await coordinator.mount('orchestrator',Loop())
"#;
    let hook_module = r#"__amplifier_module_type__='hook'
import hashlib,json,os,subprocess,urllib.request
from pathlib import Path
from amplifier_core import HookResult
_consumer=None
async def mount(coordinator,config=None):
    global _consumer
    config=config or {}
    async def consume(event,data):
        uv=subprocess.check_output(['uv','--version'],text=True).strip()
        output=subprocess.check_output([str(Path.home()/'.amplifier/skills/probe/run')])
        request=urllib.request.Request(os.environ['FRESHELL_URL']+'/api/mcp',data=b'{}',headers={'x-auth-token':os.environ['FRESHELL_TOKEN']})
        with urllib.request.urlopen(request,timeout=5) as response: authenticated=response.status==200
        result={'nativeCallback':event=='on_session_ready','exactIdentity':data.get('session_id')==config['session_id'],'physicalHome':str(Path.home()),'authenticated':authenticated,'scopedAlias':os.environ.get('FRESHELL')=='1','onecli':hashlib.sha256(os.environ.get('OPENAI_API_KEY','').encode()).hexdigest()==config['key_digest'],'nativeModuleInstaller':uv.startswith('uv 0.8.22'),'resourceAndDependency':hashlib.sha256(output).hexdigest()}
        Path(config['receipt']).write_text(json.dumps(result))
        return HookResult(action='continue')
    _consumer=consume
    for event in ['session:start','session:resume']: coordinator.hooks.register(event,consume,name='closed-native-probe')
async def on_session_ready(coordinator):
    await _consumer('on_session_ready',{'session_id':coordinator.session_id})
"#;
    for (name, module) in [
        ("context-probe", context_module),
        ("loop-probe", loop_module),
        ("hooks-probe", hook_module),
    ] {
        std::fs::write(
            bundle.join(format!(
                "modules/{name}/amplifier_module_{}/__init__.py",
                name.replace('-', "_")
            )),
            module,
        )
        .unwrap();
    }
    let native_id = "41a04bb3-86f0-463d-97c5-f085e8a9ea4b";
    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    let bundle_document=format!("bundle:\n  name: closed-native-bundle\nsession:\n  orchestrator:\n    module: loop-probe\n    source: ./modules/loop-probe\n  context:\n    module: context-probe\n    source: ./modules/context-probe\nproviders:\n  - module: provider-vllm\n    config:\n      base_url: http://127.0.0.1:9\n      default_model: closed-model-free\nhooks:\n  - module: hooks-probe\n    source: ./modules/hooks-probe\n    config:\n      receipt: {}\n      session_id: {}\n      key_digest: {}\n",serde_json::to_string(receipt.to_str().unwrap()).unwrap(),native_id,hash(b"synthetic-amplifier-onecli-value"));
    std::fs::write(bundle.join("bundle.yaml"), &bundle_document).unwrap();
    let settings=format!("bundle:\n  active: file://{}\nproviders:\n  - module: provider-vllm\n    config:\n      base_url: http://127.0.0.1:9\n      default_model: closed-model-free\n",bundle.display());
    std::fs::write(home.join(".amplifier/settings.yaml"), &settings).unwrap();
    let env_file = fixture.join("grants/environment.env");
    std::fs::write(
        &env_file,
        "OPENAI_API_KEY=synthetic-amplifier-onecli-value\nOPENAI_BASE_URL=http://127.0.0.1:9\n",
    )
    .unwrap();
    std::fs::set_permissions(&env_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::env::set_var("FRESHELL_MANAGED_AMPLIFIER_ONECLI_ENV_FILE", &env_file);
    let registry = Registry::open(
        fixture.join("registry"),
        Some(
            InstallationId::parse(std::env::var("FRESHELL_PROVIDER_LAUNCH_INSTALLATION").unwrap())
                .unwrap(),
        ),
    )
    .unwrap();
    std::env::set_var("FRESHELL_MANAGED_PROVIDER_QUALIFICATION", "amplifier");
    let socket = control.join("control.sock");
    let secret_file = control.join("secret");
    std::fs::write(&secret_file, "closed-synthetic-control-secret").unwrap();
    std::fs::set_permissions(&secret_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    freshell_supervisor::backend::docker::configure_capability_dir(&socket).unwrap();
    let supervisor = Supervisor::new(
        registry.clone(),
        Arc::new(BrokerAuthorizedBackend {
            real: DockerEngineBackend::new(fixture.join("broker.sock")),
            control: control.clone(),
            handoff: fixture.join("handoff"),
            certificate_sentinel: b"synthetic-amplifier-onecli-value".to_vec(),
        }),
        SupervisorConfig {
            runtime_root: runtime,
            control_socket_path: socket.clone(),
            host_binary_path: PathBuf::from(
                std::env::var_os("FRESHELL_PROVIDER_LAUNCH_HOST_BINARY").unwrap(),
            ),
            image_ref: std::env::var("FRESHELL_PROVIDER_LAUNCH_IMAGE").unwrap(),
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
    let app = axum::Router::new()
        .route("/api/health", axum::routing::get(|| async { "ok" }))
        .route(
            "/api/mcp",
            axum::routing::post(|headers: axum::http::HeaderMap| async move {
                if headers
                    .get("x-auth-token")
                    .is_some_and(|token| token == "closed-synthetic-web-token")
                {
                    axum::http::StatusCode::OK
                } else {
                    axum::http::StatusCode::UNAUTHORIZED
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            Arc::new("closed-synthetic-web-token".to_string()),
            crate::managed_mcp_capability::scoped_auth_middleware,
        ));
    let web_task = tokio::spawn(async move { axum::serve(web, app).await.unwrap() });
    crate::managed_mcp_capability::configure("0.0.0.0", port, &socket, &secret_file).unwrap();
    crate::managed_mcp_capability::spawn_callback_server()
        .await
        .unwrap();
    for name in [
        "FRESHELL_MANAGED_RUNTIME_V1",
        "FRESHELL_MANAGED_FRESH_AGENT_V1",
    ] {
        std::env::set_var(name, "1");
    }
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SOCKET", &socket);
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SECRET_FILE", &secret_file);
    std::env::set_var("HOME", &home);
    let controller = crate::managed_runtime::ServerManagedRuntimeController::from_env()
        .await
        .unwrap()
        .unwrap();
    let cwd = workspace.to_str().unwrap().to_string();
    let ambient_home = fixture.join("ambient-home");
    std::fs::create_dir_all(ambient_home.join(".amplifier")).unwrap();
    std::fs::write(
        ambient_home.join(".amplifier/settings.yaml"),
        "bundle:\n  active: ./missing-ambient-decoy\n",
    )
    .unwrap();
    std::env::set_var("HOME", &ambient_home);
    let terminal = controller
        .launch(ManagedTerminalLaunch {
            spec: freshell_platform::spawn::SpawnSpec {
                program: "amplifier".into(),
                args: vec![
                    "session".into(),
                    "resume".into(),
                    "--full-history".into(),
                    native_id.into(),
                ],
                env_overrides: BTreeMap::new(),
                cwd: Some(cwd),
                cols: 120,
                rows: 30,
            },
            env: BTreeMap::from([("HOME".into(), home.to_str().unwrap().into())]),
            terminal_id: "closed-native-terminal".into(),
            stream_id: "closed-native-stream".into(),
            mode: "amplifier".into(),
            resume_session_id: Some(native_id.into()),
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            view_tab_id: None,
            view_pane_id: None,
            create_request_id: Some("closed-native-terminal-create".into()),
        })
        .await
        .expect("complete native Amplifier terminal startup");
    let client = controller.runtime_client();
    let observed = tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            if let Ok(bytes) = std::fs::read(&receipt) {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    break value;
                }
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .ok();
    if observed.is_some() {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let output = client
        .read_output(
            SoulId::parse(terminal.soul_id.clone()).unwrap(),
            0,
            64 * 1024,
        )
        .await
        .unwrap();
    if observed.is_none() || output.exited {
        let text = crate::ai_title::strip_ansi(
            &output
                .frames
                .iter()
                .map(|frame| frame.data.as_str())
                .collect::<String>(),
        );
        let classes = [
            "ENOENT",
            "EACCES",
            "Module",
            "module",
            "provider",
            "Provider",
            "orchestrator",
            "context",
            "Error",
            "Error:",
            "failed",
            "Traceback",
            "installed",
            "Installing",
            "dependency",
            "missing",
            "Permission",
            "session",
            "Session",
            "bundle",
            "Bundle",
            "setup",
            "configure",
            "No module named",
            "ModuleNotFoundError",
            "ImportError",
            "TypeError",
            "AttributeError",
            "ValidationError",
            "RuntimeError",
            "FileNotFoundError",
            "PermissionError",
            "ModuleLoadError",
            "ModuleValidationError",
            "Failed to install",
            "Failed to load",
            "Failed to mount",
            "Failed to initialize",
            "Failed to resolve",
            "not found",
            "not installed",
            "pyproject.toml",
            "No solution found",
            "network",
            "Connection",
            "loop-probe",
            "context-probe",
            "hooks-probe",
            "provider-vllm",
            "orchestrator missing",
            "context missing",
            "required",
            "abstract",
            "signature",
            "source",
            "not found in prepared bundle",
            "no source hint",
            "activation failed",
            "Failed to activate",
            "Failed to lazy-activate",
            "does not exist",
            "entry points or filesystem",
            "has no valid Python package",
            "failed validation",
            "Mount function",
            "must be async",
            "No pyproject.toml",
            "Could not find",
            "Cannot find",
            "Could not load",
            "Module source",
            "Source path",
            "All configured",
            "not available",
            "not mounted",
            "install dependencies",
            "dependency installation",
            "No context module",
            "No orchestrator module",
            "not a valid",
            "parse",
            "activate",
            "resolve",
            "validate",
            "uv is not installed",
            "File not found:",
            "No such file or directory",
            "Read-only file system",
            "Permission denied",
            "Failed to install module",
            "No providers",
            "No context",
            "No orchestrator",
            "Failed to initialize session",
            "validation",
            "mount",
            "uv",
            "pip",
            "base_url",
            "session_id",
            "attribute",
            "await",
            "Context",
            "dict",
            "Prompt",
            "factory",
        ]
        .into_iter()
        .filter(|class| text.contains(class))
        .collect::<Vec<_>>();
        // Emit only finite diagnostic labels; paths, credentials, arbitrary
        // exception payloads and provider output never enter the test log.
        let labels = "error failed unable cannot could not create remove write read only readonly filesystem permission denied temporary directory file path uv pip install installed package build backend fetch download resolve git clone network connection certificate tls ssl python virtual environment target source module cache lock resource unavailable no such system command subprocess status exit stdout stderr caused by requires version dependency dependencies hooks-mode modes hatchling setuptools attribute object dict await coroutine context set_system_prompt_factory get_context_info config keys data serialize tuple type callable required schema factory prompt"
            .split_whitespace().collect::<Vec<_>>();
        let classified_errors = text
            .lines()
            .filter(|line| {
                let line = line.to_ascii_lowercase();
                line.contains("error") || line.contains("failed") || line.contains("caused by")
            })
            .take(16)
            .map(|line| {
                line.split(|ch: char| !ch.is_ascii_alphabetic() && ch != '-')
                    .filter_map(|word| {
                        labels
                            .iter()
                            .copied()
                            .find(|label| word.eq_ignore_ascii_case(label))
                    })
                    .take(80)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        println!(
            "provider_launch_diagnostic {}",
            json!({"provider":"amplifier","route":"terminal","exited":output.exited,"exitCode":output.exit_code,"outputBytes":text.len(),"classes":classes,"classifiedErrors":classified_errors})
        );
    }
    let expected = json!({"nativeCallback":true,"exactIdentity":true,"physicalHome":"/home/freshell/provider","authenticated":true,"scopedAlias":true,"onecli":true,"nativeModuleInstaller":true,"resourceAndDependency":hash(b"closed-amplifier-resource:closed-amplifier-dependency")});
    assert_eq!(observed.expect("real Amplifier must activate selected local module and executable skill before a model turn"),expected);
    assert!(
        !output.exited,
        "native Amplifier must remain usable after the initialization consumer"
    );
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"amplifier","route":"terminal","digest":hash(serde_json::to_vec(&expected).unwrap().as_slice())})
    );
    assert_eq!(
        std::fs::read_to_string(home.join(".amplifier/settings.yaml")).unwrap(),
        settings
    );
    assert_eq!(
        std::fs::read_to_string(bundle.join("bundle.yaml")).unwrap(),
        bundle_document
    );
    client
        .stop(SoulId::parse(terminal.soul_id).unwrap())
        .await
        .unwrap();
    web_task.abort();
    control_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn managed_provider_claude_terminal_and_fresh_native_startup_consumes_prepared_inputs() {
    let failure_classes = capture_fresh_launch_failure_classes();
    use freshell_supervisor::{
        admission::AdmissionPolicy,
        registry::Registry,
        service::{serve_control, Supervisor, SupervisorConfig},
    };
    use freshell_terminal::registry::{ManagedTerminalController, ManagedTerminalLaunch};
    use freshell_ws::hosted_fresh_agent::{HostedFreshAgentCommand, HostedFreshAgentGateway};
    use sha2::{Digest, Sha256};
    use std::{os::unix::fs::PermissionsExt, sync::Arc};
    let fixture = PathBuf::from(
        std::env::var_os("FRESHELL_PROVIDER_LAUNCH_FIXTURE").expect("closed Claude launch fixture"),
    );
    assert_eq!(fixture.parent(), Some(Path::new("/tmp")));
    assert!(fixture
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("fln-"));
    let home = fixture.join("source-home");
    let selected_config = home.join("selected-config");
    let workspace = fixture.join("workspace");
    let plugin = home.join("selected-plugin");
    let control = fixture.join("scenarios/native/control");
    let runtime = fixture.join("scenarios/n/r");
    for path in [
        &control,
        &runtime,
        &home.join(".claude"),
        &selected_config,
        &plugin.join(".claude-plugin"),
        &plugin.join("hooks"),
        &plugin.join("scripts/node_modules/probe-dependency"),
        &plugin.join("skills/probe"),
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(&workspace)
        .status()
        .unwrap()
        .success());
    let disabled_project_memory = workspace.join("CLAUDE.md");
    let disabled_project_settings = workspace.join(".claude/settings.json");
    std::fs::create_dir_all(workspace.join(".claude")).unwrap();
    std::fs::write(&disabled_project_memory, "@missing-disabled-project.md\n").unwrap();
    std::fs::write(
        &disabled_project_settings,
        r#"{"env":{"CLAUDE_SELECTED_NONCE":"disabled-project-decoy"}}"#,
    )
    .unwrap();
    let receipt = workspace.join("claude-consumed.json");
    let instructions_receipt = workspace.join("claude-import-consumed.json");
    let memory = format!(
        "closed-claude-global-memory\n@../imported-memory.md\n@../selected-plugin/relative-memory.md\n@~/selected-plugin/home-memory.md\n@{}/absolute-memory.md\n@../selected-plugin/spaced\\ memory.md\n`@../selected-plugin/ignored-inline.md`\n```\n@../selected-plugin/ignored-fence.md\n```\n@\"../selected-plugin/ignored-quoted.md\"\n",
        plugin.display()
    ).into_bytes();
    std::fs::write(
        home.join("imported-memory.md"),
        b"closed-claude-imported-memory\n@./selected-plugin/nested-memory.md\n",
    )
    .unwrap();
    std::fs::write(selected_config.join("CLAUDE.md"), &memory).unwrap();
    std::fs::create_dir_all(selected_config.join("rules/nested")).unwrap();
    let rule = "@../../../rule-memory.md\n`@../../../missing-rule-code.md`\n```\n@../../../missing-rule-fence.md\n```\n";
    std::fs::write(selected_config.join("rules/nested/policy.md"), rule).unwrap();
    std::fs::write(home.join("rule-memory.md"), "closed-selected-rule-memory\n").unwrap();
    std::fs::write(
        home.join(".claude/CLAUDE.md"),
        "@../missing-unselected-default.md\n",
    )
    .unwrap();
    for name in [
        "relative-memory.md",
        "home-memory.md",
        "absolute-memory.md",
        "spaced memory.md",
        "nested-memory.md",
        "ignored-inline.md",
        "ignored-fence.md",
        "ignored-quoted.md",
    ] {
        std::fs::write(plugin.join(name), format!("closed-native-{name}")).unwrap();
    }
    let settings = r#"{"env":{"CLAUDE_SELECTED_NONCE":"closed-selected-settings"}}"#;
    std::fs::write(selected_config.join("settings.json"), settings).unwrap();
    std::fs::write(
        home.join(".claude/settings.json"),
        r#"{"env":{"CLAUDE_SELECTED_NONCE":"unselected-default"}}"#,
    )
    .unwrap();
    std::fs::write(plugin.join("skills/probe/SKILL.md"),"---\nname: closed-plugin-probe\ndescription: selected complete native plugin\n---\nUse the adjacent resources.\n").unwrap();
    std::fs::write(plugin.join("scripts/resource"), b"closed-claude-resource").unwrap();
    std::fs::write(
        plugin.join("scripts/node_modules/probe-dependency/index.js"),
        "module.exports='closed-claude-dependency'\n",
    )
    .unwrap();
    std::fs::write(
        plugin.join("scripts/run"),
        "#!/bin/sh\ncat \"$(dirname \"$0\")/resource\"\n",
    )
    .unwrap();
    std::fs::set_permissions(
        plugin.join("scripts/run"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let consumer = r#"const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',async()=>{
 const input=JSON.parse(raw),root=path.resolve(__dirname,'..');
 const endpoint=process.env.FRESHELL_URL,token=process.env.FRESHELL_TOKEN;
 const authenticated=await new Promise(resolve=>{if(!endpoint||!token)return resolve(false);const req=http.request(new URL('/api/mcp',endpoint),{method:'POST',headers:{'x-auth-token':token}},res=>{res.resume();resolve(res.statusCode===200)});req.on('error',()=>resolve(false));req.end('{}')});
 const record={hook:input.hook_event_name==='SessionStart',physicalHome:process.env.HOME,settings:['closed-selected-settings','closed-explicit-settings'].includes(process.env.CLAUDE_SELECTED_NONCE),authenticated,scopedAlias:process.env.FRESHELL==='1',onecli:hash(process.env.ANTHROPIC_API_KEY||'')===process.argv[3],
 memory:hash(fs.readFileSync(path.join(process.env.HOME,'.claude/CLAUDE.md'))),skill:hash(fs.readFileSync(path.join(root,'skills/probe/SKILL.md'))),resource:hash(require('node:child_process').execFileSync(path.join(__dirname,'run'))),dependency:hash(require('probe-dependency'))};
 fs.writeFileSync(process.argv[2],JSON.stringify(record));
});
"#;
    std::fs::write(plugin.join("scripts/consume.cjs"), consumer).unwrap();
    let flag_receipt = workspace.join("claude-flag-receipt.json");
    std::fs::write(plugin.join("scripts/flag.cjs"), "const fs=require('node:fs'),crypto=require('node:crypto');const hash=v=>crypto.createHash('sha256').update(v).digest('hex');let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const input=JSON.parse(raw);fs.writeFileSync(process.argv[2],JSON.stringify({flag:input.hook_event_name==='SessionStart'&&process.env.CLAUDE_SELECTED_NONCE==='closed-explicit-settings',resource:hash(require('node:child_process').execFileSync(__dirname+'/run')),dependency:hash(require('probe-dependency'))}))})").unwrap();
    let flag_commands = selected_config.join("commands");
    std::fs::create_dir_all(flag_commands.join("node_modules/probe-dependency")).unwrap();
    for relative in [
        "flag.cjs",
        "run",
        "resource",
        "node_modules/probe-dependency/index.js",
    ] {
        std::fs::copy(
            plugin.join("scripts").join(relative),
            flag_commands.join(relative),
        )
        .unwrap();
    }
    let flag_origin = selected_config.join("explicit-origin");
    std::fs::create_dir(&flag_origin).unwrap();
    let flag_settings = flag_origin.join("settings.json");
    let flag_value = json!({"env":{"CLAUDE_SELECTED_NONCE":"closed-explicit-settings"},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":format!("node \"../source-home/selected-config/commands/flag.cjs\" {}",serde_json::to_string(flag_receipt.to_str().unwrap()).unwrap()),"timeout":10}]}]}});
    let flag_bytes = serde_json::to_vec(&flag_value).unwrap();
    std::fs::write(&flag_settings, &flag_bytes).unwrap();
    let flag_alias = selected_config.join("selected-settings.json");
    std::os::unix::fs::symlink(&flag_settings, &flag_alias).unwrap();
    let settings_form = std::env::var("FRESHELL_PROVIDER_LAUNCH_CLAUDE_SETTINGS_FORM")
        .unwrap_or_else(|_| "file".into());
    let flag_argument = match settings_form.as_str() {
        "file" => "../source-home/selected-config/selected-settings.json".into(),
        "inline" => String::from_utf8(flag_bytes.clone()).unwrap(),
        "owned-last" => freshell_platform::cli_launch::claude_settings_json(
            freshell_platform::cli_launch::ProviderTarget::Unix,
        ),
        _ => panic!("closed fixture settings form must be file, inline or owned-last"),
    };
    let instructions_consumer = r#"const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{
 const input=JSON.parse(raw),name=path.basename(input.file_path||''),event=input.hook_event_name==='InstructionsLoaded';
 const names=['imported-memory.md','relative-memory.md','home-memory.md','absolute-memory.md','spaced memory.md','nested-memory.md','rule-memory.md'];
 const selected=event&&names.includes(name)?{name,digest:crypto.createHash('sha256').update(fs.readFileSync(input.file_path)).digest('hex')}:null;
 fs.appendFileSync(process.argv[2]+'.events',JSON.stringify({event,global:input.file_path===process.env.HOME+'/.claude/CLAUDE.md',project:input.file_path===process.argv[3],ignored:event&&name.startsWith('ignored-'),selected})+'\n');
 if(event&&input.file_path===process.env.HOME+'/imported-memory.md')fs.writeFileSync(process.argv[2],JSON.stringify({nativeImport:true,digest:selected.digest}));
});
"#;
    std::fs::write(
        plugin.join("scripts/instructions.cjs"),
        instructions_consumer,
    )
    .unwrap();
    let manifest = json!({"name":"closed-selected-plugin","version":"1.0.0","skills":"./skills","hooks":"./hooks/hooks.json"});
    std::fs::write(
        plugin.join(".claude-plugin/plugin.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let key_digest = format!("{:x}", Sha256::digest(b"synthetic-claude-onecli-value"));
    let hooks = json!({"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":format!("node \"${{CLAUDE_PLUGIN_ROOT}}/scripts/consume.cjs\" {} {}",serde_json::to_string(receipt.to_str().unwrap()).unwrap(),key_digest),"timeout":10}]}]}});
    let mut hooks = hooks;
    hooks["hooks"]["InstructionsLoaded"] = json!([{"hooks":[{"type":"command","command":format!("node \"${{CLAUDE_PLUGIN_ROOT}}/scripts/instructions.cjs\" {} {}",serde_json::to_string(instructions_receipt.to_str().unwrap()).unwrap(),serde_json::to_string(disabled_project_memory.to_str().unwrap()).unwrap()),"timeout":10}]}]);
    std::fs::write(
        plugin.join("hooks/hooks.json"),
        serde_json::to_vec(&hooks).unwrap(),
    )
    .unwrap();
    let validated = std::process::Command::new("claude")
        .args(["plugin", "validate"])
        .arg(&plugin)
        .env("HOME", &home)
        .output()
        .unwrap();
    assert!(
        validated.status.success(),
        "native terminal plugin schema prerequisite failed"
    );
    let env_file = fixture.join("grants/environment.env");
    std::fs::write(
        &env_file,
        "ANTHROPIC_API_KEY=synthetic-claude-onecli-value\nANTHROPIC_BASE_URL=http://127.0.0.1:9\n",
    )
    .unwrap();
    std::fs::set_permissions(&env_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::env::set_var("FRESHELL_MANAGED_CLAUDE_ONECLI_ENV_FILE", &env_file);
    std::env::set_var("CLAUDE_CONFIG_DIR", &selected_config);
    let registry = Registry::open(
        fixture.join("registry"),
        Some(
            InstallationId::parse(std::env::var("FRESHELL_PROVIDER_LAUNCH_INSTALLATION").unwrap())
                .unwrap(),
        ),
    )
    .unwrap();
    std::env::set_var("FRESHELL_MANAGED_PROVIDER_QUALIFICATION", "claude");
    let socket = control.join("control.sock");
    let secret_file = control.join("secret");
    std::fs::write(&secret_file, "closed-synthetic-control-secret").unwrap();
    std::fs::set_permissions(&secret_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    freshell_supervisor::backend::docker::configure_capability_dir(&socket).unwrap();
    let supervisor = Supervisor::new(
        registry.clone(),
        Arc::new(BrokerAuthorizedBackend {
            real: DockerEngineBackend::new(fixture.join("broker.sock")),
            control: control.clone(),
            handoff: fixture.join("handoff"),
            certificate_sentinel: b"synthetic-claude-onecli-value".to_vec(),
        }),
        SupervisorConfig {
            runtime_root: runtime,
            control_socket_path: socket.clone(),
            host_binary_path: PathBuf::from(
                std::env::var_os("FRESHELL_PROVIDER_LAUNCH_HOST_BINARY").unwrap(),
            ),
            image_ref: std::env::var("FRESHELL_PROVIDER_LAUNCH_IMAGE").unwrap(),
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
    let app = axum::Router::new()
        .route("/api/health", axum::routing::get(|| async { "ok" }))
        .route(
            "/api/mcp",
            axum::routing::post(|headers: axum::http::HeaderMap| async move {
                if headers
                    .get("x-auth-token")
                    .is_some_and(|token| token == "closed-synthetic-web-token")
                {
                    axum::http::StatusCode::OK
                } else {
                    axum::http::StatusCode::UNAUTHORIZED
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            Arc::new("closed-synthetic-web-token".to_string()),
            crate::managed_mcp_capability::scoped_auth_middleware,
        ));
    let web_task = tokio::spawn(async move { axum::serve(web, app).await.unwrap() });
    crate::managed_mcp_capability::configure("0.0.0.0", port, &socket, &secret_file).unwrap();
    crate::managed_mcp_capability::spawn_callback_server()
        .await
        .unwrap();
    for name in [
        "FRESHELL_MANAGED_RUNTIME_V1",
        "FRESHELL_MANAGED_FRESH_AGENT_V1",
    ] {
        std::env::set_var(name, "1");
    }
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SOCKET", &socket);
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SECRET_FILE", &secret_file);
    std::env::set_var("HOME", &home);
    let controller = crate::managed_runtime::ServerManagedRuntimeController::from_env()
        .await
        .unwrap()
        .unwrap();
    let cwd = workspace.to_str().unwrap().to_string();
    let ambient_home = fixture.join("ambient-home");
    std::fs::create_dir_all(ambient_home.join(".claude")).unwrap();
    std::fs::write(
        ambient_home.join(".claude/CLAUDE.md"),
        "@missing-ambient-decoy.md\n",
    )
    .unwrap();
    std::env::set_var("HOME", &ambient_home);
    let terminal = controller
        .launch(ManagedTerminalLaunch {
            spec: freshell_platform::spawn::SpawnSpec {
                program: "claude".into(),
                args: vec![
                    "--init-only".into(),
                    "--setting-sources".into(),
                    "user".into(),
                    // Native chooses the last selector. Neither an unavailable
                    // earlier file nor its private inline document is selected.
                    "--settings".into(),
                    "missing-ignored-settings.json".into(),
                    "--settings={\"env\":{\"CLAUDE_SELECTED_NONCE\":\"ignored-settings-sentinel\"}}".into(),
                    "--settings".into(),
                    flag_argument,
                    "--plugin-dir".into(),
                    plugin.to_str().unwrap().into(),
                ],
                env_overrides: BTreeMap::new(),
                cwd: Some(cwd.clone()),
                cols: 120,
                rows: 30,
            },
            env: BTreeMap::from([
                ("HOME".into(), home.to_str().unwrap().into()),
                ("CLAUDE_CONFIG_DIR".into(), "../source-home/selected-config".into()),
            ]),
            terminal_id: "closed-native-terminal".into(),
            stream_id: "closed-native-stream".into(),
            mode: "claude".into(),
            resume_session_id: None,
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            view_tab_id: None,
            view_pane_id: None,
            create_request_id: Some("closed-native-terminal-create".into()),
        })
        .await
        .expect("complete native Claude terminal startup");
    let client = controller.runtime_client();
    async fn consumed(path: &Path) -> Option<Value> {
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                if let Ok(bytes) = std::fs::read(path) {
                    if let Ok(value) = serde_json::from_slice(&bytes) {
                        break value;
                    }
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .ok()
    }
    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    let expected = json!({"hook":true,"physicalHome":"/home/freshell/provider","settings":true,"authenticated":true,"scopedAlias":true,"onecli":true,"memory":hash(&memory),"skill":hash(std::fs::read(plugin.join("skills/probe/SKILL.md")).unwrap().as_slice()),"resource":hash(b"closed-claude-resource"),"dependency":hash(b"closed-claude-dependency")});
    let imported_bytes = std::fs::read(home.join("imported-memory.md")).unwrap();
    let mut expected_imports = serde_json::Map::new();
    expected_imports.insert("imported-memory.md".into(), json!(hash(&imported_bytes)));
    expected_imports.insert(
        "rule-memory.md".into(),
        json!(hash(b"closed-selected-rule-memory\n")),
    );
    for name in [
        "relative-memory.md",
        "home-memory.md",
        "absolute-memory.md",
        "spaced memory.md",
        "nested-memory.md",
    ] {
        expected_imports.insert(
            name.into(),
            json!(hash(std::fs::read(plugin.join(name)).unwrap().as_slice())),
        );
    }
    let expected_imports = Value::Object(expected_imports);
    let instructions_events = instructions_receipt.with_extension("json.events");
    fn instruction_events(path: &Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("complete native instruction event"))
            .collect()
    }
    async fn imported_graph(path: &Path, expected: &Value) {
        let result = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let mut loaded = serde_json::Map::new();
                for event in instruction_events(path) {
                    assert_ne!(
                        event["ignored"],
                        json!(true),
                        "native code spans/fences/quoted tokens must remain unselected"
                    );
                    if let Some(name) = event["selected"]["name"].as_str() {
                        loaded.insert(name.into(), event["selected"]["digest"].clone());
                    }
                }
                if Value::Object(loaded.clone()) == *expected {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await;
        assert!(
            result.is_ok(),
            "native must load the complete original-form Markdown import graph; observed {:?}",
            instruction_events(path)
        );
    }
    let qualified_digest = hash(
        serde_json::to_vec(&json!({"startup":expected,"nativeImports":expected_imports,"terminalSettingSources":"user","disabledProjectConsumed":false,"freshSettingSources":"user,project,local"}))
            .unwrap()
            .as_slice(),
    );
    let observed = consumed(&receipt).await;
    if observed.is_none() {
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
        let text = crate::ai_title::strip_ansi(&text);
        let classes = [
            "ENOENT",
            "EACCES",
            "trust",
            "Trust",
            "onboarding",
            "Sign in",
            "API key",
            "plugin",
            "Plugin",
            "settings",
            "MCP",
            "Permission denied",
            "text style",
            "theme",
            "Theme",
            "Welcome",
            "Let's",
            "Enter",
            "Continue",
            "terms",
            "Token",
            "Authentication",
            "Setup",
            "select",
            "Select",
        ]
        .into_iter()
        .filter(|class| text.contains(class))
        .collect::<Vec<_>>();
        println!(
            "provider_launch_diagnostic {}",
            json!({"provider":"claude","route":"terminal","exited":output.exited,"exitCode":output.exit_code,"outputBytes":text.len(),"classes":classes})
        );
    }
    assert_eq!(
        observed.expect("native Claude selected plugin must execute its startup hook"),
        expected
    );
    if settings_form == "owned-last" {
        assert!(
            !flag_receipt.exists(),
            "ignored user settings hooks must not execute"
        );
    } else {
        assert_eq!(
            consumed(&flag_receipt)
                .await
                .expect("native must execute the explicitly selected last flag settings hook"),
            json!({"flag":true,"resource":hash(b"closed-claude-resource"),"dependency":hash(b"closed-claude-dependency")})
        );
    }
    assert_eq!(std::fs::read(&flag_settings).unwrap(), flag_bytes);
    assert_eq!(
        std::fs::read_to_string(selected_config.join("rules/nested/policy.md")).unwrap(),
        rule
    );
    assert_eq!(std::fs::read_link(&flag_alias).unwrap(), flag_settings);
    let native_import = consumed(&instructions_receipt).await;
    if native_import.is_none() {
        println!(
            "provider_memory_diagnostic {}",
            json!({"route":"terminal","hookEvents":std::fs::read_to_string(instructions_receipt.with_extension("json.events")).unwrap_or_default().lines().filter_map(|line|serde_json::from_str::<Value>(line).ok()).collect::<Vec<_>>() })
        );
    }
    assert_eq!(
        native_import.expect("native Claude must load selected memory import"),
        json!({"nativeImport":true,"digest":hash(&imported_bytes)})
    );
    imported_graph(&instructions_events, &expected_imports).await;
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"claude","route":"terminal","digest":qualified_digest})
    );
    client
        .stop(SoulId::parse(terminal.soul_id).unwrap())
        .await
        .unwrap();
    assert!(instruction_events(&instructions_events)
        .iter()
        .all(|event| event["ignored"] != json!(true)));
    assert!(
        instruction_events(&instructions_events)
            .iter()
            .all(|event| event["project"] != json!(true)),
        "the real native terminal must leave project memory unselected"
    );
    assert_eq!(
        std::fs::read_to_string(&disabled_project_memory).unwrap(),
        "@missing-disabled-project.md\n"
    );
    // Fresh SDK exposes the existing all-source default. Remove only these
    // terminal-specific owned decoys before its independent launch.
    std::fs::remove_file(&disabled_project_memory).unwrap();
    std::fs::remove_file(&disabled_project_settings).unwrap();
    std::fs::remove_file(&receipt).unwrap();
    std::fs::remove_file(&instructions_receipt).unwrap();
    std::fs::remove_file(&instructions_events).unwrap();
    let (broadcast, _) = tokio::sync::broadcast::channel(256);
    let mut events = broadcast.subscribe();
    std::env::set_var("HOME", &home);
    let proxy = crate::fresh_agent_proxy::HostedFreshAgentProxy::from_opt_in(
        Some(client.clone()),
        Arc::new(broadcast),
    )
    .unwrap()
    .unwrap();
    let flavor = std::env::var("FRESHELL_PROVIDER_LAUNCH_CLAUDE_FLAVOR").unwrap();
    assert!(matches!(flavor.as_str(), "freshclaude" | "kilroy"));
    Arc::clone(&proxy).dispatch(HostedFreshAgentCommand::Create(serde_json::from_value(json!({"requestId":"closed-native-fresh-create","sessionType":flavor,"provider":"claude","cwd":cwd,"plugins":[plugin.to_str().unwrap()]})).unwrap())).await;
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            let frame: Value = serde_json::from_str(&events.recv().await.unwrap()).unwrap();
            if frame["type"] == "freshAgent.create.failed" {
                println!("provider_launch_failure_classes {}", json!({"provider":"claude","flavor":flavor,"classes":failure_classes.lock().unwrap().clone()}));
                panic!(
                    "fresh Claude startup failed classification: {}",
                    frame["message"]
                );
            }
            if frame["type"] == "freshAgent.created" {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        consumed(&receipt)
            .await
            .expect("genuine default SDK selected plugin must execute its startup hook"),
        expected
    );
    assert_eq!(
        consumed(&instructions_receipt)
            .await
            .expect("native default SDK must load selected memory import"),
        json!({"nativeImport":true,"digest":hash(&imported_bytes)})
    );
    imported_graph(&instructions_events, &expected_imports).await;
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"claude","route":"fresh","digest":qualified_digest})
    );
    assert_eq!(
        std::fs::read_to_string(selected_config.join("settings.json")).unwrap(),
        settings
    );
    assert_eq!(
        std::fs::read_to_string(plugin.join("scripts/consume.cjs")).unwrap(),
        consumer
    );
    for view in client.inventory().await.unwrap() {
        if view.desired_state == DesiredState::Running {
            client.stop(view.soul_id).await.unwrap();
        }
    }
    assert!(instruction_events(&instructions_events)
        .iter()
        .all(|event| event["ignored"] != json!(true)));
    web_task.abort();
    control_task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn managed_provider_codex_terminal_and_fresh_native_startup_consumes_prepared_inputs() {
    use freshell_supervisor::{
        admission::AdmissionPolicy,
        registry::Registry,
        service::{serve_control, Supervisor, SupervisorConfig},
    };
    use freshell_terminal::registry::{ManagedTerminalController, ManagedTerminalLaunch};
    use freshell_ws::hosted_fresh_agent::{HostedFreshAgentCommand, HostedFreshAgentGateway};
    use sha2::{Digest, Sha256};
    use std::{os::unix::fs::PermissionsExt, sync::Arc};
    let fixture = PathBuf::from(
        std::env::var_os("FRESHELL_PROVIDER_LAUNCH_FIXTURE")
            .expect("run the closed --provider-launches --provider codex sandbox"),
    );
    assert_eq!(fixture.parent(), Some(Path::new("/tmp")));
    assert!(fixture
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("fln-"));
    let home = fixture.join("source-home");
    let workspace = fixture.join("workspace");
    let control = fixture.join("scenarios/native/control");
    let runtime = fixture.join("scenarios/n/r");
    let skill = home.join(".codex/skills/probe");
    for path in [
        &control,
        &runtime,
        &skill.join("scripts/node_modules/probe-dependency"),
        &workspace.join(".codex/agents"),
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(&workspace)
        .status()
        .unwrap()
        .success());
    std::fs::write(skill.join("SKILL.md"), "---\nname: transport-probe\ndescription: complete launch fixture\n---\nExecute the adjacent synthetic resource.\n").unwrap();
    std::fs::write(skill.join("scripts/resource"), b"closed-codex-resource").unwrap();
    std::fs::write(
        skill.join("scripts/node_modules/probe-dependency/index.js"),
        "module.exports='closed-codex-dependency'\n",
    )
    .unwrap();
    std::fs::write(
        skill.join("scripts/run"),
        "#!/bin/sh\ncat \"$(dirname \"$0\")/resource\"\n",
    )
    .unwrap();
    std::fs::set_permissions(
        skill.join("scripts/run"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let receipt = workspace.join("codex-consumed.json");
    let server = r#"const fs=require('node:fs'),crypto=require('node:crypto'),http=require('node:http'),path=require('node:path');
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');
const readline=require('node:readline').createInterface({input:process.stdin});
readline.on('line',async line=>{let message;try{message=JSON.parse(line)}catch{return}if(message.id===undefined)return;
let result={};if(message.method==='initialize'){
 const endpoint=process.env.FRESHELL_URL,token=process.env.FRESHELL_TOKEN;
 const authenticated=await new Promise(resolve=>{if(!endpoint||!token)return resolve(false);const req=http.request(new URL('/api/mcp',endpoint),{method:'POST',headers:{'x-auth-token':token}},res=>{res.resume();resolve(res.statusCode===200)});req.on('error',()=>resolve(false));req.end('{}')});
 const nativeArgv=fs.readFileSync('/proc/'+process.ppid+'/cmdline','utf8').split('\0');
 const retainedMcpRecipe=nativeArgv.includes('mcp_servers.freshell.command="node"')&&nativeArgv.includes('mcp_servers.freshell.args=["/opt/freshell-mcp/server.js"]')&&nativeArgv.some(arg=>arg.startsWith('mcp_servers.freshell.env_vars='));
 const policy=JSON.parse(require('node:child_process').execFileSync('codex',['execpolicy','check','--rules',path.join(process.env.CODEX_HOME,'rules/probe.rules'),'closed-fixture-never-run'],{encoding:'utf8'}));
 const record={globalInstructions:digest(fs.readFileSync(path.join(process.env.CODEX_HOME,'AGENTS.md'))),nativeRuleForbidden:policy.decision==='forbidden',physicalHome:process.env.HOME,initialized:true,authenticated,retainedMcpRecipe,scopedAlias:process.env.FRESHELL==='1',endpointPresent:!!endpoint,tokenPresent:!!token,
   user:digest(fs.readFileSync(path.join(process.env.CODEX_HOME,'user.md'))),project:digest(fs.readFileSync(path.join(process.cwd(),'.codex/project.md'))),
   role:digest(fs.readFileSync(path.join(process.cwd(),'.codex/agents/role.md'))),skill:digest(fs.readFileSync(path.join(__dirname,'../SKILL.md'))),
   resource:digest(require('node:child_process').execFileSync(path.join(__dirname,'run'))),dependency:digest(require('probe-dependency'))};
 fs.writeFileSync(process.argv[2],JSON.stringify(record));result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'closed-managed-source-consumer',version:'1'}};
}else if(message.method==='tools/list')result={tools:[]};else if(message.method==='resources/list')result={resources:[]};else if(message.method==='prompts/list')result={prompts:[]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');});
"#;
    std::fs::write(skill.join("scripts/server.cjs"), server).unwrap();
    let plugin = home.join(".codex/plugins/cache/fixture/probe/local");
    let plugin_data_name = format!("{:x}", Sha256::digest(b"fixture\0probe"));
    let plugin_data = home
        .join(".codex/plugins/data/agent-plugins")
        .join(&plugin_data_name);
    let plugin_receipt = workspace.join("codex-installed-consumed.json");
    std::fs::create_dir_all(plugin.join("scripts/node_modules/probe-dependency")).unwrap();
    std::fs::create_dir_all(&plugin_data).unwrap();
    std::fs::write(plugin.join("plugin.json"), r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"probe"}"#).unwrap();
    std::fs::write(
        plugin.join("scripts/node_modules/probe-dependency/index.js"),
        "module.exports='closed-installed-plugin-dependency'",
    )
    .unwrap();
    std::fs::write(plugin_data.join("nonce"), b"closed-hashed-plugin-resource").unwrap();
    std::fs::write(plugin.join("scripts/server.cjs"), r#"const fs=require('node:fs'),crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 let message;try{message=JSON.parse(line)}catch{return}if(message.id===undefined)return;
 let result={};if(message.method==='initialize'){
  const record={initialized:true,data:digest(fs.readFileSync(process.argv[2])),dependency:digest(require('probe-dependency')),
   dataIdentity:process.env.PLUGIN_DATA.endsWith('/plugins/data/agent-plugins/'+process.argv[4]),
   dataCwd:process.cwd()===process.env.PLUGIN_DATA,root:process.env.PLUGIN_ROOT==='/home/freshell/provider/.codex/plugins/cache/fixture/probe/local'};
  fs.writeFileSync(process.argv[3],JSON.stringify(record));
  result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'closed-installed-data-consumer',version:'1'}};
 }else if(message.method==='tools/list')result={tools:[]};else if(message.method==='resources/list')result={resources:[]};else if(message.method==='prompts/list')result={prompts:[]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
});
"#).unwrap();
    std::fs::write(plugin.join("mcp.json"), serde_json::to_vec(&json!({
        "$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        "mcpServers":{"data-probe":{"type":"stdio","command":"node","args":["${PLUGIN_ROOT}/scripts/server.cjs","${PLUGIN_DATA}/nonce",plugin_receipt,plugin_data_name],"cwd":"${PLUGIN_DATA}"}}
    })).unwrap()).unwrap();
    std::fs::create_dir_all(home.join(".codex/rules")).unwrap();
    std::fs::write(home.join(".codex/AGENTS.md"), b"closed-global-instructions").unwrap();
    std::fs::write(
        home.join(".codex/rules/probe.rules"),
        "prefix_rule(pattern=['closed-fixture-never-run'], decision='forbidden')\n",
    )
    .unwrap();
    let config = format!("model='synthetic-model'\nmodel_provider='fixture'\nmodel_instructions_file='./user.md'\n[model_providers.fixture]\nname='Closed fixture'\nbase_url='http://127.0.0.1:9'\nwire_api='responses'\nrequires_openai_auth=false\n[projects.{}]\ntrust_level='trusted'\n[mcp_servers.probe]\ncommand='node'\nenv_vars=['FRESHELL_URL','FRESHELL_TOKEN','FRESHELL','CODEX_HOME']\nargs=[{},{}]\n", serde_json::to_string(workspace.to_str().unwrap()).unwrap(), serde_json::to_string(skill.join("scripts/server.cjs").to_str().unwrap()).unwrap(), serde_json::to_string(receipt.to_str().unwrap()).unwrap());
    let config = format!("{config}[features]\nplugins=true\n[plugins.\"probe@fixture\"]\n");
    std::fs::write(home.join(".codex/config.toml"), &config).unwrap();
    std::fs::write(home.join(".codex/user.md"), b"closed-user-input").unwrap();
    let project_config = "model_instructions_file='./project.md'\n[agents.worker]\nconfig_file='./agents/worker.toml'\n";
    std::fs::write(workspace.join(".codex/config.toml"), project_config).unwrap();
    std::fs::write(workspace.join(".codex/project.md"), b"closed-project-input").unwrap();
    std::fs::write(workspace.join(".codex/agents/worker.toml"), "name='worker'\ndescription='synthetic role'\ndeveloper_instructions='synthetic developer'\nmodel_instructions_file='./role.md'\n").unwrap();
    std::fs::write(
        workspace.join(".codex/agents/role.md"),
        b"closed-role-input",
    )
    .unwrap();
    let registry = Registry::open(
        fixture.join("registry"),
        Some(
            InstallationId::parse(std::env::var("FRESHELL_PROVIDER_LAUNCH_INSTALLATION").unwrap())
                .unwrap(),
        ),
    )
    .unwrap();
    std::env::set_var("FRESHELL_MANAGED_PROVIDER_QUALIFICATION", "codex");
    let socket = control.join("control.sock");
    let secret_file = control.join("secret");
    std::fs::write(&secret_file, "closed-synthetic-control-secret").unwrap();
    std::fs::set_permissions(&secret_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    freshell_supervisor::backend::docker::configure_capability_dir(&socket).unwrap();
    let supervisor = Supervisor::new(
        registry.clone(),
        Arc::new(BrokerAuthorizedBackend {
            real: DockerEngineBackend::new(fixture.join("broker.sock")),
            control: control.clone(),
            handoff: fixture.join("handoff"),
            certificate_sentinel: b"unselected-private-sentinel".to_vec(),
        }),
        SupervisorConfig {
            runtime_root: runtime,
            control_socket_path: socket.clone(),
            host_binary_path: PathBuf::from(
                std::env::var_os("FRESHELL_PROVIDER_LAUNCH_HOST_BINARY").unwrap(),
            ),
            image_ref: std::env::var("FRESHELL_PROVIDER_LAUNCH_IMAGE").unwrap(),
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
    let web_token = Arc::new("closed-synthetic-web-token".to_string());
    let app = axum::Router::new()
        .route("/api/health", axum::routing::get(|| async { "ok" }))
        .route(
            "/api/mcp",
            axum::routing::post(|headers: axum::http::HeaderMap| async move {
                if headers
                    .get("x-auth-token")
                    .is_some_and(|token| token == "closed-synthetic-web-token")
                {
                    axum::http::StatusCode::OK
                } else {
                    axum::http::StatusCode::UNAUTHORIZED
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            web_token,
            crate::managed_mcp_capability::scoped_auth_middleware,
        ));
    let web_task = tokio::spawn(async move { axum::serve(web, app).await.unwrap() });
    crate::managed_mcp_capability::configure("0.0.0.0", port, &socket, &secret_file).unwrap();
    crate::managed_mcp_capability::spawn_callback_server()
        .await
        .unwrap();
    for (name, value) in [
        ("FRESHELL_MANAGED_RUNTIME_V1", "1"),
        ("FRESHELL_MANAGED_FRESH_AGENT_V1", "1"),
    ] {
        std::env::set_var(name, value);
    }
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SOCKET", &socket);
    std::env::set_var("FRESHELL_RUNTIME_CONTROL_SECRET_FILE", &secret_file);
    std::env::set_var("HOME", &home);
    let controller = crate::managed_runtime::ServerManagedRuntimeController::from_env()
        .await
        .unwrap()
        .unwrap();
    let cwd = workspace.to_str().unwrap().to_owned();
    let terminal = controller
        .launch(ManagedTerminalLaunch {
            spec: freshell_platform::spawn::SpawnSpec {
                program: "codex".into(),
                args: vec![],
                env_overrides: BTreeMap::new(),
                cwd: Some(cwd.clone()),
                cols: 120,
                rows: 30,
            },
            env: BTreeMap::new(),
            terminal_id: "closed-native-terminal".into(),
            stream_id: "closed-native-stream".into(),
            mode: "codex".into(),
            resume_session_id: None,
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            view_tab_id: None,
            view_pane_id: None,
            create_request_id: Some("closed-native-terminal-create".into()),
        })
        .await
        .expect("actual Codex controller/supervisor/session-host terminal startup");
    let client = controller.runtime_client();
    async fn consumed(path: &Path) -> Result<Value, &'static str> {
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                if let Ok(bytes) = std::fs::read(path) {
                    if let Ok(value) = serde_json::from_slice(&bytes) {
                        break value;
                    }
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .map_err(|_| "native Codex must initialize its configured MCP consumer")
    }
    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    let expected = json!({"globalInstructions":hash(b"closed-global-instructions"),"nativeRuleForbidden":true,"physicalHome":"/home/freshell/provider","initialized":true,"authenticated":true,"retainedMcpRecipe":true,"scopedAlias":true,"endpointPresent":true,"tokenPresent":true,"user":hash(b"closed-user-input"),"project":hash(b"closed-project-input"),"role":hash(b"closed-role-input"),"skill":hash(std::fs::read(skill.join("SKILL.md")).unwrap().as_slice()),"resource":hash(b"closed-codex-resource"),"dependency":hash(b"closed-codex-dependency")});
    let consumed_terminal = consumed(&receipt).await;
    if consumed_terminal.is_err() {
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
            "ERR_INVALID_ARG_TYPE",
            "ENOENT",
            "EACCES",
            "onboarding",
            "Sign in",
            "trust",
            "API key",
            "MCP",
            "mcp",
            "initialize",
            "failed",
            "Permission denied",
            "Terminal",
            "TERM",
            "user.md",
            "project.md",
            "role.md",
            "server.cjs",
            "node",
            "config.toml",
        ]
        .into_iter()
        .filter(|class| text.contains(class))
        .collect::<Vec<_>>();
        println!(
            "provider_launch_diagnostic {}",
            json!({"provider":"codex","route":"terminal","exited":output.exited,"exitCode":output.exit_code,"outputBytes":text.len(),"classes":classes})
        );
    }
    assert_eq!(consumed_terminal.unwrap(), expected);
    let expected_plugin = json!({"initialized":true,"data":hash(b"closed-hashed-plugin-resource"),"dependency":hash(b"closed-installed-plugin-dependency"),"dataIdentity":true,"dataCwd":true,"root":true});
    assert_eq!(
        consumed(&plugin_receipt)
            .await
            .expect("native AgentPlugin MCP must consume transported hashed data"),
        expected_plugin
    );
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"codex","route":"terminal","digest":hash(serde_json::to_vec(&json!({"ordinary":expected,"installed":expected_plugin})).unwrap().as_slice())})
    );
    client
        .stop(SoulId::parse(terminal.soul_id).unwrap())
        .await
        .unwrap();
    std::fs::remove_file(&receipt).unwrap();
    std::fs::remove_file(&plugin_receipt).unwrap();
    let (broadcast, _) = tokio::sync::broadcast::channel(256);
    let mut events = broadcast.subscribe();
    let proxy = crate::fresh_agent_proxy::HostedFreshAgentProxy::from_opt_in(
        Some(client.clone()),
        Arc::new(broadcast),
    )
    .unwrap()
    .unwrap();
    Arc::clone(&proxy).dispatch(HostedFreshAgentCommand::Create(serde_json::from_value(json!({"requestId":"closed-native-fresh-create","sessionType":"freshcodex","provider":"codex","cwd":cwd})).unwrap())).await;
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            let frame: Value = serde_json::from_str(&events.recv().await.unwrap()).unwrap();
            if frame["type"] == "freshAgent.create.failed" {
                panic!("actual fresh Codex failed: {}", frame["message"]);
            }
            if frame["type"] == "freshAgent.created" {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(consumed(&receipt).await.unwrap(), expected);
    assert_eq!(
        consumed(&plugin_receipt)
            .await
            .expect("native fresh AgentPlugin MCP must consume transported hashed data"),
        expected_plugin
    );
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"codex","route":"fresh","digest":hash(serde_json::to_vec(&json!({"ordinary":expected,"installed":expected_plugin})).unwrap().as_slice())})
    );
    assert_eq!(
        std::fs::read_to_string(home.join(".codex/config.toml")).unwrap(),
        config
    );
    assert_eq!(
        std::fs::read_to_string(workspace.join(".codex/config.toml")).unwrap(),
        project_config
    );
    assert_eq!(
        std::fs::read(plugin_data.join("nonce")).unwrap(),
        b"closed-hashed-plugin-resource"
    );
    for view in client.inventory().await.unwrap() {
        if view.desired_state == DesiredState::Running {
            client.stop(view.soul_id).await.unwrap();
        }
    }
    web_task.abort();
    control_task.abort();
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
    let certificate = std::fs::read_to_string(fixture.join("grants/ca.pem")).unwrap();
    let certificate_sentinel = certificate
        .lines()
        .find(|line| !line.starts_with("-----"))
        .unwrap()
        .as_bytes()
        .to_vec();
    assert!(certificate_sentinel.len() >= 32);
    let backend = Arc::new(BrokerAuthorizedBackend {
        real: DockerEngineBackend::new(fixture.join("broker.sock")),
        control: control.clone(),
        handoff: fixture.join("handoff"),
        certificate_sentinel: certificate_sentinel.clone(),
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
    let inline_auth_url = format!("{well_known_url}/inline-auth");
    std::fs::write(
        fixture.join("grants/auth.json"),
        serde_json::to_vec(&json!({well_known_url.clone(): {
            "type": "wellknown", "key": "OPENAI_API_KEY",
            "token": format!("AUTH_PREFIX{{file:{}}}AUTH_SUFFIX", fixture.join("workspace/home rule with spaces.txt").display())
        }, inline_auth_url.clone(): {"type":"wellknown","key":"INLINE_VALUE","token":"AUTH_INLINE_SHADOW_NO_FILE"}}))
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
    let nested = fixture.join("workspace/nested");
    std::fs::create_dir_all(&nested).unwrap();
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(fixture.join("workspace"))
        .status()
        .unwrap()
        .success());
    let shared_source = fixture.join("workspace/shared.json");
    let shared_receipt = fixture.join("workspace/shared-origin-consumed.json");
    let shared_home_rule = fixture.join("workspace/home rule with spaces.txt");
    std::fs::write(&shared_home_rule, "shared-home-sensitive-file\n").unwrap();
    std::fs::set_permissions(&shared_home_rule, std::fs::Permissions::from_mode(0o600)).unwrap();
    let shared_lane_receipt = fixture.join("workspace/shared-lane-consumed");
    let shared_json = serde_json::to_string(&json!({"agent":{
        "probe":{"prompt":"{env:OPENAI_API_KEY}"},
        "sharedRelative":{"prompt":"{file:./rules.txt}"},
        "sharedAbsolute":{"prompt":format!("{{file:{}}}", shared_home_rule.display())},
        "sharedHome":{"prompt":"{file:~/home rule with spaces.txt}"}
    }, "plugin":[["./shared-probe", {"receipt":shared_receipt,"laneReceipt":shared_lane_receipt,"auth":"{env:OPENAI_API_KEY}","ca":"{file:{env:NODE_EXTRA_CA_CERTS}}"}]]}))
    .unwrap();
    let shared_bytes = format!(
        "{{\n // native comment {{file:./unselected-missing}}\n{}",
        &shared_json[1..]
    )
    .into_bytes();
    for (directory, label) in [
        (fixture.join("workspace"), "root"),
        (nested.clone(), "nested"),
    ] {
        let plugin = format!(
            r#"import fs from 'node:fs';import crypto from 'node:crypto';
export default {{id:'closed-shared-{label}',async server(input,options){{return {{async config(config){{
 let receipt=fs.existsSync(options.receipt)?JSON.parse(fs.readFileSync(options.receipt,'utf8')):{{}};
 receipt.{label}={{relative:crypto.createHash('sha256').update(fs.readFileSync(new URL('../rules.txt',import.meta.url))).digest('hex'),absolute:crypto.createHash('sha256').update(config.agent.sharedAbsolute.prompt).digest('hex'),home:crypto.createHash('sha256').update(config.agent.sharedHome.prompt).digest('hex')}};
 fs.writeFileSync(options.receipt,JSON.stringify(receipt));
 fs.writeFileSync(options.laneReceipt+'.{label}.main',JSON.stringify({{auth:crypto.createHash('sha256').update(options.auth).digest('hex'),ca:crypto.createHash('sha256').update(options.ca).digest('hex')}}));
}}}}}}}};
"#
        );
        let tui_plugin = format!(
            r#"import fs from 'node:fs';import crypto from 'node:crypto';
export default {{id:'closed-shared-{label}',async tui(api,options){{
 fs.writeFileSync(options.laneReceipt+'.{label}.tui',JSON.stringify({{auth:crypto.createHash('sha256').update(options.auth).digest('hex'),ca:crypto.createHash('sha256').update(options.ca).digest('hex'),theme:crypto.createHash('sha256').update(api.tuiConfig.theme).digest('hex')}}));
 setTimeout(()=>{{const dir='/home/freshell/provider/.freshell/session-signals/opencode';const alive=fs.existsSync(dir)&&fs.readdirSync(dir).some(name=>name.startsWith('closed-native-terminal__')&&JSON.parse(fs.readFileSync(dir+'/'+name,'utf8')).hello===true);fs.writeFileSync(options.laneReceipt+'.{label}.rebind',JSON.stringify({{alive}}));}},1500);
}}}};
"#
        );
        let package = directory.join("shared-probe");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("server.mjs"), plugin).unwrap();
        std::fs::write(package.join("tui.mjs"), tui_plugin).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"exports":{"./server":"./server.mjs","./tui":"./tui.mjs"}}"#,
        )
        .unwrap();
    }
    std::fs::write(&shared_source, &shared_bytes).unwrap();
    std::os::unix::fs::symlink("shared.json", fixture.join("workspace/opencode.json")).unwrap();
    std::os::unix::fs::symlink("../shared.json", nested.join("opencode.json")).unwrap();
    for (path, bytes) in [
        (
            fixture.join("workspace/rules.txt"),
            b"native-shared-root-rule".as_slice(),
        ),
        (
            nested.join("rules.txt"),
            b"native-shared-nested-rule".as_slice(),
        ),
    ] {
        std::fs::write(&path, bytes).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let cwd = nested.to_string_lossy().into_owned();
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
    std::os::unix::fs::symlink("shared.json", &selected_tui).unwrap();
    let project_tui = fixture.join("workspace/tui.jsonc");
    let tui_receipt = fixture.join("workspace/native-tui-consumed.json");
    let selected_tui_bytes = format!("{{ // selected origin\n\"theme\":\"{{file:./selected-theme}}\",\"plugin\":[[\"file:///home/freshell/provider/.config/opencode/plugins/probe-tui/index.mjs\",{{\"receipt\":{}}}]],}}", serde_json::to_string(&tui_receipt).unwrap());
    std::fs::write(&project_tui, &selected_tui_bytes).unwrap();
    std::fs::write(fixture.join("workspace/selected-theme"), "  dark\n").unwrap();
    let inline_source = r#"{ // inline instance origin
"agent":{"probe":{"description":"{env:INLINE_VALUE}"}}}"#;
    let inline_value = "INLINE_PREFIX{file:./inline-rule}INLINE_SUFFIX";
    std::fs::write(nested.join("inline-rule"), "native-inline-selected-rule\n").unwrap();
    let resource_root = fixture.join("workspace/.opencode");
    let root_receipt = fixture.join("workspace/native-root-consumed.json");
    let home_root_receipt = fixture.join("workspace/native-home-root-consumed.json");
    std::fs::create_dir_all(resource_root.join("plugins/selected/node_modules/fixture-dependency"))
        .unwrap();
    std::fs::write(
        resource_root.join("plugins/selected/node_modules/fixture-dependency/package.json"),
        r#"{"name":"fixture-dependency","type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    std::fs::write(
        resource_root.join("plugins/selected/node_modules/fixture-dependency/index.mjs"),
        "export default 'selected-root-dependency';",
    )
    .unwrap();
    std::fs::write(
        resource_root.join("plugins/selected/resource"),
        "selected-root-resource",
    )
    .unwrap();
    std::fs::write(resource_root.join("plugins/selected/index.mjs"), r#"import fs from 'node:fs';import crypto from 'node:crypto';import dependency from 'fixture-dependency';
const home=import.meta.url.startsWith('file:///home/freshell/provider/.opencode/');
export default {id:'closed-writable-selected-root-'+(home?'home':'workspace'),async server(input,options){return {async config(config){
 const root=new URL('../../',import.meta.url); const path=new URL('provider-owned-write',root);
 fs.writeFileSync(path,'selected-root-write');
 fs.writeFileSync(home?options.homeReceipt:options.receipt,JSON.stringify({physicalHome:process.env.HOME,privateRule:crypto.createHash('sha256').update(config.agent.rootScope.prompt).digest('hex'),dependency:crypto.createHash('sha256').update(dependency).digest('hex'),resource:crypto.createHash('sha256').update(fs.readFileSync(new URL('./resource',import.meta.url))).digest('hex'),write:crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')}));
}}}};
"#).unwrap();
    let root_config = serde_json::to_vec(
        &json!({"agent":{"rootScope":{"prompt":"{file:./private-root-rule}"}}, "plugin":[["./plugins/selected/index.mjs", {"receipt":root_receipt, "homeReceipt":home_root_receipt}]]}),
    )
    .unwrap();
    std::fs::write(resource_root.join("opencode.json"), &root_config).unwrap();
    std::fs::write(
        resource_root.join("private-root-rule"),
        "shared-home-private-rule\n",
    )
    .unwrap();
    std::fs::set_permissions(
        resource_root.join("private-root-rule"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    for name in ["package.json", "package-lock.json"] {
        std::fs::copy(
            fixture.join("source-home/.config/opencode").join(name),
            resource_root.join(name),
        )
        .unwrap();
    }
    std::os::unix::fs::symlink(
        fixture.join("source-home/.config/opencode/node_modules"),
        resource_root.join("node_modules"),
    )
    .unwrap();
    std::os::unix::fs::symlink(&resource_root, fixture.join("source-home/.opencode")).unwrap();
    let explicit_directory = fixture.join("workspace/selected-directory");
    let directory_receipt = fixture.join("workspace/native-directory-consumed.json");
    std::fs::create_dir_all(explicit_directory.join("plugins")).unwrap();
    std::fs::create_dir_all(explicit_directory.join("skills/probe")).unwrap();
    let transported_dependency =
        fixture.join("source-home/.config/opencode/node_modules/transport-only");
    std::fs::create_dir_all(&transported_dependency).unwrap();
    std::fs::write(
        transported_dependency.join("package.json"),
        r#"{"name":"transport-only","type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    std::fs::write(
        transported_dependency.join("index.mjs"),
        "export default 'transport-only-cross-root-dependency';",
    )
    .unwrap();
    std::fs::copy(
        fixture.join("source-home/.config/opencode/package.json"),
        explicit_directory.join("package.json"),
    )
    .unwrap();
    std::fs::copy(
        fixture.join("source-home/.config/opencode/package-lock.json"),
        explicit_directory.join("package-lock.json"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        fixture.join("source-home/.config/opencode/node_modules"),
        explicit_directory.join("node_modules"),
    )
    .unwrap();
    std::fs::write(
        explicit_directory.join("skills/probe/SKILL.md"),
        "selected-directory-skill",
    )
    .unwrap();
    let directory_plugin = format!(
        r#"import fs from 'node:fs';import crypto from 'node:crypto';
export default {{id:'closed-directory-discovery',async server(){{
 let dependency;
 try {{dependency=(await import('transport-only')).default;}} catch(error) {{
  const link=new URL('../node_modules',import.meta.url);
  fs.writeFileSync({},JSON.stringify({{failureClass:'dependency_load',linkIsSymbolic:fs.lstatSync(link).isSymbolicLink(),linkAbsolute:fs.lstatSync(link).isSymbolicLink()&&fs.readlinkSync(link).startsWith('/'),modulePresent:fs.existsSync(new URL('../node_modules/transport-only/index.mjs',import.meta.url))}}));
  throw error;
 }}
 return {{async config(){{
 const root=new URL('../',import.meta.url);const write=new URL('provider-owned-auto-write',root);
 fs.writeFileSync(write,'selected-directory-write');
 fs.writeFileSync({},JSON.stringify({{linkIsSymbolic:fs.lstatSync(new URL('node_modules',root)).isSymbolicLink(),linkAbsolute:fs.lstatSync(new URL('node_modules',root)).isSymbolicLink()&&fs.readlinkSync(new URL('node_modules',root)).startsWith('/'),dependency:crypto.createHash('sha256').update(dependency).digest('hex'),skill:crypto.createHash('sha256').update(fs.readFileSync(new URL('skills/probe/SKILL.md',root))).digest('hex'),write:crypto.createHash('sha256').update(fs.readFileSync(write)).digest('hex')}}));
}}}}}}}};
"#,
        serde_json::to_string(&directory_receipt).unwrap(),
        serde_json::to_string(&directory_receipt).unwrap()
    );
    std::fs::write(
        explicit_directory.join("plugins/auto-probe.js"),
        directory_plugin,
    )
    .unwrap();

    // Qualify original HOME equal to the Git workspace, with a nested launch
    // cwd. Native project discovery must stay in the workspace while provider
    // HOME remains its independent physical volume.
    let terminal_home = fixture.join("workspace");
    std::env::set_var("XDG_CONFIG_HOME", fixture.join("source-home/.config"));
    std::env::set_var("HOME", &terminal_home);
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
            (
                "FRESHELL_TERMINAL_ID".into(),
                "closed-native-terminal".into(),
            ),
            ("OPENCODE_CONFIG_DIR".into(), "../selected-directory".into()),
            ("OPENCODE_CONFIG".into(), "../selected-config.json".into()),
            ("OPENCODE_TUI_CONFIG".into(), "../selected-tui.jsonc".into()),
            ("OPENCODE_CONFIG_CONTENT".into(), inline_source.into()),
            ("INLINE_VALUE".into(), inline_value.into()),
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
    let expected = json!({"prompt":format!("{:x}",Sha256::digest(b"AUTH_PREFIXshared-home-sensitive-fileAUTH_SUFFIX")),
        "description":format!("{:x}",Sha256::digest(b"INLINE_PREFIXnative-inline-selected-ruleINLINE_SUFFIX")),
        "references":(["third","fourth","fifth","sixth"].map(|ordinal|format!("{:x}",Sha256::digest(format!("native-{ordinal}-rule").as_bytes())))),
        "resource":format!("{:x}",Sha256::digest(b"plugin-relative-resource")),
        "dependency":format!("{:x}",Sha256::digest(b"plugin-actual-local-dependency")),"sdk":format!("{:x}",Sha256::digest(b"function")),"snapshotDisabled":false});
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
                "install",
                "Resolving",
                "package",
                "lockfile",
                "Permission denied",
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
    let expected_root = json!({"physicalHome":"/home/freshell/provider","privateRule":format!("{:x}",Sha256::digest(b"shared-home-private-rule")),"dependency":format!("{:x}",Sha256::digest(b"selected-root-dependency")),"resource":format!("{:x}",Sha256::digest(b"selected-root-resource")),"write":format!("{:x}",Sha256::digest(b"selected-root-write"))});
    assert_eq!(read_receipt(&root_receipt).await.unwrap(), expected_root);
    assert_eq!(
        read_receipt(&home_root_receipt).await.unwrap(),
        expected_root,
        "actual native HOME and workspace discovery must both consume the shared transported root"
    );
    let expected_directory = json!({"linkIsSymbolic":true,"linkAbsolute":true,"dependency":format!("{:x}",Sha256::digest(b"transport-only-cross-root-dependency")),"skill":format!("{:x}",Sha256::digest(b"selected-directory-skill")),"write":format!("{:x}",Sha256::digest(b"selected-directory-write"))});
    assert_eq!(
        read_receipt(&directory_receipt).await.unwrap(),
        expected_directory
    );
    assert!(!explicit_directory
        .join("provider-owned-auto-write")
        .exists());
    assert!(
        !resource_root.join("provider-owned-write").exists(),
        "native writes must land in the selected soul subpath, preserving originals"
    );
    assert_eq!(
        std::fs::read(resource_root.join("opencode.json")).unwrap(),
        root_config
    );
    let shared_consumption = read_receipt(&shared_receipt).await;
    if shared_consumption.is_err() {
        let output = client
            .read_output(
                SoulId::parse(terminal.soul_id.clone()).unwrap(),
                0,
                1024 * 1024,
            )
            .await
            .unwrap();
        let text = output
            .frames
            .iter()
            .map(|frame| frame.data.as_str())
            .collect::<String>();
        let classes = [
            "shared-probe",
            "SyntaxError",
            "TypeError",
            "ConfigInvalidError",
            "ConfigJsonError",
            "ENOENT",
            "EACCES",
            "failed to load plugin",
            "Plugin export",
            "OpenSSL",
            "certificate",
            "Failed to import",
        ]
        .into_iter()
        .filter(|class| text.contains(class))
        .collect::<Vec<_>>();
        println!(
            "provider_launch_diagnostic {}",
            json!({"route":"shared-main","exited":output.exited,"exitCode":output.exit_code,"outputBytes":text.len(),"classes":classes})
        );
    }
    assert_eq!(
        shared_consumption.unwrap(),
        json!({"root":{"relative":format!("{:x}",Sha256::digest(b"native-shared-root-rule")),"absolute":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file")),"home":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file"))},"nested":{"relative":format!("{:x}",Sha256::digest(b"native-shared-nested-rule")),"absolute":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file")),"home":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file"))}})
    );
    assert_eq!(
        read_receipt(&tui_receipt)
            .await
            .expect("actual TUI plugin must consume the selected effective TUI configuration"),
        json!({"theme":format!("{:x}",Sha256::digest(b"dark"))})
    );
    let ca_digest = format!(
        "{:x}",
        Sha256::digest(
            std::fs::read_to_string(fixture.join("grants/ca.pem"))
                .unwrap()
                .trim()
                .as_bytes()
        )
    );
    assert_eq!(
        read_receipt(&shared_lane_receipt.with_extension("root.main"))
            .await
            .unwrap(),
        json!({"auth":format!("{:x}",Sha256::digest(b"AUTH_PREFIXshared-home-sensitive-fileAUTH_SUFFIX")),"ca":ca_digest})
    );
    assert_eq!(
        read_receipt(&shared_lane_receipt.with_extension("root.tui"))
            .await
            .unwrap(),
        json!({"auth":format!("{:x}",Sha256::digest(b"synthetic-onecli-shadowed")),"ca":ca_digest,"theme":format!("{:x}",Sha256::digest(b"dark"))})
    );
    assert_eq!(read_receipt(&shared_lane_receipt.with_extension("root.rebind")).await.unwrap(), json!({"alive":true}),
        "the actual native TUI loader must execute the owned package entrypoint, not merely retain its config spec");
    assert_eq!(
        std::fs::read_to_string(&project_tui).unwrap(),
        selected_tui_bytes
    );
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"opencode","route":"terminal-tui","digest":format!("{:x}",Sha256::digest(b"dark"))})
    );
    assert_eq!(std::fs::read(&original_config).unwrap(), original_bytes);
    assert_eq!(std::fs::read(&shared_source).unwrap(), shared_bytes);
    assert!(
        std::fs::symlink_metadata(fixture.join("workspace/opencode.json"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(std::fs::symlink_metadata(nested.join("opencode.json"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(&explicit_config).unwrap(), explicit_bytes);
    println!(
        "provider_launch_consumer {}",
        json!({"provider":"opencode","route":"terminal","workspaceScope":"default-home","digest":format!("{:x}",Sha256::digest(serde_json::to_vec(&expected).unwrap()))})
    );
    client
        .stop(SoulId::parse(terminal.soul_id).unwrap())
        .await
        .unwrap();
    std::fs::remove_file(&receipt).unwrap();
    std::fs::remove_file(&shared_receipt).unwrap();
    std::fs::remove_file(&root_receipt).unwrap();
    std::fs::remove_file(&home_root_receipt).unwrap();
    std::fs::remove_file(&directory_receipt).unwrap();
    std::fs::remove_file(shared_lane_receipt.with_extension("root.main")).unwrap();
    // Fresh launches use current server controls; the terminal exercised a
    // request-only relative control. Both must activate the explicit layer.
    // The fresh route has a workspace beneath original HOME. Both role
    // topologies consume the same independently retained synthetic fixtures.
    std::os::unix::fs::symlink(&resource_root, fixture.join(".opencode")).unwrap();
    std::os::unix::fs::symlink(&shared_home_rule, fixture.join("home rule with spaces.txt"))
        .unwrap();
    std::fs::write(fixture.join("grants/auth.json"), serde_json::to_vec(&json!({well_known_url: {
        "type":"wellknown", "key":"OPENAI_API_KEY", "token":"AUTH_PREFIX{file:~/home rule with spaces.txt}AUTH_SUFFIX"
    }, inline_auth_url: {"type":"wellknown", "key":"INLINE_VALUE", "token":"AUTH_INLINE_SHADOW_NO_FILE"}})).unwrap()).unwrap();
    std::env::set_var("HOME", &fixture);
    std::env::set_var("OPENCODE_CONFIG", &explicit_config);
    std::env::set_var("OPENCODE_CONFIG_DIR", &explicit_directory);
    std::env::set_var("OPENCODE_TUI_CONFIG", &selected_tui);
    std::env::set_var("OPENCODE_CONFIG_CONTENT", inline_source);
    std::env::set_var("INLINE_VALUE", inline_value);
    let mut fresh_expected = expected.clone();
    fresh_expected["snapshotDisabled"] = json!(true);
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
    assert_eq!(read_receipt(&receipt).await.unwrap(), fresh_expected);
    assert_eq!(
        read_receipt(&shared_lane_receipt.with_extension("root.main"))
            .await
            .unwrap(),
        json!({"auth":format!("{:x}",Sha256::digest(b"AUTH_PREFIXshared-home-sensitive-fileAUTH_SUFFIX")),"ca":ca_digest})
    );
    assert_eq!(read_receipt(&root_receipt).await.unwrap(), expected_root);
    assert_eq!(
        read_receipt(&home_root_receipt).await.unwrap(),
        expected_root
    );
    assert_eq!(
        read_receipt(&directory_receipt).await.unwrap(),
        expected_directory
    );
    assert!(!explicit_directory
        .join("provider-owned-auto-write")
        .exists());
    assert!(!resource_root.join("provider-owned-write").exists());
    assert_eq!(
        std::fs::read(resource_root.join("opencode.json")).unwrap(),
        root_config
    );
    assert_eq!(
        read_receipt(&shared_receipt).await.unwrap(),
        json!({"root":{"relative":format!("{:x}",Sha256::digest(b"native-shared-root-rule")),"absolute":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file")),"home":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file"))},"nested":{"relative":format!("{:x}",Sha256::digest(b"native-shared-nested-rule")),"absolute":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file")),"home":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file"))}})
    );
    assert_eq!(std::fs::read(&original_config).unwrap(), original_bytes);
    assert_eq!(std::fs::read(&shared_source).unwrap(), shared_bytes);
    assert!(
        std::fs::symlink_metadata(fixture.join("workspace/opencode.json"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(std::fs::symlink_metadata(nested.join("opencode.json"))
        .unwrap()
        .file_type()
        .is_symlink());
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
        json!({"provider":"opencode","route":"fresh","workspaceScope":"workspace-under-home","digest":format!("{:x}",Sha256::digest(serde_json::to_vec(&fresh_expected).unwrap()))})
    );
    // Scan only run-owned durable/staged surfaces; referenced payloads belong
    // in private indexed files, not ordinary resource/configuration trees.
    assert_private_sentinels_absent(&fixture.join("registry"), &certificate_sentinel);
    assert_private_sentinels_absent(&fixture.join("handoff"), &certificate_sentinel);
    for view in client.inventory().await.unwrap() {
        if view.desired_state == DesiredState::Running {
            client.stop(view.soul_id).await.unwrap();
        }
    }
    web_task.abort();
    control_task.abort();
}
