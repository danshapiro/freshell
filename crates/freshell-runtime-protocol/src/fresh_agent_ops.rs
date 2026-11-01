//! Host-owned fresh-agent operation contracts.

use crate::{FreshAgentTurnSettings, FreshProvider, HostBootId, IncarnationId, SoulId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentCompactRequest {
    pub soul_id: SoulId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

/// Apply settings to a hosted fresh agent's live session without a turn.
/// Absent settings keep their stored values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentConfigureRequest {
    pub soul_id: SoulId,
    pub settings: FreshAgentTurnSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FreshAgentRollbackDirection {
    Undo,
    Redo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FreshAgentRollbackMode {
    Step,
    ToTurn,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentRollbackRequest {
    pub soul_id: SoulId,
    pub direction: FreshAgentRollbackDirection,
    pub mode: FreshAgentRollbackMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentCaptureRequest {
    pub soul_id: SoulId,
    pub max_bytes: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentCapture {
    pub provider: FreshProvider,
    pub session_type: String,
    pub presentation_session_id: String,
    pub native_session_id: String,
    pub text: String,
    pub truncated: bool,
}

/// Metadata authority captured from the current managed runtime. A name
/// request cannot follow a replacement incarnation merely because its root
/// has the same spelling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentNativeNameSource {
    pub incarnation_id: IncarnationId,
    pub host_boot_id: HostBootId,
    pub execution_generation: u64,
    pub intent_revision: u64,
    pub native_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum FreshAgentNativeNameOperation {
    Probe,
    Read,
    Write { title: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FreshAgentNativeNameError {
    Unavailable { message: String },
    Rpc { code: i64, message: String },
    Timeout { timeout_ms: u64 },
    Closed,
    Transport { message: String },
    InvalidResponse { detail: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum FreshAgentNativeNameReply {
    Available,
    Title(Option<String>),
    Renamed,
    Failed(FreshAgentNativeNameError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentNativeNameRequest {
    pub soul_id: SoulId,
    pub source: FreshAgentNativeNameSource,
    pub codex_home: String,
    pub operation: FreshAgentNativeNameOperation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_control_epoch: Option<u64>,
}
