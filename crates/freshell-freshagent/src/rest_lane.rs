//! Typed REST/MCP ingress shared by local and hosted fresh-agent runtimes.
//! Hosted implementations live in `freshell-server`; this crate deliberately
//! knows nothing about supervisor IPC.

use async_trait::async_trait;
use serde_json::Value;

pub type RestCreateSettingsReader = std::sync::Arc<
    dyn Fn() -> futures_util::future::BoxFuture<'static, freshell_protocol::SettingsFreshAgent>
        + Send
        + Sync,
>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestLaneErrorKind {
    BadRequest,
    Forbidden,
    NotFound,
    Conflict,
    Unavailable,
    Internal,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestLaneError {
    pub kind: RestLaneErrorKind,
    pub code: String,
    pub message: String,
    pub retryable: Option<bool>,
    pub retry_after_ms: Option<u64>,
    pub owner: Option<crate::ownership_lane::TerminalOwnerFields>,
}

impl RestLaneError {
    pub fn new(
        kind: RestLaneErrorKind,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            code: code.into(),
            message: message.into(),
            retryable: None,
            retry_after_ms: None,
            owner: None,
        }
    }
}

impl From<()> for RestLaneError {
    fn from(_: ()) -> Self {
        Self::new(
            RestLaneErrorKind::Unavailable,
            "FRESH_AGENT_UNAVAILABLE",
            "durable fresh-agent operation is temporarily unavailable",
        )
    }
}

#[derive(Default)]
pub struct RestLaneProviderInputs {
    pub plugins: Option<Vec<String>>,
    pub model_selection: Option<Option<freshell_protocol::ModelSelection>>,
    pub permission_mode: Option<String>,
    pub sandbox: Option<freshell_protocol::Sandbox>,
}

pub fn provider_inputs(body: &Value) -> Result<RestLaneProviderInputs, String> {
    let plugins = body
        .get("plugins")
        .map(|value| {
            serde_json::from_value(value.clone()).map_err(|_| "invalid plugins".to_string())
        })
        .transpose()?;
    let model_selection = body
        .get("modelSelection")
        .map(|value| {
            serde_json::from_value(value.clone()).map_err(|_| "invalid modelSelection".to_string())
        })
        .transpose()?;
    let permission_mode = body
        .get("permissionMode")
        .map(|value| {
            serde_json::from_value(value.clone()).map_err(|_| "invalid permissionMode".to_string())
        })
        .transpose()?;
    let sandbox = body
        .get("sandbox")
        .map(|value| {
            serde_json::from_value(value.clone()).map_err(|_| "invalid sandbox".to_string())
        })
        .transpose()?;
    Ok(RestLaneProviderInputs {
        plugins,
        model_selection,
        permission_mode,
        sandbox,
    })
}

pub(crate) fn observed_fence(body: &Value) -> Result<(Option<u64>, Option<u64>), RestLaneError> {
    let read = |field: &str| match body.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or_else(|| {
            RestLaneError::new(
                RestLaneErrorKind::BadRequest,
                "INVALID_FENCE",
                format!("{field} must be an unsigned integer"),
            )
        }),
    };
    let epoch = read("observedEpoch")?;
    let generation = read("observedGeneration")?;
    crate::ownership_lane::wire_fence(epoch, generation).map_err(|error| {
        RestLaneError::new(RestLaneErrorKind::BadRequest, error.code(), error.message())
    })?;
    Ok((epoch, generation))
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RestLaneCreate {
    pub request_id: String,
    pub provider: String,
    pub session_type: String,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub native_session_id: Option<String>,
    pub plugins: Option<Vec<String>>,
    pub model_selection: Option<Option<freshell_protocol::ModelSelection>>,
    pub permission_mode: Option<String>,
    pub sandbox: Option<freshell_protocol::Sandbox>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
    pub naming_handle: Option<String>,
    pub model_effort_levels: Option<Vec<String>>,
    pub observed_epoch: Option<u64>,
    pub observed_generation: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct RestLaneCreated {
    /// Stable presentation identity used by the web layout and gateway alias
    /// table. It is not substituted for the provider's native identity.
    pub session_id: String,
    pub session_ref: Option<freshell_protocol::SessionLocator>,
    /// Provider-owned identity of a runtime newly started by this create.
    /// An adopted existing writer has no cleanup token.
    pub cleanup_token: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestLaneSend {
    pub request_id: String,
    pub session_id: String,
    pub provider: String,
    pub session_type: String,
    pub text: String,
    pub timeout_ms: u64,
    pub observed_epoch: Option<u64>,
    pub observed_generation: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RestLaneSendResult {
    pub session_id: String,
    pub completed: bool,
    pub submitted_turn_id: Option<String>,
    pub noop: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestLaneCapture {
    pub session_id: String,
    pub provider: String,
    pub session_type: String,
    pub max_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestLaneCaptureResult {
    pub session_id: String,
    pub native_session_id: String,
    pub text: String,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestLaneCaptureError {
    Unsupported,
    Unavailable,
    NotFound,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestLaneSnapshot {
    pub session_id: String,
    pub provider: String,
    pub session_type: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestLaneChildRead {
    pub parent_session_id: String,
    pub child_thread_id: String,
    pub observed_epoch: Option<u64>,
    pub observed_generation: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestLaneSnapshotError {
    OwnershipUnavailable,
    ManagedUnavailable,
}

#[async_trait]
pub trait FreshAgentRestLane: Send + Sync {
    async fn read_child(
        &self,
        _request: RestLaneChildRead,
    ) -> Result<Option<Value>, crate::codex::children::ChildReadError> {
        Err(crate::codex::children::ChildReadError::SourceUnavailable)
    }
    /// None leaves genuinely unmanaged threads on their existing read path.
    /// A hosted read failure must never fall back to saved history as live truth.
    async fn snapshot(
        &self,
        _request: RestLaneSnapshot,
    ) -> Result<Option<Value>, RestLaneSnapshotError> {
        Err(RestLaneSnapshotError::OwnershipUnavailable)
    }
    async fn create_agent(
        self: std::sync::Arc<Self>,
        request: RestLaneCreate,
    ) -> Result<RestLaneCreated, RestLaneError>;

    async fn abandon_create(
        &self,
        _request: &RestLaneCreate,
        created: &RestLaneCreated,
    ) -> Result<(), RestLaneError> {
        if created.cleanup_token.is_none() {
            return Ok(());
        }
        Err(RestLaneError::new(
            RestLaneErrorKind::Unavailable,
            "CREATE_CLEANUP_UNAVAILABLE",
            "the provider could not clean up the abandoned create",
        ))
    }

    async fn send_agent(&self, request: RestLaneSend) -> Result<RestLaneSendResult, RestLaneError>;

    async fn capture(
        &self,
        _request: RestLaneCapture,
    ) -> Result<RestLaneCaptureResult, RestLaneCaptureError> {
        Err(RestLaneCaptureError::Unsupported)
    }
}

pub type SharedFreshAgentRestLane = std::sync::Arc<dyn FreshAgentRestLane>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_rest_provider_inputs_preserve_explicit_model_clear_and_plugins() {
        let body = serde_json::json!({
            "plugins": ["/workspace/plugin"],
            "modelSelection": null,
            "permissionMode": "default",
            "sandbox": "workspace-write"
        });
        let inputs = provider_inputs(&body).unwrap();
        assert_eq!(inputs.plugins, Some(vec!["/workspace/plugin".into()]));
        assert_eq!(inputs.model_selection, Some(None));
        assert_eq!(inputs.permission_mode.as_deref(), Some("default"));
        assert_eq!(
            inputs.sandbox,
            Some(freshell_protocol::Sandbox::WorkspaceWrite)
        );
        assert!(provider_inputs(&serde_json::json!({"plugins": "wrong"})).is_err());
    }
}
