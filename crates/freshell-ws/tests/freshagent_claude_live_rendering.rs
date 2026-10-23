//! Live rendering of a freshclaude turn, end to end over the real sidecar
//! (transcript-live plan C3): the real `index.mjs` over the CLI simulator
//! (RealSidecarSim, `common::claude_rig`), a real freshell-ws server, its
//! snapshot REST route, and WS clients.
//!
//! The rich turn is a replay of a turn the pinned CLI 2.1.237 really ran
//! (the simulator's `replay` step over the `tools-sync` recording): thinking,
//! streamed text, Write, two Edits (one failing), a Read and a synchronous
//! subagent (`Agent`) that itself reads a file. The replay holds before the
//! subagent's tool result, which is how a test sees the turn mid-way.
//!
//! What a client must get, per the plan's wire contract (§4.2):
//! - every `freshAgent.stream` frame names the API message it belongs to
//!   (`messageId`), and every `freshAgent.assistant` names its transcript
//!   line (`uuid`);
//! - one `freshAgent.session.changed {reason:'transcript'}` per message the
//!   CLI persists, and each such message does reach the transcript;
//! - mid-turn, the REST snapshot already shows the running delegation with
//!   its subagent's running tool call;
//! - after the turn, the snapshot carries the changed files and the token
//!   usage;
//! - API retries, notices and the CLI's own permission-mode change reach
//!   the client, and a configure that changes the permission mode states it.

mod common;

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use common::claude_rig::{repo_root, ClaudeRig, RigConnection, RigKind, RIG_FRAME_BUDGET};

/// The recording the rich turn replays.
const RECORDING: &str = "tools-sync";
/// The recorded uuid of the subagent's tool result: the replay holds before
/// it, so the subagent's Read call stays running for a while.
const SUBAGENT_TOOL_RESULT: &str = "1ee90712-3476-4188-b310-22a881bf6e20";
const REPLAY_PROMPT: &str = "replay the recorded tools turn";
const RETRY_PROMPT: &str = "answer after two overloaded attempts";

async fn rig() -> ClaudeRig {
    let program = json!({ "rules": [
        { "on": "msg:prompt", "match": { "text": REPLAY_PROMPT }, "emit": [
            { "kind": "replay", "data": {
                "recording": RECORDING,
                "holdBeforeMs": { SUBAGENT_TOOL_RESULT: 4000 },
            } },
        ] },
        { "on": "msg:prompt", "match": { "text": RETRY_PROMPT }, "emit": [
            { "kind": "api_retry", "data": { "status": 529, "attempts": 2 } },
            { "kind": "text", "data": { "text": "recovered" } },
        ] },
    ] })
    .to_string();
    ClaudeRig::start_with_env(RigKind::Sim, &[("FRESHELL_CLAUDE_SIM_PROGRAM", &program)]).await
}

/// The `freshAgent.event`s of one inner type this connection read for `session_id`.
fn events<'a>(conn: &'a RigConnection, session_id: &str, event_type: &str) -> Vec<&'a Value> {
    conn.frames
        .iter()
        .filter(|frame| {
            frame["type"] == "freshAgent.event"
                && frame["sessionId"] == session_id
                && frame["event"]["type"] == event_type
        })
        .collect()
}

/// The durable claude id the session's `session.init` named.
fn durable_id(conn: &RigConnection, session_id: &str) -> String {
    events(conn, session_id, "freshAgent.session.init")
        .last()
        .and_then(|frame| frame["event"]["cliSessionId"].as_str())
        .expect("the session reported its durable id")
        .to_string()
}

/// Poll the snapshot route until `ready` holds (the transcript lands about
/// 100 ms after each message, F7).
async fn snapshot_when(
    rig: &ClaudeRig,
    thread_id: &str,
    what: &str,
    ready: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        let (status, snapshot) = rig.snapshot(thread_id).await;
        if status == 200 && ready(&snapshot) {
            return snapshot;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the snapshot never showed {what}; last answer {status}: {snapshot}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Every item of every turn of a snapshot.
fn items(snapshot: &Value) -> Vec<&Value> {
    snapshot["turns"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|turn| turn["items"].as_array().into_iter().flatten())
        .collect()
}

fn delegation(snapshot: &Value) -> Option<&Value> {
    items(snapshot)
        .into_iter()
        .find(|item| item["kind"] == "task_delegation")
}

/// The uuids of every line in the session's transcripts (main and subagents).
fn persisted_uuids(rig: &ClaudeRig) -> BTreeSet<String> {
    fn collect(dir: &Path, out: &mut BTreeSet<String>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "jsonl") {
                let text = std::fs::read_to_string(&path).unwrap_or_default();
                for line in text.lines() {
                    if let Ok(value) = serde_json::from_str::<Value>(line) {
                        if let Some(uuid) = value["uuid"].as_str() {
                            out.insert(uuid.to_string());
                        }
                    }
                }
            }
        }
    }
    let mut out = BTreeSet::new();
    collect(&rig.claude_config_dir.join("projects"), &mut out);
    out
}

/// The replayed recording's changed-file rows, with the session's workspace.
fn recorded_diffs(workspace: &Path) -> Value {
    let golden: Value = serde_json::from_str(
        &std::fs::read_to_string(
            repo_root()
                .join("test/fixtures/fresh-agent/claude/real-cli-2.1.237")
                .join(RECORDING)
                .join("snapshot.golden.json"),
        )
        .expect("the recording's golden snapshot"),
    )
    .expect("the golden parses");
    let workspace = workspace.to_str().expect("a utf-8 workspace");
    serde_json::from_str(
        &golden["diffs"]
            .to_string()
            .replace("/fixture/ws", workspace),
    )
    .expect("the rewritten rows parse")
}

fn recorded_token_usage() -> Value {
    let golden: Value = serde_json::from_str(
        &std::fs::read_to_string(
            repo_root()
                .join("test/fixtures/fresh-agent/claude/real-cli-2.1.237")
                .join(RECORDING)
                .join("snapshot.golden.json"),
        )
        .expect("the recording's golden snapshot"),
    )
    .expect("the golden parses");
    golden["tokenUsage"].clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rich_turn_renders_live_and_its_snapshot_shows_the_delegation_the_diffs_and_the_usage() {
    let rig = rig().await;
    let mut conn = rig.connect().await;
    let session_id = conn.create("live-rich").await;

    conn.send_text(&session_id, "send-rich", REPLAY_PROMPT)
        .await;

    // Mid-turn: the subagent's tool call has been announced (its transcript
    // line is on its way); the REST snapshot shows the running delegation
    // with the running call, before the turn's result.
    let subagent_call = conn
        .wait_for("the subagent's tool call", |frame| {
            frame["type"] == "freshAgent.event"
                && frame["event"]["type"] == "freshAgent.assistant"
                && frame["event"]["parentToolUseId"].is_string()
                && frame["event"]["content"]
                    .as_array()
                    .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_use"))
        })
        .await;
    let agent_tool_use_id = subagent_call["event"]["parentToolUseId"]
        .as_str()
        .expect("the subagent's parent tool call")
        .to_string();
    let durable = durable_id(&conn, &session_id);
    let mid_turn = snapshot_when(
        &rig,
        &durable,
        "the running delegation with its running tool call",
        |snapshot| {
            delegation(snapshot).is_some_and(|item| {
                item["status"] == "running"
                    && item["activity"]
                        .as_array()
                        .is_some_and(|rows| rows.iter().any(|row| row["status"] == "running"))
            })
        },
    )
    .await;
    assert!(
        events(&conn, &session_id, "freshAgent.result").is_empty(),
        "the snapshot was taken mid-turn"
    );
    let running = delegation(&mid_turn).expect("the delegation");
    assert_eq!(running["description"], "check file", "{running}");
    assert_eq!(
        running["activity"],
        json!([{
            "tool": "Read",
            "status": "running",
            "preview": rig.workspace.join("a.txt").to_str().unwrap(),
        }]),
        "{running}"
    );

    conn.wait_for("the rich turn's result", |frame| {
        frame["sessionId"] == session_id.as_str() && frame["event"]["type"] == "freshAgent.result"
    })
    .await;

    // Streams: only main-thread frames, each naming its API message; the
    // message_start names the message every later frame of it carries.
    let streams = events(&conn, &session_id, "freshAgent.stream");
    assert!(streams.len() > 10, "{} stream frames", streams.len());
    let mut started: Vec<String> = Vec::new();
    for frame in &streams {
        let message_id = frame["event"]["messageId"]
            .as_str()
            .unwrap_or_else(|| panic!("a stream frame without its messageId: {frame}"));
        if frame["event"]["event"]["type"] == "message_start" {
            assert_eq!(
                frame["event"]["event"]["message"]["id"], message_id,
                "{frame}"
            );
            started.push(message_id.to_string());
        } else {
            assert_eq!(
                started.last().map(String::as_str),
                Some(message_id),
                "a stream frame of a message that did not start last: {frame}"
            );
        }
        assert_eq!(frame["event"]["parentToolUseId"], Value::Null, "{frame}");
    }

    // Assistant messages name their transcript line; the main thread's
    // name the API message their stream started.
    let assistants = events(&conn, &session_id, "freshAgent.assistant");
    assert!(
        assistants.len() >= 8,
        "{} assistant frames",
        assistants.len()
    );
    for frame in &assistants {
        assert!(frame["event"]["uuid"].is_string(), "{frame}");
        if frame["event"]["parentToolUseId"].is_null() {
            let message_id = frame["event"]["messageId"].as_str().expect("its messageId");
            assert!(started.iter().any(|id| id == message_id), "{frame}");
        }
    }

    // One transcript announcement per persisted message: no repeats, every
    // assistant message announced, and every announced message on disk.
    let announced: Vec<String> = events(&conn, &session_id, "freshAgent.session.changed")
        .into_iter()
        .filter(|frame| frame["event"]["reason"] == "transcript")
        .map(|frame| {
            frame["event"]["uuid"]
                .as_str()
                .expect("an announcement names its uuid")
                .to_string()
        })
        .collect();
    let distinct: BTreeSet<String> = announced.iter().cloned().collect();
    assert_eq!(distinct.len(), announced.len(), "{announced:?}");
    for frame in &assistants {
        let uuid = frame["event"]["uuid"].as_str().unwrap();
        assert!(
            distinct.contains(uuid),
            "assistant {uuid} was not announced"
        );
    }
    let subagent_announcements = events(&conn, &session_id, "freshAgent.session.changed")
        .into_iter()
        .filter(|frame| frame["event"]["parentToolUseId"] == agent_tool_use_id.as_str())
        .count();
    assert!(subagent_announcements >= 2, "{subagent_announcements}");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let persisted = persisted_uuids(&rig);
        let missing: Vec<&String> = distinct.difference(&persisted).collect();
        if missing.is_empty() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "announced but never persisted: {missing:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // After the turn: the completed delegation, the changed files and the usage.
    let done = snapshot_when(&rig, &durable, "the completed delegation", |snapshot| {
        delegation(snapshot).is_some_and(|item| item["status"] == "completed")
    })
    .await;
    let completed = delegation(&done).unwrap();
    assert_eq!(completed["result"], "SUBAGENT-DONE: file has two");
    assert_eq!(completed["activity"][0]["status"], "completed");
    assert_eq!(
        done["diffs"],
        recorded_diffs(&rig.workspace),
        "{}",
        done["diffs"]
    );
    assert_eq!(done["capabilities"]["diffs"], true);
    assert_eq!(done["tokenUsage"], recorded_token_usage());
    let announced_assistants: HashMap<&str, ()> = assistants
        .iter()
        .filter_map(|frame| frame["event"]["uuid"].as_str())
        .map(|uuid| (uuid, ()))
        .collect();
    let line_uuids = done["extensions"]["claude"]["transcriptLineUuids"]
        .as_array()
        .expect("the snapshot lists its newest line uuids");
    assert!(
        line_uuids
            .iter()
            .filter_map(Value::as_str)
            .any(|uuid| announced_assistants.contains_key(uuid)),
        "the landing check's uuids include the turn's messages"
    );

    conn.kill(&session_id).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retries_notices_and_permission_mode_changes_reach_the_client() {
    let rig = rig().await;
    let mut conn = rig.connect().await;
    let created = conn
        .request_create("live-status", json!({ "permissionMode": "plan" }))
        .await;
    assert_eq!(created["type"], "freshAgent.created", "{created}");
    let session_id = created["sessionId"].as_str().unwrap().to_string();

    // Two overloaded attempts, each a retry frame, before the reply streams.
    send_and_wait(&mut conn, &session_id, "send-retry", RETRY_PROMPT).await;
    let retries = events(&conn, &session_id, "freshAgent.retry");
    let attempts: Vec<(Value, Value, Value)> = retries
        .iter()
        .map(|frame| {
            (
                frame["event"]["attempt"].clone(),
                frame["event"]["errorStatus"].clone(),
                frame["event"]["error"].clone(),
            )
        })
        .collect();
    assert_eq!(
        attempts,
        vec![
            (json!(1), json!(529), json!("overloaded")),
            (json!(2), json!(529), json!("overloaded")),
        ]
    );
    let position = |wanted: &Value| conn.frames.iter().position(|frame| frame == wanted);
    let first_stream = events(&conn, &session_id, "freshAgent.stream")[0].clone();
    assert!(position(retries[1]) < position(&first_stream));
    assert!(
        events(&conn, &session_id, "freshAgent.error").is_empty(),
        "a retry is not an error"
    );

    // ExitPlanMode, approved: the CLI leaves plan mode by itself, every
    // client hears it, and the snapshot's live settings follow.
    conn.send_text(&session_id, "send-plan", "PLAN:exit").await;
    let request = conn.wait_for_event("freshAgent.permission.request").await;
    conn.send(json!({
        "type": "freshAgent.approval.respond",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": session_id,
        "requestId": request["event"]["requestId"],
        "decision": { "behavior": "allow" },
    }))
    .await;
    let metadata = conn
        .wait_for("the CLI's permission-mode change", |frame| {
            frame["sessionId"] == session_id.as_str()
                && frame["event"]["type"] == "freshAgent.session.metadata"
                && frame["event"]["permissionMode"] == "default"
        })
        .await;
    assert!(metadata["event"].get("model").is_none(), "{metadata}");
    wait_for_results(&mut conn, &session_id, 2).await;
    let durable = durable_id(&conn, &session_id);
    snapshot_when(&rig, &durable, "the default permission mode", |snapshot| {
        snapshot["settings"]["permissionMode"] == "default"
    })
    .await;

    // A failed compaction is a notice, not an error, and the turn ends normally.
    send_and_wait(
        &mut conn,
        &session_id,
        "send-compact",
        "/compact APIERR:400",
    )
    .await;
    let notices = events(&conn, &session_id, "freshAgent.notice");
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0]["event"]["level"], "error");
    assert_eq!(notices[0]["event"]["code"], "COMPACTION_FAILED");
    assert!(
        notices[0]["event"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("400")),
        "{}",
        notices[0]
    );
    assert!(events(&conn, &session_id, "freshAgent.error").is_empty());

    // Back to plan mode through a configure: its metadata states the mode.
    conn.send(json!({
        "type": "freshAgent.configure",
        "provider": "claude",
        "sessionType": "freshclaude",
        "sessionId": session_id,
        "requestId": "configure-plan",
        "settings": { "permissionMode": "plan" },
    }))
    .await;
    conn.wait_for("the configure's metadata", |frame| {
        frame["sessionId"] == session_id.as_str()
            && frame["event"]["type"] == "freshAgent.session.metadata"
            && frame["event"]["permissionMode"] == "plan"
    })
    .await;
    let control = rig.ledger_rows("control");
    assert!(
        control
            .iter()
            .any(|row| row["name"] == "setPermissionMode" && row["args"] == json!(["plan"])),
        "the configure reached the CLI: {control:?}"
    );

    conn.kill(&session_id).await;
}

/// Send `text` and wait for the turn's result.
async fn send_and_wait(conn: &mut RigConnection, session_id: &str, request_id: &str, text: &str) {
    let before = events(conn, session_id, "freshAgent.result").len();
    conn.send_text(session_id, request_id, text).await;
    wait_for_results(conn, session_id, before + 1).await;
}

/// Wait until this connection has read `count` results for the session.
async fn wait_for_results(conn: &mut RigConnection, session_id: &str, count: usize) {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    while events(conn, session_id, "freshAgent.result").len() < count {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for result {count} of {session_id}"
        );
        conn.read_for(Duration::from_millis(100)).await;
    }
}
