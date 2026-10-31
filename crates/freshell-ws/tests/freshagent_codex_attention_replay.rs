mod common;
use common::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
static ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
struct Environment(Vec<(&'static str, Option<std::ffi::OsString>)>);
impl Drop for Environment {
    fn drop(&mut self) {
        for (key, value) in &self.0 {
            if let Some(value) = value {
                std::env::set_var(key, value)
            } else {
                std::env::remove_var(key)
            }
        }
    }
}

async fn ready_with_replay(url: &str, enabled: bool) -> Value {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    ws.send(Message::Text(json!({"type":"hello","token":AUTH_TOKEN,"protocolVersion":freshell_protocol::WS_PROTOCOL_VERSION,"capabilities":{"freshAgentAttentionReplayV1":enabled}}).to_string())).await.unwrap();
    let frame = tokio::time::timeout(FRAME_BUDGET, ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(raw) = frame else {
        panic!("ready text")
    };
    serde_json::from_str(&raw).unwrap()
}
async fn ready(url: &str) -> Value {
    ready_with_replay(url, true).await
}
async fn event(ws: &mut TestWs, kind: &str) -> Value {
    loop {
        let value = next_frame_of_type(ws, "freshAgent.event").await;
        if value["event"]["type"] == kind {
            return value["event"].clone();
        }
    }
}
async fn run_replay(async_question: bool) {
    let _guard = ENV.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let keys = [
        "CODEX_CMD",
        "CODEX_HOME",
        "FAKE_CODEX_APP_SERVER_BEHAVIOR",
        "FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES",
    ];
    let _environment = Environment(
        keys.iter()
            .map(|key| (*key, std::env::var_os(key)))
            .collect(),
    );
    std::env::set_var(
        "CODEX_CMD",
        format!(
            "node {}/../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs",
            env!("CARGO_MANIFEST_DIR")
        ),
    );
    std::env::set_var("CODEX_HOME", dir.path().join("codex-home"));
    std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");
    std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR",json!({"recordTurns":true,"overrides":{"turn/start":{"result":{"turn":{"id":"replay-turn","status":"inProgress"}}}},"serverRequestsByPrompt":{"ask":{"id":51,"method":"item/tool/requestUserInput","params":{"isBlocking":false,"questions":[{"id":"choice","header":"Choice","question":"Which?","options":null}]}}},"notificationsAfterMethods":{"thread/read":[{"method":"item/completed","params":{"threadId":"thread-new-1","turnId":"replay-turn","item":{"id":"async-replay","type":"agentMessage","text":"Work continues","delivery":"async","questions":[{"title":"Where?","options":["Staging"]}]}}}]}}).to_string());
    let (url, _registry, state) = spawn_server_with_specs_and_state(vec![]).await;
    state.fresh_codex.set_enabled(true);
    let (mut first, _) = connect_and_capture_inventory(&url).await;
    state.fresh_codex.handle_create(serde_json::from_value(json!({"requestId":"create-replay","provider":"codex","sessionType":"freshcodex","cwd":dir.path(),"permissionMode":"never"})).unwrap(),None).await;
    let created = next_frame_of_type(&mut first, "freshAgent.created").await;
    let session_id = created["sessionId"].as_str().unwrap();
    state.fresh_codex.handle_send(serde_json::from_value(json!({"requestId":"send-replay","provider":"codex","sessionType":"freshcodex","sessionId":session_id,"text":"ask"})).unwrap()).await;
    let request = event(&mut first, "freshAgent.question.request").await;
    let waiting = event(&mut first, "freshAgent.turn.waiting").await;
    let available = if async_question {
        state
            .fresh_codex
            .get_snapshot(session_id, None)
            .await
            .unwrap();
        Some(event(&mut first, "freshAgent.question.available").await)
    } else {
        None
    };
    let unnegotiated = ready_with_replay(&url, false).await;
    assert!(
        unnegotiated.get("freshAgentAttention").is_none(),
        "unnegotiated ready must omit replay"
    );
    let before = ready(&url).await;
    state.fresh_codex.handle_question_respond(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":session_id,"requestId":request["requestId"],"answers":{"choice":"answer"}})).unwrap()).await;
    let after = ready(&url).await;
    state.fresh_codex.shutdown().await;
    let find = |value: &Value| {
        value["freshAgentAttention"]
            .as_array()
            .and_then(|marks| marks.iter().find(|mark| mark["sessionId"] == session_id))
            .cloned()
            .unwrap_or_else(|| json!(null))
    };
    if let Some(available) = available {
        assert_eq!(
            find(&before)["lastQuestionAvailableAt"],
            available["at"],
            "async question replay must be separate from awaited state: {before}"
        );
        assert_eq!(find(&after)["lastQuestionAvailableAt"], available["at"]);
    } else {
        assert_eq!(
            find(&before)["lastWaitingAt"],
            waiting["at"],
            "awaited Codex control must seed ready replay: {before}"
        );
        assert!(find(&after).get("lastWaitingAt").is_none());
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task5_ready_replays_awaited_codex_controls_only_while_pending() {
    run_replay(false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task5_ready_separates_nonblocking_async_question_attention() {
    run_replay(true).await;
}

async fn replay_after_native_exit(mint_new: bool) {
    let _guard = ENV.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let keys = [
        "CODEX_CMD",
        "CODEX_HOME",
        "FAKE_CODEX_APP_SERVER_BEHAVIOR",
        "FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES",
    ];
    let _environment = Environment(
        keys.iter()
            .map(|key| (*key, std::env::var_os(key)))
            .collect(),
    );
    std::env::set_var(
        "CODEX_CMD",
        format!(
            "node {}/../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs",
            env!("CARGO_MANIFEST_DIR")
        ),
    );
    std::env::set_var("CODEX_HOME", dir.path().join("codex"));
    std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");
    std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR", json!({"threadStartThreadId":"replay-old","recordTurns":true,"exitProcessAfterMethodsOnce":["turn/start"]}).to_string());
    let (url, _, state) = spawn_server_with_specs_and_state(vec![]).await;
    state.fresh_codex.set_enabled(true);
    let (mut ws, _) = connect_and_capture_inventory(&url).await;
    state.fresh_codex.handle_create(serde_json::from_value(json!({"requestId":"recovery-create","provider":"codex","sessionType":"freshcodex","cwd":dir.path(),"permissionMode":"never"})).unwrap(),None).await;
    let created = next_frame_of_type(&mut ws, "freshAgent.created").await;
    let old = created["sessionId"].as_str().unwrap();
    state.fresh_codex.handle_send(serde_json::from_value(json!({"requestId":"recovery-send","provider":"codex","sessionType":"freshcodex","sessionId":old,"text":"finish"})).unwrap()).await;
    let complete = event(&mut ws, "freshAgent.turn.complete").await;
    loop {
        let status = event(&mut ws, "freshAgent.status").await;
        if status["status"] == "exited" {
            break;
        }
    }
    let before = ready(&url).await;
    std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR",if mint_new {json!({"threadStartThreadId":"replay-new","overrides":{"thread/resume":{"error":{"code":-32001,"message":"Thread not found"}}}})} else {json!({})}.to_string());
    state.fresh_codex.handle_attach(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":old,"cwd":dir.path()})).unwrap()).await;
    let current = if mint_new {
        next_frame_of_type(&mut ws, "freshAgent.session.materialized").await["sessionId"]
            .as_str()
            .unwrap()
            .to_string()
    } else {
        old.to_string()
    };
    let after = ready(&url).await;
    state
        .fresh_codex
        .handle_kill(
            serde_json::from_value(
                json!({"provider":"codex","sessionType":"freshcodex","sessionId":current}),
            )
            .unwrap(),
        )
        .await;
    next_frame_of_type(&mut ws, "freshAgent.killed").await;
    let closed = ready(&url).await;
    state.fresh_codex.shutdown().await;
    let mark = |value: &Value, id: &str| {
        value["freshAgentAttention"]
            .as_array()
            .and_then(|marks| marks.iter().find(|mark| mark["sessionId"] == id))
            .cloned()
            .unwrap_or(Value::Null)
    };
    assert_eq!(mark(&before, old)["lastTurnCompleteAt"], complete["at"]);
    assert_eq!(
        mark(&after, old)["lastTurnCompleteAt"],
        complete["at"],
        "old envelope must retain its exact attention after actual native exit/recovery: {after}"
    );
    assert_eq!(
        mark(&after, &current)["lastTurnCompleteAt"],
        complete["at"],
        "materialized alias and current identity share one attention history: {after}"
    );
    assert!(
        mark(&closed, old).is_null() && mark(&closed, &current).is_null(),
        "explicit close forgets every alias: {closed}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task6_ready_retains_completion_across_actual_native_exit_and_same_id_recovery() {
    replay_after_native_exit(false).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task6_ready_retains_materialization_aliases_and_close_forgets_them() {
    replay_after_native_exit(true).await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task6_actual_same_session_resume_keeps_unsaved_output_under_a_new_finite_source() {
    let _guard = ENV.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let keys = [
        "CODEX_CMD",
        "CODEX_HOME",
        "FAKE_CODEX_APP_SERVER_BEHAVIOR",
        "FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES",
    ];
    let _environment = Environment(
        keys.iter()
            .map(|key| (*key, std::env::var_os(key)))
            .collect(),
    );
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
        .canonicalize()
        .unwrap();
    let pid_file = dir.path().join("owned-native.pid");
    let notifications = dir.path().join("native-notifications.jsonl");
    let wrapper = dir.path().join("owned-codex.mjs");
    std::fs::write(
        &wrapper,
        format!(
            "import fs from 'node:fs'; fs.writeFileSync({},String(process.pid)); await import({});",
            json!(pid_file),
            json!(fixture)
        ),
    )
    .unwrap();
    std::env::set_var("CODEX_CMD", format!("node {}", wrapper.display()));
    std::env::set_var("CODEX_HOME", dir.path().join("codex"));
    std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");
    std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR",json!({"recordTurns":true,"liveTranscript":true,"threadStartThreadId":"warm-same-session","waitForTurnReleasePath":dir.path().join("never-released"),"appendNativeNotificationLogPath":notifications}).to_string());
    let (url, _, state) = spawn_server_with_specs_and_state(vec![]).await;
    state.fresh_codex.set_enabled(true);
    let (mut ws, _) = connect_and_capture_inventory(&url).await;
    state.fresh_codex.handle_create(serde_json::from_value(json!({"requestId":"warm-create","provider":"codex","sessionType":"freshcodex","cwd":dir.path(),"permissionMode":"never"})).unwrap(),None).await;
    let created = next_frame_of_type(&mut ws, "freshAgent.created").await;
    let session = created["sessionId"].as_str().unwrap();
    state.fresh_codex.handle_send(serde_json::from_value(json!({"requestId":"warm-send","provider":"codex","sessionType":"freshcodex","sessionId":session,"text":"Native partial before crash"})).unwrap()).await;
    loop {
        let patch = event(&mut ws, "freshAgent.transcript.patch").await;
        if serde_json::to_string(&patch)
            .unwrap()
            .contains("Native streaming fragment")
        {
            break;
        }
    }
    let before = state.fresh_codex.retained_state(session).await.unwrap();
    let native_turn = before["snapshot"]["extensions"]["codex"]["projection"]["eventOwnedTurnIds"]
        [0]
    .as_str()
    .unwrap()
    .to_string();
    let pid = std::fs::read_to_string(&pid_file)
        .unwrap()
        .parse::<i32>()
        .unwrap();
    // The test-owned wrapper wrote this PID before importing the native fake.
    // This exact child is inside the strict disposable process-kill sandbox.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
    event(&mut ws, "freshAgent.turn.complete").await;
    let dead = state.fresh_codex.retained_state(session).await.unwrap();
    // Canonical saved history deliberately lacks the event-owned tool/text body.
    // A native refresh may reveal only that finite interrupted representation.
    std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR",json!({"recordTurns":true,"appendNativeNotificationLogPath":notifications,"threadReadResults":{session:{"id":session,"ephemeral":false,"status":{"type":"idle"},"turns":[{"id":native_turn,"status":"interrupted","itemsView":"full","items":[]}]}}}).to_string());
    state.fresh_codex.handle_attach(serde_json::from_value(json!({"provider":"codex","sessionType":"freshcodex","sessionId":session,"cwd":dir.path()})).unwrap()).await;
    let rebound = state.fresh_codex.retained_state(session).await.unwrap();
    let refreshed = state.fresh_codex.get_snapshot(session, None).await.unwrap();
    state.fresh_codex.shutdown().await;
    let starts = std::fs::read_to_string(notifications)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|frame| frame["method"] == "turn/started")
        .count();
    assert!(serde_json::to_string(&before)
        .unwrap()
        .contains("Native streaming fragment"));
    assert!(serde_json::to_string(&dead)
        .unwrap()
        .contains("Native streaming fragment"));
    assert_ne!(
        before["source"]["projectionId"], rebound["source"]["projectionId"],
        "actual resume must allocate a new source, never reuse the old append authority"
    );
    assert!(serde_json::to_string(&rebound).unwrap().contains("Native streaming fragment"),"new retained source must preserve available unsaved output without another native history RPC: {rebound}");
    assert_eq!(
        rebound["snapshot"]["extensions"]["codex"]["projection"]["turnOutputStates"][&native_turn]
            ["diagnostic"],
        "interrupted"
    );
    assert_eq!(
        rebound["snapshot"]["extensions"]["codex"]["projection"]["turnOutputStates"][&native_turn]
            ["refreshPending"],
        false
    );
    assert!(
        serde_json::to_string(&refreshed)
            .unwrap()
            .contains("Native streaming fragment"),
        "separate native refresh must keep available interrupted evidence"
    );
    assert_eq!(
        starts, 1,
        "resume and retained reconciliation must never replay the prompt"
    );
}
