//! Browser-shaped checkpointed sends through the production sidecar and CLI simulator.
//! Creation owns the native UUID before SDK init. Exercise sends before the
//! first init, after a real warm-up turn, and across coordinator fencing.

mod common;
use common::claude_rig::{ClaudeRig, RigConnection, RigKind};
use serde_json::{json, Value};

fn completions(conn: &RigConnection, id: &str) -> Vec<i64> {
    conn.frames
        .iter()
        .filter(|frame| {
            frame["sessionId"] == id && frame["event"]["type"] == "freshAgent.turn.complete"
        })
        .map(|frame| frame["event"]["at"].as_i64().expect("numeric edge at"))
        .collect()
}

fn prompts(rig: &ClaudeRig, id: &str) -> Vec<Value> {
    rig.ledger_rows("prompt")
        .into_iter()
        .filter(|row| row["sessionId"] == id)
        .collect()
}

async fn expect_turn(
    rig: &ClaudeRig,
    conn: &mut RigConnection,
    id: &str,
    start: usize,
    request: &str,
    text: &str,
    turn: usize,
) {
    let outcome = conn
        .wait_for_since(start, "the send outcome", |frame| {
            frame["requestId"] == request
                && matches!(
                    frame["type"].as_str(),
                    Some("error" | "freshAgent.send.accepted")
                )
        })
        .await;
    assert_eq!(outcome["type"], "freshAgent.send.accepted", "{outcome}");
    conn.wait_for_since(start, "the completed turn", |frame| {
        frame["sessionId"] == id && frame["event"]["type"] == "freshAgent.turn.complete"
    })
    .await;
    conn.wait_for_since(start, "the real SDK result", |frame| {
        frame["sessionId"] == id && frame["event"]["type"] == "freshAgent.result"
    })
    .await;
    let seen = prompts(rig, id);
    assert_eq!(
        seen.len(),
        turn,
        "every accepted turn ran exactly once: {seen:?}"
    );
    assert_eq!(seen.last().unwrap()["text"], text);
    assert_eq!(
        seen.last().unwrap()["uuid"],
        outcome["submittedTurnId"],
        "the accepted command reached the actual SDK input stream"
    );
    assert_eq!(completions(conn, id).len(), turn);
}

async fn send_fenced(
    conn: &mut RigConnection,
    id: &str,
    request: &str,
    text: &str,
    observed: (u64, u64),
) -> usize {
    let start = conn.frames.len();
    conn.send(
        json!({"type":"freshAgent.send", "provider":"claude", "sessionType":"freshclaude",
        "sessionId":id, "requestId":request, "text":text,
        "checkpointIntent":{"logicalAttemptId":format!("attempt-{request}")},
        "observedEpoch":observed.0, "observedGeneration":observed.1}),
    )
    .await;
    start
}

async fn messages_each_run_once(after_init: bool) {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut conn = rig.connect().await;
    let id = conn.create("create-checkpointed").await;
    assert!(
        conn.owner_pair(&id).is_some(),
        "create announced ownership before SDK init"
    );
    assert_eq!(conn.events_seen("freshAgent.session.init"), 0);
    let mut expected = Vec::new();
    if after_init {
        let start = conn.frames.len();
        conn.send_text(&id, "warm-up", "initialize the existing conversation")
            .await;
        expect_turn(
            &rig,
            &mut conn,
            &id,
            start,
            "warm-up",
            "initialize the existing conversation",
            1,
        )
        .await;
        assert_eq!(conn.events_seen("freshAgent.session.init"), 1);
        expected.push("initialize the existing conversation");
    }
    for (index, text) in ["first message", "second message", "third message"]
        .into_iter()
        .enumerate()
    {
        let request = format!("send-{index}");
        let start = conn.frames.len();
        conn.send_checkpointed_text(&id, &request, text).await;
        expected.push(text);
        expect_turn(&rig, &mut conn, &id, start, &request, text, expected.len()).await;
        assert!(conn.owner_pair(&id).is_some());
    }
    conn.kill(&id).await;
    assert_eq!(
        prompts(&rig, &id)
            .iter()
            .map(|row| row["text"].as_str().unwrap())
            .collect::<Vec<_>>(),
        expected
    );
    let edges = completions(&conn, &id);
    assert!(
        edges.windows(2).all(|pair| pair[0] < pair[1]),
        "strictly increasing edges: {edges:?}"
    );
    assert_eq!(conn.events_seen("freshAgent.result"), expected.len());
    rig.fresh_claude.shutdown().await;
}

mod checkpointed_sends {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_when_the_session_is_reported_by_the_first_prompt() {
        messages_each_run_once(false).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_after_the_cli_has_initialized_the_existing_conversation() {
        messages_each_run_once(true).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_a_stale_owner_pair_are_refused_once_the_session_is_reported() {
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut conn = rig.connect().await;
        let id = conn.create("create-stale-fence").await;
        let observed = conn.owner_pair(&id).expect("create-time owner pair");
        let freshell_ownership::BeginOutcome::Granted { generation } = rig.ownership.begin_handoff(
            "claude",
            &id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "generation-bump",
            None,
            "test",
            freshell_ownership::now_epoch_ms(),
        ) else {
            panic!("the handoff must start")
        };
        assert!(matches!(
            rig.ownership
                .fail("claude", &id, "generation-bump", generation, true),
            freshell_ownership::FailOutcome::RestoredPriorOwner
        ));
        let current = rig.ownership.observe("claude", &id);
        assert!(
            matches!(
                current.state,
                freshell_ownership::OwnershipState::Live { .. }
            ) && current.generation > observed.1
        );
        let start = send_fenced(&mut conn, &id, "stale", "stale message", observed).await;
        let refused = conn
            .wait_for_since(start, "the stale refusal", |frame| {
                frame["requestId"] == "stale"
                    && matches!(
                        frame["type"].as_str(),
                        Some("error" | "freshAgent.send.accepted")
                    )
            })
            .await;
        assert_eq!(refused["type"], "error", "{refused}");
        let message = refused["message"].as_str().unwrap();
        assert!(
            message.starts_with("SESSION_RESERVED")
                && message.contains(freshell_freshagent::ownership_lane::STALE_OP_GUARD_MESSAGE),
            "{refused}"
        );
        let start = send_fenced(
            &mut conn,
            &id,
            "current",
            "current message",
            (current.epoch, current.generation),
        )
        .await;
        expect_turn(&rig, &mut conn, &id, start, "current", "current message", 1).await;
        // These fence-only fixtures bypass the handoff runner's retained-stamp
        // repair. They own their rig, so shut it down and prove its processes
        // exit without pretending the complete handoff adapter ran.
        let processes = rig.runtime_processes(&id);
        rig.fresh_claude.shutdown().await;
        processes
            .wait_until_exited("the registry-transition fixture")
            .await;
        assert_eq!(
            prompts(&rig, &id)
                .iter()
                .map(|row| row["text"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["current message"]
        );
        assert_eq!(completions(&conn, &id).len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wait_for_a_lifecycle_operation_on_the_native_uuid_before_the_first_init() {
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut conn = rig.connect().await;
        let id = conn.create("create-lifecycle-fence").await;
        assert_eq!(conn.events_seen("freshAgent.session.init"), 0);
        let freshell_ownership::BeginOutcome::Granted { generation } = rig.ownership.begin_handoff(
            "claude",
            &id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "native-handoff",
            None,
            "test",
            freshell_ownership::now_epoch_ms(),
        ) else {
            panic!("the native handoff must start")
        };
        let start = send_fenced(
            &mut conn,
            &id,
            "during",
            "message during the handoff",
            (rig.ownership.boot_epoch(), generation),
        )
        .await;
        let refused = conn
            .wait_for_since(start, "the lifecycle refusal", |frame| {
                frame["requestId"] == "during"
                    && matches!(
                        frame["type"].as_str(),
                        Some("error" | "freshAgent.send.accepted")
                    )
            })
            .await;
        assert_eq!(refused["type"], "error", "{refused}");
        let message = refused["message"].as_str().unwrap();
        assert!(
            message.starts_with("SESSION_RESERVED")
                && message
                    .contains(freshell_freshagent::ownership_lane::LIFECYCLE_OP_GUARD_MESSAGE),
            "{refused}"
        );
        assert!(matches!(
            rig.ownership
                .fail("claude", &id, "native-handoff", generation, true),
            freshell_ownership::FailOutcome::RestoredPriorOwner
        ));
        let restored = rig.ownership.observe("claude", &id);
        let start = send_fenced(
            &mut conn,
            &id,
            "after",
            "message after the handoff",
            (restored.epoch, restored.generation),
        )
        .await;
        expect_turn(
            &rig,
            &mut conn,
            &id,
            start,
            "after",
            "message after the handoff",
            1,
        )
        .await;
        // These fence-only fixtures bypass the handoff runner's retained-stamp
        // repair. They own their rig, so shut it down and prove its processes
        // exit without pretending the complete handoff adapter ran.
        let processes = rig.runtime_processes(&id);
        rig.fresh_claude.shutdown().await;
        processes
            .wait_until_exited("the registry-transition fixture")
            .await;
        assert_eq!(
            prompts(&rig, &id)
                .iter()
                .map(|row| row["text"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["message after the handoff"]
        );
        assert_eq!(completions(&conn, &id).len(), 1);
    }
}
