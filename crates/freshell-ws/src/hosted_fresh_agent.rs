//! Optional web gateway for host-owned fresh-agent souls.
//!
//! The installed object is a proxy only: provider transports live in the
//! session host. Dropping a browser or this whole web process drops cursors,
//! never the provider writer.

use freshell_protocol::{
    ClientMessage, FreshAgentApprovalRespond, FreshAgentAttach, FreshAgentCompact,
    FreshAgentCreate, FreshAgentFork, FreshAgentInterrupt, FreshAgentKill,
    FreshAgentQuestionRespond, FreshAgentRedo, FreshAgentSend, FreshAgentUndo,
};
use futures::future::BoxFuture;
use std::sync::{Arc, OnceLock};

#[derive(Debug, Clone)]
pub enum HostedFreshAgentCommand {
    Create(FreshAgentCreate),
    Attach(FreshAgentAttach),
    Send(FreshAgentSend),
    Interrupt(FreshAgentInterrupt),
    Kill(FreshAgentKill),
    Approval(FreshAgentApprovalRespond),
    Question(FreshAgentQuestionRespond),
    Compact(FreshAgentCompact),
    Fork(FreshAgentFork),
    Undo(FreshAgentUndo),
    Redo(FreshAgentRedo),
}

impl HostedFreshAgentCommand {
    fn from_message(message: &ClientMessage) -> Option<Self> {
        match message {
            ClientMessage::FreshAgentCreate(value) => Some(Self::Create(value.clone())),
            ClientMessage::FreshAgentAttach(value) => Some(Self::Attach(value.clone())),
            ClientMessage::FreshAgentSend(value) => Some(Self::Send(value.clone())),
            ClientMessage::FreshAgentInterrupt(value) => Some(Self::Interrupt(value.clone())),
            ClientMessage::FreshAgentKill(value) => Some(Self::Kill(value.clone())),
            ClientMessage::FreshAgentApprovalRespond(value) => Some(Self::Approval(value.clone())),
            ClientMessage::FreshAgentQuestionRespond(value) => Some(Self::Question(value.clone())),
            ClientMessage::FreshAgentCompact(value) => Some(Self::Compact(value.clone())),
            ClientMessage::FreshAgentFork(value) => Some(Self::Fork(value.clone())),
            ClientMessage::FreshAgentUndo(value) => Some(Self::Undo(value.clone())),
            ClientMessage::FreshAgentRedo(value) => Some(Self::Redo(value.clone())),
            _ => None,
        }
    }
}

pub trait HostedFreshAgentGateway: Send + Sync {
    fn dispatch(self: Arc<Self>, command: HostedFreshAgentCommand) -> BoxFuture<'static, ()>;
}

static GATEWAY: OnceLock<Arc<dyn HostedFreshAgentGateway>> = OnceLock::new();

/// Installs the process-wide gateway before the axum router begins accepting
/// connections. Freshell has one WS server per process; rejecting replacement
/// prevents a test or reload path from silently changing ownership policy.
pub fn install_gateway(gateway: Arc<dyn HostedFreshAgentGateway>) -> Result<(), &'static str> {
    GATEWAY
        .set(gateway)
        .map_err(|_| "hosted fresh-agent gateway is already installed")
}

pub(crate) fn dispatch_if_installed(message: &ClientMessage) -> bool {
    let Some(gateway) = GATEWAY.get() else {
        return false;
    };
    let Some(command) = HostedFreshAgentCommand::from_message(message) else {
        return false;
    };
    let task = Arc::clone(gateway).dispatch(command);
    tokio::spawn(task);
    true
}
