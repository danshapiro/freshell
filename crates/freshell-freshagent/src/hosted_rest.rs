//! Typed seam for routing the REST/MCP fresh-agent ingress to the durable
//! session-host owner. The implementation lives in `freshell-server`; this
//! crate deliberately knows nothing about supervisor IPC.

use async_trait::async_trait;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedRestCreate {
    pub request_id: String,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub native_session_id: Option<String>,
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
    async fn create_opencode(
        self: std::sync::Arc<Self>,
        request: HostedRestCreate,
    ) -> Result<HostedRestCreated, ()>;

    async fn send_opencode(&self, request: HostedRestSend) -> Result<HostedRestSendResult, ()>;

    async fn capture(
        &self,
        request: HostedRestCapture,
    ) -> Result<HostedRestCaptureResult, HostedRestCaptureError>;
}

pub type SharedHostedFreshAgentRestGateway = std::sync::Arc<dyn HostedFreshAgentRestGateway>;
