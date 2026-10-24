//! Live retry, notice, transcript and permission-mode behavior through the
//! production sidecar, SDK adapter and contract-tested CLI simulator.

use super::teardown_tests::capture;
use super::tests::ClaudeTestRuntime;
use super::*;

struct LiveSession {
    st: FreshClaudeState,
    rx: tokio::sync::broadcast::Receiver<String>,
    pane: String,
    frames: Vec<Value>,
    runtime: ClaudeTestRuntime,
    _env: tokio::sync::MutexGuard<'static, ()>,
}

impl LiveSession {
    async fn start(permission_mode: Option<&str>) -> Self {
        Self::start_program(permission_mode, json!([{"kind":"hang"}]), None).await
    }

    async fn start_program(
        permission_mode: Option<&str>,
        steps: Value,
        sdk_messages: Option<Value>,
    ) -> Self {
        let env = super::tests::CLAUDE_ENV_LOCK.lock().await;
        let runtime = ClaudeTestRuntime::install();
        runtime.program(steps);
        if let Some(messages) = sdk_messages {
            std::env::set_var("FRESHELL_TEST_CLAUDE_SDK_MESSAGES", messages.to_string());
        }
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(512);
        let st = FreshClaudeState::new(Arc::new(tx));
        let mut session = Self {
            st,
            rx,
            pane: String::new(),
            frames: Vec::new(),
            runtime,
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
        session.pane = created["sessionId"].as_str().unwrap().to_string();
        session
    }

    async fn send(&self, text: &str) {
        assert!(matches!(
            self.st.handle_send(send_msg(&self.pane, text)).await,
            ClaudeSendOutcome::Accepted { .. }
        ));
    }

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

    async fn await_event(&mut self, event_type: &str) -> Value {
        self.await_frame(event_type, |frame| {
            frame["type"] == "freshAgent.event" && frame["event"]["type"] == event_type
        })
        .await
    }

    fn rows(&self, file: &str) -> Vec<Value> {
        std::fs::read_to_string(self.runtime.dir.join(file))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn configures(&self) -> Vec<Value> {
        self.rows("requests.jsonl")
            .into_iter()
            .filter(|frame| frame["type"] == "configure")
            .collect()
    }

    async fn overlay_status(&self) -> Value {
        let mut snapshot = json!({});
        self.st
            .apply_snapshot_metadata(&self.pane, &mut snapshot)
            .await;
        snapshot["status"].clone()
    }
}

/// Restores the process store in the snapshot-only environment test.
struct ClaudeEnvReset(Option<std::ffi::OsString>);
impl Drop for ClaudeEnvReset {
    fn drop(&mut self) {
        match &self.0 {
            Some(previous) => std::env::set_var("CLAUDE_CONFIG_DIR", previous),
            None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
        }
    }
}

fn create_msg(request_id: &str) -> FreshAgentCreate {
    FreshAgentCreate {
        pane_id: None,
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
    let mut session = LiveSession::start_program(
        None,
        json!([
            {"kind":"text", "data":{"text":"working"}},
            {"kind":"api_retry", "data":{"status":529}},
            {"kind":"hang"},
        ]),
        None,
    )
    .await;
    session.send("retry this model request").await;

    let retry = session.await_event("freshAgent.retry").await;
    assert_eq!(retry["sessionId"], json!(session.pane), "{retry}");
    assert_eq!(retry["provider"], "claude");
    assert_eq!(retry["sessionType"], "freshclaude");
    assert_eq!(retry["event"]["attempt"], 1);
    assert_eq!(retry["event"]["maxRetries"], 10);
    assert_eq!(retry["event"]["delayMs"], 500);
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
    let rate_limit =
        json!({"status":"rejected", "resetsAt":1_792_656_000, "rateLimitType":"five_hour"});
    let mut session = LiveSession::start_program(None, json!([
        {"kind":"text", "data":{"text":"working"}}, {"kind":"hang"},
    ]), Some(json!([
        {"type":"rate_limit_event", "uuid":"11111111-1111-4111-8111-111111111111", "rate_limit_info":rate_limit},
        {"type":"system", "subtype":"informational", "uuid":"22222222-2222-4222-8222-222222222222", "level":"suggestion", "content":"a private hook said hello"},
    ]))).await;
    session.send("show provider notices").await;

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
    let mut session = LiveSession::start_program(
        None,
        json!([
            {"kind":"replay", "data":{"recording":"tools-sync", "pace":0}},
        ]),
        None,
    )
    .await;
    session
        .send("replay the recorded CLI tool and subagent turn")
        .await;
    session.await_event("freshAgent.result").await;
    let expected: Vec<Value> = session
        .rows("sdk.jsonl")
        .into_iter()
        .filter(|msg| {
            (msg["type"] == "assistant" || msg["type"] == "user") && msg["uuid"].is_string()
        })
        .map(|msg| json!({"uuid":msg["uuid"], "parentToolUseId":msg["parent_tool_use_id"]}))
        .collect();
    assert!(
        expected
            .iter()
            .any(|row| row["parentToolUseId"].is_string()),
        "the real recording includes a subagent"
    );
    assert!(
        expected.iter().any(|row| row["parentToolUseId"].is_null()),
        "the main conversation also writes messages"
    );
    let actual: Vec<Value> = session.frames.iter()
        .filter(|frame| frame["event"]["type"] == "freshAgent.session.changed" && frame["event"]["reason"] == "transcript")
        .map(|frame| {
            assert_eq!(frame["sessionId"], session.pane);
            json!({"uuid":frame["event"]["uuid"], "parentToolUseId":frame["event"]["parentToolUseId"]})
        }).collect();
    assert_eq!(
        actual, expected,
        "every actual SDK transcript message is announced once in order"
    );
}

/// The CLI changed its own permission mode (an approved ExitPlanMode): the
/// sidecar reports `sdk.session.metadata {permissionMode}`. Every client
/// receives it, and the session's settings take the new mode, so the next
/// configure (or settings-bearing send) that states the same mode applies
/// nothing, and the snapshot overlay states the new mode.
#[tokio::test]
async fn the_clis_own_permission_mode_change_becomes_the_sessions_setting() {
    let (events, _capture) = capture::install();
    let mut session = LiveSession::start_program(
        Some("plan"),
        json!([
            {"kind":"exit_plan", "data":{"plan":"# Plan\n\nContinue the work"}},
            {"kind":"text", "data":{"text":"plan approved"}},
        ]),
        None,
    )
    .await;
    session.send("request approval to exit plan mode").await;
    let permission = session.await_event("freshAgent.permission.request").await;
    session
        .st
        .handle_approval_respond(FreshAgentApprovalRespond {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session.pane.clone(),
            session_type: SessionType::Freshclaude,
            request_id: freshell_protocol::StringOrNumber::Str(
                permission["event"]["requestId"].as_str().unwrap().into(),
            ),
            decision: json!({"behavior":"allow"}),
            cwd: None,
        })
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

/// A configure that changes only the permission mode converges every
/// device: the metadata broadcast states the new mode (with the unchanged
/// model and effort pair, as every metadata frame does).
#[tokio::test]
async fn a_configure_that_changes_the_permission_mode_broadcasts_metadata_stating_it() {
    let mut session = LiveSession::start(None).await;
    session
        .st
        .handle_configure(configure_msg(&session.pane, "plan"))
        .await;
    assert_eq!(session.configures().len(), 1);

    let metadata = session.await_event("freshAgent.session.metadata").await;
    assert_eq!(metadata["sessionId"], json!(session.pane), "{metadata}");
    assert_eq!(metadata["event"]["permissionMode"], "plan");
    assert_eq!(metadata["event"]["model"], Value::Null);
    assert_eq!(metadata["event"]["effort"], Value::Null);
}

/// The same convergence for a send whose settings change the mode (a device
/// that missed the configure still lands here).
#[tokio::test]
async fn a_send_that_changes_the_permission_mode_broadcasts_metadata_stating_it() {
    let mut session = LiveSession::start(Some("plan")).await;
    let mut send = send_msg(&session.pane, "[]");
    send.settings = Some(freshell_protocol::FreshAgentSendSettings {
        cwd: None,
        model: None,
        permission_mode: Some("acceptEdits".to_string()),
        sandbox: None,
        effort: None,
    });
    session.st.handle_send(send).await;
    assert_eq!(session.configures().len(), 1);

    let metadata = session.await_event("freshAgent.session.metadata").await;
    assert_eq!(metadata["sessionId"], json!(session.pane), "{metadata}");
    assert_eq!(metadata["event"]["permissionMode"], "acceptEdits");
}

/// A lane whose sidecars get an explicit environment (a test rig) serves
/// snapshots from the transcript store that environment names, the store its
/// CLI writes, not from this process's.
#[tokio::test]
async fn snapshots_read_the_store_the_lanes_sidecars_write() {
    let _env = super::tests::CLAUDE_ENV_LOCK.lock().await;
    let _reset = ClaudeEnvReset(std::env::var_os("CLAUDE_CONFIG_DIR"));
    let process_store = tempfile::tempdir().expect("this process's store");
    std::env::set_var("CLAUDE_CONFIG_DIR", process_store.path());
    let sidecar_store = tempfile::tempdir().expect("the sidecars' store");
    let thread = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let project = sidecar_store.path().join("projects").join("-ws");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(
        project.join(format!("{thread}.jsonl")),
        format!(
            "{}\n",
            json!({
                "type": "user", "uuid": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                "sessionId": thread, "message": { "role": "user", "content": "hello" },
            })
        ),
    )
    .unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
    let st = FreshClaudeState::new(Arc::new(tx)).with_sidecar_environment([
        (
            "CLAUDE_CONFIG_DIR".to_string(),
            sidecar_store.path().to_string_lossy().into_owned(),
        ),
        ("HOME".to_string(), "/nonexistent-home".to_string()),
    ]);

    let snapshot = st
        .get_snapshot(SessionType::Freshclaude, thread)
        .await
        .expect("the snapshot reads the sidecars' store");
    assert_eq!(
        snapshot["turns"][0]["items"][0]["text"], "hello",
        "{snapshot}"
    );
}

#[tokio::test]
async fn a_live_session_restores_the_process_environment() {
    let before = {
        let _env = super::tests::CLAUDE_ENV_LOCK.lock().await;
        (
            std::env::var_os("FRESHELL_CLAUDE_SIDECAR"),
            std::env::var_os("CLAUDE_CONFIG_DIR"),
        )
    };
    drop(LiveSession::start(None).await);
    let _env = super::tests::CLAUDE_ENV_LOCK.lock().await;
    assert_eq!(
        (
            std::env::var_os("FRESHELL_CLAUDE_SIDECAR"),
            std::env::var_os("CLAUDE_CONFIG_DIR")
        ),
        before
    );
}
