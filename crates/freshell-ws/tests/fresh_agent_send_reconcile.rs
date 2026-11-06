//! Positive wire-level coverage for receipt-only Codex send reconciliation.
//!
//! This is its own test binary because the hosted gateway is intentionally
//! installed once per process. The test uses a real loopback WebSocket server
//! and client so capability negotiation and the production inbound frame route
//! are exercised together.

mod common;

use std::sync::Arc;
use std::time::Duration;

use freshell_terminal::registry::{
    ManagedOutputRead, ManagedTerminalController, ManagedTerminalDescriptor, ManagedTerminalFuture,
    ManagedTerminalLaunch, ManagedTerminalLaunchError,
};
use freshell_ws::hosted_fresh_agent::{
    install_gateway, HostedFreshAgentCommand, HostedFreshAgentGateway,
};
use futures::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;

struct CapabilityFixture;

impl ManagedTerminalController for CapabilityFixture {
    fn lookup_terminal<'a>(
        &'a self,
        _: &'a str,
        _: Option<String>,
    ) -> ManagedTerminalFuture<'a, Result<Option<ManagedTerminalDescriptor>, String>> {
        Box::pin(async { Ok(None) })
    }

    fn launch<'a>(
        &'a self,
        _: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, ManagedTerminalLaunchError>>
    {
        Box::pin(async { Err("the reconciliation test never launches a terminal".into()) })
    }

    fn input<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: String,
    ) -> ManagedTerminalFuture<'a, Result<(), freshell_terminal::registry::ManagedTerminalInputError>>
    {
        Box::pin(async { Ok(()) })
    }

    fn resize<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: u16,
        _: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn stop<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn read_output<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: i64,
        _: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        Box::pin(async { Err("the reconciliation test does not read terminal output".into()) })
    }
}

struct RecordingGateway {
    commands: mpsc::UnboundedSender<HostedFreshAgentCommand>,
}

impl HostedFreshAgentGateway for RecordingGateway {
    fn dispatch(self: Arc<Self>, command: HostedFreshAgentCommand) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            self.commands
                .send(command)
                .expect("recording gateway receiver remains open");
        })
    }
}

async fn connect_and_capture_ready(url: &str) -> (common::TestWs, serde_json::Value) {
    let (mut ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("connect to loopback WS server");
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": common::AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            "capabilities": {
                "managedRuntimeV1": true,
                "freshAgentSendReconcileV1": true,
            },
        })
        .to_string(),
    ))
    .await
    .expect("send hello");

    let deadline = tokio::time::Instant::now() + common::FRAME_BUDGET;
    let mut ready = None;
    let mut inventory_seen = false;
    for _ in 0..8 {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let frame = tokio::time::timeout(remaining, ws.next())
            .await
            .expect("handshake frame arrives within the shared budget")
            .expect("WS connection remains open")
            .expect("valid WS frame");
        let WsMessage::Text(text) = frame else {
            continue;
        };
        let value: serde_json::Value = serde_json::from_str(&text).expect("JSON handshake frame");
        match value["type"].as_str() {
            Some("ready") => ready = Some(value),
            Some("terminal.inventory") => {
                inventory_seen = true;
                break;
            }
            _ => {}
        }
    }
    assert!(inventory_seen, "handshake includes terminal.inventory");
    (ws, ready.expect("handshake includes ready"))
}

#[tokio::test]
async fn negotiated_receipt_reconcile_reaches_the_hosted_gateway_without_becoming_a_send() {
    let (command_tx, mut command_rx) = mpsc::unbounded_channel();
    install_gateway(Arc::new(RecordingGateway {
        commands: command_tx,
    }))
    .expect("this isolated test binary installs its gateway once");

    let (url, _registry, state) = common::spawn_server_with_specs_and_state(vec![]).await;
    state
        .registry
        .set_managed_controller(Some(Arc::new(CapabilityFixture)));

    let (mut ws, ready) = connect_and_capture_ready(&url).await;
    assert_eq!(
        ready["capabilities"]["managedRuntimeV1"].as_bool(),
        Some(true)
    );
    assert_eq!(
        ready["capabilities"]["freshAgentSendReconcileV1"].as_bool(),
        Some(true),
        "the server acknowledges receipt reconciliation only after its gateway and managed controller are installed"
    );

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "freshAgent.send.reconcile",
            "provider": "codex",
            "sessionId": "codex-root-original",
            "sessionType": "freshcodex",
            "requestId": "request-original-send-71",
            "text": "original prompt, used only for receipt lookup",
            "checkpointIntent": {
                "logicalAttemptId": "checkpoint-logical-attempt-71",
            },
        })
        .to_string(),
    ))
    .await
    .expect("send receipt-only reconcile frame");

    let command = tokio::time::timeout(Duration::from_secs(5), command_rx.recv())
        .await
        .expect("hosted gateway receives the reconcile frame")
        .expect("recorded command channel remains open");
    let HostedFreshAgentCommand::SendReconcile(send) = command else {
        panic!("receipt-only WS frame was routed as {command:?}");
    };
    assert_eq!(
        serde_json::to_value(send).expect("serialize parsed gateway command"),
        serde_json::json!({
            "provider": "codex",
            "sessionId": "codex-root-original",
            "sessionType": "freshcodex",
            "requestId": "request-original-send-71",
            "text": "original prompt, used only for receipt lookup",
            "checkpointIntent": {
                "logicalAttemptId": "checkpoint-logical-attempt-71",
            },
        }),
        "the gateway receives the original request identity and checkpoint intent intact"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), command_rx.recv())
            .await
            .is_err(),
        "one reconcile frame dispatches one hosted command"
    );
}
