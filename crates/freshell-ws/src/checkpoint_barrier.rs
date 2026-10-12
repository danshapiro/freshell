//! Narrow service seam for the modern fresh-agent send/capture barrier.
//!
//! The server owns the captured attempt and only polls the provider-forward
//! future after capture publication or failure has fully settled. Callers
//! pass the forward operation as a future so duplicate logical attempts can
//! join one server-owned job without dispatching twice.

use std::sync::Arc;

use freshell_protocol::{AgentProvider, FreshAgentSend, SessionType};
use futures::future::BoxFuture;

pub trait FreshAgentCheckpointBarrier: Send + Sync {
    fn barrier_and_forward(
        self: Arc<Self>,
        send: FreshAgentSend,
        forward: BoxFuture<'static, ()>,
    ) -> BoxFuture<'static, ()>;

    /// Replays durable per-turn results when a pane reattaches after missing
    /// the pre-forward outcome broadcast. Implementations filter by provider
    /// session identity and never infer an outcome from transcript text.
    fn replay_for_session(
        self: Arc<Self>,
        provider: AgentProvider,
        session_id: String,
        session_type: SessionType,
    ) -> BoxFuture<'static, ()>;
}

#[derive(Clone, Default)]
pub struct WsCheckpointState {
    pub service: Option<Arc<dyn FreshAgentCheckpointBarrier>>,
}
