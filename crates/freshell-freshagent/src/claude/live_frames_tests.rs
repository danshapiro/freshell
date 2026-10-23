//! The live frames a claude sidecar sends mid-turn (transcript-live plan §4.2,
//! Phase C): API retries, notices, per-message transcript announcements and the
//! CLI's own permission-mode changes, as every client receives them.
//!
//! The sidecar is a small Node fake started through the production create
//! (`handle_create`), so the stdout consumer, its folds and the broadcast are
//! the real ones. A send's text is the list of `sdk.*` frames the fake writes
//! back (as a JSON array), each stamped with the sidecar's session id; a
//! configure is logged and answered the way index.mjs answers it.

use super::*;

use super::teardown_tests::capture;

/// The durable id the fake's session reports.
const DURABLE: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/// The fake sidecar; `CONFIGURE_LOG` and `DURABLE` are prepended.
const ECHO_SIDECAR: &str = r#"
const fs = require('node:fs')
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.type === 'create') {
    const sessionId = 'live-frames-session'
    out({ type: 'created', requestId: msg.requestId, sessionId, protocol: 2 })
    out({ type: 'sdk.session.init', sessionId, cliSessionId: DURABLE, model: 'fake-model', cwd: '/tmp', tools: [] })
  } else if (msg.type === 'send') {
    for (const frame of JSON.parse(msg.text)) out({ ...frame, sessionId: msg.sessionId })
  } else if (msg.type === 'configure') {
    fs.appendFileSync(CONFIGURE_LOG, JSON.stringify(msg) + '\n')
    out({ type: 'sdk.configured', sessionId: msg.sessionId, requestId: msg.requestId, ok: true, settings: msg.settings })
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

/// One session of the echo fake, created through the production create.
struct EchoSession {
    st: FreshClaudeState,
    rx: tokio::sync::broadcast::Receiver<String>,
    /// The pane's id for the session (its map key and envelope id).
    pane: String,
    configure_log: std::path::PathBuf,
    /// Every frame read off the bus so far, in order.
    frames: Vec<Value>,
    _dir: tempfile::TempDir,
    _env: tokio::sync::MutexGuard<'static, ()>,
}

impl EchoSession {
    async fn start(permission_mode: Option<&str>) -> Self {
        let env = super::tests::CLAUDE_ENV_LOCK.lock().await;
        let dir = tempfile::tempdir().expect("fake sidecar directory");
        let script = dir.path().join("echo-sidecar.cjs");
        let configure_log = dir.path().join("configure.log");
        std::fs::write(&configure_log, "").expect("init the configure log");
        let quoted = |text: &str| serde_json::to_string(text).expect("a JS string");
        std::fs::write(
            &script,
            format!(
                "const CONFIGURE_LOG = {}\nconst DURABLE = {}\n{ECHO_SIDECAR}",
                quoted(&configure_log.to_string_lossy()),
                quoted(DURABLE),
            ),
        )
        .expect("write the fake sidecar");
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
        std::env::set_var("CLAUDE_CONFIG_DIR", dir.path().join("claude"));
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(256);
        let st = FreshClaudeState::new(Arc::new(tx));
        let mut session = Self {
            st,
            rx,
            pane: String::new(),
            configure_log,
            frames: Vec::new(),
            _dir: dir,
            _env: env,
        };
        let mut create = create_msg("live-frames");
        create.permission_mode = permission_mode.map(str::to_string);
        session.st.handle_create(create, None).await;
        let created = session
            .await_frame("the created answer", |frame| {
                frame["requestId"] == "live-frames"
            })
            .await;
        assert_eq!(created["type"], "freshAgent.created", "{created}");
        session.pane = created["sessionId"]
            .as_str()
            .expect("the created session id")
            .to_string();
        session
    }

    /// The fake writes `frames` back as the CLI side of a send.
    async fn sidecar_writes(&mut self, frames: Value) {
        self.st
            .handle_send(send_msg(&self.pane, &frames.to_string()))
            .await;
    }

    /// Read frames until one matches `want` (returned) or 20 s pass.
    async fn await_frame(&mut self, what: &str, want: impl Fn(&Value) -> bool) -> Value {
        if let Some(hit) = self.frames.iter().find(|frame| want(frame)) {
            return hit.clone();
        }
        let found = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let frame = match self.rx.recv().await {
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(err) => panic!("broadcast recv failed: {err}"),
                    Ok(raw) => serde_json::from_str::<Value>(&raw).expect("a JSON frame"),
                };
                self.frames.push(frame.clone());
                if want(&frame) {
                    return frame;
                }
            }
        })
        .await;
        found.unwrap_or_else(|_| panic!("no {what}; frames: {:?}", self.frames))
    }

    /// The first `freshAgent.event` whose inner event has this type.
    async fn await_event(&mut self, event_type: &str) -> Value {
        let what = format!("a {event_type} event");
        self.await_frame(&what, |frame| {
            frame["type"] == "freshAgent.event" && frame["event"]["type"] == event_type
        })
        .await
    }

    /// The configure lines the fake received.
    fn configures(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.configure_log)
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).expect("a configure line"))
            .collect()
    }

    /// The status the snapshot overlay states for the session.
    async fn overlay_status(&self) -> Value {
        let mut snapshot = json!({});
        self.st
            .apply_snapshot_metadata(&self.pane, &mut snapshot)
            .await;
        snapshot["status"].clone()
    }
}

fn create_msg(request_id: &str) -> FreshAgentCreate {
    FreshAgentCreate {
        naming_handle: None,
        observed_epoch: None,
        observed_generation: None,
        request_id: request_id.to_string(),
        session_type: SessionType::Freshclaude,
        provider: Some(freshell_protocol::AgentProvider::Claude),
        cwd: None,
        legacy_restore_context: None,
        resume_session_id: None,
        session_ref: None,
        model: None,
        model_selection: None,
        permission_mode: None,
        sandbox: None,
        effort: None,
        plugins: None,
        tab_id: None,
    }
}

fn send_msg(session_id: &str, text: &str) -> FreshAgentSend {
    FreshAgentSend {
        provider: freshell_protocol::AgentProvider::Claude,
        session_id: session_id.to_string(),
        session_type: SessionType::Freshclaude,
        text: text.to_string(),
        cwd: None,
        images: None,
        request_id: None,
        settings: None,
        observed_epoch: None,
        observed_generation: None,
        checkpoint_intent: None,
    }
}

fn configure_msg(session_id: &str, permission_mode: &str) -> FreshAgentConfigure {
    FreshAgentConfigure {
        provider: freshell_protocol::AgentProvider::Claude,
        session_id: session_id.to_string(),
        session_type: SessionType::Freshclaude,
        cwd: None,
        request_id: Some("live-frames-configure".to_string()),
        settings: freshell_protocol::FreshAgentSendSettings {
            cwd: None,
            model: None,
            permission_mode: Some(permission_mode.to_string()),
            sandbox: None,
            effort: None,
        },
    }
}

/// The captured records whose `event` field is `event`, in order.
fn records(
    events: &Arc<std::sync::Mutex<Vec<(tracing::Level, capture::Fields)>>>,
    event: &str,
) -> Vec<(tracing::Level, capture::Fields)> {
    events
        .lock()
        .expect("capture lock")
        .iter()
        .filter(|(_, fields)| fields.get("event").map(String::as_str) == Some(event))
        .cloned()
        .collect()
}

/// An API retry reaches every client as `freshAgent.retry`, stamped with the
/// pane's id, with the sidecar's fields intact. It is logged under the
/// pane's id, and it never ends the turn.
#[tokio::test]
async fn an_api_retry_reaches_every_client_as_freshagent_retry_and_keeps_the_turn_running() {
    let (events, _capture) = capture::install();
    let mut session = EchoSession::start(None).await;
    session
        .sidecar_writes(json!([
            { "type": "sdk.assistant", "content": [{ "type": "text", "text": "working" }], "model": "fake-model" },
            { "type": "sdk.retry", "attempt": 1, "maxRetries": 10, "delayMs": 512, "errorStatus": 529, "error": "overloaded" },
        ]))
        .await;

    let retry = session.await_event("freshAgent.retry").await;
    assert_eq!(retry["sessionId"], json!(session.pane), "{retry}");
    assert_eq!(retry["provider"], "claude");
    assert_eq!(retry["sessionType"], "freshclaude");
    assert_eq!(retry["event"]["attempt"], 1);
    assert_eq!(retry["event"]["maxRetries"], 10);
    assert_eq!(retry["event"]["delayMs"], 512);
    assert_eq!(retry["event"]["errorStatus"], 529);
    assert_eq!(retry["event"]["error"], "overloaded");

    assert_eq!(session.overlay_status().await, "running");
    let logged = records(&events, "freshagent.claude.api_retry");
    assert_eq!(logged.len(), 1, "{logged:?}");
    let (level, fields) = &logged[0];
    assert_eq!(*level, tracing::Level::INFO);
    assert_eq!(fields.get("session_id"), Some(&session.pane));
    assert_eq!(fields.get("attempt").map(String::as_str), Some("1"));
    assert_eq!(fields.get("error_status").map(String::as_str), Some("529"));
    assert_eq!(fields.get("error").map(String::as_str), Some("overloaded"));
}

/// A notice (rate limit, informational banner, failed compaction) reaches
/// every client as `freshAgent.notice` with its level, code, message and
/// rate limit. It is logged at a severity that follows its level, without
/// its text, and it never ends the turn.
#[tokio::test]
async fn a_notice_reaches_every_client_as_freshagent_notice_and_keeps_the_turn_running() {
    let (events, _capture) = capture::install();
    let mut session = EchoSession::start(None).await;
    let rate_limit =
        json!({ "status": "rejected", "resetsAt": 1_792_656_000, "rateLimitType": "five_hour" });
    session
        .sidecar_writes(json!([
            { "type": "sdk.assistant", "content": [{ "type": "text", "text": "working" }], "model": "fake-model" },
            { "type": "sdk.notice", "level": "error", "code": "RATE_LIMITED", "message": "You have reached your Claude usage limit.", "rateLimit": rate_limit },
            { "type": "sdk.notice", "level": "info", "code": "INFORMATIONAL", "message": "a private hook said hello" },
        ]))
        .await;

    let notice = session.await_event("freshAgent.notice").await;
    assert_eq!(notice["sessionId"], json!(session.pane), "{notice}");
    assert_eq!(notice["event"]["level"], "error");
    assert_eq!(notice["event"]["code"], "RATE_LIMITED");
    assert_eq!(
        notice["event"]["message"],
        "You have reached your Claude usage limit."
    );
    assert_eq!(notice["event"]["rateLimit"], rate_limit);
    session
        .await_frame("the informational notice", |frame| {
            frame["event"]["type"] == "freshAgent.notice"
                && frame["event"]["code"] == "INFORMATIONAL"
        })
        .await;

    assert_eq!(session.overlay_status().await, "running");
    let logged = records(&events, "freshagent.claude.notice");
    let summary: Vec<(tracing::Level, Option<&str>)> = logged
        .iter()
        .map(|(level, fields)| (*level, fields.get("code").map(String::as_str)))
        .collect();
    assert_eq!(
        summary,
        vec![
            (tracing::Level::WARN, Some("RATE_LIMITED")),
            (tracing::Level::INFO, Some("INFORMATIONAL")),
        ]
    );
    let (_, rate_limited) = &logged[0];
    assert_eq!(rate_limited.get("session_id"), Some(&session.pane));
    assert_eq!(
        rate_limited.get("rate_limit_status").map(String::as_str),
        Some("rejected")
    );
    let (_, informational) = &logged[1];
    assert_eq!(
        informational.get("message_bytes").map(String::as_str),
        Some("25")
    );
    assert!(
        informational
            .values()
            .all(|value| !value.contains("private hook")),
        "a notice's text is never logged: {informational:?}"
    );
}

/// A per-message transcript announcement passes through to every client
/// unchanged (only the `session-commands` reason is folded server-side).
#[tokio::test]
async fn a_transcript_announcement_reaches_every_client_as_session_changed() {
    let mut session = EchoSession::start(None).await;
    session
        .sidecar_writes(json!([
            { "type": "sdk.session.changed", "reason": "transcript", "uuid": "11111111-1111-4111-8111-111111111111", "parentToolUseId": null },
            { "type": "sdk.session.changed", "reason": "transcript", "uuid": "22222222-2222-4222-8222-222222222222", "parentToolUseId": "toolu_agent1" },
        ]))
        .await;

    let announced = session
        .await_frame("the subagent's announcement", |frame| {
            frame["event"]["type"] == "freshAgent.session.changed"
                && frame["event"]["parentToolUseId"] == "toolu_agent1"
        })
        .await;
    assert_eq!(announced["sessionId"], json!(session.pane));
    assert_eq!(announced["event"]["reason"], "transcript");
    assert_eq!(
        announced["event"]["uuid"],
        "22222222-2222-4222-8222-222222222222"
    );
    let main_thread: Vec<&Value> = session
        .frames
        .iter()
        .filter(|frame| {
            frame["event"]["type"] == "freshAgent.session.changed"
                && frame["event"]["reason"] == "transcript"
        })
        .collect();
    assert_eq!(main_thread.len(), 2, "{main_thread:?}");
    assert_eq!(
        main_thread[0]["event"]["uuid"],
        "11111111-1111-4111-8111-111111111111"
    );
    assert_eq!(main_thread[0]["event"]["parentToolUseId"], Value::Null);
}

/// The CLI changed its own permission mode (an approved ExitPlanMode): the
/// sidecar reports `sdk.session.metadata {permissionMode}`. Every client
/// receives it, and the session's settings take the new mode, so the next
/// configure (or settings-bearing send) that states the same mode applies
/// nothing, and the snapshot overlay states the new mode.
#[tokio::test]
async fn the_clis_own_permission_mode_change_becomes_the_sessions_setting() {
    let (events, _capture) = capture::install();
    let mut session = EchoSession::start(Some("plan")).await;
    session
        .sidecar_writes(json!([
            { "type": "sdk.session.metadata", "permissionMode": "default" },
            { "type": "sdk.result", "result": "success", "durationMs": 1, "costUsd": 0, "usage": {} },
        ]))
        .await;
    let metadata = session.await_event("freshAgent.session.metadata").await;
    assert_eq!(metadata["sessionId"], json!(session.pane), "{metadata}");
    assert_eq!(metadata["event"]["permissionMode"], "default");
    session.await_event("freshAgent.result").await;

    let mut snapshot = json!({});
    session
        .st
        .apply_snapshot_metadata(&session.pane, &mut snapshot)
        .await;
    assert_eq!(snapshot["settings"]["permissionMode"], "default");
    let logged = records(&events, "freshagent.claude.permission_mode_changed");
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert_eq!(logged[0].1.get("session_id"), Some(&session.pane));
    assert_eq!(
        logged[0].1.get("permission_mode").map(String::as_str),
        Some("default")
    );

    session
        .st
        .handle_configure(configure_msg(&session.pane, "default"))
        .await;
    assert_eq!(
        session.configures(),
        Vec::<Value>::new(),
        "the session already runs in the mode the configure states"
    );

    // The configure lane itself still works: going back to plan applies.
    session
        .st
        .handle_configure(configure_msg(&session.pane, "plan"))
        .await;
    let configures = session.configures();
    assert_eq!(configures.len(), 1, "{configures:?}");
    assert_eq!(configures[0]["settings"]["permissionMode"], "plan");
}
