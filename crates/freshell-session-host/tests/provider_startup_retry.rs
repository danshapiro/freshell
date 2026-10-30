//! Startup preparation contracts run the real host and provider UID in an owned,
//! disposable rootless container. No provider executable or credential is used.

use freshell_runtime_protocol::{
    host_proof, read_frame, write_frame, ControlRole, Envelope, FreshAgentLaunchSpec, GrantId,
    HostBootId, HostCommand, HostReply, HostResult, IncarnationId, ProviderConfigReference,
    ProviderConfigRoot, ProviderLaunchContext, ProviderPreparation, RequestId,
    RuntimeDiagnosticCode, RuntimeError, SoulId, TerminalLaunchSpec, CONTROL_PROTOCOL_VERSION,
};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};
use tokio::net::UnixStream;

const PROVIDER_HOME: &str = "/home/freshell/provider";
const BOOTSTRAP_ROOT: &str = "/run/freshell-bootstrap";
const PROVIDER_UID: u32 = 65534;
const PROVIDER_GID: u32 = 0;
const SECRET: &[u8] = b"synthetic-startup-host-secret-0123456789";
const CONTAINER_MARKER: &str = "FRESHELL_STARTUP_PREPARATION_CONTAINER";

fn in_disposable_container(test: &str) -> bool {
    if std::env::var_os(CONTAINER_MARKER).is_some() {
        assert_eq!(unsafe { libc::geteuid() }, 0);
        assert_ne!(unsafe { libc::geteuid() }, PROVIDER_UID);
        return true;
    }
    let security = Command::new("docker")
        .args(["info", "--format", "{{json .SecurityOptions}}"])
        .output()
        .expect("query the rootless test daemon");
    assert!(security.status.success());
    let options: Vec<String> = serde_json::from_slice(&security.stdout).unwrap();
    assert!(options.iter().any(|option| option == "name=rootless"));
    let name = format!("freshell-startup-retry-{}", uuid::Uuid::new_v4().simple());
    let output = Command::new("docker")
        .args([
            "run",
            "--rm",
            "--name",
            &name,
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--cap-add",
            "CHOWN",
            "--cap-add",
            "SETUID",
            "--cap-add",
            "SETGID",
            "--security-opt",
            "no-new-privileges:true",
            "--pids-limit",
            "64",
            "--memory",
            "512m",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=64m",
            "--tmpfs",
            "/home/freshell/provider:rw,nosuid,nodev,size=64m,mode=755",
            "--tmpfs",
            "/run/freshell-bootstrap:rw,nosuid,nodev,size=16m",
            "--mount",
        ])
        .arg(format!(
            "type=bind,src={},dst=/runtime/contract-tests,readonly",
            std::env::current_exe().unwrap().display()
        ))
        .arg("--mount")
        .arg(format!(
            "type=bind,src={},dst=/runtime/freshell-session-host,readonly",
            env!("CARGO_BIN_EXE_freshell-session-host")
        ))
        .args([
            "--env",
            &format!("{CONTAINER_MARKER}=1"),
            "--entrypoint",
            "/runtime/contract-tests",
            "freshell-sandbox:latest",
            "--exact",
            test,
            "--nocapture",
        ])
        .output()
        .expect("run the isolated startup contract");
    assert!(
        output.status.success(),
        "startup contract {test} failed in {name}:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    false
}

struct Host {
    child: Child,
    socket: PathBuf,
    incarnation: IncarnationId,
    boot: HostBootId,
}

impl Drop for Host {
    fn drop(&mut self) {
        // This is only the exact child launched by this fixture in its container.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Host {
    async fn start(root: &Path) -> Self {
        let incarnation = IncarnationId::new();
        let state = root.join(incarnation.as_str());
        fs::create_dir(&state).unwrap();
        let socket = state.join("control.sock");
        let secret = state.join("secret");
        fs::write(&secret, SECRET).unwrap();
        let child = Command::new("/runtime/freshell-session-host")
            .arg("serve")
            .arg("--control-socket")
            .arg(&socket)
            .arg("--state-dir")
            .arg(&state)
            .arg("--secret-file")
            .arg(&secret)
            .arg("--incarnation-id")
            .arg(incarnation.as_str())
            .args([
                "--requested-limits",
                r#"{"cpuMilli":500,"memoryBytes":134217728,"swapBytes":0,"pidsMax":64}"#,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut host = Self {
            child,
            socket,
            incarnation,
            boot: HostBootId::new(),
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            while !host.socket.exists() {
                assert!(
                    host.child.try_wait().unwrap().is_none(),
                    "host exited before listening"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("host control socket must become available");
        let result = host
            .send(HostCommand::Hello {
                incarnation_id: host.incarnation.clone(),
                challenge: "startup-test".into(),
            })
            .await
            .unwrap();
        let HostResult::Hello { host_boot_id, .. } = result else {
            panic!("missing host handshake")
        };
        host.boot = host_boot_id;
        host
    }

    async fn send(&self, body: HostCommand) -> Result<HostResult, RuntimeError> {
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut stream = UnixStream::connect(&self.socket).await.unwrap();
            write_frame(
                &mut stream,
                &Envelope {
                    protocol_version: CONTROL_PROTOCOL_VERSION,
                    request_id: RequestId::new(),
                    role: ControlRole::Supervisor,
                    auth: Some(host_proof(
                        SECRET,
                        "command-auth",
                        &self.boot,
                        &self.incarnation,
                    )),
                    body,
                },
            )
            .await
            .unwrap();
            read_frame::<_, HostReply>(&mut stream)
                .await
                .unwrap()
                .result
        })
        .await
        .expect("host command must finish")
    }

    fn grant(&self, soul: &SoulId, launch: FreshAgentLaunchSpec) -> HostCommand {
        HostCommand::GrantExecution {
            incarnation_id: self.incarnation.clone(),
            soul_id: soul.clone(),
            host_boot_id: self.boot.clone(),
            control_epoch: 1,
            execution_generation: 1,
            grant_id: GrantId::new(),
            fixture: None,
            terminal: None,
            fresh_agent: Some(Box::new(launch)),
            resume_spec: None,
            native_identity_launch: None,
            provider_path_inputs: Default::default(),
            dispatch_budget_ms: None,
        }
    }
}

fn provider_command(args: &[&str]) -> Vec<u8> {
    let output = Command::new("/usr/bin/setpriv")
        .args([
            "--reuid",
            "65534",
            "--regid",
            "0",
            "--clear-groups",
            "--no-new-privs",
            "--",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn provider_file_snapshot(path: &Path) -> (Vec<u8>, Vec<u8>) {
    let path = path.to_str().unwrap();
    (
        provider_command(&["stat", "-c", "%i:%u:%g:%a", path]),
        provider_command(&["cat", path]),
    )
}

fn write_retained_provider_state(bootstrap: &Path, native: &Path) {
    provider_command(&["/bin/sh", "-ec", &format!(
        "printf provider-owned > '{bootstrap}'; mkdir -p '{native_parent}'; printf retained-native > '{native}'",
        bootstrap=bootstrap.display(), native_parent=native.parent().unwrap().display(), native=native.display()
    )]);
}

fn selected_context(provider: &str, destination: &str) -> ProviderLaunchContext {
    ProviderLaunchContext {
        preparation: if provider == "codex" {
            ProviderPreparation::Codex {
                tui_args: vec![],
                sidecar_args: vec![],
            }
        } else {
            ProviderPreparation::Opencode {
                project_config: vec![],
                tui_config: None,
                tui_source: None,
                inline_config: false,
            }
        },
        mcp_capability: None,
        prepared_inputs: None,
        config: vec![ProviderConfigReference {
            root: ProviderConfigRoot::Workspace,
            relative_path: "selected-config".into(),
            provider_relative_path: destination.into(),
            format: if provider == "codex" { "toml" } else { "json" }.into(),
        }],
    }
}

async fn fresh_retry(provider: &str) {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    // Actor startup creates this journal before invoking the native transport.
    // The read-only root stops the repaired grant after config preparation,
    // without requiring a provider executable or credential.
    let actor_error = fs::create_dir("/run/freshell-host-actor").unwrap_err();
    assert_eq!(actor_error.raw_os_error(), Some(libc::EROFS));
    let home = Path::new(PROVIDER_HOME);
    let home_inode = fs::metadata(home).unwrap().ino();
    let prefix = if provider == "codex" {
        ".codex"
    } else {
        ".config/opencode"
    };
    let config = format!(
        "{prefix}/{}",
        if provider == "codex" {
            "config.toml"
        } else {
            "opencode.json"
        }
    );
    let bootstrap = format!("{prefix}/bootstrap-marker");
    fs::write(
        Path::new(BOOTSTRAP_ROOT).join("provider-0"),
        b"initial bootstrap",
    )
    .unwrap();
    let source = root.path().join("selected-config");
    let launch: FreshAgentLaunchSpec = serde_json::from_value(serde_json::json!({
        "sessionId":"startup-retry", "provider":provider, "sessionType":format!("fresh{provider}"),
        "runtimeVariant":if provider == "codex" { "codex-app-server" } else { "opencode-sdk" },
        "providerStoreId":"retry-store", "cwd":root.path(), "workspacePath":root.path(),
        "runAsUid":PROVIDER_UID, "runAsGid":PROVIDER_GID,
        "providerBootstrapFiles":[{"sourcePath":"synthetic-only", "providerRelativePath":bootstrap}],
        "providerLaunchContext":selected_context(provider, &config)
    })).unwrap();
    assert!(launch.native_session_id.is_none());
    let soul = SoulId::new();
    let host = Host::start(root.path()).await;
    let first = host
        .send(host.grant(&soul, launch.clone()))
        .await
        .unwrap_err();
    assert_eq!(
        first.diagnostic_code,
        Some(RuntimeDiagnosticCode::ProviderStatePrepareFailed)
    );
    let initialized = fs::metadata(home).unwrap();
    assert_eq!(
        (
            initialized.uid(),
            initialized.gid(),
            initialized.mode() & 0o777
        ),
        (PROVIDER_UID, PROVIDER_GID, 0o700)
    );
    assert_eq!(initialized.ino(), home_inode);
    drop(host);

    // These writes happen as the actual provider, after the handoff. Retrying
    // bootstrap would erase its changes or require a now unavailable input.
    let retained = home.join(&bootstrap);
    let native = home.join(if provider == "codex" {
        ".codex/sessions/provider-owned.jsonl"
    } else {
        ".local/share/opencode/opencode.db"
    });
    write_retained_provider_state(&retained, &native);
    let retained_before = provider_file_snapshot(&retained);
    let native_before = provider_file_snapshot(&native);
    fs::remove_file(Path::new(BOOTSTRAP_ROOT).join("provider-0")).unwrap();
    fs::write(
        &source,
        if provider == "codex" {
            b"model = \"selected\"\n".as_slice()
        } else {
            br#"{"model":"selected"}"#.as_slice()
        },
    )
    .unwrap();

    let replacement = Host::start(root.path()).await;
    let retry = replacement
        .send(replacement.grant(&soul, launch))
        .await
        .unwrap_err();
    assert_eq!(
        retry.diagnostic_code,
        Some(RuntimeDiagnosticCode::FreshAgentOpenFailed),
        "a repaired startup must finish config preparation before refusing the unavailable actor journal: {retry:?}"
    );
    assert_eq!(
        provider_command(&["cat", home.join(config).to_str().unwrap()]),
        fs::read(source).unwrap()
    );
    assert_eq!(provider_file_snapshot(&retained), retained_before);
    assert_eq!(provider_file_snapshot(&native), native_before);
    let after = fs::metadata(home).unwrap();
    assert_eq!(
        (after.ino(), after.uid(), after.gid(), after.mode()),
        (
            initialized.ino(),
            initialized.uid(),
            initialized.gid(),
            initialized.mode()
        )
    );
}

#[tokio::test]
async fn fresh_codex_retries_pre_native_startup_after_home_handoff() {
    if in_disposable_container("fresh_codex_retries_pre_native_startup_after_home_handoff") {
        fresh_retry("codex").await;
    }
}

#[tokio::test]
async fn fresh_opencode_retries_pre_native_startup_after_home_handoff() {
    if in_disposable_container("fresh_opencode_retries_pre_native_startup_after_home_handoff") {
        fresh_retry("opencode").await;
    }
}

#[tokio::test]
async fn opencode_transfer_retry_requires_selected_config_before_advancing_preflight() {
    if !in_disposable_container(
        "opencode_transfer_retry_requires_selected_config_before_advancing_preflight",
    ) {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o755)).unwrap();
    let home = Path::new(PROVIDER_HOME);
    let config = ".config/opencode/opencode.json";
    let bootstrap = ".config/opencode/bootstrap-marker";
    fs::write(
        Path::new(BOOTSTRAP_ROOT).join("provider-0"),
        b"initial bootstrap",
    )
    .unwrap();
    let host = Host::start(root.path()).await;
    let soul = SoulId::new();
    let terminal: TerminalLaunchSpec = serde_json::from_value(serde_json::json!({
        "terminalId":"opencode-preflight-retry", "streamId":"opencode-retry-stream",
        "mode":"opencode", "program":"/synthetic-provider-must-never-run", "args":[],
        "cwd":root.path(), "workspacePath":root.path(),
        "runAsUid":PROVIDER_UID, "runAsGid":PROVIDER_GID,
        "cols":80, "rows":24, "projectKey":"startup-retry", "resumeSessionId":"ses_synthetic",
        "providerBootstrapFiles":[{"sourcePath":"synthetic-only", "providerRelativePath":bootstrap}],
        "providerLaunchContext":selected_context("opencode", config),
        // Deliberately incomplete transfer metadata stops at the real stage
        // validator after HOME preparation. No importer, provider or PTY may run.
        "opencodeTransfer":{
            "transferId":"synthetic-startup-transfer", "provider":"opencode",
            "sourceStoreId":"synthetic-source", "rootSessionId":"ses_synthetic",
            "sourceGeneration":"synthetic-generation", "providerSchema":"opencode-1.18.21",
            "sourceSchemaFingerprint":"synthetic-schema", "migrationJournalFingerprint":"synthetic-migrations",
            "destinationStoreId":soul.as_str(), "destinationDatabasePath":".local/share/opencode/opencode.db",
            "targetImageRef":format!("sha256:{}", "a".repeat(64)), "targetBuildReceipt":"synthetic-build",
            "incarnationId":host.incarnation.as_str(), "manifestJson":"{}", "files":[],
            "totalBytes":0, "bundleSha256":"synthetic-bundle"
        }
    })).unwrap();
    let grant = HostCommand::GrantExecution {
        incarnation_id: host.incarnation.clone(),
        soul_id: soul,
        host_boot_id: host.boot.clone(),
        control_epoch: 1,
        execution_generation: 1,
        grant_id: GrantId::new(),
        fixture: None,
        terminal: Some(Box::new(terminal)),
        fresh_agent: None,
        resume_spec: None,
        native_identity_launch: None,
        provider_path_inputs: Default::default(),
        dispatch_budget_ms: None,
    };
    let first = host.send(grant.clone()).await.unwrap_err();
    assert!(
        first.message.contains("prepare provider config"),
        "{first:?}"
    );
    let initialized = fs::metadata(home).unwrap();
    assert_eq!(
        (
            initialized.uid(),
            initialized.gid(),
            initialized.mode() & 0o777
        ),
        (PROVIDER_UID, PROVIDER_GID, 0o700)
    );
    let retained = home.join(bootstrap);
    let native = home.join(".local/share/opencode/opencode.db");
    write_retained_provider_state(&retained, &native);
    let retained_before = provider_file_snapshot(&retained);
    let native_before = provider_file_snapshot(&native);
    fs::remove_file(Path::new(BOOTSTRAP_ROOT).join("provider-0")).unwrap();
    let events_path = host.socket.parent().unwrap().join("host-lifecycle.jsonl");
    let prepared_events = || {
        fs::read_to_string(&events_path)
            .unwrap()
            .lines()
            .filter(|line| {
                let event: serde_json::Value = serde_json::from_str(line).unwrap();
                event["event"] == "host.opencode_transfer.provider_home_prepared"
            })
            .count()
    };
    assert_eq!(prepared_events(), 0);

    let still_missing = host.send(grant.clone()).await.unwrap_err();
    assert!(still_missing.message.contains("prepare provider config"),
        "retry must remain at configuration publication while selected input is missing: {still_missing:?}");
    assert_eq!(
        prepared_events(),
        0,
        "ownership alone must not complete preparation"
    );
    provider_command(&["test", "!", "-e", home.join(config).to_str().unwrap()]);

    let selected = br#"{"model":"selected-after-repair"}"#;
    fs::write(root.path().join("selected-config"), selected).unwrap();
    let repaired = host.send(grant).await.unwrap_err();
    assert!(repaired.message.contains("OpenCode transfer descriptor is invalid"),
        "publication must finish before the real next-phase validator refuses the synthetic transfer: {repaired:?}");
    assert_eq!(prepared_events(), 1);
    assert_eq!(
        provider_command(&["cat", home.join(config).to_str().unwrap()]),
        selected
    );
    assert_eq!(provider_file_snapshot(&retained), retained_before);
    assert_eq!(provider_file_snapshot(&native), native_before);
    let after = fs::metadata(home).unwrap();
    assert_eq!(
        (after.ino(), after.uid(), after.gid(), after.mode()),
        (
            initialized.ino(),
            initialized.uid(),
            initialized.gid(),
            initialized.mode()
        )
    );
    let state: serde_json::Value = serde_json::from_slice(
        &fs::read(host.socket.parent().unwrap().join("host-state.json")).unwrap(),
    )
    .unwrap();
    assert!(
        state["grantId"].is_null(),
        "preflight failure must leave the grant unconsumed"
    );
    assert_eq!(state["workerLaunchCount"], 0);
}
