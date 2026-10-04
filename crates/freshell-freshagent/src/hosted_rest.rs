//! Typed seam for routing the REST/MCP fresh-agent ingress to the durable
//! session-host owner. The implementation lives in `freshell-server`; this
//! crate deliberately knows nothing about supervisor IPC.

use async_trait::async_trait;
use serde_json::Value;

#[derive(Default)]
pub struct HostedRestProviderInputs {
    pub plugins: Option<Vec<String>>,
    pub model_selection: Option<Option<freshell_protocol::ModelSelection>>,
    pub permission_mode: Option<String>,
    pub sandbox: Option<freshell_protocol::Sandbox>,
}

pub fn provider_inputs(body: &Value) -> Result<HostedRestProviderInputs, String> {
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
    Ok(HostedRestProviderInputs {
        plugins,
        model_selection,
        permission_mode,
        sandbox,
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct HostedRestCreate {
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
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedRestCreated {
    /// Stable presentation identity used by the web layout and gateway alias
    /// table. It is not substituted for the provider's native identity.
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedRestSend {
    pub request_id: String,
    pub session_id: String,
    pub provider: String,
    pub session_type: String,
    pub text: String,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedRestSendResult {
    pub session_id: String,
    pub completed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedRestCapture {
    pub session_id: String,
    pub provider: String,
    pub session_type: String,
    pub max_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedRestCaptureResult {
    pub session_id: String,
    pub native_session_id: String,
    pub text: String,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostedRestCaptureError {
    Unsupported,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedRestSnapshot {
    pub session_id: String,
    pub provider: String,
    pub session_type: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostedRestSnapshotError {
    OwnershipUnavailable,
    ManagedUnavailable,
}

#[async_trait]
pub trait HostedFreshAgentRestGateway: Send + Sync {
    /// None leaves genuinely unmanaged threads on their existing read path.
    /// A hosted read failure must never fall back to saved history as live truth.
    async fn snapshot(
        &self,
        _request: HostedRestSnapshot,
    ) -> Result<Option<Value>, HostedRestSnapshotError> {
        Err(HostedRestSnapshotError::OwnershipUnavailable)
    }
    async fn create_agent(
        self: std::sync::Arc<Self>,
        request: HostedRestCreate,
    ) -> Result<HostedRestCreated, ()>;

    async fn send_agent(&self, request: HostedRestSend) -> Result<HostedRestSendResult, ()>;

    async fn capture(
        &self,
        _request: HostedRestCapture,
    ) -> Result<HostedRestCaptureResult, HostedRestCaptureError> {
        Err(HostedRestCaptureError::Unsupported)
    }
}

pub type SharedHostedFreshAgentRestGateway = std::sync::Arc<dyn HostedFreshAgentRestGateway>;

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
