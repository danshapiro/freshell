use crate::registry::OwnedRuntimeHandle;
use async_trait::async_trait;
use freshell_runtime_protocol::{
    DockerDaemonId, IncarnationId, InstallationId, RuntimeLimits, SoulId,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
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
        let body = json!({
            "Image": spec.image_ref,
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
                "NetworkMode": "none",
                "PidMode": "",
                "ReadonlyRootfs": true,
                "Privileged": false,
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"],
                "RestartPolicy": {"Name":"no","MaximumRetryCount":0},
                "NanoCpus": spec.limits.cpu_milli.saturating_mul(1_000_000),
                "Memory": spec.limits.memory_bytes,
                "MemorySwap": memory_swap,
                "PidsLimit": spec.limits.pids_max,
                "Binds": [
                    format!("{}:/runtime/freshell-session-host:ro", binary.display()),
                    format!("{}:/run/freshell:rw", runtime_dir.display())
                ],
                "Tmpfs": {"/tmp":"rw,noexec,nosuid,nodev,size=64m"}
            }
        });
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExpectedConfig {
    image_ref: String,
    installation_id: String,
    soul_id: String,
    incarnation_id: String,
    host_binary_path: String,
    runtime_dir: String,
    limits: RuntimeLimits,
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
    })
}

fn digest_expected(expected: &ExpectedConfig) -> Result<String, BackendError> {
    let bytes = serde_json::to_vec(expected).map_err(|e| BackendError::Malformed(e.to_string()))?;
    let digest = Sha256::digest(bytes);
    Ok(format!("sha256:{digest:x}"))
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
    let host_config = value
        .get("HostConfig")
        .ok_or_else(|| BackendError::OwnershipMismatch("missing HostConfig".into()))?;
    if host_config.get("NetworkMode").and_then(Value::as_str) != Some("none") {
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
    fn parses_chunked_response() {
        let response = parse_http_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ntest\r\n0\r\n\r\n",
        )
        .unwrap();
        assert_eq!(response.body, b"test");
    }
}
