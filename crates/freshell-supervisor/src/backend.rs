pub mod docker;

use crate::registry::OwnedRuntimeHandle;
use async_trait::async_trait;
use freshell_runtime_protocol::{
    DockerDaemonId, FreshAgentLaunchSpec, IncarnationId, InstallationId, RuntimeLimits, SoulId,
    TerminalLaunchSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};

const DOCKER_API: &str = "/v1.47";

#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("docker backend unavailable: {0}")]
    Unavailable(String),
    #[error("runtime ownership proof no longer matches the backend object: {0}")]
    OwnershipMismatch(String),
    #[error("docker request failed with HTTP {status}: {body}")]
    DockerHttp { status: u16, body: String },
    #[error("docker response was malformed: {0}")]
    Malformed(String),
    #[error("runtime backend configuration rejected: {0}")]
    InvalidConfig(String),
}

#[derive(Debug, Clone)]
pub struct CreateRuntimeSpec {
    pub installation_id: InstallationId,
    pub soul_id: SoulId,
    pub incarnation_id: IncarnationId,
    pub image_ref: String,
    pub host_binary_path: PathBuf,
    pub runtime_dir: PathBuf,
    pub limits: RuntimeLimits,
    pub test_run_id: String,
    pub terminal: Option<TerminalLaunchSpec>,
    pub fresh_agent: Option<FreshAgentLaunchSpec>,
    pub provider_volume_name: String,
}

#[derive(Debug, Clone)]
pub struct BackendCreated {
    pub daemon_id: DockerDaemonId,
    pub container_id: String,
    pub immutable_config_digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendRuntimeState {
    Created,
    Running,
    Paused,
    Restarting,
    Exited,
    Dead,
    Missing,
}

#[derive(Debug, Clone)]
pub struct BackendInspection {
    pub state: BackendRuntimeState,
    pub configured_limits: RuntimeLimits,
}

#[async_trait]
pub trait RuntimeBackend: Send + Sync {
    async fn create_stopped(
        &self,
        spec: &CreateRuntimeSpec,
    ) -> Result<BackendCreated, BackendError>;
    async fn start_host(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError>;
    async fn inspect(&self, handle: &OwnedRuntimeHandle)
        -> Result<BackendInspection, BackendError>;
    async fn request_stop(
        &self,
        handle: &OwnedRuntimeHandle,
        grace_seconds: u64,
    ) -> Result<(), BackendError>;
    async fn force_stop(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError>;
    async fn verify_empty(&self, handle: &OwnedRuntimeHandle) -> Result<bool, BackendError>;
    /// Inspect only registry-issued ownership capabilities supplied by the
    /// caller. This deliberately is not a Docker-wide container listing.
    async fn list_known(
        &self,
        handles: &[OwnedRuntimeHandle],
    ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError>;
    async fn read_limits(&self, handle: &OwnedRuntimeHandle)
        -> Result<RuntimeLimits, BackendError>;
    async fn enable_long_lived(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError>;
}

#[derive(Clone)]
pub struct DockerEngineBackend {
    socket_path: PathBuf,
}

impl DockerEngineBackend {
    pub fn new(socket_path: impl Into<PathBuf>) -> Self {
        Self {
            socket_path: socket_path.into(),
        }
    }

    pub async fn ping(&self) -> Result<(), BackendError> {
        let response = self.request("GET", "/_ping", None).await?;
        if response.status == 200 && response.body.starts_with(b"OK") {
            Ok(())
        } else {
            Err(response.as_error())
        }
    }

    async fn daemon_id(&self) -> Result<DockerDaemonId, BackendError> {
        let response = self
            .request("GET", &format!("{DOCKER_API}/info"), None)
            .await?;
        if response.status != 200 {
            return Err(response.as_error());
        }
        let value: Value = serde_json::from_slice(&response.body)
            .map_err(|e| BackendError::Malformed(e.to_string()))?;
        let id = value
            .get("ID")
            .and_then(Value::as_str)
            .ok_or_else(|| BackendError::Malformed("docker /info returned no ID".into()))?;
        DockerDaemonId::parse(id.to_owned()).map_err(|e| BackendError::Malformed(e.to_string()))
    }

    async fn inspect_value(&self, container_id: &str) -> Result<Option<Value>, BackendError> {
        let response = self
            .request(
                "GET",
                &format!("{DOCKER_API}/containers/{container_id}/json"),
                None,
            )
            .await?;
        if response.status == 404 {
            return Ok(None);
        }
        if response.status != 200 {
            return Err(response.as_error());
        }
        serde_json::from_slice(&response.body)
            .map(Some)
            .map_err(|e| BackendError::Malformed(e.to_string()))
    }

    async fn verify_handle_value(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<Option<Value>, BackendError> {
        let daemon = self.daemon_id().await?;
        if &daemon != handle.daemon_id() {
            return Err(BackendError::OwnershipMismatch(format!(
                "docker daemon id changed from {} to {}",
                handle.daemon_id(),
                daemon
            )));
        }
        let Some(value) = self.inspect_value(handle.container_id()).await? else {
            return Ok(None);
        };
        let actual_id = value.get("Id").and_then(Value::as_str).unwrap_or_default();
        if actual_id != handle.container_id() {
            return Err(BackendError::OwnershipMismatch(
                "full container id mismatch".into(),
            ));
        }

        let expected_digest = immutable_digest_from_handle(handle)?;
        if expected_digest != handle.immutable_config_digest() {
            return Err(BackendError::OwnershipMismatch(
                "registry immutable-config digest does not match its own fields".into(),
            ));
        }
        verify_inspect_config(handle, &value)?;
        Ok(Some(value))
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<DockerResponse, BackendError> {
        let mut stream = UnixStream::connect(&self.socket_path)
            .await
            .map_err(|e| BackendError::Unavailable(e.to_string()))?;
        let body_bytes = match body {
            Some(v) => serde_json::to_vec(v).map_err(|e| BackendError::Malformed(e.to_string()))?,
            None => Vec::new(),
        };
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\nContent-Length: {}\r\n", body_bytes.len());
        if body.is_some() {
            head.push_str("Content-Type: application/json\r\n");
        }
        head.push_str("\r\n");
        stream
            .write_all(head.as_bytes())
            .await
            .map_err(|e| BackendError::Unavailable(e.to_string()))?;
        if !body_bytes.is_empty() {
            stream
                .write_all(&body_bytes)
                .await
                .map_err(|e| BackendError::Unavailable(e.to_string()))?;
        }
        stream
            .flush()
            .await
            .map_err(|e| BackendError::Unavailable(e.to_string()))?;
        let mut raw = Vec::new();
        stream
            .read_to_end(&mut raw)
            .await
            .map_err(|e| BackendError::Unavailable(e.to_string()))?;
        parse_http_response(&raw)
    }
}

fn docker_create_body(
    spec: &CreateRuntimeSpec,
    binds: Vec<String>,
    host_env: Vec<String>,
    cap_add: Vec<&str>,
    runtime_tmpfs_config: BTreeMap<String, String>,
    requested_limits: String,
    memory_swap: u64,
) -> Value {
    json!({
        "Image": spec.image_ref,
        "Env": host_env,
        "Cmd": [
            "/runtime/freshell-session-host", "serve",
            "--control-socket", "/run/freshell/host.sock",
            "--state-dir", "/run/freshell",
            "--secret-file", "/run/freshell/secret",
            "--incarnation-id", spec.incarnation_id.as_str(),
            "--requested-limits", requested_limits
        ],
        "Labels": {
            "project": "freshell",
            "com.freshell.managed": "true",
            "com.freshell.installation-id": spec.installation_id.as_str(),
            "com.freshell.soul-id": spec.soul_id.as_str(),
            "com.freshell.incarnation-id": spec.incarnation_id.as_str(),
            "com.freshell.runtime-test-run-id": spec.test_run_id,
        },
        "HostConfig": {
            "AutoRemove": false,
            "NetworkMode": if spec.terminal.is_some() || spec.fresh_agent.is_some() { "bridge" } else { "none" },
            "PidMode": "",
            "ReadonlyRootfs": true,
            "Privileged": false,
            "CapDrop": ["ALL"],
            "CapAdd": cap_add,
            "SecurityOpt": ["no-new-privileges:true"],
            "RestartPolicy": {"Name":"no","MaximumRetryCount":0},
            "NanoCpus": spec.limits.cpu_milli.saturating_mul(1_000_000),
            "Memory": spec.limits.memory_bytes,
            "MemorySwap": memory_swap,
            "PidsLimit": spec.limits.pids_max,
            "Binds": binds,
            "Tmpfs": runtime_tmpfs_config
        }
    })
}

fn runtime_host_environment(
    terminal: Option<&TerminalLaunchSpec>,
    fresh_agent: Option<&FreshAgentLaunchSpec>,
) -> Result<Vec<String>, BackendError> {
    let mut values = BTreeMap::new();
    for key in [
        "FRESHELL_RUNTIME_OUTPUT_RING_BYTES",
        "FRESHELL_RUNTIME_OUTPUT_SPOOL_BYTES",
    ] {
        if let Ok(value) = std::env::var(key) {
            values.insert(key.to_string(), value);
        }
    }
    if let Some(agent) = fresh_agent {
        values.extend([
            ("HOME".into(), "/home/freshell/provider".into()),
            (
                "CLAUDE_CONFIG_DIR".into(),
                "/home/freshell/provider/.claude".into(),
            ),
            ("CODEX_HOME".into(), "/home/freshell/provider/.codex".into()),
            (
                "XDG_DATA_HOME".into(),
                "/home/freshell/provider/.local/share".into(),
            ),
            (
                "XDG_CONFIG_HOME".into(),
                "/home/freshell/provider/.config".into(),
            ),
            (
                "FRESHELL_HOSTED_FRESH_AGENT".into(),
                agent.provider.as_str().into(),
            ),
            (
                "FRESHELL_PROVIDER_RUN_AS_UID".into(),
                agent.run_as_uid.to_string(),
            ),
            (
                "FRESHELL_PROVIDER_RUN_AS_GID".into(),
                agent.run_as_gid.to_string(),
            ),
        ]);
        if matches!(
            agent.provider,
            freshell_runtime_protocol::FreshProvider::Claude
                | freshell_runtime_protocol::FreshProvider::Kilroy
        ) {
            values.insert(
                "FRESHELL_CLAUDE_SIDECAR".into(),
                "/opt/freshell-claude-sidecar/index.mjs".into(),
            );
        }
        if agent.provider == freshell_runtime_protocol::FreshProvider::Codex {
            values.insert(
                "CODEX_CMD".into(),
                format!(
                    "/usr/bin/setpriv --reuid {} --regid {} --clear-groups --no-new-privs -- codex",
                    agent.run_as_uid, agent.run_as_gid
                ),
            );
        }
    }
    if let Some(terminal) = terminal.filter(|terminal| terminal.mode == "codex") {
        for key in [
            "HOME",
            "CODEX_HOME",
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "TMPDIR",
            "PATH",
            "TERM",
            "LANG",
            "LC_ALL",
        ] {
            if let Some(value) = terminal.env.get(key) {
                values.insert(key.to_string(), value.clone());
            }
        }
        if terminal.program.contains(char::is_whitespace) || terminal.program.contains('\0') {
            return Err(BackendError::InvalidConfig(
                "managed Codex program must be one argument-safe executable token".into(),
            ));
        }
        values.insert(
            "CODEX_CMD".into(),
            format!(
                "/usr/bin/setpriv --reuid {} --regid {} --clear-groups --no-new-privs -- {}",
                terminal.run_as_uid, terminal.run_as_gid, terminal.program
            ),
        );
    }
    Ok(values
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect())
}

#[async_trait]
impl RuntimeBackend for DockerEngineBackend {
    async fn create_stopped(
        &self,
        spec: &CreateRuntimeSpec,
    ) -> Result<BackendCreated, BackendError> {
        spec.limits
            .validate()
            .map_err(|e| BackendError::InvalidConfig(e.message))?;
        if !spec.image_ref.starts_with("sha256:") || spec.image_ref.len() < 20 {
            return Err(BackendError::InvalidConfig(
                "runtime image must be pinned by sha256 id/digest".into(),
            ));
        }
        let binary = canonical_regular_file(&spec.host_binary_path)?;
        let runtime_dir = canonical_dir(&spec.runtime_dir)?;
        if !spec.provider_volume_name.starts_with("freshell-provider-")
            || spec.provider_volume_name.len() > 96
        {
            return Err(BackendError::InvalidConfig(
                "provider volume name is not installation-scoped".into(),
            ));
        }
        let terminal_mounts = match (&spec.terminal, &spec.fresh_agent) {
            (Some(terminal), None) => Some(docker::terminal_mounts(terminal)),
            (None, Some(agent)) => Some(docker::fresh_agent_mounts(agent)),
            (None, None) => None,
            (Some(_), Some(_)) => {
                return Err(BackendError::InvalidConfig(
                    "runtime cannot host terminal and fresh-agent workloads together".into(),
                ))
            }
        }
        .transpose()
        .map_err(BackendError::InvalidConfig)?;
        let expected = ExpectedConfig::new(spec, &binary, &runtime_dir);
        let immutable_config_digest = digest_expected(&expected)?;
        let daemon_id = self.daemon_id().await?;
        let memory_swap = spec
            .limits
            .memory_bytes
            .checked_add(spec.limits.swap_bytes)
            .ok_or_else(|| BackendError::InvalidConfig("memory+swap overflow".into()))?;
        let requested_limits = serde_json::to_string(&spec.limits)
            .map_err(|e| BackendError::Malformed(e.to_string()))?;
        let mut binds = vec![
            format!("{}:/runtime/freshell-session-host:ro", binary.display()),
            format!("{}:/run/freshell:rw", runtime_dir.display()),
            format!("{}:/home/freshell/provider:rw", spec.provider_volume_name),
        ];
        if let Some(mounts) = &terminal_mounts {
            binds.push(format!(
                "{}:{}:rw",
                mounts.workspace.display(),
                mounts.workspace.display()
            ));
            if let Some(git) = &mounts.git_common_dir {
                if !git.starts_with(&mounts.workspace) {
                    binds.push(format!("{}:{}:rw", git.display(), git.display()));
                }
            }
            for (index, source) in mounts.provider_bootstrap_files.iter().enumerate() {
                binds.push(format!(
                    "{}:/run/freshell-bootstrap/provider-{index}:ro",
                    source.display()
                ));
            }
            for (index, source) in mounts.provider_secret_files.iter().enumerate() {
                binds.push(format!(
                    "{}:/run/freshell-secrets/provider-{index}:ro",
                    source.display()
                ));
            }
        }
        let host_env = runtime_host_environment(spec.terminal.as_ref(), spec.fresh_agent.as_ref())?;
        let cap_add: Vec<&str> = if spec.terminal.is_some() || spec.fresh_agent.is_some() {
            vec!["CHOWN", "SETGID", "SETUID"]
        } else {
            Vec::new()
        };
        let runtime_mode = spec
            .terminal
            .as_ref()
            .map(|terminal| terminal.mode.as_str())
            .or_else(|| {
                spec.fresh_agent
                    .as_ref()
                    .map(|agent| agent.provider.as_str())
            });
        let runtime_tmpfs_config = runtime_tmpfs(runtime_mode);
        let body = docker_create_body(
            spec,
            binds,
            host_env,
            cap_add,
            runtime_tmpfs_config,
            requested_limits,
            memory_swap,
        );
        // The name is diagnostic only and is deliberately unique per create attempt.
        // A crash after Docker create but before the container-id commit can leave a
        // stopped, unregistered object. Retrying the PREPARED transaction must be able
        // to create a new stopped candidate without treating the stale object's name
        // as ownership authority.
        let name = format!(
            "freshell-{}-{}",
            spec.incarnation_id.as_str(),
            uuid::Uuid::new_v4()
        );
        let response = self
            .request(
                "POST",
                &format!("{DOCKER_API}/containers/create?name={name}"),
                Some(&body),
            )
            .await?;
        if response.status != 201 {
            return Err(response.as_error());
        }
        let value: Value = serde_json::from_slice(&response.body)
            .map_err(|e| BackendError::Malformed(e.to_string()))?;
        let container_id = value
            .get("Id")
            .and_then(Value::as_str)
            .ok_or_else(|| BackendError::Malformed("container create returned no Id".into()))?
            .to_owned();
        if container_id.len() < 32 {
            return Err(BackendError::Malformed(
                "container create returned a short Id".into(),
            ));
        }
        Ok(BackendCreated {
            daemon_id,
            container_id,
            immutable_config_digest,
        })
    }

    async fn start_host(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        let state = self.inspect(handle).await?.state;
        if state == BackendRuntimeState::Running {
            return Ok(());
        }
        if !matches!(
            state,
            BackendRuntimeState::Created | BackendRuntimeState::Exited
        ) {
            return Err(BackendError::OwnershipMismatch(format!(
                "container cannot start from state {state:?}"
            )));
        }
        let response = self
            .request(
                "POST",
                &format!("{DOCKER_API}/containers/{}/start", handle.container_id()),
                None,
            )
            .await?;
        if response.status == 204 || response.status == 304 {
            Ok(())
        } else {
            Err(response.as_error())
        }
    }

    async fn inspect(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<BackendInspection, BackendError> {
        let Some(value) = self.verify_handle_value(handle).await? else {
            return Ok(BackendInspection {
                state: BackendRuntimeState::Missing,
                configured_limits: handle.requested_limits(),
            });
        };
        let state_value = value.get("State").cloned().unwrap_or(Value::Null);
        let running = state_value
            .get("Running")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let paused = state_value
            .get("Paused")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let restarting = state_value
            .get("Restarting")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let status = state_value
            .get("Status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let state = if paused {
            BackendRuntimeState::Paused
        } else if restarting {
            BackendRuntimeState::Restarting
        } else if running {
            BackendRuntimeState::Running
        } else {
            match status {
                "created" => BackendRuntimeState::Created,
                "dead" => BackendRuntimeState::Dead,
                _ => BackendRuntimeState::Exited,
            }
        };
        Ok(BackendInspection {
            state,
            configured_limits: configured_limits_from_inspect(&value, handle.requested_limits()),
        })
    }

    async fn request_stop(
        &self,
        handle: &OwnedRuntimeHandle,
        grace_seconds: u64,
    ) -> Result<(), BackendError> {
        let inspected = self.inspect(handle).await?;
        match inspected.state {
            BackendRuntimeState::Missing
            | BackendRuntimeState::Exited
            | BackendRuntimeState::Dead => return Ok(()),
            BackendRuntimeState::Paused => {
                let response = self
                    .request(
                        "POST",
                        &format!("{DOCKER_API}/containers/{}/unpause", handle.container_id()),
                        None,
                    )
                    .await?;
                if response.status != 204 {
                    return Err(response.as_error());
                }
            }
            _ => {}
        }
        let response = self
            .request(
                "POST",
                &format!(
                    "{DOCKER_API}/containers/{}/stop?t={}",
                    handle.container_id(),
                    grace_seconds.min(30)
                ),
                None,
            )
            .await?;
        if matches!(response.status, 204 | 304) {
            Ok(())
        } else {
            Err(response.as_error())
        }
    }

    async fn force_stop(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        let inspected = self.inspect(handle).await?;
        if matches!(
            inspected.state,
            BackendRuntimeState::Missing | BackendRuntimeState::Exited | BackendRuntimeState::Dead
        ) {
            return Ok(());
        }
        if inspected.state == BackendRuntimeState::Paused {
            let response = self
                .request(
                    "POST",
                    &format!("{DOCKER_API}/containers/{}/unpause", handle.container_id()),
                    None,
                )
                .await?;
            if response.status != 204 {
                return Err(response.as_error());
            }
        }
        let response = self
            .request(
                "POST",
                &format!(
                    "{DOCKER_API}/containers/{}/kill?signal=KILL",
                    handle.container_id()
                ),
                None,
            )
            .await?;
        if matches!(response.status, 204 | 304 | 409) {
            Ok(())
        } else {
            Err(response.as_error())
        }
    }

    async fn verify_empty(&self, handle: &OwnedRuntimeHandle) -> Result<bool, BackendError> {
        Ok(matches!(
            self.inspect(handle).await?.state,
            BackendRuntimeState::Missing | BackendRuntimeState::Exited | BackendRuntimeState::Dead
        ))
    }

    async fn list_known(
        &self,
        handles: &[OwnedRuntimeHandle],
    ) -> Result<Vec<(IncarnationId, BackendInspection)>, BackendError> {
        let mut out = Vec::with_capacity(handles.len());
        for handle in handles {
            out.push((handle.incarnation_id().clone(), self.inspect(handle).await?));
        }
        Ok(out)
    }

    async fn read_limits(
        &self,
        handle: &OwnedRuntimeHandle,
    ) -> Result<RuntimeLimits, BackendError> {
        Ok(self.inspect(handle).await?.configured_limits)
    }

    async fn enable_long_lived(&self, handle: &OwnedRuntimeHandle) -> Result<(), BackendError> {
        self.verify_handle_value(handle).await?;
        let body = json!({"RestartPolicy":{"Name":"unless-stopped","MaximumRetryCount":0}});
        let response = self
            .request(
                "POST",
                &format!("{DOCKER_API}/containers/{}/update", handle.container_id()),
                Some(&body),
            )
            .await?;
        if response.status == 200 {
            Ok(())
        } else {
            Err(response.as_error())
        }
    }
}

fn runtime_tmpfs(mode: Option<&str>) -> std::collections::BTreeMap<String, String> {
    let mut mounts = std::collections::BTreeMap::from([(
        "/tmp".to_string(),
        "rw,noexec,nosuid,nodev,size=128m".to_string(),
    )]);
    if mode == Some("opencode") {
        mounts.insert(
            "/run/opencode-tmp".to_string(),
            "rw,exec,nosuid,nodev,size=64m,mode=1777".to_string(),
        );
    }
    mounts
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExpectedConfig {
    image_ref: String,
    installation_id: String,
    soul_id: String,
    incarnation_id: String,
    host_binary_path: String,
    runtime_dir: String,
    limits: RuntimeLimits,
    terminal: Option<TerminalLaunchSpec>,
    fresh_agent: Option<ImmutableFreshAgentConfig>,
    provider_volume_name: String,
}

/// Only enclosure-affecting fields belong in the Docker ownership digest.
/// Conversation identity and per-turn settings are durable mutable state and
/// may change while this exact container continues to own the soul.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImmutableFreshAgentConfig {
    provider: freshell_runtime_protocol::FreshProvider,
    session_type: String,
    runtime_variant: String,
    provider_store_id: String,
    workspace_path: String,
    git_common_dir: Option<String>,
    run_as_uid: u32,
    run_as_gid: u32,
    fixture_transport: Option<freshell_runtime_protocol::FreshAgentFixtureTransport>,
    provider_bootstrap_files: Vec<freshell_runtime_protocol::ProviderBootstrapFile>,
}

impl From<&FreshAgentLaunchSpec> for ImmutableFreshAgentConfig {
    fn from(spec: &FreshAgentLaunchSpec) -> Self {
        Self {
            provider: spec.provider.clone(),
            session_type: spec.session_type.clone(),
            runtime_variant: spec.runtime_variant.clone(),
            provider_store_id: spec.provider_store_id.clone(),
            workspace_path: spec.workspace_path.clone(),
            git_common_dir: spec.git_common_dir.clone(),
            run_as_uid: spec.run_as_uid,
            run_as_gid: spec.run_as_gid,
            fixture_transport: spec.fixture_transport,
            provider_bootstrap_files: spec.provider_bootstrap_files.clone(),
        }
    }
}

impl ExpectedConfig {
    fn new(spec: &CreateRuntimeSpec, binary: &Path, runtime_dir: &Path) -> Self {
        Self {
            image_ref: spec.image_ref.clone(),
            installation_id: spec.installation_id.to_string(),
            soul_id: spec.soul_id.to_string(),
            incarnation_id: spec.incarnation_id.to_string(),
            host_binary_path: binary.to_string_lossy().into_owned(),
            runtime_dir: runtime_dir.to_string_lossy().into_owned(),
            limits: spec.limits,
            terminal: spec.terminal.clone(),
            fresh_agent: spec
                .fresh_agent
                .as_ref()
                .map(ImmutableFreshAgentConfig::from),
            provider_volume_name: spec.provider_volume_name.clone(),
        }
    }
}

fn immutable_digest_from_handle(handle: &OwnedRuntimeHandle) -> Result<String, BackendError> {
    digest_expected(&ExpectedConfig {
        image_ref: handle.image_ref().to_owned(),
        installation_id: handle.installation_id().to_string(),
        soul_id: handle.soul_id().to_string(),
        incarnation_id: handle.incarnation_id().to_string(),
        host_binary_path: handle.host_binary_path().to_string_lossy().into_owned(),
        runtime_dir: handle.runtime_dir().to_string_lossy().into_owned(),
        limits: handle.requested_limits(),
        terminal: handle.terminal().cloned(),
        fresh_agent: handle.fresh_agent().map(ImmutableFreshAgentConfig::from),
        provider_volume_name: handle.provider_volume_name().to_owned(),
    })
}

fn digest_expected(expected: &ExpectedConfig) -> Result<String, BackendError> {
    let bytes = serde_json::to_vec(expected).map_err(|e| BackendError::Malformed(e.to_string()))?;
    let digest = Sha256::digest(bytes);
    Ok(format!("sha256:{digest:x}"))
}

fn verify_runtime_environment(inspect: &Value, expected: &[String]) -> Result<(), BackendError> {
    let actual = inspect
        .get("Config")
        .and_then(|config| config.get("Env"))
        .and_then(Value::as_array)
        .ok_or_else(|| BackendError::OwnershipMismatch("missing runtime environment".into()))?;
    let actual: std::collections::BTreeMap<String, String> = actual
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|entry| entry.split_once('='))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    for entry in expected {
        let (key, expected_value) = entry
            .split_once('=')
            .ok_or_else(|| BackendError::InvalidConfig("runtime env entry has no '='".into()))?;
        if actual.get(key).map(String::as_str) != Some(expected_value) {
            return Err(BackendError::OwnershipMismatch(format!(
                "runtime environment changed for {key}"
            )));
        }
    }
    for forbidden in [
        "AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENCODE_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
    ] {
        if actual.contains_key(forbidden) {
            return Err(BackendError::OwnershipMismatch(format!(
                "forbidden credential environment {forbidden} reached the session host"
            )));
        }
    }
    Ok(())
}

fn verify_inspect_config(handle: &OwnedRuntimeHandle, value: &Value) -> Result<(), BackendError> {
    let actual_image = value
        .get("Image")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if actual_image != handle.image_ref() {
        return Err(BackendError::OwnershipMismatch(format!(
            "image mismatch: {actual_image}"
        )));
    }
    let labels = value
        .pointer("/Config/Labels")
        .and_then(Value::as_object)
        .ok_or_else(|| BackendError::OwnershipMismatch("missing labels".into()))?;
    let expected_labels = [
        ("com.freshell.managed", "true"),
        (
            "com.freshell.installation-id",
            handle.installation_id().as_str(),
        ),
        ("com.freshell.soul-id", handle.soul_id().as_str()),
        (
            "com.freshell.incarnation-id",
            handle.incarnation_id().as_str(),
        ),
    ];
    for (key, expected) in expected_labels {
        if labels.get(key).and_then(Value::as_str) != Some(expected) {
            return Err(BackendError::OwnershipMismatch(format!(
                "label mismatch for {key}"
            )));
        }
    }
    let expected_env = runtime_host_environment(handle.terminal(), handle.fresh_agent())?;
    verify_runtime_environment(value, &expected_env)?;

    let host_config = value
        .get("HostConfig")
        .ok_or_else(|| BackendError::OwnershipMismatch("missing HostConfig".into()))?;
    let expected_network = if handle.terminal().is_some() || handle.fresh_agent().is_some() {
        "bridge"
    } else {
        "none"
    };
    if host_config.get("NetworkMode").and_then(Value::as_str) != Some(expected_network) {
        return Err(BackendError::OwnershipMismatch(
            "network mode changed".into(),
        ));
    }
    if host_config
        .get("PidMode")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != ""
    {
        return Err(BackendError::OwnershipMismatch(
            "host pid namespace exposure detected".into(),
        ));
    }
    if host_config
        .get("Privileged")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(BackendError::OwnershipMismatch(
            "container became privileged".into(),
        ));
    }
    let actual_cap_add = host_config
        .get("CapAdd")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(|value| value.trim_start_matches("CAP_").to_string())
                .collect::<std::collections::BTreeSet<_>>()
        })
        .unwrap_or_default();
    let expected_cap_add = if handle.terminal().is_some() || handle.fresh_agent().is_some() {
        ["CHOWN", "SETGID", "SETUID"]
            .into_iter()
            .map(str::to_string)
            .collect::<std::collections::BTreeSet<_>>()
    } else {
        std::collections::BTreeSet::new()
    };
    if actual_cap_add != expected_cap_add {
        return Err(BackendError::OwnershipMismatch(format!(
            "runtime capability set changed: {actual_cap_add:?}"
        )));
    }
    let expected_mode = handle
        .terminal()
        .map(|terminal| terminal.mode.as_str())
        .or_else(|| handle.fresh_agent().map(|agent| agent.provider.as_str()));
    let expected_tmpfs = runtime_tmpfs(expected_mode);
    let actual_tmpfs = host_config
        .get("Tmpfs")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(path, value)| {
                    value
                        .as_str()
                        .map(|value| (path.clone(), value.to_string()))
                })
                .collect::<std::collections::BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    if actual_tmpfs != expected_tmpfs {
        return Err(BackendError::OwnershipMismatch(format!(
            "runtime tmpfs topology changed: {actual_tmpfs:?}"
        )));
    }

    let mounts = value
        .get("Mounts")
        .and_then(Value::as_array)
        .ok_or_else(|| BackendError::OwnershipMismatch("missing mounts".into()))?;
    let has_binary = mounts.iter().any(|m| {
        m.get("Source").and_then(Value::as_str)
            == Some(handle.host_binary_path().to_string_lossy().as_ref())
            && m.get("Destination").and_then(Value::as_str)
                == Some("/runtime/freshell-session-host")
    });
    let has_runtime = mounts.iter().any(|m| {
        m.get("Source").and_then(Value::as_str)
            == Some(handle.runtime_dir().to_string_lossy().as_ref())
            && m.get("Destination").and_then(Value::as_str) == Some("/run/freshell")
    });
    if !has_binary || !has_runtime {
        return Err(BackendError::OwnershipMismatch(
            "runtime mount topology changed".into(),
        ));
    }
    let has_provider = mounts.iter().any(|mount| {
        mount.get("Name").and_then(Value::as_str) == Some(handle.provider_volume_name())
            && mount.get("Destination").and_then(Value::as_str) == Some("/home/freshell/provider")
    });
    if !has_provider {
        return Err(BackendError::OwnershipMismatch(
            "provider home volume changed".into(),
        ));
    }
    if let Some(terminal) = handle.terminal() {
        let expected =
            docker::terminal_mounts(terminal).map_err(BackendError::OwnershipMismatch)?;
        verify_workload_mounts(mounts, &expected)?;
    }
    if let Some(agent) = handle.fresh_agent() {
        let expected =
            docker::fresh_agent_mounts(agent).map_err(BackendError::OwnershipMismatch)?;
        verify_workload_mounts(mounts, &expected)?;
    }
    Ok(())
}

fn verify_workload_mounts(
    mounts: &[Value],
    expected: &docker::TerminalMounts,
) -> Result<(), BackendError> {
    let workspace = expected.workspace.to_string_lossy();
    let has_workspace = mounts.iter().any(|mount| {
        mount.get("Source").and_then(Value::as_str) == Some(workspace.as_ref())
            && mount.get("Destination").and_then(Value::as_str) == Some(workspace.as_ref())
    });
    if !has_workspace {
        return Err(BackendError::OwnershipMismatch(
            "workspace mount changed".into(),
        ));
    }
    if let Some(git) = expected.git_common_dir.as_ref() {
        if !git.starts_with(&expected.workspace) {
            let git_text = git.to_string_lossy();
            let has_git = mounts.iter().any(|mount| {
                mount.get("Source").and_then(Value::as_str) == Some(git_text.as_ref())
                    && mount.get("Destination").and_then(Value::as_str) == Some(git_text.as_ref())
            });
            if !has_git {
                return Err(BackendError::OwnershipMismatch(
                    "git common-dir mount changed".into(),
                ));
            }
        }
        for (index, source) in expected.provider_secret_files.iter().enumerate() {
            let source_text = source.to_string_lossy();
            let destination = format!("/run/freshell-secrets/provider-{index}");
            let found = mounts.iter().any(|mount| {
                mount.get("Source").and_then(Value::as_str) == Some(source_text.as_ref())
                    && mount.get("Destination").and_then(Value::as_str)
                        == Some(destination.as_str())
                    && mount.get("RW").and_then(Value::as_bool) == Some(false)
            });
            if !found {
                return Err(BackendError::OwnershipMismatch(
                    "provider secret-reference mount changed".into(),
                ));
            }
        }
    }
    for (index, source) in expected.provider_bootstrap_files.iter().enumerate() {
        let source_text = source.to_string_lossy();
        let destination = format!("/run/freshell-bootstrap/provider-{index}");
        let found = mounts.iter().any(|mount| {
            mount.get("Source").and_then(Value::as_str) == Some(source_text.as_ref())
                && mount.get("Destination").and_then(Value::as_str) == Some(destination.as_str())
                && mount.get("RW").and_then(Value::as_bool) == Some(false)
        });
        if !found {
            return Err(BackendError::OwnershipMismatch(
                "provider bootstrap mount changed".into(),
            ));
        }
    }
    Ok(())
}

fn configured_limits_from_inspect(value: &Value, fallback: RuntimeLimits) -> RuntimeLimits {
    let host = value.get("HostConfig").unwrap_or(&Value::Null);
    let memory = host
        .get("Memory")
        .and_then(Value::as_u64)
        .unwrap_or(fallback.memory_bytes);
    let memory_swap_total = host
        .get("MemorySwap")
        .and_then(Value::as_u64)
        .unwrap_or(memory.saturating_add(fallback.swap_bytes));
    let nano_cpus = host
        .get("NanoCpus")
        .and_then(Value::as_u64)
        .unwrap_or(fallback.cpu_milli.saturating_mul(1_000_000));
    RuntimeLimits {
        cpu_milli: nano_cpus / 1_000_000,
        memory_bytes: memory,
        swap_bytes: memory_swap_total.saturating_sub(memory),
        pids_max: host
            .get("PidsLimit")
            .and_then(Value::as_u64)
            .unwrap_or(fallback.pids_max),
    }
}

fn canonical_regular_file(path: &Path) -> Result<PathBuf, BackendError> {
    let path = std::fs::canonicalize(path)
        .map_err(|e| BackendError::InvalidConfig(format!("host binary: {e}")))?;
    if !path.is_file() {
        return Err(BackendError::InvalidConfig(
            "host binary is not a regular file".into(),
        ));
    }
    Ok(path)
}

fn canonical_dir(path: &Path) -> Result<PathBuf, BackendError> {
    let path = std::fs::canonicalize(path)
        .map_err(|e| BackendError::InvalidConfig(format!("runtime dir: {e}")))?;
    if !path.is_dir() {
        return Err(BackendError::InvalidConfig(
            "runtime dir is not a directory".into(),
        ));
    }
    Ok(path)
}

struct DockerResponse {
    status: u16,
    body: Vec<u8>,
}
impl DockerResponse {
    fn as_error(&self) -> BackendError {
        BackendError::DockerHttp {
            status: self.status,
            body: String::from_utf8_lossy(&self.body)
                .chars()
                .take(2048)
                .collect(),
        }
    }
}

fn parse_http_response(raw: &[u8]) -> Result<DockerResponse, BackendError> {
    let split = find_bytes(raw, b"\r\n\r\n")
        .ok_or_else(|| BackendError::Malformed("HTTP response has no header terminator".into()))?;
    let head =
        std::str::from_utf8(&raw[..split]).map_err(|e| BackendError::Malformed(e.to_string()))?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| BackendError::Malformed("HTTP response has no numeric status".into()))?;
    let mut body = raw[split + 4..].to_vec();
    let chunked = head.lines().skip(1).any(|line| {
        line.to_ascii_lowercase().starts_with("transfer-encoding:")
            && line.to_ascii_lowercase().contains("chunked")
    });
    if chunked {
        body = decode_chunked(&body)?;
    }
    Ok(DockerResponse { status, body })
}

fn decode_chunked(raw: &[u8]) -> Result<Vec<u8>, BackendError> {
    let mut cursor = 0usize;
    let mut out = Vec::new();
    loop {
        let line_end = find_bytes(&raw[cursor..], b"\r\n")
            .ok_or_else(|| BackendError::Malformed("invalid chunk header".into()))?
            + cursor;
        let size_raw = std::str::from_utf8(&raw[cursor..line_end])
            .map_err(|e| BackendError::Malformed(e.to_string()))?;
        let size = usize::from_str_radix(size_raw.split(';').next().unwrap_or(""), 16)
            .map_err(|e| BackendError::Malformed(e.to_string()))?;
        cursor = line_end + 2;
        if size == 0 {
            break;
        }
        if cursor + size + 2 > raw.len() {
            return Err(BackendError::Malformed(
                "chunk exceeds response body".into(),
            ));
        }
        out.extend_from_slice(&raw[cursor..cursor + size]);
        cursor += size + 2;
    }
    Ok(out)
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_content_length_response() {
        let response =
            parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, b"{}");
    }

    #[test]
    fn opencode_gets_dedicated_bounded_exec_tmpfs_while_global_tmp_stays_noexec() {
        let opencode = runtime_tmpfs(Some("opencode"));
        assert_eq!(
            opencode.get("/tmp").map(String::as_str),
            Some("rw,noexec,nosuid,nodev,size=128m")
        );
        assert_eq!(
            opencode.get("/run/opencode-tmp").map(String::as_str),
            Some("rw,exec,nosuid,nodev,size=64m,mode=1777")
        );
        assert_eq!(opencode.len(), 2);

        let shell = runtime_tmpfs(Some("shell"));
        assert_eq!(shell.len(), 1);
        assert!(!shell.contains_key("/run/opencode-tmp"));
    }

    #[test]
    fn parses_chunked_response() {
        let response = parse_http_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ntest\r\n0\r\n\r\n",
        )
        .unwrap();
        assert_eq!(response.body, b"test");
    }
    #[test]
    fn codex_host_environment_drops_to_the_provider_uid_and_uses_soul_home() {
        let terminal = TerminalLaunchSpec {
            terminal_id: "terminal-one".into(),
            stream_id: "stream-one".into(),
            mode: "codex".into(),
            program: "codex".into(),
            args: Vec::new(),
            env: BTreeMap::from([
                ("HOME".into(), "/home/freshell/provider".into()),
                ("CODEX_HOME".into(), "/home/freshell/provider/.codex".into()),
                ("AUTH_TOKEN".into(), "must-not-cross".into()),
            ]),
            cwd: "/workspace".into(),
            run_as_uid: 65_534,
            run_as_gid: 0,
            cols: 80,
            rows: 24,
            project_key: "project-one".into(),
            workspace_path: "/workspace".into(),
            git_common_dir: None,
            create_request_id: None,
            resume_session_id: None,
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
        };
        let env = runtime_host_environment(Some(&terminal), None).unwrap();
        assert!(env
            .iter()
            .any(|value| value == "HOME=/home/freshell/provider"));
        assert!(env
            .iter()
            .any(|value| value == "CODEX_HOME=/home/freshell/provider/.codex"));
        assert!(env.iter().any(|value| value == "CODEX_CMD=/usr/bin/setpriv --reuid 65534 --regid 0 --clear-groups --no-new-privs -- codex"));
        assert!(!env.iter().any(|value| value.contains("AUTH_TOKEN")));
    }

    #[test]
    fn amplifier_onecli_secret_mount_is_reference_only_in_docker_json() {
        use freshell_runtime_protocol::{ProviderSecretProfile, ProviderSecretReference};

        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let keys = root.path().join("keys.env");
        let secret = "amplifier-onecli-secret-sentinel";
        std::fs::write(&keys, format!("LUNAROUTE_API_KEY={secret}\n")).unwrap();
        let keys = std::fs::canonicalize(keys).unwrap();
        let workspace = std::fs::canonicalize(workspace.path()).unwrap();
        let terminal = TerminalLaunchSpec {
            terminal_id: "terminal-amplifier".into(),
            stream_id: "stream-amplifier".into(),
            mode: "amplifier".into(),
            program: "amplifier".into(),
            args: Vec::new(),
            env: BTreeMap::from([("HOME".into(), "/home/freshell/provider".into())]),
            cwd: workspace.to_string_lossy().into_owned(),
            run_as_uid: 65_534,
            run_as_gid: 0,
            cols: 80,
            rows: 24,
            project_key: "project-amplifier".into(),
            workspace_path: workspace.to_string_lossy().into_owned(),
            git_common_dir: None,
            create_request_id: Some("create-amplifier".into()),
            resume_session_id: Some("session-amplifier".into()),
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: vec![ProviderSecretReference {
                source_path: keys.to_string_lossy().into_owned(),
                profile: ProviderSecretProfile::AmplifierOnecliLunarouteGlm53,
            }],
        };
        let mounts = docker::terminal_mounts(&terminal).unwrap();
        let binds: Vec<String> = mounts
            .provider_secret_files
            .iter()
            .enumerate()
            .map(|(index, source)| {
                format!(
                    "{}:/run/freshell-secrets/provider-{index}:ro",
                    source.display()
                )
            })
            .collect();
        let spec = CreateRuntimeSpec {
            installation_id: InstallationId::parse("installation-test").unwrap(),
            soul_id: SoulId::parse("soul-test").unwrap(),
            incarnation_id: IncarnationId::parse("incarnation-test").unwrap(),
            image_ref: "sha256:image".into(),
            host_binary_path: root.path().join("host"),
            runtime_dir: root.path().join("runtime"),
            limits: RuntimeLimits {
                cpu_milli: 1000,
                memory_bytes: 1024,
                swap_bytes: 0,
                pids_max: 64,
            },
            test_run_id: "reference-only".into(),
            terminal: Some(terminal),
            fresh_agent: None,
            provider_volume_name: "freshell-provider-test".into(),
        };
        let body = docker_create_body(
            &spec,
            binds,
            Vec::new(),
            vec!["CHOWN", "SETGID", "SETUID"],
            BTreeMap::new(),
            serde_json::to_string(&spec.limits).unwrap(),
            spec.limits.memory_bytes,
        );
        let durable_json = serde_json::to_string(&body).unwrap();
        assert!(durable_json.contains(&keys.to_string_lossy().to_string()));
        // Docker needs only the exact read-only mount. The profile selector is
        // delivered later over the authenticated host grant, while resolved
        // upstream/proxy credentials stay out of Docker JSON and labels.
        assert!(!durable_json.contains("amplifier_onecli_lunaroute_glm53"));
        assert!(!durable_json.contains("onecli.example.invalid"));
        assert!(!durable_json.contains(secret));
    }

    #[test]
    fn fresh_agent_ownership_digest_ignores_mutable_conversation_state() {
        let root = tempfile::tempdir().unwrap();
        let mut agent = FreshAgentLaunchSpec {
            session_id: "presentation-parent".into(),
            provider: freshell_runtime_protocol::FreshProvider::Claude,
            session_type: "freshclaude".into(),
            runtime_variant: "claude-agent-sdk".into(),
            provider_store_id: "store-one".into(),
            cwd: "/workspace/project".into(),
            workspace_path: "/workspace".into(),
            git_common_dir: None,
            run_as_uid: 65_534,
            run_as_gid: 0,
            model: Some("haiku".into()),
            effort: Some("low".into()),
            permission_mode: Some("ask".into()),
            sandbox: Some("workspace-write".into()),
            native_session_id: None,
            fixture_transport: None,
            provider_bootstrap_files: Vec::new(),
        };
        let make = |agent: FreshAgentLaunchSpec| CreateRuntimeSpec {
            installation_id: InstallationId::parse("installation-digest").unwrap(),
            soul_id: SoulId::parse("soul-digest").unwrap(),
            incarnation_id: IncarnationId::parse("incarnation-digest").unwrap(),
            image_ref: "sha256:image".into(),
            host_binary_path: root.path().join("host"),
            runtime_dir: root.path().join("runtime"),
            limits: RuntimeLimits {
                cpu_milli: 1000,
                memory_bytes: 1024,
                swap_bytes: 0,
                pids_max: 64,
            },
            test_run_id: "digest".into(),
            terminal: None,
            fresh_agent: Some(agent),
            provider_volume_name: "freshell-provider-digest".into(),
        };
        let initial = make(agent.clone());
        let initial_digest = digest_expected(&ExpectedConfig::new(
            &initial,
            &initial.host_binary_path,
            &initial.runtime_dir,
        ))
        .unwrap();

        // These values legitimately change while the same container remains
        // alive: native identity materializes, a fork changes presentation,
        // and per-turn settings are updated inside the host actor.
        agent.session_id = "presentation-child".into();
        agent.native_session_id = Some("native-child".into());
        agent.cwd = "/workspace/project/subdir".into();
        agent.model = Some("sonnet".into());
        agent.effort = Some("high".into());
        agent.permission_mode = Some("plan".into());
        agent.sandbox = Some("read-only".into());
        let changed = make(agent.clone());
        let changed_digest = digest_expected(&ExpectedConfig::new(
            &changed,
            &changed.host_binary_path,
            &changed.runtime_dir,
        ))
        .unwrap();
        assert_eq!(initial_digest, changed_digest);

        // Enclosure-affecting identity/topology still changes ownership truth.
        agent.workspace_path = "/different-workspace".into();
        let escaped = make(agent);
        let escaped_digest = digest_expected(&ExpectedConfig::new(
            &escaped,
            &escaped.host_binary_path,
            &escaped.runtime_dir,
        ))
        .unwrap();
        assert_ne!(initial_digest, escaped_digest);
    }

    #[test]
    fn inspect_environment_requires_exact_host_policy_and_rejects_credentials() {
        let expected = vec![
            "HOME=/home/freshell/provider".to_string(),
            "CODEX_CMD=/usr/bin/setpriv --reuid 65534 --regid 0 --clear-groups --no-new-privs -- codex".to_string(),
        ];
        let good = serde_json::json!({
            "Config": {"Env": [
                "PATH=/usr/local/bin:/usr/bin:/bin",
                "HOME=/home/freshell/provider",
                "CODEX_CMD=/usr/bin/setpriv --reuid 65534 --regid 0 --clear-groups --no-new-privs -- codex"
            ]}
        });
        assert!(verify_runtime_environment(&good, &expected).is_ok());

        let changed = serde_json::json!({
            "Config": {"Env": [
                "HOME=/home/freshell/provider",
                "CODEX_CMD=codex"
            ]}
        });
        assert!(matches!(
            verify_runtime_environment(&changed, &expected),
            Err(BackendError::OwnershipMismatch(_))
        ));

        let leaked = serde_json::json!({
            "Config": {"Env": [
                "HOME=/home/freshell/provider",
                "CODEX_CMD=/usr/bin/setpriv --reuid 65534 --regid 0 --clear-groups --no-new-privs -- codex",
                "OPENAI_API_KEY=secret"
            ]}
        });
        assert!(matches!(
            verify_runtime_environment(&leaked, &expected),
            Err(BackendError::OwnershipMismatch(_))
        ));
    }
}
