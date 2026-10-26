//! Optional web gateway for host-owned fresh-agent souls.
//!
//! The installed object is a proxy only: provider transports live in the
//! session host. Dropping a browser or this whole web process drops cursors,
//! never the provider writer.

use freshell_protocol::{
    ClientMessage, FreshAgentApprovalRespond, FreshAgentAttach, FreshAgentCompact,
    FreshAgentConfigure, FreshAgentCreate, FreshAgentElicitationRespond, FreshAgentFork,
    FreshAgentInterrupt, FreshAgentKill, FreshAgentQuestionRespond, FreshAgentRecoveryStop,
    FreshAgentRedo, FreshAgentSend, FreshAgentUndo,
};
use futures::future::BoxFuture;
use std::sync::{Arc, OnceLock};

#[derive(Debug, Clone)]
pub enum HostedFreshAgentCommand {
    Create(FreshAgentCreate),
    Attach(FreshAgentAttach),
    Send(FreshAgentSend),
    Interrupt(FreshAgentInterrupt),
    Configure(FreshAgentConfigure),
    Kill(FreshAgentKill),
    RecoveryStop(FreshAgentRecoveryStop),
    Approval(FreshAgentApprovalRespond),
    Question(FreshAgentQuestionRespond),
    Elicitation(FreshAgentElicitationRespond),
    Compact(FreshAgentCompact),
    Fork(FreshAgentFork),
    Undo(FreshAgentUndo),
    Redo(FreshAgentRedo),
}

/// Where an inbound client frame goes while a hosted gateway is installed.
#[derive(Debug, Clone)]
pub(crate) enum HostedRoute {
    /// A fresh-agent operation: the gateway consumes it. It must never fall
    /// through to the in-process provider states, which do not own hosted
    /// sessions. Boxed: commands carry whole client frames.
    Gateway(Box<HostedFreshAgentCommand>),
    /// Not a fresh-agent operation: the web process handles it as usual.
    NotFreshAgent,
}

/// Classifies every client message for the hosted gateway.
///
/// This match is deliberately exhaustive with no wildcard arm: adding a
/// `ClientMessage` variant fails to compile here until someone decides
/// whether the hosted gateway owns it.
pub(crate) fn hosted_route(message: &ClientMessage) -> HostedRoute {
    use HostedFreshAgentCommand as Command;
    let command = match message {
        ClientMessage::FreshAgentCreate(value) => Command::Create(value.clone()),
        ClientMessage::FreshAgentAttach(value) => Command::Attach(value.clone()),
        ClientMessage::FreshAgentSend(value) => Command::Send(value.clone()),
        ClientMessage::FreshAgentInterrupt(value) => Command::Interrupt(value.clone()),
        ClientMessage::FreshAgentConfigure(value) => Command::Configure(value.clone()),
        ClientMessage::FreshAgentKill(value) => Command::Kill(value.clone()),
        ClientMessage::FreshAgentRecoveryStop(value) => Command::RecoveryStop(value.clone()),
        ClientMessage::FreshAgentApprovalRespond(value) => Command::Approval(value.clone()),
        ClientMessage::FreshAgentQuestionRespond(value) => Command::Question(value.clone()),
        ClientMessage::FreshAgentElicitationRespond(value) => Command::Elicitation(value.clone()),
        ClientMessage::FreshAgentCompact(value) => Command::Compact(value.clone()),
        ClientMessage::FreshAgentFork(value) => Command::Fork(value.clone()),
        ClientMessage::FreshAgentUndo(value) => Command::Undo(value.clone()),
        ClientMessage::FreshAgentRedo(value) => Command::Redo(value.clone()),
        ClientMessage::Hello(_)
        | ClientMessage::Ping
        | ClientMessage::SessionsPrefs(_)
        | ClientMessage::ClientDiagnostic(_)
        | ClientMessage::TerminalCreate(_)
        | ClientMessage::TerminalCodexCandidatePersisted(_)
        | ClientMessage::TerminalAttach(_)
        | ClientMessage::TerminalInterest(_)
        | ClientMessage::TerminalReplayCredit(_)
        | ClientMessage::TerminalAutoResumeCancel(_)
        | ClientMessage::TerminalDetach(_)
        | ClientMessage::PaneClosed(_)
        | ClientMessage::PanesClosed(_)
        | ClientMessage::PaneOpened(_)
        | ClientMessage::TerminalInput(_)
        | ClientMessage::TerminalResize(_)
        | ClientMessage::TerminalKill(_)
        | ClientMessage::CodexActivityList(_)
        | ClientMessage::OpencodeActivityList(_)
        | ClientMessage::ClaudeActivityList(_)
        | ClientMessage::AmplifierActivityList(_)
        | ClientMessage::UiLayoutSync(_)
        | ClientMessage::UiScreenshotResult(_)
        | ClientMessage::CodingCliCreate(_)
        | ClientMessage::CodingCliInput(_)
        | ClientMessage::CodingCliKill(_)
        | ClientMessage::PaneReconcileRequest(_)
        | ClientMessage::HostStatsSubscribe
        | ClientMessage::HostStatsUnsubscribe
        | ClientMessage::HostStatsRefresh(_) => return HostedRoute::NotFreshAgent,
    };
    HostedRoute::Gateway(Box::new(command))
}

pub trait HostedFreshAgentGateway: Send + Sync {
    fn attention_marks(&self) -> BoxFuture<'_, Vec<freshell_protocol::FreshAgentAttentionMark>> {
        Box::pin(async { Vec::new() })
    }
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

pub(crate) async fn retained_attention_marks() -> Vec<freshell_protocol::FreshAgentAttentionMark> {
    match GATEWAY.get() {
        Some(gateway) => gateway.attention_marks().await,
        None => Vec::new(),
    }
}

pub(crate) fn dispatch_if_installed(message: &ClientMessage) -> bool {
    let Some(gateway) = GATEWAY.get() else {
        return false;
    };
    let HostedRoute::Gateway(command) = hosted_route(message) else {
        return false;
    };
    let task = Arc::clone(gateway).dispatch(*command);
    tokio::spawn(task);
    true
}

#[cfg(test)]
#[path = "hosted_fresh_agent_tests.rs"]
mod tests;
