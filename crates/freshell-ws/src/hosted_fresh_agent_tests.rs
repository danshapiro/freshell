use super::*;
use freshell_protocol::{CLIENT_MESSAGE_TYPES, EXTENSION_CLIENT_MESSAGE_TYPES};
use serde_json::json;

/// One decodable wire sample for every `freshAgent.*` client discriminant.
fn fresh_agent_sample(kind: &str) -> serde_json::Value {
    let session = json!({
        "provider": "claude",
        "sessionId": "session-1",
        "sessionType": "freshclaude",
    });
    let extra = match kind {
        "freshAgent.create" => json!({"requestId": "create-1"}),
        "freshAgent.attach" => json!({}),
        "freshAgent.send" => json!({"text": "hello"}),
        "freshAgent.interrupt" => json!({}),
        "freshAgent.configure" => {
            json!({"requestId": "configure-1", "settings": {"model": "opus", "effort": "high"}})
        }
        "freshAgent.compact" => json!({"requestId": "compact-1"}),
        "freshAgent.approval.respond" => json!({"requestId": 7, "decision": {"allow": true}}),
        "freshAgent.question.respond" => json!({"requestId": "q-1", "answers": {"q": "a"}}),
        "freshAgent.elicitation.respond" => {
            json!({"requestId": "41", "action": "decline", "content": null})
        }
        "freshAgent.kill" => json!({}),
        "freshAgent.recovery.stop" => json!({"requestId": "stop-1"}),
        "freshAgent.fork" => json!({"requestId": "fork-1"}),
        "freshAgent.undo" => json!({"requestId": "undo-1"}),
        "freshAgent.redo" => json!({"requestId": "redo-1"}),
        other => panic!("no hosted-routing sample for fresh-agent message {other}"),
    };
    let mut frame = session;
    frame
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    frame["type"] = json!(kind);
    frame
}

/// The wire discriminant each gateway command was decoded from. Exhaustive,
/// so a new command variant must be named here too.
fn command_wire_type(command: &HostedFreshAgentCommand) -> &'static str {
    match command {
        HostedFreshAgentCommand::Create(_) => "freshAgent.create",
        HostedFreshAgentCommand::Attach(_) => "freshAgent.attach",
        HostedFreshAgentCommand::Send(_) => "freshAgent.send",
        HostedFreshAgentCommand::Interrupt(_) => "freshAgent.interrupt",
        HostedFreshAgentCommand::Configure(_) => "freshAgent.configure",
        HostedFreshAgentCommand::Kill(_) => "freshAgent.kill",
        HostedFreshAgentCommand::RecoveryStop(_) => "freshAgent.recovery.stop",
        HostedFreshAgentCommand::Approval(_) => "freshAgent.approval.respond",
        HostedFreshAgentCommand::Question(_) => "freshAgent.question.respond",
        HostedFreshAgentCommand::Elicitation(_) => "freshAgent.elicitation.respond",
        HostedFreshAgentCommand::Compact(_) => "freshAgent.compact",
        HostedFreshAgentCommand::Fork(_) => "freshAgent.fork",
        HostedFreshAgentCommand::Undo(_) => "freshAgent.undo",
        HostedFreshAgentCommand::Redo(_) => "freshAgent.redo",
    }
}

#[test]
fn every_fresh_agent_client_message_is_consumed_by_the_hosted_gateway() {
    let kinds: Vec<&str> = CLIENT_MESSAGE_TYPES
        .iter()
        .chain(EXTENSION_CLIENT_MESSAGE_TYPES.iter())
        .copied()
        .filter(|kind| kind.starts_with("freshAgent."))
        .collect();
    assert!(
        !kinds.is_empty(),
        "the inventory lists fresh-agent messages"
    );
    let mut unrouted = Vec::new();
    for kind in kinds {
        let message: ClientMessage = serde_json::from_value(fresh_agent_sample(kind))
            .unwrap_or_else(|error| panic!("sample {kind} must decode: {error}"));
        match hosted_route(&message) {
            HostedRoute::Gateway(command) => assert_eq!(
                command_wire_type(&command),
                kind,
                "{kind} must reach the gateway as its own command"
            ),
            HostedRoute::NotFreshAgent => unrouted.push(kind),
        }
    }
    assert!(
        unrouted.is_empty(),
        "fresh-agent messages fell through the hosted gateway: {unrouted:?}"
    );
}

#[test]
fn non_fresh_agent_client_messages_stay_with_the_web_process() {
    for frame in [
        json!({"type": "ping"}),
        json!({"type": "hoststats.subscribe"}),
        json!({"type": "terminal.input", "terminalId": "term-1", "data": "ls\r"}),
        json!({"type": "terminal.detach", "terminalId": "term-1"}),
    ] {
        let message: ClientMessage = serde_json::from_value(frame.clone())
            .unwrap_or_else(|error| panic!("sample {frame} must decode: {error}"));
        assert!(
            matches!(hosted_route(&message), HostedRoute::NotFreshAgent),
            "{frame} must not be routed to the hosted gateway"
        );
    }
}
