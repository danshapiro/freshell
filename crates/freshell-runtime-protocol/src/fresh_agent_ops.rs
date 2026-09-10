//! Host-owned fresh-agent operation contracts.

use crate::{FreshProvider, SoulId};
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
