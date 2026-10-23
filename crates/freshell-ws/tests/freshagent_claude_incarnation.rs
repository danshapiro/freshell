//! In-process send observers correlate a sidecar end to its exact runtime.

#![cfg(unix)]

mod common;

use common::claude_rig::{ClaudeRig, RigKind, RigOptions};
use freshell_freshagent::{claude::ClaudeSendOutcome, ClaudeTurnEvent};
use freshell_protocol::{AgentProvider, FreshAgentSend, SessionType};
use std::time::Duration;

async fn accepted_owner(rig: &ClaudeRig, id: &str, request: &str) -> String {
    let outcome = rig
        .fresh_claude
        .handle_send(FreshAgentSend {
            provider: AgentProvider::Claude,
            session_id: id.into(),
            session_type: SessionType::Freshclaude,
            text: "HANG".into(),
            request_id: Some(request.into()),
            cwd: None,
            images: None,
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: None,
        })
        .await;
    match outcome {
        ClaudeSendOutcome::Accepted { ownership_id, .. } => {
            assert!(!ownership_id.is_empty());
            ownership_id
        }
        refused => panic!("send should be accepted: {refused:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ended_event_identifies_the_accepted_runtime_across_a_resume() {
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut conn = rig.connect().await;
    let pane = conn.create("create-incarnation").await;
    let durable = rig
        .converse(&mut conn, &pane, &["make the transcript durable"])
        .await;
    let mut events = rig.fresh_claude.subscribe_turn_events();
    let first_owner = accepted_owner(&rig, &durable, "first-incarnation").await;
    rig.kill_first_sidecar(&mut conn).await;
    conn.attach(&durable).await;
    let second_owner = accepted_owner(&rig, &durable, "second-incarnation").await;
    assert_ne!(
        first_owner, second_owner,
        "a new process has a new ownership id"
    );
    let ended_owner = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let ClaudeTurnEvent::Ended { ownership_id, .. } = events.recv().await.unwrap() {
                break ownership_id;
            }
        }
    })
    .await
    .expect("the dead runtime publishes its end");
    assert_eq!(ended_owner, first_owner);
    assert_ne!(
        ended_owner, second_owner,
        "a delayed old end cannot match a new send"
    );
    rig.fresh_claude.shutdown().await;
}
