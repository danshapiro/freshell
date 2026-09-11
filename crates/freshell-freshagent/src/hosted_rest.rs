//! Typed seam for routing the REST/MCP fresh-agent ingress to the durable
//! session-host owner. The implementation lives in `freshell-server`; this
//! crate deliberately knows nothing about supervisor IPC.

use async_trait::async_trait;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedRestCreate {
    pub request_id: String,
    pub provider: String,
    pub session_type: String,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub native_session_id: Option<String>,
    pub preferred_tab_id: String,
    pub preferred_pane_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedRestPane {
    pub tab_id: String,
    pub pane_id: String,
    pub session_id: String,
    pub provider: String,
    pub session_type: String,
    pub title: Option<String>,
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

#[async_trait]
pub trait HostedFreshAgentRestGateway: Send + Sync {
    async fn create_agent(
        self: std::sync::Arc<Self>,
        request: HostedRestCreate,
    ) -> Result<HostedRestCreated, ()>;

    async fn send_agent(&self, request: HostedRestSend) -> Result<HostedRestSendResult, ()>;

    async fn resolve_pane(&self, _pane_id: &str) -> Result<Option<HostedRestPane>, ()> {
        Ok(None)
    }

    async fn capture(
        &self,
        _request: HostedRestCapture,
    ) -> Result<HostedRestCaptureResult, HostedRestCaptureError> {
        Err(HostedRestCaptureError::Unsupported)
    }
}

pub type SharedHostedFreshAgentRestGateway = std::sync::Arc<dyn HostedFreshAgentRestGateway>;
