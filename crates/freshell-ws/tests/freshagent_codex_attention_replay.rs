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

async fn ready(url: &str) -> Value {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    ws.send(Message::Text(json!({"type":"hello","token":AUTH_TOKEN,"protocolVersion":freshell_protocol::WS_PROTOCOL_VERSION,"capabilities":{"freshAgentAttentionReplayV1":true}}).to_string())).await.unwrap();
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
