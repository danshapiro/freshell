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
    let shared_bytes = serde_json::to_vec(&json!({"agent":{
        "probe":{"prompt":"{env:OPENAI_API_KEY}"},
        "sharedRelative":{"prompt":"{file:./rules.txt}"},
        "sharedAbsolute":{"prompt":format!("{{file:{}}}", shared_home_rule.display())},
        "sharedHome":{"prompt":"{file:~/home rule with spaces.txt}"}
    }, "plugin":[["./shared-probe.mjs", {"receipt":shared_receipt}]]}))
    .unwrap();
    for (directory, label) in [
        (fixture.join("workspace"), "root"),
        (nested.clone(), "nested"),
    ] {
        let plugin = format!(
            r#"import fs from 'node:fs';import crypto from 'node:crypto';
export default {{id:'closed-shared-{label}',async server(input,options){{return {{async config(config){{
 let receipt=fs.existsSync(options.receipt)?JSON.parse(fs.readFileSync(options.receipt,'utf8')):{{}};
 receipt.{label}={{relative:crypto.createHash('sha256').update(fs.readFileSync(new URL('./rules.txt',import.meta.url))).digest('hex'),absolute:crypto.createHash('sha256').update(config.agent.sharedAbsolute.prompt).digest('hex'),home:crypto.createHash('sha256').update(config.agent.sharedHome.prompt).digest('hex')}};
 fs.writeFileSync(options.receipt,JSON.stringify(receipt));
}}}}}}}};
"#
        );
        std::fs::write(directory.join("shared-probe.mjs"), plugin).unwrap();
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
    let tui_receipt = fixture.join("workspace/native-tui-consumed.json");
    let selected_tui_bytes = format!("{{ // selected origin\n\"theme\":\"{{file:./selected-theme}}\",\"plugin\":[[\"file:///home/freshell/provider/.config/opencode/plugins/probe-tui/index.mjs\",{{\"receipt\":{}}}]],}}", serde_json::to_string(&tui_receipt).unwrap());
    std::fs::write(&selected_tui, &selected_tui_bytes).unwrap();
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
    assert_eq!(
        read_receipt(&shared_receipt).await.unwrap(),
        json!({"root":{"relative":format!("{:x}",Sha256::digest(b"native-shared-root-rule")),"absolute":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file")),"home":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file"))},"nested":{"relative":format!("{:x}",Sha256::digest(b"native-shared-nested-rule")),"absolute":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file")),"home":format!("{:x}",Sha256::digest(b"shared-home-sensitive-file"))}})
    );
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
                    b"native-inline-selected-rule".as_slice(),
                    b"native-shared-root-rule".as_slice(),
                    b"native-shared-nested-rule".as_slice(),
                    b"shared-home-private-rule".as_slice(),
                    b"shared-home-sensitive-file".as_slice(),
                    b"INLINE_PREFIX".as_slice(),
                    b"AUTH_INLINE_SHADOW_NO_FILE".as_slice(),
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
