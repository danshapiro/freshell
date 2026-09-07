//! Versioned control protocol and durable identity types for managed Freshell runtimes.
//!
//! This crate deliberately contains no process-management APIs. Runtime termination
//! authority lives in `freshell-supervisor` and is represented there by a private-
//! constructor ownership capability.

use hmac::{Hmac, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::Sha256;
use std::fmt;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const CONTROL_PROTOCOL_VERSION: u32 = 1;
pub const MAX_CONTROL_FRAME_BYTES: usize = 1024 * 1024;

type HmacSha256 = Hmac<Sha256>;

macro_rules! string_id {
    ($name:ident, $prefix:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new() -> Self {
                Self(format!("{}{}", $prefix, uuid::Uuid::new_v4()))
            }

            pub fn parse(value: impl Into<String>) -> Result<Self, IdentityError> {
                let value = value.into();
                if value.is_empty()
                    || value.len() > 160
                    || value.bytes().any(|b| b.is_ascii_control())
                {
                    return Err(IdentityError::Invalid(stringify!($name)));
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

string_id!(InstallationId, "installation-");
string_id!(SoulId, "soul-");
string_id!(IncarnationId, "incarnation-");
string_id!(RequestId, "request-");
string_id!(LaunchNonce, "launch-");
string_id!(HostBootId, "hostboot-");
string_id!(GrantId, "grant-");
string_id!(RuntimeContainerId, "container-");
string_id!(DockerDaemonId, "daemon-");
string_id!(RecoveryAttemptId, "recovery-");

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum IdentityError {
    #[error("invalid {0}")]
    Invalid(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionRef {
    pub provider: String,
    pub provider_store_id: String,
    pub native_session_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesiredState {
    Running,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryState {
    Live,
    Recovering,
    Blocked,
    Lost,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DurabilityState {
    Unknown,
    LiveOnly,
    ResumeCaptured,
    CheckpointCaptured,
    IntrinsicallyNonResumable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchState {
    Prepared,
    Created,
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

impl LaunchState {
    pub fn is_potentially_active(self) -> bool {
        matches!(
            self,
            Self::Prepared | Self::Created | Self::Starting | Self::Running | Self::Stopping
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupState {
    None,
    Requested,
    TerminationUnconfirmed,
    VerifiedEmpty,
    BlockedOwnership,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopOutcome {
    VerifiedEmpty,
    BlockedOwnership,
    BackendUnavailable,
    TerminationUnconfirmed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuntimeErrorCode {
    InvalidRequest,
    ProtocolVersionMismatch,
    UnauthorizedRole,
    FrameTooLarge,
    RequestIdConflict,
    RegistryBusy,
    RegistryFailure,
    StaleControlEpoch,
    UnknownSoul,
    UnknownIncarnation,
    OwnershipMismatch,
    BackendUnavailable,
    TerminationUnconfirmed,
    HostUnreachable,
    HostAuthenticationFailed,
    StaleExecutionGrant,
    InvalidRuntimeLimits,
    FaultInjected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLimits {
    pub cpu_milli: u64,
    pub memory_bytes: u64,
    /// Additional swap beyond `memory_bytes`. Zero means no swap allowance.
    pub swap_bytes: u64,
    pub pids_max: u64,
}

impl RuntimeLimits {
    pub fn validate(self) -> Result<Self, RuntimeError> {
        if self.cpu_milli == 0
            || self.memory_bytes < 16 * 1024 * 1024
            || self.pids_max == 0
            || self.cpu_milli > 1_000_000
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvalidRuntimeLimits,
                "runtime limits are outside the supported range",
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeError {
    pub code: RuntimeErrorCode,
    pub message: String,
}

impl RuntimeError {
    pub fn new(code: RuntimeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlRole {
    Web,
    Supervisor,
    Runtime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope<T> {
    pub protocol_version: u32,
    pub request_id: RequestId,
    pub role: ControlRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    pub body: T,
}

impl<T> Envelope<T> {
    pub fn new(request_id: RequestId, role: ControlRole, body: T) -> Self {
        Self {
            protocol_version: CONTROL_PROTOCOL_VERSION,
            request_id,
            role,
            auth: None,
            body,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub soul_id: SoulId,
    pub provider: String,
    pub provider_store_id: String,
    pub creation_seed_ref: String,
    pub limits: RuntimeLimits,
    pub fixture: FixtureKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixtureKind {
    Heartbeat,
    DescendantSpawner,
    CpuBurner,
    MemoryAllocator,
    NativeSession,
    SecurityProbe,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRequest {
    pub soul_id: SoulId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum AdminCommand {
    Health,
    Launch(LaunchRequest),
    Stop(StopRequest),
    Inventory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeView {
    pub soul_id: SoulId,
    pub incarnation_id: IncarnationId,
    pub launch_state: LaunchState,
    pub cleanup_state: CleanupState,
    pub intent_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub container_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_boot_id: Option<HostBootId>,
    pub execution_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_limits: Option<RuntimeLimits>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub view: RuntimeView,
    pub worker_pid: u32,
    pub worker_launch_count: u64,
    pub host_boot_id: HostBootId,
    pub effective_limits: RuntimeLimits,
    #[serde(default)]
    pub fixture_evidence: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum AdminResult {
    Health {
        control_epoch: u64,
        installation_id: InstallationId,
    },
    Launch(LaunchResult),
    Stop {
        outcome: StopOutcome,
        view: RuntimeView,
    },
    Inventory(Vec<RuntimeView>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminReply {
    pub request_id: RequestId,
    pub result: Result<AdminResult, RuntimeError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum HostCommand {
    Hello {
        incarnation_id: IncarnationId,
        challenge: String,
    },
    GrantExecution {
        incarnation_id: IncarnationId,
        soul_id: SoulId,
        host_boot_id: HostBootId,
        control_epoch: u64,
        execution_generation: u64,
        grant_id: GrantId,
        fixture: FixtureKind,
    },
    Stop {
        incarnation_id: IncarnationId,
        control_epoch: u64,
        execution_generation: u64,
    },
    SecurityProbe {
        incarnation_id: IncarnationId,
    },
    Status {
        incarnation_id: IncarnationId,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum HostResult {
    Hello {
        host_boot_id: HostBootId,
        proof: String,
        capabilities: Vec<String>,
        effective_limits: RuntimeLimits,
    },
    GrantAccepted {
        host_boot_id: HostBootId,
        worker_pid: u32,
        worker_launch_count: u64,
        fixture_evidence: serde_json::Value,
    },
    Stopped,
    SecurityProbe(serde_json::Value),
    Status {
        host_boot_id: HostBootId,
        worker_pid: Option<u32>,
        worker_launch_count: u64,
        max_control_epoch: u64,
        max_execution_generation: u64,
        #[serde(default)]
        fixture_evidence: serde_json::Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostReply {
    pub request_id: RequestId,
    pub result: Result<HostResult, RuntimeError>,
}

pub fn host_proof(
    secret: &[u8],
    challenge: &str,
    host_boot_id: &HostBootId,
    incarnation_id: &IncarnationId,
) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts arbitrary key length");
    mac.update(challenge.as_bytes());
    mac.update(b"\0");
    mac.update(host_boot_id.as_str().as_bytes());
    mac.update(b"\0");
    mac.update(incarnation_id.as_str().as_bytes());
    hex_lower(&mac.finalize().into_bytes())
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0xf) as usize] as char);
    }
    out
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("control frame exceeds {MAX_CONTROL_FRAME_BYTES} bytes")]
    TooLarge,
    #[error("control frame I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("control frame JSON failed: {0}")]
    Json(#[from] serde_json::Error),
}

pub async fn write_frame<W, T>(writer: &mut W, value: &T) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_CONTROL_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await?;
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

pub async fn read_frame<R, T>(reader: &mut R) -> Result<T, FrameError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len = [0u8; 4];
    reader.read_exact(&mut len).await?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_CONTROL_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    let mut bytes = vec![0; len];
    reader.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_reject_control_characters_and_are_distinct() {
        assert!(SoulId::parse("bad\nvalue").is_err());
        assert_ne!(SoulId::new(), SoulId::new());
    }

    #[test]
    fn hmac_proof_is_scoped_to_boot_and_incarnation() {
        let incarnation = IncarnationId::new();
        let boot = HostBootId::new();
        let one = host_proof(b"secret", "challenge", &boot, &incarnation);
        let two = host_proof(b"secret", "challenge", &HostBootId::new(), &incarnation);
        assert_ne!(one, two);
    }

    #[tokio::test]
    async fn frame_rejects_oversized_payload_before_allocation() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&((MAX_CONTROL_FRAME_BYTES as u32) + 1).to_be_bytes());
        let mut cursor = std::io::Cursor::new(bytes);
        let result: Result<serde_json::Value, _> = read_frame(&mut cursor).await;
        assert!(matches!(result, Err(FrameError::TooLarge)));
    }

    #[tokio::test]
    async fn frame_round_trips() {
        let envelope = Envelope::new(RequestId::new(), ControlRole::Web, AdminCommand::Health);
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &envelope).await.unwrap();
        let mut cursor = std::io::Cursor::new(bytes);
        let restored: Envelope<AdminCommand> = read_frame(&mut cursor).await.unwrap();
        assert_eq!(restored.protocol_version, CONTROL_PROTOCOL_VERSION);
        assert!(matches!(restored.body, AdminCommand::Health));
    }
}
