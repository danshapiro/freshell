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
//!
//! C18, the server mints every attention edge (design §5.3-§5.5): a result rings
//! unless the user's own Stop landed on it, and a failed one shows why; a death
//! with a turn owed rings; a pending approval or question rings the waiting
//! edge. The sidecar mints none. A Stop targets only the running turn
//! (decision 1: another device's queued message runs and rings), an idle Stop
//! sends nothing, and a Stop that missed a command the CLI was still starting
//! (T13: every receipt shape, through the simulator's cold-command knob) is
//! sent again and the turn ends aborted and silent. In-process observers get
//! the same truth as typed turn events (§9.3 I3) and attention hooks (§9.2 I-1).

mod common;

use std::time::Duration;

use serde_json::{json, Value};

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RigOptions, RIG_FRAME_BUDGET};
use common::log_capture;
use freshell_freshagent::{AttentionObserver, ClaudeSendOutcome, ClaudeTurnEvent, TurnOutcome};
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
/// (logged, and folded into the turn ledger) and never reach a client: no
/// client is shown a model request or the end of a status as a status.
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

// ── C18: the server mints every attention edge; the Stop latch ───────────────

/// The user's Stop.
async fn stop(conn: &mut RigConnection, session_id: &str) {
    conn.send(json!({
        "type": "freshAgent.interrupt",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": session_id,
    }))
    .await;
}

/// The session's events of this inner type this connection read, in order.
fn session_events<'a>(
    conn: &'a RigConnection,
    session_id: &str,
    event_type: &str,
) -> Vec<&'a Value> {
    conn.frames
        .iter()
        .filter(|v| {
            v["type"] == "freshAgent.event"
                && v["sessionId"] == session_id
                && v["event"]["type"] == event_type
        })
        .collect()
}

/// The first streamed text delta: the turn runs (its command started).
async fn wait_for_streamed_text(conn: &mut RigConnection) {
    conn.wait_for("the first streamed text", |v| {
        v["type"] == "freshAgent.event"
            && v["event"]["type"] == "freshAgent.stream"
            && v["event"]["event"]["type"] == "content_block_delta"
    })
    .await;
}

/// The turn ended aborted (T11), with no edge and no banner: the user's own
/// Stop. The session settles idle.
fn assert_stopped_silently(conn: &RigConnection, session_id: &str) {
    let results = session_events(conn, session_id, "freshAgent.result");
    let result = &results.last().expect("a result")["event"];
    assert_eq!(result["subtype"], "error_during_execution", "{result}");
    assert!(
        result["terminalReason"]
            .as_str()
            .is_some_and(|reason| reason.starts_with("aborted_")),
        "the turn was aborted: {result}"
    );
    assert_eq!(
        session_events(conn, session_id, "freshAgent.turn.complete").len(),
        0,
        "the user's own Stop never rings: {:?}",
        conn.frames
    );
    assert_eq!(
        session_events(conn, session_id, "freshAgent.error").len(),
        0,
        "the user's own Stop shows no banner: {:?}",
        conn.frames
    );
    assert_eq!(
        statuses(conn, session_id).last().map(|(_, s)| s.as_str()),
        Some("idle"),
        "{:?}",
        conn.frames
    );
}

/// The next turn runs and rings exactly once more.
async fn the_next_turn_rings_once(conn: &mut RigConnection, session_id: &str) {
    let rings = session_events(conn, session_id, "freshAgent.turn.complete").len();
    let results = conn.events_seen("freshAgent.result");
    conn.send_text(session_id, "send-next", "hello").await;
    wait_for_results(conn, results + 1, "the next turn").await;
    conn.wait_for("the next turn's edge", |v| {
        v["type"] == "freshAgent.event"
            && v["sessionId"] == session_id
            && v["event"]["type"] == "freshAgent.turn.complete"
    })
    .await;
    conn.read_for(Duration::from_millis(300)).await;
    assert_eq!(
        session_events(conn, session_id, "freshAgent.turn.complete").len(),
        rings + 1,
        "{:?}",
        conn.frames
    );
}

/// Design §11.5 item 2: a Stop while the turn streams text ends it aborted,
/// silently (no edge, no "Agent error" banner, G03), and the next turn rings.
async fn a_warm_stop_is_silent(kind: RigKind) {
    let rig = ClaudeRig::start(kind).await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "SLOW stop me").await;
    wait_for_streamed_text(&mut conn).await;
    stop(&mut conn, &session_id).await;
    wait_for_results(&mut conn, 1, "the stopped turn").await;
    conn.read_for(Duration::from_millis(500)).await;
    assert_stopped_silently(&conn, &session_id);
    the_next_turn_rings_once(&mut conn, &session_id).await;
    conn.kill(&session_id).await;
}

/// Design §11.5 item 3: a Stop sent right after the send, while the CLI may
/// still be starting the command (T13). Whichever way the race goes - the
/// Stop lands, or it misses and is sent again once the command runs - the turn
/// ends aborted and silent.
async fn a_stop_right_after_the_send_is_silent(kind: RigKind) {
    let rig = ClaudeRig::start(kind).await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "SLOW stop me early")
        .await;
    accepted(&mut conn, "send-1").await;
    stop(&mut conn, &session_id).await;
    wait_for_results(&mut conn, 1, "the stopped turn").await;
    conn.read_for(Duration::from_millis(500)).await;
    assert_stopped_silently(&conn, &session_id);
    the_next_turn_rings_once(&mut conn, &session_id).await;
    conn.kill(&session_id).await;
}

/// The interrupts the simulated CLI took.
fn sim_interrupts(rig: &ClaudeRig) -> Vec<Value> {
    rig.ledger_rows("interrupt")
}

/// The Stop decisions logged for this session.
fn stop_logs(logs: &log_capture::LogCapture, session_id: &str) -> Vec<log_capture::CapturedEvent> {
    logs.matching(|event| {
        event.message == "freshagent.claude.stop" && event.field("session_id") == Some(session_id)
    })
}

/// A cold Stop (T13): the simulator's cold-command knob makes the first
/// command miss a Stop that arrives while it still starts, with the receipt
/// shape `shape`. The server sends the Stop again under re-send rule `case`
/// once the command runs, and the turn ends aborted and silent.
async fn a_cold_stop_is_aborted_and_silent(shape: &str, case: &str) {
    let logs = log_capture::install();
    let rig =
        ClaudeRig::start_with_env(RigKind::Sim, &[("FRESHELL_CLAUDE_SIM_COLD_COMMAND", shape)])
            .await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("create-1").await;
    conn.send_text(&session_id, "send-1", "SLOW cold").await;
    let uuid = accepted(&mut conn, "send-1").await["submittedTurnId"]
        .as_str()
        .expect("submittedTurnId")
        .to_string();
    stop(&mut conn, &session_id).await;
    wait_for_results(&mut conn, 1, "the stopped turn").await;
    conn.read_for(Duration::from_millis(500)).await;
    assert_stopped_silently(&conn, &session_id);

    let interrupts = sim_interrupts(&rig);
    assert_eq!(
        interrupts.len(),
        2,
        "the Stop and its re-send: {interrupts:?}"
    );
    assert_eq!(interrupts[0]["missed"], json!(uuid), "{interrupts:?}");
    assert_eq!(interrupts[1]["running"], true, "{interrupts:?}");
    let stops = stop_logs(&logs, &session_id);
    let outcomes: Vec<(Option<&str>, Option<&str>)> = stops
        .iter()
        .map(|event| (event.field("outcome"), event.field("case")))
        .collect();
    assert_eq!(
        outcomes,
        vec![(Some("sent"), None), (Some("reissued"), Some(case))],
        "{stops:?}"
    );
    assert_eq!(stops[0].field("target"), Some("not_started"));
    the_next_turn_rings_once(&mut conn, &session_id).await;
    conn.kill(&session_id).await;
}

/// Records every attention hook it is given.
#[derive(Default)]
struct RecordingObserver(std::sync::Mutex<Vec<String>>);

impl AttentionObserver for RecordingObserver {
    fn on_registered(&self, id: &str, session_type: &str) {
        self.0
            .lock()
            .unwrap()
            .push(format!("registered {id} {session_type}"));
    }
    fn on_turn_complete(&self, id: &str, _session_type: &str, at: i64) {
        self.0.lock().unwrap().push(format!("complete {id} {at}"));
    }
    fn on_waiting(&self, id: &str, _session_type: &str, at: i64) {
        self.0.lock().unwrap().push(format!("waiting {id} {at}"));
    }
    fn on_pending_drained(&self, id: &str) {
        self.0.lock().unwrap().push(format!("drained {id}"));
    }
    fn on_forgotten(&self, id: &str) {
        self.0.lock().unwrap().push(format!("forgotten {id}"));
    }
}

impl RecordingObserver {
    fn calls(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

mod sim {
    use super::*;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_warm_stop_is_silent() {
        super::a_warm_stop_is_silent(RigKind::Sim).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stop_right_after_the_send_is_silent() {
        super::a_stop_right_after_the_send_is_silent(RigKind::Sim).await;
    }

    /// Case A, receipt `[]` before the command's lifecycle (the Stop overtook
    /// the command): re-sent at its start.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cold_stop_overtaking_the_command_is_aborted_and_silent() {
        super::a_cold_stop_is_aborted_and_silent("empty", "A").await;
    }

    /// Case A, receipt `[uuid]` (the command was queued): re-sent at its start.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cold_stop_listing_the_command_is_aborted_and_silent() {
        super::a_cold_stop_is_aborted_and_silent("queued", "A").await;
    }

    /// Case B, receipt `[]` after the command's queued and started: re-sent on
    /// its replay, its first content.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cold_stop_after_the_commands_start_is_aborted_on_the_replay() {
        super::a_cold_stop_is_aborted_and_silent("started", "B").await;
    }

    /// A Stop that races the turn's completion: it misses a command that is
    /// still starting, and the command finishes before the re-sent interrupt
    /// lands. The user believes it stopped, and it did not: it rings, once,
    /// with no banner (G06).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stop_racing_completion_rings() {
        let rig = ClaudeRig::start_with_env(
            RigKind::Sim,
            &[("FRESHELL_CLAUDE_SIM_COLD_COMMAND", "started")],
        )
        .await;
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;
        // A plain text turn: once it produces content it finishes at once.
        conn.send_text(&session_id, "send-1", "hello").await;
        accepted(&mut conn, "send-1").await;
        stop(&mut conn, &session_id).await;
        wait_for_results(&mut conn, 1, "the turn").await;
        conn.wait_for_event("freshAgent.turn.complete").await;
        conn.read_for(Duration::from_millis(500)).await;
        let result = &session_events(&conn, &session_id, "freshAgent.result")[0]["event"];
        assert_eq!(result["subtype"], "success", "{result}");
        assert_eq!(
            session_events(&conn, &session_id, "freshAgent.turn.complete").len(),
            1,
            "{:?}",
            conn.frames
        );
        assert!(session_events(&conn, &session_id, "freshAgent.error").is_empty());
        assert_eq!(sim_interrupts(&rig).len(), 2, "the Stop was sent again");
        the_next_turn_rings_once(&mut conn, &session_id).await;
        conn.kill(&session_id).await;
    }

    /// Decision 1: a Stop targets only the running turn. A message another
    /// device queued behind it runs as its own turn and rings, on every
    /// device; the stopped turn is silent, and no Stop reaches the queued one.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stop_leaves_another_devices_queued_send_to_run_and_ring() {
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut first = rig.connect().await;
        let mut second = rig.connect().await;
        let session_id = first.create("create-1").await;
        first.send_text(&session_id, "send-1", "SLOW stop me").await;
        wait_for_streamed_text(&mut first).await;
        second
            .send_text(&session_id, "send-queued", "the other device's message")
            .await;
        accepted(&mut second, "send-queued").await;
        stop(&mut first, &session_id).await;
        for conn in [&mut first, &mut second] {
            wait_for_results(conn, 2, "the stopped turn and the queued one").await;
            conn.wait_for_event("freshAgent.turn.complete").await;
            conn.read_for(Duration::from_millis(500)).await;
            let results = session_events(conn, &session_id, "freshAgent.result");
            assert!(
                results[0]["event"]["terminalReason"]
                    .as_str()
                    .is_some_and(|reason| reason.starts_with("aborted_")),
                "{:?}",
                conn.frames
            );
            assert_eq!(results[1]["event"]["subtype"], "success");
            assert_eq!(results[1]["event"]["sessionBusy"], false);
            assert_eq!(
                session_events(conn, &session_id, "freshAgent.turn.complete").len(),
                1,
                "only the queued turn rings: {:?}",
                conn.frames
            );
            let second_result_at = conn
                .frames
                .iter()
                .position(|v| std::ptr::eq(v, results[1]))
                .unwrap();
            let ring_at = conn
                .frames
                .iter()
                .position(|v| v["event"]["type"] == "freshAgent.turn.complete")
                .unwrap();
            assert!(ring_at > second_result_at, "the queued turn's result rings");
            assert!(session_events(conn, &session_id, "freshAgent.error").is_empty());
        }
        assert_eq!(
            sim_interrupts(&rig).len(),
            1,
            "no Stop reached the queued turn"
        );
        first.kill(&session_id).await;
    }

    /// A Stop with nothing running sends nothing (logged `idle`) and leaves
    /// nothing behind: the next turn rings.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_idle_stop_is_a_no_op() {
        let logs = log_capture::install();
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;
        stop(&mut conn, &session_id).await;
        logs.wait_for("the idle Stop", |event| {
            event.message == "freshagent.claude.stop"
                && event.field("session_id") == Some(session_id.as_str())
        })
        .await;
        conn.read_for(Duration::from_millis(300)).await;
        assert_eq!(
            stop_logs(&logs, &session_id)
                .iter()
                .map(|event| event.field("outcome").unwrap_or_default().to_string())
                .collect::<Vec<_>>(),
            ["idle"]
        );
        assert!(
            sim_interrupts(&rig).is_empty(),
            "no interrupt reached the CLI"
        );
        assert!(session_events(&conn, &session_id, "freshAgent.error").is_empty());
        the_next_turn_rings_once(&mut conn, &session_id).await;
        conn.kill(&session_id).await;
    }

    /// A turn the CLI starts by itself (a background agent finished, T19) rings
    /// when it ends, like any other turn.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cli_initiated_turn_rings() {
        let logs = log_capture::install();
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;
        conn.send_text(&session_id, "send-agent", "AGENT:async")
            .await;
        wait_for_results(&mut conn, 2, "the launching turn and the CLI's own").await;
        conn.read_for(Duration::from_millis(500)).await;
        let rings = session_events(&conn, &session_id, "freshAgent.turn.complete");
        assert_eq!(rings.len(), 2, "{:?}", conn.frames);
        let (second_result_at, _) = results(&conn)[1];
        assert!(
            conn.frames
                .iter()
                .skip(second_result_at)
                .any(|v| v["event"]["type"] == "freshAgent.turn.complete"),
            "the CLI's own turn rings after its result"
        );
        // Minted by the server from each result.
        let minted = logs.matching(|event| {
            event.message == "freshagent.turn.complete"
                && event.field("session_id") == Some(session_id.as_str())
        });
        assert_eq!(
            minted
                .iter()
                .map(|event| event.field("source").unwrap_or_default().to_string())
                .collect::<Vec<_>>(),
            ["result", "result"]
        );
        conn.kill(&session_id).await;
    }

    /// An API error (T18) rings once and shows no banner: the transcript shows
    /// the error itself.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_api_error_result_rings_with_no_banner() {
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;
        conn.send_text(&session_id, "send-1", "APIERR:500").await;
        wait_for_results(&mut conn, 1, "the API error").await;
        conn.wait_for_event("freshAgent.turn.complete").await;
        conn.read_for(Duration::from_millis(500)).await;
        let result = &session_events(&conn, &session_id, "freshAgent.result")[0]["event"];
        assert_eq!(result["subtype"], "success", "{result}");
        assert_eq!(result["isError"], true, "{result}");
        assert_eq!(
            session_events(&conn, &session_id, "freshAgent.turn.complete").len(),
            1
        );
        assert!(
            session_events(&conn, &session_id, "freshAgent.error").is_empty(),
            "{:?}",
            conn.frames
        );
        conn.kill(&session_id).await;
    }

    /// A turn that ends `error_max_turns` rings once and shows why, after its
    /// result (the nested `CLAUDE_TURN_FAILED` banner; the CLI gave no text of
    /// its own, so the banner is the copy for the result kind).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn error_max_turns_rings_with_a_banner() {
        let program = json!({ "rules": [{
            "on": "msg:prompt", "match": { "text": "max turns" },
            "emit": [{ "kind": "completion", "data": { "subtype": "error_max_turns", "errors": [] } }],
        }] })
        .to_string();
        let rig =
            ClaudeRig::start_with_env(RigKind::Sim, &[("FRESHELL_CLAUDE_SIM_PROGRAM", &program)])
                .await;
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;
        conn.send_text(&session_id, "send-1", "max turns").await;
        wait_for_results(&mut conn, 1, "the failed turn").await;
        conn.wait_for_event("freshAgent.turn.complete").await;
        conn.read_for(Duration::from_millis(500)).await;
        let errors = session_events(&conn, &session_id, "freshAgent.error");
        assert_eq!(errors.len(), 1, "{:?}", conn.frames);
        assert_eq!(errors[0]["event"]["code"], "CLAUDE_TURN_FAILED");
        assert_eq!(
            errors[0]["event"]["message"],
            "Claude reached its turn limit. Send a message to continue."
        );
        assert_eq!(
            session_events(&conn, &session_id, "freshAgent.turn.complete").len(),
            1
        );
        let (result_at, _) = results(&conn)[0];
        let error_at = index_of(&conn, "the banner", |v| {
            v["event"]["type"] == "freshAgent.error"
        });
        let ring_at = index_of(&conn, "the edge", |v| {
            v["event"]["type"] == "freshAgent.turn.complete"
        });
        assert!(
            result_at < error_at && error_at < ring_at,
            "result, banner, edge"
        );
        conn.kill(&session_id).await;
    }

    /// G24: the result's edge and the death's edge come from one clock: the
    /// death of a queued turn right after a result rings with a strictly
    /// larger `at` (the client drops an edge whose `at` is not above the last).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_death_after_a_result_rings_with_a_strictly_larger_at() {
        let program = json!({ "rules": [{
            "on": "msg:prompt", "match": { "text": "die" }, "emit": [{ "kind": "crash" }],
        }] })
        .to_string();
        let rig = ClaudeRig::start_with_env(
            RigKind::Sim,
            &[
                ("FRESHELL_CLAUDE_SIM_PROGRAM", program.as_str()),
                ("FRESHELL_CLAUDE_SIM_TIME_SCALE", "0"),
            ],
        )
        .await;
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;
        conn.send_text(&session_id, "send-1", "hello").await;
        conn.send_text(&session_id, "send-2", "die").await;
        conn.wait_for("the exit report", |v| {
            v["event"]["code"] == "SIDECAR_EXITED"
        })
        .await;
        conn.read_for(Duration::from_millis(500)).await;
        let rings: Vec<i64> = session_events(&conn, &session_id, "freshAgent.turn.complete")
            .iter()
            .map(|v| v["event"]["at"].as_i64().expect("a numeric at"))
            .collect();
        assert_eq!(
            rings.len(),
            2,
            "the result and the death: {:?}",
            conn.frames
        );
        assert!(rings[1] > rings[0], "{rings:?}");
    }

    /// The waiting edge is the server's: on the 0 -> >=1 pending transition,
    /// after the approval request it follows, once, logged with source
    /// `pending`; the turn's end then rings once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_waiting_edge_is_minted_by_the_server() {
        let logs = log_capture::install();
        let program = json!({ "rules": [{
            "on": "msg:prompt", "match": { "text": "ask" },
            "emit": [{ "kind": "approval", "data": { "tool": "Bash", "input": { "command": "ls" } } }],
        }] })
        .to_string();
        let rig =
            ClaudeRig::start_with_env(RigKind::Sim, &[("FRESHELL_CLAUDE_SIM_PROGRAM", &program)])
                .await;
        let mut conn = rig.connect().await;
        let created = conn
            .request_create("create-1", json!({ "permissionMode": "default" }))
            .await;
        let session_id = created["sessionId"]
            .as_str()
            .expect("sessionId")
            .to_string();
        conn.send_text(&session_id, "send-1", "ask").await;
        let request = conn.wait_for_event("freshAgent.permission.request").await;
        let waiting = conn.wait_for_event("freshAgent.turn.waiting").await;
        assert!(waiting["event"]["at"].as_i64().is_some(), "{waiting}");
        let request_at = index_of(&conn, "the request", |v| {
            v["event"]["type"] == "freshAgent.permission.request"
        });
        let waiting_at = index_of(&conn, "the edge", |v| {
            v["event"]["type"] == "freshAgent.turn.waiting"
        });
        assert!(request_at < waiting_at, "the edge follows the request");
        let minted = logs
            .wait_for("the minted waiting edge", |event| {
                event.message == "freshagent.turn.waiting"
                    && event.field("session_id") == Some(session_id.as_str())
            })
            .await;
        assert_eq!(minted.field("source"), Some("pending"));

        conn.send(json!({
            "type": "freshAgent.approval.respond",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session_id,
            "requestId": request["event"]["requestId"],
            "decision": { "behavior": "allow", "updatedInput": { "command": "ls" } },
        }))
        .await;
        wait_for_results(&mut conn, 1, "the approved turn").await;
        conn.wait_for_event("freshAgent.turn.complete").await;
        conn.read_for(Duration::from_millis(300)).await;
        assert_eq!(
            session_events(&conn, &session_id, "freshAgent.turn.waiting").len(),
            1
        );
        assert_eq!(
            session_events(&conn, &session_id, "freshAgent.turn.complete").len(),
            1
        );
        conn.kill(&session_id).await;
    }

    /// Answering one approval then receiving another creates another waiting
    /// interval. Each request is announced before its one edge; the result
    /// remains a separate single completion edge.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sequential_approvals_each_raise_one_waiting_edge() {
        let program = json!({"rules": [{
            "on": "msg:prompt", "match": {"text": "ask twice"},
            "emit": [
                {"kind": "approval", "data": {"tool":"Bash", "input":{"command":"ls"}}},
                {"kind": "approval", "data": {"tool":"Bash", "input":{"command":"pwd"}}},
                {"kind": "text", "data":{"text":"both answered"}},
            ],
        }]})
        .to_string();
        let rig =
            ClaudeRig::start_with_env(RigKind::Sim, &[("FRESHELL_CLAUDE_SIM_PROGRAM", &program)])
                .await;
        let mut conn = rig.connect().await;
        let created = conn
            .request_create("create-1", json!({"permissionMode":"default"}))
            .await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        conn.send_text(&session_id, "send-1", "ask twice").await;
        let mut previous_at = 0i64;
        for command in ["ls", "pwd"] {
            let request = conn
                .wait_for("the next approval", |frame| {
                    frame["event"]["type"] == "freshAgent.permission.request"
                        && frame["event"]["tool"]["input"]["command"] == command
                })
                .await;
            let waiting = conn
                .wait_for("the next waiting edge", |frame| {
                    frame["event"]["type"] == "freshAgent.turn.waiting"
                        && frame["event"]["at"]
                            .as_i64()
                            .is_some_and(|at| at > previous_at)
                })
                .await;
            previous_at = waiting["event"]["at"].as_i64().unwrap();
            conn.send(json!({
                "type":"freshAgent.approval.respond", "provider":"claude", "sessionType":"freshclaude",
                "sessionId":session_id, "requestId":request["event"]["requestId"],
                "decision":{"behavior":"allow", "updatedInput":{"command":command}},
            })).await;
        }
        wait_for_results(&mut conn, 1, "the twice-approved turn").await;
        conn.wait_for_event("freshAgent.turn.complete").await;
        conn.read_for(Duration::from_millis(200)).await;
        assert_eq!(
            session_events(&conn, &session_id, "freshAgent.turn.waiting").len(),
            2
        );
        assert_eq!(
            session_events(&conn, &session_id, "freshAgent.turn.complete").len(),
            1
        );
        conn.kill(&session_id).await;
    }

    /// In-process observers (design §9.3 I3, §9.2 I-1): every settled turn is
    /// published with the requests it retired and its edge's `at`, a turn the
    /// user's Stop silenced with no `at`; the attention observer hears the
    /// registration, each edge and the close.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn turn_events_and_attention_hooks_follow_every_settled_turn() {
        let rig = ClaudeRig::start_with_options(RigKind::Sim, RigOptions::default()).await;
        let observer = std::sync::Arc::new(RecordingObserver::default());
        let _ = rig
            .fresh_claude
            .clone()
            .with_attention_observer(observer.clone());
        let mut events = rig.fresh_claude.subscribe_turn_events();
        let mut conn = rig.connect().await;
        let session_id = conn.create("create-1").await;

        conn.send_text(&session_id, "send-1", "hello").await;
        let uuid = accepted(&mut conn, "send-1").await["submittedTurnId"]
            .as_str()
            .expect("submittedTurnId")
            .to_string();
        let ring = conn.wait_for_event("freshAgent.turn.complete").await;
        let at = ring["event"]["at"].as_i64().expect("at");
        let settled = tokio::time::timeout(RIG_FRAME_BUDGET, events.recv())
            .await
            .expect("a turn event")
            .expect("the channel is open");
        assert_eq!(
            settled,
            ClaudeTurnEvent::Settled {
                session_key: session_id.clone(),
                retired_request_ids: vec!["send-1".to_string()],
                retired_command_ids: vec![uuid],
                outcome: TurnOutcome::Completed,
                at: Some(at),
            }
        );

        conn.send_text(&session_id, "send-2", "SLOW stop me").await;
        wait_for_streamed_text(&mut conn).await;
        stop(&mut conn, &session_id).await;
        let silenced = tokio::time::timeout(RIG_FRAME_BUDGET, events.recv())
            .await
            .expect("a turn event")
            .expect("the channel is open");
        assert!(
            matches!(
                &silenced,
                ClaudeTurnEvent::Settled { retired_request_ids, outcome: TurnOutcome::Interrupted, at: None, .. }
                    if retired_request_ids == &vec!["send-2".to_string()]
            ),
            "{silenced:?}"
        );
        conn.kill(&session_id).await;
        assert_eq!(
            observer.calls(),
            vec![
                format!("registered {session_id} freshclaude"),
                format!("complete {session_id} {at}"),
                format!("forgotten {session_id}"),
            ]
        );
    }

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
            ..
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
            matches!(&refused, ClaudeSendOutcome::Refused { code, .. } if code == "INVALID_SESSION_ID"),
            "{refused:?}"
        );
        // The pane learns the conversation is missing, and its unsent prompt
        // is returned to the sender with the same typed outcome.
        conn.wait_for("the missing conversation", |v| {
            v["event"]["code"] == "INVALID_SESSION_ID" && v["sessionId"] == "no-such-session"
        })
        .await;
        let error = conn
            .wait_for("the send-2 request error", |v| {
                v["type"] == "error" && v["requestId"] == "send-2"
            })
            .await;
        assert_eq!(error["code"], "INVALID_SESSION_ID");
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_warm_stop_is_silent() {
        super::a_warm_stop_is_silent(RigKind::Cli).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stop_right_after_the_send_is_silent() {
        super::a_stop_right_after_the_send_is_silent(RigKind::Cli).await;
    }
}
