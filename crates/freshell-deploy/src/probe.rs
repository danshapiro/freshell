use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use freshell_deployment::{assert_mutually_compatible, parse_declaration, Declaration};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::error::{DeployError, Result};
use crate::legacy::{NodePrerequisite, RuntimeBindings};
use crate::manifest::ManifestEntry;
use crate::paths::{validate_relative_path, DeployPort};
use crate::process_control::{LinuxPidfdBackend, PidfdBackend, Signal, StopPolicy};
use crate::process_identity::ProcessIdentity;
use crate::process_identity::{FileIdentity, LinuxPidFd, LinuxProcfs, ProcessInspector};
use crate::receipts::validate_generation_id;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeploymentReadyReceipt {
    pub schema_version: String,
    pub nonce: String,
    pub actual_address: String,
    pub pid: u32,
    pub boot_id: String,
    pub instance_id: String,
    pub server_process_generation_id: String,
    pub server_component_version: String,
    pub build_commit: String,
}

impl DeploymentReadyReceipt {
    pub fn validate(&self) -> Result<SocketAddr> {
        if self.schema_version != "1"
            || self.nonce.is_empty()
            || self.pid == 0
            || self.boot_id.is_empty()
            || self.instance_id.is_empty()
            || self.server_component_version.is_empty()
            || self.build_commit.is_empty()
        {
            return Err(DeployError::Probe(
                "ready receipt is incomplete or malformed".to_string(),
            ));
        }
        validate_generation_id(&self.server_process_generation_id)?;
        let address = self.actual_address.parse::<SocketAddr>().map_err(|_| {
            DeployError::Probe("ready receipt actualAddress is invalid".to_string())
        })?;
        if address.port() == 0 || (!address.ip().is_loopback() && !address.ip().is_unspecified()) {
            return Err(DeployError::Probe(
                "ready receipt must identify a loopback or wildcard listener".to_string(),
            ));
        }
        Ok(address)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateEvidence {
    pub ready: DeploymentReadyReceipt,
    pub process: ProcessIdentity,
}

impl CandidateEvidence {
    pub fn validate(&self) -> Result<SocketAddr> {
        let address = self.ready.validate()?;
        self.process.validate()?;
        if self.ready.pid != self.process.pid
            || address.port() != self.process.listener.port.get()
            || self.process.listener.owner_pid != self.ready.pid
        {
            return Err(DeployError::Probe(
                "ready receipt and process/listener identity disagree".to_string(),
            ));
        }
        Ok(address)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompatibilityPair {
    pub client: Declaration,
    pub server: Declaration,
    pub server_process_generation_id: Option<String>,
    pub boot_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientCompatibilityArtifact {
    schema_version: String,
    declaration: Box<RawValue>,
    declaration_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerCompatibilityResponse {
    schema_version: String,
    server_declaration: Box<RawValue>,
    server_declaration_sha256: String,
    server_process_generation_id: Option<String>,
    boot_id: String,
}

/// Strictly parse both immutable artifact declarations and require reciprocal
/// half-open compatibility before any live mutation.
pub fn validate_compatibility_artifacts(
    client_artifact_path: &Path,
    server_response: &[u8],
) -> Result<CompatibilityPair> {
    let client_bytes = fs::read(client_artifact_path).map_err(|error| {
        DeployError::Probe(format!(
            "cannot read client compatibility artifact {}: {error}",
            client_artifact_path.display()
        ))
    })?;
    let client_artifact: ClientCompatibilityArtifact = serde_json::from_slice(&client_bytes)
        .map_err(|error| {
            DeployError::Probe(format!("invalid client compatibility artifact: {error}"))
        })?;
    if client_artifact.schema_version != "1" {
        return Err(DeployError::Probe(
            "client compatibility artifact schemaVersion must be \"1\"".to_string(),
        ));
    }
    let client = parse_declaration(
        client_artifact.declaration.get(),
        Some(client_artifact.declaration_sha256.as_str()),
    )
    .map_err(|error| DeployError::Probe(format!("invalid client declaration: {error}")))?;

    let server_response: ServerCompatibilityResponse = serde_json::from_slice(server_response)
        .map_err(|error| {
            DeployError::Probe(format!("invalid server compatibility response: {error}"))
        })?;
    if server_response.schema_version != "1" || server_response.boot_id.is_empty() {
        return Err(DeployError::Probe(
            "server compatibility identity is incomplete".to_string(),
        ));
    }
    if let Some(id) = &server_response.server_process_generation_id {
        validate_generation_id(id)?;
    }
    let server = parse_declaration(
        server_response.server_declaration.get(),
        Some(server_response.server_declaration_sha256.as_str()),
    )
    .map_err(|error| DeployError::Probe(format!("invalid server declaration: {error}")))?;
    assert_mutually_compatible(&client, &server)
        .map_err(|error| DeployError::Probe(format!("incompatible client/server pair: {error}")))?;

    Ok(CompatibilityPair {
        client,
        server,
        server_process_generation_id: server_response.server_process_generation_id,
        boot_id: server_response.boot_id,
    })
}

/// Prove a client-only generation changes no server/runtime/dependency bytes
/// and retains every previously published hashed browser asset.
pub fn validate_client_only_entries(
    prior: &[ManifestEntry],
    target: &[ManifestEntry],
) -> Result<()> {
    let by_path = |entries: &[ManifestEntry]| {
        entries
            .iter()
            .cloned()
            .map(|entry| (entry.path.clone(), entry))
            .collect::<BTreeMap<_, _>>()
    };
    let prior = by_path(prior);
    let target = by_path(target);

    let prior_runtime = prior
        .iter()
        .filter(|(path, _)| !path.starts_with("client/"))
        .collect::<BTreeMap<_, _>>();
    let target_runtime = target
        .iter()
        .filter(|(path, _)| !path.starts_with("client/"))
        .collect::<BTreeMap<_, _>>();
    if prior_runtime != target_runtime {
        return Err(DeployError::Probe(
            "client-only target changed the server/runtime/dependency closure".to_string(),
        ));
    }

    for (path, expected) in prior
        .iter()
        .filter(|(path, _)| path.starts_with("client/assets/"))
    {
        if target.get(path.as_str()) != Some(expected) {
            return Err(DeployError::Probe(format!(
                "client-only target did not retain prior hashed asset {path}"
            )));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeCommand {
    pub program: PathBuf,
    pub arguments: Vec<OsString>,
    pub current_dir: PathBuf,
    pub environment: BTreeMap<OsString, OsString>,
    pub stdin: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeCommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeLaunch {
    pub executable: PathBuf,
    pub current_dir: PathBuf,
    pub environment: BTreeMap<OsString, OsString>,
}

pub trait ProbeBackend {
    type Child;

    fn run_command(
        &mut self,
        command: &ProbeCommand,
        timeout: Duration,
    ) -> Result<ProbeCommandOutput>;
    fn spawn_server(&mut self, launch: &ProbeLaunch) -> Result<Self::Child>;
    fn child_pid(&self, child: &Self::Child) -> u32;
    fn wait_ready(
        &mut self,
        child: &mut Self::Child,
        ready_file: &Path,
        timeout: Duration,
    ) -> Result<Vec<u8>>;
    fn inspect_process(&mut self, child: &Self::Child, port: DeployPort)
        -> Result<ProcessIdentity>;
    fn listener_is_loopback(&mut self, child: &Self::Child, port: DeployPort) -> Result<bool>;
    fn http_get(
        &mut self,
        address: SocketAddr,
        path: &str,
        auth_token: Option<&str>,
    ) -> Result<Vec<u8>>;
    fn terminate_reap(
        &mut self,
        child: &mut Self::Child,
        process: Option<&ProcessIdentity>,
        timeout: Duration,
    ) -> Result<()>;
}

#[derive(Clone)]
pub struct GenerationProbeRequest {
    pub generation_root: PathBuf,
    pub generation_id: String,
    pub isolated_home: PathBuf,
    pub ready_file: PathBuf,
    pub nonce: String,
    pub auth_token: String,
    pub runtime: RuntimeBindings,
    pub node: NodePrerequisite,
}

impl GenerationProbeRequest {
    fn resolve(&self, relative: &str) -> PathBuf {
        self.generation_root.join(relative)
    }

    fn server_executable(&self) -> PathBuf {
        self.resolve(&self.runtime.server_executable)
    }

    fn client_dir(&self) -> PathBuf {
        self.resolve(&self.runtime.client_dir)
    }

    fn extensions_dir(&self) -> PathBuf {
        self.resolve(&self.runtime.extensions_dir)
    }

    fn mcp_entry(&self) -> PathBuf {
        self.resolve(&self.runtime.mcp_entry)
    }

    fn sidecar_entry(&self) -> PathBuf {
        self.resolve(&self.runtime.claude_sidecar_entry)
    }

    fn package_json(&self) -> PathBuf {
        self.resolve(&self.runtime.package_json)
    }

    fn package_lock(&self) -> PathBuf {
        self.resolve(&self.runtime.package_lock)
    }

    fn production_node_modules(&self) -> PathBuf {
        self.resolve(&self.runtime.production_node_modules)
    }

    fn validate(&self) -> Result<()> {
        validate_generation_id(&self.generation_id)?;
        if !self.generation_root.is_absolute()
            || self
                .generation_root
                .file_name()
                .and_then(|name| name.to_str())
                != Some(self.generation_id.as_str())
            || !self.isolated_home.is_absolute()
            || !self.ready_file.is_absolute()
            || self.nonce.is_empty()
            || self.auth_token.is_empty()
            || !self.node.executable.is_absolute()
            || self.node.version.is_empty()
        {
            return Err(DeployError::Probe(
                "generation probe request is incomplete or not absolute".to_string(),
            ));
        }
        for relative in [
            &self.runtime.server_executable,
            &self.runtime.client_dir,
            &self.runtime.extensions_dir,
            &self.runtime.dist_server_dir,
            &self.runtime.mcp_entry,
            &self.runtime.claude_sidecar_entry,
            &self.runtime.package_json,
            &self.runtime.package_lock,
            &self.runtime.production_node_modules,
        ] {
            validate_relative_path(Path::new(relative), false)
                .map_err(|error| DeployError::Probe(error.to_string()))?;
        }
        if self.ready_file.exists() {
            return Err(DeployError::Probe(
                "probe ready path already exists; stale evidence is forbidden".to_string(),
            ));
        }
        for (label, path, directory) in [
            ("server executable", self.server_executable(), false),
            ("client", self.client_dir(), true),
            ("extensions", self.extensions_dir(), true),
            (
                "compiled server",
                self.resolve(&self.runtime.dist_server_dir),
                true,
            ),
            ("MCP entry", self.mcp_entry(), false),
            ("Claude sidecar", self.sidecar_entry(), false),
            ("package.json", self.package_json(), false),
            ("package-lock.json", self.package_lock(), false),
            (
                "production dependencies",
                self.production_node_modules(),
                true,
            ),
            ("Node executable", self.node.executable.clone(), false),
        ] {
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                DeployError::Probe(format!("missing {label} {}: {error}", path.display()))
            })?;
            if metadata.file_type().is_symlink()
                || (directory && !metadata.is_dir())
                || (!directory && !metadata.is_file())
            {
                return Err(DeployError::Probe(format!(
                    "{label} is not the expected real file/directory: {}",
                    path.display()
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationProbeResult {
    pub candidate: CandidateEvidence,
    pub compatibility: CompatibilityPair,
}

pub struct GenerationProbe<'a, Backend> {
    backend: &'a mut Backend,
    timeout: Duration,
}

impl<'a, Backend: ProbeBackend> GenerationProbe<'a, Backend> {
    pub fn new(backend: &'a mut Backend, timeout: Duration) -> Self {
        Self { backend, timeout }
    }

    pub fn verify(&mut self, request: &GenerationProbeRequest) -> Result<GenerationProbeResult> {
        request.validate()?;
        self.verify_node_and_imports(request)?;
        let launch = probe_launch(request)?;
        let mut child = self.backend.spawn_server(&launch)?;
        let child_pid = self.backend.child_pid(&child);
        let mut process = None;
        let validation = (|| {
            let ready_bytes =
                self.backend
                    .wait_ready(&mut child, &request.ready_file, self.timeout)?;
            let ready: DeploymentReadyReceipt =
                serde_json::from_slice(&ready_bytes).map_err(|error| {
                    DeployError::Probe(format!("invalid probe ready receipt: {error}"))
                })?;
            let address = ready.validate()?;
            if !address.ip().is_loopback() {
                return Err(DeployError::Probe(
                    "port-zero probe must publish an actual loopback listener".to_string(),
                ));
            }
            if ready.nonce != request.nonce
                || ready.server_process_generation_id != request.generation_id
                || ready.pid != child_pid
            {
                return Err(DeployError::Probe(
                    "probe ready receipt does not identify the spawned candidate".to_string(),
                ));
            }
            let port = DeployPort::new(address.port())?;
            let observed = self.backend.inspect_process(&child, port)?;
            if !self.backend.listener_is_loopback(&child, port)? {
                return Err(DeployError::Probe(
                    "port-zero probe actually bound a non-loopback listener".to_string(),
                ));
            }
            validate_probe_process(request, &ready, &observed)?;
            process = Some(observed.clone());

            let compatibility_bytes = self.backend.http_get(
                address,
                "/api/deployment-compatibility",
                Some(&request.auth_token),
            )?;
            let compatibility = validate_compatibility_artifacts(
                &request.client_dir().join("deployment-compatibility.json"),
                &compatibility_bytes,
            )?;
            if compatibility.server_process_generation_id.as_deref()
                != Some(request.generation_id.as_str())
                || compatibility.boot_id != ready.boot_id
                || compatibility.server.version != ready.server_component_version
            {
                return Err(DeployError::Probe(
                    "compatibility response does not match ready process identity".to_string(),
                ));
            }
            validate_health(
                &self.backend.http_get(address, "/api/health", None)?,
                &ready,
            )?;
            let served_client = self.backend.http_get(address, "/", None)?;
            let expected_client = fs::read(request.client_dir().join("index.html"))?;
            if served_client != expected_client {
                return Err(DeployError::Probe(
                    "probe server did not serve the exact staged client entry".to_string(),
                ));
            }
            let revalidated = self.backend.inspect_process(&child, port)?;
            if revalidated != observed {
                return Err(DeployError::Probe(
                    "probe process/listener identity changed during validation".to_string(),
                ));
            }
            Ok(GenerationProbeResult {
                candidate: CandidateEvidence {
                    ready,
                    process: observed,
                },
                compatibility,
            })
        })();
        let cleanup = self
            .backend
            .terminate_reap(&mut child, process.as_ref(), self.timeout);
        combine_probe_cleanup(validation, cleanup)
    }

    fn verify_node_and_imports(&mut self, request: &GenerationProbeRequest) -> Result<()> {
        let base_environment = BTreeMap::from([(
            OsString::from("HOME"),
            request.isolated_home.as_os_str().to_owned(),
        )]);
        let version = self.backend.run_command(
            &ProbeCommand {
                program: request.node.executable.clone(),
                arguments: vec![OsString::from("--version")],
                current_dir: request.generation_root.clone(),
                environment: BTreeMap::new(),
                stdin: Vec::new(),
            },
            self.timeout,
        )?;
        if std::str::from_utf8(&version.stdout).ok().map(str::trim)
            != Some(request.node.version.as_str())
        {
            return Err(DeployError::Probe(
                "Node executable/version prerequisite changed".to_string(),
            ));
        }

        self.backend.run_command(
            &ProbeCommand {
                program: request.node.executable.clone(),
                arguments: vec![request.sidecar_entry().into_os_string()],
                current_dir: request.generation_root.clone(),
                environment: base_environment.clone(),
                stdin: b"{\"type\":\"shutdown\"}\n".to_vec(),
            },
            self.timeout,
        )?;
        let script = "const {pathToFileURL}=await import('node:url');\
                      await import(pathToFileURL(process.argv[1]).href);process.exit(0)";
        self.backend.run_command(
            &ProbeCommand {
                program: request.node.executable.clone(),
                arguments: vec![
                    OsString::from("--input-type=module"),
                    OsString::from("--eval"),
                    OsString::from(script),
                    request.mcp_entry().into_os_string(),
                ],
                current_dir: request.generation_root.clone(),
                environment: base_environment,
                stdin: Vec::new(),
            },
            self.timeout,
        )?;
        Ok(())
    }
}

fn probe_launch(request: &GenerationProbeRequest) -> Result<ProbeLaunch> {
    let node_parent =
        request.node.executable.parent().ok_or_else(|| {
            DeployError::Probe("Node executable has no verified parent".to_string())
        })?;
    let environment = BTreeMap::from([
        (
            OsString::from("AUTH_TOKEN"),
            OsString::from(&request.auth_token),
        ),
        (
            OsString::from("FRESHELL_BIND_HOST"),
            OsString::from("127.0.0.1"),
        ),
        (
            OsString::from("FRESHELL_CLAUDE_NODE"),
            request.node.executable.as_os_str().to_owned(),
        ),
        (
            OsString::from("FRESHELL_CLAUDE_SIDECAR"),
            request.sidecar_entry().into_os_string(),
        ),
        (
            OsString::from("FRESHELL_CLIENT_DIR"),
            request.client_dir().into_os_string(),
        ),
        (
            OsString::from("FRESHELL_DEPLOY_GENERATION_ID"),
            OsString::from(&request.generation_id),
        ),
        (
            OsString::from("FRESHELL_DEPLOY_NONCE"),
            OsString::from(&request.nonce),
        ),
        (
            OsString::from("FRESHELL_DEPLOY_READY_FILE"),
            request.ready_file.as_os_str().to_owned(),
        ),
        (
            OsString::from("FRESHELL_EXTENSIONS_DIR"),
            request.extensions_dir().into_os_string(),
        ),
        (
            OsString::from("FRESHELL_HOME"),
            request.isolated_home.as_os_str().to_owned(),
        ),
        (
            OsString::from("FRESHELL_MCP_SERVER_ENTRY"),
            request.mcp_entry().into_os_string(),
        ),
        (
            OsString::from("HOME"),
            request.isolated_home.as_os_str().to_owned(),
        ),
        (OsString::from("NODE_ENV"), OsString::from("production")),
        (OsString::from("PATH"), node_parent.as_os_str().to_owned()),
        (OsString::from("PORT"), OsString::from("0")),
    ]);
    Ok(ProbeLaunch {
        executable: request.server_executable(),
        current_dir: request.generation_root.clone(),
        environment,
    })
}

fn validate_probe_process(
    request: &GenerationProbeRequest,
    ready: &DeploymentReadyReceipt,
    process: &ProcessIdentity,
) -> Result<()> {
    let candidate = CandidateEvidence {
        ready: ready.clone(),
        process: process.clone(),
    };
    candidate.validate()?;
    let executable = FileIdentity::from_path(&request.server_executable())?;
    if process.executable != executable
        || Path::new(&process.cwd) != request.generation_root
        || process.runtime.client_dir != request.client_dir().display().to_string()
        || process.runtime.extensions_dir != request.extensions_dir().display().to_string()
        || process.runtime.dist_server_dir
            != request
                .resolve(&request.runtime.dist_server_dir)
                .display()
                .to_string()
        || process.runtime.mcp_entry != request.mcp_entry().display().to_string()
        || process.runtime.claude_sidecar_entry != request.sidecar_entry().display().to_string()
        || process.runtime.node_executable != request.node.executable.display().to_string()
        || process.runtime.package_json != request.package_json().display().to_string()
        || process.runtime.package_lock != request.package_lock().display().to_string()
        || process.runtime.production_node_modules
            != request.production_node_modules().display().to_string()
    {
        return Err(DeployError::Probe(
            "probe process escaped or changed the immutable runtime closure".to_string(),
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HealthResponse {
    app: String,
    ok: bool,
    requires_auth: bool,
    version: String,
    ready: bool,
    instance_id: String,
    started_at: String,
}

fn validate_health(bytes: &[u8], ready: &DeploymentReadyReceipt) -> Result<()> {
    let health: HealthResponse = serde_json::from_slice(bytes)
        .map_err(|error| DeployError::Probe(format!("invalid health response: {error}")))?;
    if health.app != "freshell"
        || !health.ok
        || !health.requires_auth
        || !health.ready
        || health.version.is_empty()
        || health.instance_id != ready.instance_id
        || health.started_at.is_empty()
    {
        return Err(DeployError::Probe(
            "health response does not identify the ready candidate".to_string(),
        ));
    }
    Ok(())
}

fn combine_probe_cleanup<T>(validation: Result<T>, cleanup: Result<()>) -> Result<T> {
    match (validation, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(validation), Err(cleanup)) => Err(DeployError::Probe(format!(
            "probe failed: {validation}; cleanup also failed: {cleanup}"
        ))),
    }
}

pub struct RealProbeChild {
    child: std::process::Child,
    pidfd: LinuxPidFd,
}

#[derive(Debug, Clone, Default)]
pub struct RealProbeBackend {
    procfs: LinuxProcfs,
}

impl ProbeBackend for RealProbeBackend {
    type Child = RealProbeChild;

    fn run_command(
        &mut self,
        command: &ProbeCommand,
        timeout: Duration,
    ) -> Result<ProbeCommandOutput> {
        let mut child = Command::new(&command.program)
            .args(&command.arguments)
            .current_dir(&command.current_dir)
            .env_clear()
            .envs(&command.environment)
            .stdin(if command.stdin.is_empty() {
                Stdio::null()
            } else {
                Stdio::piped()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| DeployError::Probe(format!("cannot run probe command: {error}")))?;
        let pidfd = match self.procfs.open_pidfd(child.id()) {
            Ok(pidfd) => pidfd,
            Err(error) => {
                let cleanup = terminate_unpinned_owned_child(&mut child);
                return combine_probe_cleanup(
                    Err(DeployError::Probe(format!(
                        "cannot pin spawned probe command: {error}"
                    ))),
                    cleanup,
                );
            }
        };
        let backend = LinuxPidfdBackend::new(self.procfs.clone());
        if !command.stdin.is_empty() {
            let write = child
                .stdin
                .as_mut()
                .ok_or_else(|| DeployError::Probe("probe command stdin unavailable".to_string()))?
                .write_all(&command.stdin);
            if let Err(error) = write {
                let cleanup =
                    kill_reap_owned_child(&mut child, &backend, &pidfd, Duration::from_secs(2));
                return combine_probe_cleanup(Err(error.into()), cleanup);
            }
            drop(child.stdin.take());
        }
        let deadline = Instant::now() + timeout;
        loop {
            let status = match child.try_wait() {
                Ok(status) => status,
                Err(error) => {
                    let cleanup =
                        kill_reap_owned_child(&mut child, &backend, &pidfd, Duration::from_secs(2));
                    return combine_probe_cleanup(Err(error.into()), cleanup);
                }
            };
            if let Some(status) = status {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                if let Some(pipe) = child.stdout.as_mut() {
                    pipe.read_to_end(&mut stdout)?;
                }
                if let Some(pipe) = child.stderr.as_mut() {
                    pipe.read_to_end(&mut stderr)?;
                }
                if !status.success() {
                    return Err(DeployError::Probe(format!(
                        "probe command failed with {status}: {}",
                        String::from_utf8_lossy(&stderr)
                    )));
                }
                return Ok(ProbeCommandOutput { stdout, stderr });
            }
            if Instant::now() >= deadline {
                let cleanup =
                    kill_reap_owned_child(&mut child, &backend, &pidfd, Duration::from_secs(2));
                return combine_probe_cleanup(
                    Err(DeployError::Probe("probe command timed out".to_string())),
                    cleanup,
                );
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn spawn_server(&mut self, launch: &ProbeLaunch) -> Result<Self::Child> {
        let mut child = Command::new(&launch.executable)
            .current_dir(&launch.current_dir)
            .env_clear()
            .envs(&launch.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| DeployError::Probe(format!("cannot spawn probe server: {error}")))?;
        let pidfd = match self.procfs.open_pidfd(child.id()) {
            Ok(pidfd) => pidfd,
            Err(error) => {
                let cleanup = terminate_unpinned_owned_child(&mut child);
                return combine_probe_cleanup(
                    Err(DeployError::Probe(format!(
                        "cannot pin spawned probe server: {error}"
                    ))),
                    cleanup,
                );
            }
        };
        Ok(RealProbeChild { child, pidfd })
    }

    fn child_pid(&self, child: &Self::Child) -> u32 {
        child.child.id()
    }

    fn wait_ready(
        &mut self,
        child: &mut Self::Child,
        ready_file: &Path,
        timeout: Duration,
    ) -> Result<Vec<u8>> {
        let deadline = Instant::now() + timeout;
        loop {
            match fs::read(ready_file) {
                Ok(bytes) => return Ok(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            if let Some(status) = child.child.try_wait()? {
                return Err(DeployError::Probe(format!(
                    "probe server exited before readiness: {status}"
                )));
            }
            if Instant::now() >= deadline {
                return Err(DeployError::Probe(
                    "probe server did not publish readiness before timeout".to_string(),
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn inspect_process(
        &mut self,
        child: &Self::Child,
        port: DeployPort,
    ) -> Result<ProcessIdentity> {
        let listener = self.procfs.resolve_listener(port)?;
        if listener.owner_pid != child.child.id() {
            return Err(DeployError::Probe(
                "probe listener is not owned by the retained child pidfd".to_string(),
            ));
        }
        let identity = self.procfs.snapshot(&child.pidfd, &listener)?;
        if identity.pid != child.child.id() || identity.listener != listener {
            return Err(DeployError::Probe(
                "retained probe pidfd snapshot does not own the listener".to_string(),
            ));
        }
        let revalidated_listener = self.procfs.resolve_listener(port)?;
        if revalidated_listener != listener {
            return Err(DeployError::Probe(
                "probe listener ownership changed during retained-pidfd inspection".to_string(),
            ));
        }
        Ok(identity)
    }

    fn listener_is_loopback(&mut self, child: &Self::Child, port: DeployPort) -> Result<bool> {
        let listener = self.procfs.resolve_listener(port)?;
        if listener.owner_pid != child.child.id() {
            return Err(DeployError::Probe(
                "probe listener owner changed before address validation".to_string(),
            ));
        }
        self.procfs
            .listener_is_loopback(port, &listener.socket_inode)
    }

    fn http_get(
        &mut self,
        address: SocketAddr,
        path: &str,
        auth_token: Option<&str>,
    ) -> Result<Vec<u8>> {
        let mut stream = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(2))
            .map_err(|error| DeployError::Probe(format!("probe HTTP connect failed: {error}")))?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        let auth = auth_token
            .map(|token| format!("x-auth-token: {token}\r\n"))
            .unwrap_or_default();
        stream.write_all(
            format!("GET {path} HTTP/1.1\r\nHost: {address}\r\n{auth}Connection: close\r\n\r\n")
                .as_bytes(),
        )?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response)?;
        parse_http_ok(&response)
    }

    fn terminate_reap(
        &mut self,
        child: &mut Self::Child,
        _process: Option<&ProcessIdentity>,
        timeout: Duration,
    ) -> Result<()> {
        let backend = LinuxPidfdBackend::new(self.procfs.clone());
        terminate_reap_owned_child(
            &mut child.child,
            &backend,
            &child.pidfd,
            StopPolicy::new(timeout, Duration::from_secs(2)),
        )
    }
}

fn terminate_unpinned_owned_child(child: &mut std::process::Child) -> Result<()> {
    let mut failures = Vec::new();
    let already_exited = match child.try_wait() {
        Ok(Some(_)) => true,
        Ok(None) => {
            // No pidfd could be opened, so this exact newly spawned Child
            // handle is the only cleanup authority available. This path never
            // applies to a discovered live deployment process.
            if let Err(error) = child.kill() {
                failures.push(format!("owned-child kill failed: {error}"));
            }
            false
        }
        Err(error) => {
            failures.push(format!("owned-child status check failed: {error}"));
            if let Err(kill_error) = child.kill() {
                failures.push(format!("owned-child kill also failed: {kill_error}"));
            }
            false
        }
    };
    if !already_exited {
        bounded_reap_owned_child(child, Duration::from_secs(2), &mut failures);
    }
    finish_owned_cleanup(failures)
}

fn kill_reap_owned_child(
    child: &mut std::process::Child,
    backend: &LinuxPidfdBackend,
    pidfd: &LinuxPidFd,
    timeout: Duration,
) -> Result<()> {
    let mut failures = Vec::new();
    let already_exited = match child.try_wait() {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(error) => {
            failures.push(format!("owned-child status check failed: {error}"));
            false
        }
    };
    if !already_exited {
        if let Err(error) = backend.signal_pidfd(pidfd, Signal::Kill) {
            failures.push(format!("pidfd SIGKILL failed: {error}"));
        }
        match backend.wait_exited(pidfd, timeout) {
            Ok(true) => {}
            Ok(false) => failures
                .push("owned probe child remained alive after pidfd-bound SIGKILL".to_string()),
            Err(error) => failures.push(format!("pidfd SIGKILL wait failed: {error}")),
        }
    }
    if !already_exited {
        bounded_reap_owned_child(child, timeout, &mut failures);
    }
    finish_owned_cleanup(failures)
}

fn terminate_reap_owned_child(
    child: &mut std::process::Child,
    backend: &LinuxPidfdBackend,
    pidfd: &LinuxPidFd,
    policy: StopPolicy,
) -> Result<()> {
    let mut failures = Vec::new();
    let already_exited = match child.try_wait() {
        Ok(Some(_)) => true,
        Ok(None) => false,
        Err(error) => {
            failures.push(format!("owned-child status check failed: {error}"));
            false
        }
    };
    if !already_exited {
        let term_sent = match backend.signal_pidfd(pidfd, Signal::Term) {
            Ok(()) => true,
            Err(error) => {
                failures.push(format!("pidfd SIGTERM failed: {error}"));
                false
            }
        };
        let term_exited = if term_sent {
            match backend.wait_exited(pidfd, policy.term_timeout) {
                Ok(exited) => exited,
                Err(error) => {
                    failures.push(format!("pidfd SIGTERM wait failed: {error}"));
                    false
                }
            }
        } else {
            false
        };
        if !term_exited {
            if let Err(error) = backend.signal_pidfd(pidfd, Signal::Kill) {
                failures.push(format!("pidfd SIGKILL failed: {error}"));
            }
            match backend.wait_exited(pidfd, policy.kill_timeout) {
                Ok(true) => {}
                Ok(false) => failures
                    .push("owned probe child remained alive after pidfd-bound SIGKILL".to_string()),
                Err(error) => failures.push(format!("pidfd SIGKILL wait failed: {error}")),
            }
        }
    }
    if !already_exited {
        bounded_reap_owned_child(child, policy.kill_timeout, &mut failures);
    }
    finish_owned_cleanup(failures)
}

fn bounded_reap_owned_child(
    child: &mut std::process::Child,
    timeout: Duration,
    failures: &mut Vec<String>,
) {
    let Some(deadline) = Instant::now().checked_add(timeout) else {
        failures.push("owned-child reap timeout overflowed".to_string());
        return;
    };
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                failures.push("owned probe child was not reaped before timeout".to_string());
                return;
            }
            Err(error) => {
                failures.push(format!("owned-child reap failed: {error}"));
                return;
            }
        }
    }
}

fn finish_owned_cleanup(failures: Vec<String>) -> Result<()> {
    if failures.is_empty() {
        Ok(())
    } else {
        Err(DeployError::Probe(format!(
            "owned probe cleanup failed: {}",
            failures.join("; ")
        )))
    }
}

fn parse_http_ok(response: &[u8]) -> Result<Vec<u8>> {
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| DeployError::Probe("probe HTTP response is malformed".to_string()))?;
    let headers = std::str::from_utf8(&response[..split])
        .map_err(|_| DeployError::Probe("probe HTTP headers are not UTF-8".to_string()))?;
    if !headers.starts_with("HTTP/1.1 200 ") && !headers.starts_with("HTTP/1.0 200 ") {
        return Err(DeployError::Probe(format!(
            "probe HTTP request did not return 200: {}",
            headers.lines().next().unwrap_or("missing status")
        )));
    }
    Ok(response[split + 4..].to_vec())
}
