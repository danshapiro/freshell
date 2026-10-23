//! freshclaude turns (core design §5 and §11.3 of
//! docs/plans/2026-10-22-freshclaude-core-runtime.md; C16 adds this file, C17 and
//! C18 grow it). Every case runs the REAL claude sidecar
//! (`crates/freshell-claude-sidecar/index.mjs`) behind a real freshell-ws server.
//!
//! C16, uuid-stamped sends: the server mints a uuid for every send and gives it
//! to the sidecar, which puts it on the SDKUserMessage. The CLI keeps it for the
//! command and writes the user line with it, so it is also the turn id the
//! snapshot shows: `freshAgent.send.accepted.submittedTurnId` is that uuid, and
//! a pane matches its sent message to the landed turn by id. `handle_send` also
//! answers its caller ([`freshell_freshagent::ClaudeSendOutcome`], design §9.3
//! I2), and a send the sidecar refuses (a bad image) is taken back: the message
//! returns to its sender, the session is not left busy, and it keeps working.
//!
//! C17, the per-command turn ledger (design §5.2): the server folds those facts
//! into one busy truth per session and publishes the session's status itself.
//! A send absorbed into a tool call (T10) leaves the session idle after its one
//! result, so the next configure is accepted and the next turn rings (G08). A
//! send queued behind streamed text keeps the client running between the two
//! results (`freshAgent.result.sessionBusy`). The status is `running` from the
//! accept, before any assistant frame, and a turn the CLI starts by itself (a
//! background agent's completion, T19) is busy too.

mod common;

use std::time::Duration;

use serde_json::{json, Value};

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RIG_FRAME_BUDGET};
use common::log_capture;
use freshell_freshagent::ClaudeSendOutcome;
use freshell_protocol::{AgentProvider, FreshAgentImage, FreshAgentSend, SessionType};

fn is_uuid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}

/// The `freshAgent.send.accepted` answering `request_id`.
async fn accepted(conn: &mut RigConnection, request_id: &str) -> Value {
    conn.wait_for(&format!("send.accepted for {request_id}"), |v| {
        v["type"] == "freshAgent.send.accepted" && v["requestId"] == request_id
    })
    .await
}

async fn wait_for_results(conn: &mut RigConnection, count: usize, what: &str) {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while conn.events_seen("freshAgent.result") < count {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the turn for {what:?} never finished; frames: {:?}",
            conn.frames
        );
        conn.read_for(Duration::from_millis(50)).await;
    }
}

/// The user turns of the session's snapshot, as (turnId, text).
async fn user_turns(rig: &ClaudeRig, session_id: &str) -> Vec<(String, String)> {
    let snapshot = rig
        .fresh_claude
        .get_snapshot(SessionType::Freshclaude, session_id)
        .await
        .unwrap_or_else(|error| panic!("a snapshot of {session_id}: {error}"));
    snapshot["turns"]
        .as_array()
        .expect("turns")
        .iter()
        .filter(|turn| turn["role"] == "user")
        .map(|turn| {
            (
                turn["turnId"].as_str().unwrap_or_default().to_string(),
                turn["items"][0]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            )
        })
        .collect()
}

/// The landed user turns, once `count` of them are on disk (the CLI writes a
/// line 95-200 ms after its SDK frame, T3).
async fn wait_for_user_turns(
    rig: &ClaudeRig,
    session_id: &str,
    count: usize,
) -> Vec<(String, String)> {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        let turns = user_turns(rig, session_id).await;
        if turns.len() >= count {
            return turns;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the snapshot never showed {count} user turns: {turns:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// `send.accepted.submittedTurnId` is a UUID, and the turn the message lands as
/// carries it as its `turnId`: the CLI wrote the user line under the uuid the
/// server minted (on the simulator, the prompt also ran under it).
async fn submitted_turn_id_is_the_snapshot_turn_id(kind: RigKind) {
    let rig = ClaudeRig::start(kind).await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;

    let mut submitted = Vec::new();
    for (n, text) in ["hello", "and again"].into_iter().enumerate() {
        let request_id = format!("send-{n}");
        let results_before = conn.events_seen("freshAgent.result");
        conn.send_text(&session_id, &request_id, text).await;
        let accepted = accepted(&mut conn, &request_id).await;
        let turn_id = accepted["submittedTurnId"]
            .as_str()
            .unwrap_or_else(|| panic!("send.accepted carries submittedTurnId: {accepted}"))
            .to_string();
        assert!(is_uuid(&turn_id), "{turn_id}");
        wait_for_results(&mut conn, results_before + 1, text).await;
        submitted.push((turn_id, text.to_string()));
    }
    assert_ne!(submitted[0].0, submitted[1].0, "each send has its own id");

    let durable = conn.init_session_id(&session_id);
    assert_eq!(
        wait_for_user_turns(&rig, &durable, 2).await,
        submitted,
        "each landed user turn carries the id its send was accepted with"
    );
    if kind == RigKind::Sim {
        let prompts: Vec<(String, String)> = rig
            .ledger_rows("prompt")
            .iter()
            .map(|row| {
                (
                    row["uuid"].as_str().unwrap_or_default().to_string(),
                    row["text"].as_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        assert_eq!(prompts, submitted, "the CLI ran each prompt under its id");
    }
    conn.kill(&session_id).await;
}

/// The CLI's lifecycle facts for a sent command come through the sidecar to the
/// server: the command's lifecycle under the send's uuid, with its replay (T8),
/// the session's state (T9) and its model requests. They are the server's own
/// (logged now; the turn ledger folds them from C17) and never reach a client:
/// no client is shown a model request or the end of a status as a status.
async fn lifecycle_facts_reach_the_server_and_no_client(kind: RigKind) {
    let logs = log_capture::install();
    let rig = ClaudeRig::start(kind).await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "hello").await;
    let uuid = accepted(&mut conn, "send-1").await["submittedTurnId"]
        .as_str()
        .expect("submittedTurnId")
        .to_string();
    wait_for_results(&mut conn, 1, "hello").await;

    let is_command = |event: &log_capture::CapturedEvent| {
        event.message == "freshagent.claude.command" && event.field("uuid") == Some(uuid.as_str())
    };
    logs.wait_for("the completed lifecycle", |event| {
        is_command(event) && event.field("state") == Some("completed")
    })
    .await;
    let commands = logs.matching(is_command);
    assert_eq!(
        commands
            .iter()
            .map(|event| event.field("state").unwrap_or_default())
            .collect::<Vec<_>>(),
        ["queued", "started", "replayed", "completed"],
        "{commands:?}"
    );
    assert!(commands
        .iter()
        .all(|event| event.level == tracing::Level::DEBUG
            && event.field("session_id") == Some(session_id.as_str())));

    let is_state = |event: &log_capture::CapturedEvent| {
        event.message == "freshagent.claude.session_state"
            && event.field("session_id") == Some(session_id.as_str())
    };
    logs.wait_for("the idle session state", |event| {
        is_state(event) && event.field("state") == Some("idle")
    })
    .await;
    assert_eq!(
        logs.matching(is_state)
            .iter()
            .map(|event| event.field("state").unwrap_or_default().to_string())
            .collect::<Vec<_>>(),
        ["running", "idle"]
    );
    logs.wait_for("the model request", |event| {
        event.message == "freshagent.claude.status_fact"
            && event.field("session_id") == Some(session_id.as_str())
            && event.field("status") == Some("requesting")
    })
    .await;

    conn.read_for(Duration::from_millis(300)).await;
    for frame in &conn.frames {
        if frame["event"]["type"] == "freshAgent.status" {
            let status = frame["event"]["status"].as_str();
            assert!(
                matches!(status, Some(shown) if shown != "requesting"),
                "a client is shown only statuses it knows: {frame}"
            );
        }
        let event_type = frame["event"]["type"].as_str().unwrap_or_default();
        assert!(
            !matches!(
                event_type,
                "freshAgent.command" | "freshAgent.session.state" | "freshAgent.heartbeat"
            ) && !event_type.starts_with("sdk."),
            "a lifecycle fact reached a client: {frame}"
        );
    }
    conn.kill(&session_id).await;
}

/// The session's `freshAgent.status` values this connection read, in order,
/// with each one's index in [`RigConnection::frames`].
fn statuses(conn: &RigConnection, session_id: &str) -> Vec<(usize, String)> {
    conn.frames
        .iter()
        .enumerate()
        .filter(|(_, v)| {
            v["type"] == "freshAgent.event"
                && v["sessionId"] == session_id
                && v["event"]["type"] == "freshAgent.status"
        })
        .map(|(at, v)| {
            (
                at,
                v["event"]["status"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            )
        })
        .collect()
}

/// The index of the first frame matching `predicate`.
fn index_of(conn: &RigConnection, what: &str, predicate: impl Fn(&Value) -> bool) -> usize {
    conn.frames
        .iter()
        .position(predicate)
        .unwrap_or_else(|| panic!("no {what} among {:?}", conn.frames))
}

/// The `freshAgent.result` frames this connection read, with their indexes.
fn results(conn: &RigConnection) -> Vec<(usize, Value)> {
    conn.frames
        .iter()
        .enumerate()
        .filter(|(_, v)| {
            v["type"] == "freshAgent.event" && v["event"]["type"] == "freshAgent.result"
        })
        .map(|(at, v)| (at, v["event"].clone()))
        .collect()
}

/// Wait until the server reports the session `want` busy, or the budget ends.
async fn wait_until_busy(rig: &ClaudeRig, session_id: &str, want: bool, what: &str) {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while rig.fresh_claude.session_busy(session_id).await != Some(want) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{what}: the session never became {}",
            if want { "busy" } else { "idle" }
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// G08 (design §11.5 item 4): a send from a second connection lands while the
/// first connection's turn runs a tool, so the CLI absorbs it into that turn
/// (T10): two commands, one result. The session is idle afterwards on the
/// server and on both connections, a model change is accepted (the session is
/// not left waiting for a second result that never comes), and the next turn
/// rings once on each connection.
async fn an_absorbed_send_from_a_second_connection_leaves_both_idle(kind: RigKind) {
    let rig = ClaudeRig::start(kind).await;
    let mut first = rig.connect().await;
    let mut second = rig.connect().await;
    // Bash runs without asking under bypassPermissions.
    let created = first
        .request_create("create-1", json!({ "permissionMode": "bypassPermissions" }))
        .await;
    assert_eq!(created["type"], "freshAgent.created", "{created}");
    let session_id = created["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();

    // 1.5 s keeps the Bash call clear of the CLI's ~3 s background-task
    // promotion (the contract suite's absorbed scenario).
    first
        .send_text(&session_id, "send-tool", "please TOOL:sleep=1.5")
        .await;
    first
        .wait_for("the tool call", |v| {
            v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.assistant"
                && v["event"]["content"]
                    .as_array()
                    .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_use"))
        })
        .await;
    second
        .send_text(&session_id, "send-absorbed", "and one more thing")
        .await;
    accepted(&mut second, "send-absorbed").await;

    wait_for_results(&mut first, 1, "the absorbing turn").await;
    wait_until_busy(&rig, &session_id, false, "after the absorbing turn").await;
    for conn in [&mut first, &mut second] {
        wait_for_results(conn, 1, "the absorbing turn").await;
        conn.read_for(Duration::from_millis(500)).await;
        assert_eq!(
            conn.events_seen("freshAgent.result"),
            1,
            "one result for the two commands: {:?}",
            conn.frames
        );
        assert_eq!(
            results(conn)[0].1["sessionBusy"],
            false,
            "{:?}",
            conn.frames
        );
        assert_eq!(
            statuses(conn, &session_id).last().map(|(_, s)| s.as_str()),
            Some("idle"),
            "{:?}",
            conn.frames
        );
    }

    second
        .send(json!({
            "type": "freshAgent.configure",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session_id,
            "requestId": "configure-1",
            "settings": { "model": "claude-haiku-4-5-20251001" },
        }))
        .await;
    let answer = second
        .wait_for("the configure's metadata or its failure", |v| {
            v["type"] == "freshAgent.event"
                && (v["event"]["type"] == "freshAgent.session.metadata"
                    || v["event"]["type"] == "freshAgent.error")
        })
        .await;
    assert_eq!(
        answer["event"]["type"], "freshAgent.session.metadata",
        "the idle session takes the model change: {answer}"
    );

    let rings_before = [&first, &second].map(|conn| conn.events_seen("freshAgent.turn.complete"));
    first.send_text(&session_id, "send-next", "hello").await;
    for (conn, before) in [&mut first, &mut second].into_iter().zip(rings_before) {
        wait_for_results(conn, 2, "the next turn").await;
        conn.wait_for_event("freshAgent.turn.complete").await;
        conn.read_for(Duration::from_millis(300)).await;
        assert_eq!(
            conn.events_seen("freshAgent.turn.complete"),
            before + 1,
            "the next turn rings once: {:?}",
            conn.frames
        );
    }
    first.kill(&session_id).await;
}

fn send_msg(session_id: &str, request_id: &str, text: &str) -> FreshAgentSend {
    FreshAgentSend {
        provider: AgentProvider::Claude,
        session_id: session_id.to_string(),
        session_type: SessionType::Freshclaude,
        text: text.to_string(),
        cwd: None,
        images: None,
        request_id: Some(request_id.to_string()),
        settings: None,
        observed_epoch: None,
        observed_generation: None,
        checkpoint_intent: None,
    }
}

mod sim {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn submitted_turn_id_is_the_snapshot_turn_id() {
        super::submitted_turn_id_is_the_snapshot_turn_id(RigKind::Sim).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lifecycle_facts_reach_the_server_and_no_client() {
        super::lifecycle_facts_reach_the_server_and_no_client(RigKind::Sim).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_absorbed_send_from_a_second_connection_leaves_both_idle() {
        super::an_absorbed_send_from_a_second_connection_leaves_both_idle(RigKind::Sim).await;
    }

    /// A send pushed while the first turn streams text queues as its own turn
    /// (T10). The first result tells the client the session is still busy
    /// (`sessionBusy: true`) and the server says `running` again after it, so
    /// the pane stays running until the queued turn's own result settles it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_queued_send_keeps_the_client_running_between_its_results() {
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;
        conn.send_text(&session_id, "send-slow", "SLOW").await;
        conn.wait_for("the first streamed text", |v| {
            v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.stream"
                && v["event"]["event"]["type"] == "content_block_delta"
        })
        .await;
        conn.send_text(&session_id, "send-queued", "queued behind")
            .await;
        accepted(&mut conn, "send-queued").await;
        wait_for_results(&mut conn, 2, "both turns").await;
        conn.read_for(Duration::from_millis(300)).await;

        let results = results(&conn);
        assert_eq!(results.len(), 2, "{:?}", conn.frames);
        let (first_at, first) = &results[0];
        let (second_at, second) = &results[1];
        assert_eq!(
            first["sessionBusy"], true,
            "the queued send is owed: {first}"
        );
        assert_eq!(second["sessionBusy"], false, "{second}");
        let statuses = statuses(&conn, &session_id);
        assert!(
            statuses
                .iter()
                .any(|(at, status)| at > first_at && at < second_at && status == "running"),
            "running again after the first result: {statuses:?}"
        );
        assert!(
            !statuses
                .iter()
                .any(|(at, status)| at > first_at && at < second_at && status == "idle"),
            "never idle between the two results: {statuses:?}"
        );
        assert_eq!(
            statuses.last().map(|(_, s)| s.as_str()),
            Some("idle"),
            "{statuses:?}"
        );
        assert!(
            statuses.last().is_some_and(|(at, _)| at > second_at),
            "idle after the last result: {statuses:?}"
        );
        conn.kill(&session_id).await;
    }

    /// A new session's status is the server's from the start: right after
    /// `freshAgent.created` the server says it is `idle` (ready, nothing
    /// owed), so a pane never waits for its first turn to learn it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_new_session_is_announced_idle_right_after_its_creation() {
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;
        let status = conn
            .wait_for("the session's first status", |v| {
                v["type"] == "freshAgent.event"
                    && v["sessionId"] == session_id
                    && v["event"]["type"] == "freshAgent.status"
            })
            .await;
        assert_eq!(status["event"]["status"], "idle", "{status}");
        let created_at = index_of(&conn, "created", |v| v["type"] == "freshAgent.created");
        assert!(
            statuses(&conn, &session_id)[0].0 > created_at,
            "the status follows the creation"
        );
        conn.kill(&session_id).await;
    }

    /// The server publishes `running` when it accepts the send, before the CLI
    /// reports anything: before the acceptance and before any assistant or
    /// stream frame. The session settles `idle` after the result.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn running_is_published_at_accept_before_any_assistant_frame() {
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;
        let sent_at = conn.frames.len();
        conn.send_text(&session_id, "send-1", "hello").await;
        wait_for_results(&mut conn, 1, "hello").await;
        conn.read_for(Duration::from_millis(300)).await;

        let statuses = statuses(&conn, &session_id);
        let (running_at, _) = statuses
            .iter()
            .find(|(at, status)| *at >= sent_at && status == "running")
            .unwrap_or_else(|| panic!("no running status: {:?}", conn.frames));
        let accepted_at = index_of(&conn, "send.accepted", |v| {
            v["type"] == "freshAgent.send.accepted" && v["requestId"] == "send-1"
        });
        let content_at = index_of(&conn, "an assistant or stream frame", |v| {
            v["type"] == "freshAgent.event"
                && matches!(
                    v["event"]["type"].as_str(),
                    Some("freshAgent.assistant" | "freshAgent.stream")
                )
        });
        assert!(
            *running_at < accepted_at,
            "{statuses:?} accepted at {accepted_at}"
        );
        assert!(
            *running_at < content_at,
            "{statuses:?} content at {content_at}"
        );
        let (result_at, _) = results(&conn)[0];
        assert!(
            statuses
                .iter()
                .any(|(at, status)| *at > result_at && status == "idle"),
            "idle after the result: {statuses:?}"
        );
        conn.kill(&session_id).await;
    }

    /// A background agent's completion starts a turn the CLI runs by itself
    /// (T19): no uuid, no lifecycle, only the session state and the turn. The
    /// session is busy for it: the server says `running` after the launching
    /// turn's result and `idle` after the CLI turn's own result.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cli_initiated_turn_is_busy() {
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;
        conn.send_text(&session_id, "send-agent", "AGENT:async")
            .await;
        wait_for_results(&mut conn, 2, "the launching turn and the CLI's own").await;
        conn.read_for(Duration::from_millis(300)).await;

        let results = results(&conn);
        let (first_at, _) = results[0];
        let (second_at, second) = &results[1];
        assert_eq!(second["sessionBusy"], false, "{second}");
        let statuses = statuses(&conn, &session_id);
        assert!(
            statuses
                .iter()
                .any(|(at, status)| *at > first_at && at < second_at && status == "running"),
            "the CLI's own turn is busy: {statuses:?}"
        );
        assert_eq!(
            statuses.last().map(|(_, s)| s.as_str()),
            Some("idle"),
            "{statuses:?}"
        );
        assert!(statuses.last().is_some_and(|(at, _)| at > second_at));
        assert_eq!(
            rig.fresh_claude.session_busy(&session_id).await,
            Some(false)
        );
        conn.kill(&session_id).await;
    }

    /// `handle_send` answers its in-process caller (design §9.3 I2): an accepted
    /// send names the session it went to and its turn id (the one broadcast as
    /// `submittedTurnId`); a refused send names the refusal. `session_busy` reports
    /// whether a live session is working, and nothing for an id with no live session.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handle_send_answers_with_the_accepted_turn_or_the_refusal() {
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;
        assert_eq!(
            rig.fresh_claude.session_busy(&session_id).await,
            Some(false)
        );
        assert_eq!(rig.fresh_claude.session_busy("no-such-session").await, None);

        // HANG: the turn's model request never completes, so the session stays busy.
        let outcome = rig
            .fresh_claude
            .handle_send(send_msg(&session_id, "send-1", "HANG"))
            .await;
        let ClaudeSendOutcome::Accepted {
            session_key,
            submitted_turn_id,
        } = outcome
        else {
            panic!("the send was accepted: {outcome:?}");
        };
        assert_eq!(session_key, session_id);
        assert!(is_uuid(&submitted_turn_id), "{submitted_turn_id}");
        assert_eq!(
            accepted(&mut conn, "send-1").await["submittedTurnId"],
            json!(submitted_turn_id)
        );
        assert_eq!(rig.fresh_claude.session_busy(&session_id).await, Some(true));

        let refused = rig
            .fresh_claude
            .handle_send(send_msg("no-such-session", "send-2", "hello"))
            .await;
        assert!(
            matches!(&refused, ClaudeSendOutcome::Refused { code, .. } if code == "SESSION_NOT_FOUND"),
            "{refused:?}"
        );
        // The refusal reached the sender too.
        conn.wait_for("the send-2 request error", |v| {
            v["type"] == "error" && v["requestId"] == "send-2"
        })
        .await;
        conn.kill(&session_id).await;
        assert_eq!(rig.fresh_claude.session_busy(&session_id).await, None);
    }

    /// The sidecar refuses a send whose image Claude cannot read
    /// (`sdk.send.rejected`, INVALID_IMAGE) and lives on. The server takes the
    /// send back: the sender gets a request error (the composer gets the message
    /// back), the session is not left busy waiting for a turn that never runs,
    /// nothing rings, and the next message runs and rings once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_send_with_a_bad_image_is_taken_back_and_the_session_keeps_working() {
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;

        let mut send = send_msg(&session_id, "send-bad", "look at this");
        send.images = Some(vec![FreshAgentImage {
            data: "PHN2Zy8+".to_string(),
            media_type: "image/svg+xml".to_string(),
        }]);
        conn.send(
            serde_json::to_value(freshell_protocol::ClientMessage::FreshAgentSend(send)).unwrap(),
        )
        .await;
        let error = conn
            .wait_for("the rejected send's request error", |v| {
                v["type"] == "error" && v["requestId"] == "send-bad"
            })
            .await;
        let message = error["message"].as_str().unwrap_or_default();
        assert!(message.starts_with("CLAUDE_SEND_REJECTED: "), "{error}");
        assert!(message.contains("image/svg+xml"), "{error}");

        // The send is taken back: nothing is owed for it.
        let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
        while rig.fresh_claude.session_busy(&session_id).await != Some(false) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the rejected send left the session busy"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        conn.send_text(&session_id, "send-next", "hello").await;
        conn.wait_for_event("freshAgent.result").await;
        conn.wait_for_event("freshAgent.turn.complete").await;
        conn.read_for(Duration::from_millis(300)).await;
        assert_eq!(
            conn.events_seen("freshAgent.turn.complete"),
            1,
            "{:?}",
            conn.frames
        );
        assert_eq!(conn.events_seen("freshAgent.result"), 1);
        assert!(
            !conn
                .frames
                .iter()
                .any(|v| v["event"]["code"] == "SIDECAR_EXITED"),
            "the sidecar lives on: {:?}",
            conn.frames
        );
        let prompts: Vec<Value> = rig
            .ledger_rows("prompt")
            .iter()
            .map(|row| row["text"].clone())
            .collect();
        assert_eq!(prompts, vec![json!("hello")], "the rejected send never ran");
        conn.kill(&session_id).await;
    }
}

mod cli {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn submitted_turn_id_is_the_snapshot_turn_id() {
        super::submitted_turn_id_is_the_snapshot_turn_id(RigKind::Cli).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lifecycle_facts_reach_the_server_and_no_client() {
        super::lifecycle_facts_reach_the_server_and_no_client(RigKind::Cli).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_absorbed_send_from_a_second_connection_leaves_both_idle() {
        super::an_absorbed_send_from_a_second_connection_leaves_both_idle(RigKind::Cli).await;
    }
}
