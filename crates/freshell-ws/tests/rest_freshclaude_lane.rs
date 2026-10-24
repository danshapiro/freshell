//! The default REST/MCP door controls the real WebSocket Claude runtime.
#![cfg(unix)]

mod common;

use common::claude_rig::{ClaudeRig, RigKind, RigOptions, RIG_FRAME_BUDGET};
use freshell_freshagent::rest_lane::{
    FreshAgentRestLane, RestLaneCreate, RestLaneCreated, RestLaneError, RestLaneSend,
    RestLaneSendResult,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn options() -> RigOptions {
    RigOptions {
        rest_api: true,
        durable_ledger: true,
        ..Default::default()
    }
}

struct PausedRealCreate {
    inner: Arc<freshell_freshagent::claude_rest_lane::ClaudeRestLane>,
    started: tokio::sync::Notify,
    finish: tokio::sync::Notify,
    receipt: std::sync::Mutex<Option<(RestLaneCreate, RestLaneCreated)>>,
}

#[async_trait::async_trait]
impl FreshAgentRestLane for PausedRealCreate {
    async fn create_agent(
        self: Arc<Self>,
        request: RestLaneCreate,
    ) -> Result<RestLaneCreated, RestLaneError> {
        let created = self.inner.clone().create_agent(request.clone()).await?;
        *self.receipt.lock().unwrap() = Some((request, created.clone()));
        self.started.notify_one();
        self.finish.notified().await;
        Ok(created)
    }
    async fn send_agent(&self, request: RestLaneSend) -> Result<RestLaneSendResult, RestLaneError> {
        self.inner.send_agent(request).await
    }
    async fn abandon_create(
        &self,
        request: &RestLaneCreate,
        created: &RestLaneCreated,
    ) -> Result<(), RestLaneError> {
        self.inner.abandon_create(request, created).await
    }
}

#[derive(Clone, Copy)]
enum CancelRealCreate {
    Owned,
    Adopted,
    CloseWriteFailure,
}

async fn close_after_real_create(case: CancelRealCreate) {
    let adopt_existing = matches!(case, CancelRealCreate::Adopted);
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..Default::default()
        },
    )
    .await;
    let mut browser = rig.connect().await;
    let existing = if adopt_existing {
        Some(browser.create("existing-visible-runtime").await)
    } else {
        None
    };
    let lane = Arc::new(PausedRealCreate {
        inner: Arc::new(freshell_freshagent::claude_rest_lane::ClaudeRestLane::new(
            rig.fresh_claude.clone(),
            Arc::new(|| true),
        )),
        started: Default::default(),
        finish: Default::default(),
        receipt: Default::default(),
    });
    let state = freshell_freshagent::FreshAgentState::new(
        Arc::new(common::AUTH_TOKEN.into()),
        Arc::new(tokio::sync::broadcast::channel(64).0),
    );
    state.set_claude_rest_lane(lane.clone()).unwrap();
    let router = freshell_freshagent::router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (shutdown, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap()
    });
    let create_base = base.clone();
    let mut body = json!({"agent":"claude", "cwd":rig.workspace.to_str().unwrap()});
    if let Some(id) = existing.as_deref() {
        body["sessionRef"] = json!({"provider":"claude", "sessionId":id});
    }
    let creating = tokio::spawn(async move {
        ClaudeRig::request_json_to("POST", &create_base, "/api/tabs", &body).await
    });
    tokio::time::timeout(RIG_FRAME_BUDGET, lane.started.notified())
        .await
        .unwrap();
    let (request, receipt) = lane.receipt.lock().unwrap().clone().unwrap();
    assert_eq!(
        receipt.cleanup_token.is_none(),
        adopt_existing,
        "only a newly started runtime belongs to cancellation"
    );
    let processes = rig.runtime_processes(&receipt.session_id);
    // This is the isolated rig's actual close journal. A regular file at the
    // directory path causes a real, root-independent atomic-write failure.
    let journal = rig
        .workspace
        .parent()
        .unwrap()
        .join("pane-ledger/close-envelopes");
    let saved_journal = journal.with_extension("saved");
    let had_journal = journal.exists();
    if matches!(case, CancelRealCreate::CloseWriteFailure) {
        if had_journal {
            std::fs::rename(&journal, &saved_journal).unwrap();
        }
        std::fs::write(&journal, b"injected close-journal failure").unwrap();
    }
    let (status, closed) = ClaudeRig::request_json_to(
        "DELETE",
        &base,
        &format!("/api/tabs/{}", request.tab_id.as_deref().unwrap()),
        &json!({}),
    )
    .await;
    assert_eq!(status, 200, "{closed}");
    lane.finish.notify_one();
    let (status, cancelled) = creating.await.unwrap();
    if matches!(case, CancelRealCreate::CloseWriteFailure) {
        assert_eq!(status, 503, "{cancelled}");
        assert_eq!(cancelled["code"], "CLAUDE_CLEANUP_UNCONFIRMED");
        assert_eq!(cancelled["retryable"], true);
        assert!(
            rig.fresh_claude.has_live_session(&receipt.session_id).await,
            "an uncommitted close must not claim the writer was stopped"
        );
        std::fs::remove_file(&journal).unwrap();
        if had_journal {
            std::fs::rename(saved_journal, &journal).unwrap();
        }
        lane.inner.abandon_create(&request, &receipt).await.unwrap();
    } else {
        assert_eq!(status, 409, "{cancelled}");
        assert_eq!(cancelled["code"], "PANE_CREATE_CANCELLED");
    }
    if adopt_existing {
        assert!(rig.fresh_claude.has_live_session(&receipt.session_id).await);
        browser
            .send_text(
                &receipt.session_id,
                "still-owned-by-existing-pane",
                "the existing writer survives the cancelled adoption",
            )
            .await;
        browser.wait_for_event("freshAgent.result").await;
        assert_eq!(rig.query_options().len(), 1);
    } else {
        processes
            .wait_until_exited("the cancelled REST create's owned runtime")
            .await;
        assert!(!rig.fresh_claude.has_live_session(&receipt.session_id).await);
    }
    rig.fresh_claude.shutdown().await;
    let _ = shutdown.send(());
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_a_late_rest_create_reaps_its_real_sidecar_and_cli() {
    close_after_real_create(CancelRealCreate::Owned).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_a_late_rest_adoption_keeps_the_existing_real_writer_alive() {
    close_after_real_create(CancelRealCreate::Adopted).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_a_late_rest_create_reports_failed_cleanup_and_can_retry_after_repair() {
    close_after_real_create(CancelRealCreate::CloseWriteFailure).await;
}

async fn get(rig: &ClaudeRig, path: &str) -> (u16, String) {
    let host = rig.http_url.strip_prefix("http://").unwrap();
    let mut stream = tokio::net::TcpStream::connect(host).await.unwrap();
    stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nx-auth-token: {}\r\nConnection: close\r\n\r\n", common::AUTH_TOKEN).as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(RIG_FRAME_BUDGET, stream.read_to_end(&mut raw))
        .await
        .unwrap()
        .unwrap();
    let response = String::from_utf8(raw).unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    (
        head.split_whitespace().nth(1).unwrap().parse().unwrap(),
        body.to_string(),
    )
}

async fn create(rig: &ClaudeRig, agent: &str) -> Value {
    let (status, body) = rig
        .post_json(
            "/api/tabs",
            &json!({"agent":agent, "cwd":rig.workspace.to_str().unwrap()}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    body["data"].clone()
}

async fn send(rig: &ClaudeRig, pane: &str, text: &str) -> Value {
    let (status, body) = rig
        .post_json(
            &format!("/api/panes/{pane}/send-keys"),
            &json!({"data":text, "requestId":"rest-request", "timeout":5}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    body["data"].clone()
}

async fn wait_for_saved_turn(rig: &ClaudeRig, id: &str, submitted: &str) {
    // The pinned CLI flushes transcript lines after their SDK frames (T3).
    // A completed REST send promises turn settlement; capture reads the saved
    // history, so observe this exact turn on disk before asserting its text.
    let path = rig.wait_for_transcript(id).await;
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        let lines: Vec<Value> = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let user = lines
            .iter()
            .rposition(|line| line["type"] == "user" && line["uuid"] == submitted);
        if user.is_some_and(|at| {
            lines[at + 1..]
                .iter()
                .any(|line| line["type"] == "assistant")
        }) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "submitted turn {submitted} never reached {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rest_create_send_capture_and_ws_create_replay_share_one_writer() {
    let rig = ClaudeRig::start_with_options(RigKind::Sim, options()).await;
    let mut observer = rig.connect().await;
    let created = create(&rig, "claude").await;
    let id = created["sessionId"].as_str().unwrap();
    let pane = created["paneId"].as_str().unwrap();
    assert!(
        uuid::Uuid::parse_str(id).is_ok(),
        "REST exposes the durable UUID immediately: {created}"
    );
    assert_eq!(
        created["sessionRef"],
        json!({"provider":"claude", "sessionId":id})
    );
    let ws_created = observer
        .wait_for("REST-created session", |frame| {
            frame["type"] == "freshAgent.created" && frame["sessionId"] == id
        })
        .await;
    let command = observer
        .wait_for("REST tab command", |frame| {
            frame["type"] == "ui.command" && frame["command"] == "tab.create"
        })
        .await;
    let content = &command["payload"]["paneContent"];
    assert_eq!(content["createRequestId"], ws_created["requestId"]);
    assert_eq!(content["sessionId"], id);
    assert_eq!(content["model"], "opus[1m]");
    assert_eq!(content["permissionMode"], "bypassPermissions");
    assert_eq!(content["effort"], "high");
    assert_eq!(content["status"], "connected");
    let mut second_browser = rig.connect().await;
    let replay = second_browser
        .request_create(
            content["createRequestId"].as_str().unwrap(),
            json!({"paneId":pane, "tabId":created["tabId"]}),
        )
        .await;
    assert_eq!(replay["sessionId"], id);
    assert_eq!(
        rig.query_options().len(),
        1,
        "REST and browser deduplicate at the same runtime create ingress"
    );
    let (status, empty) = get(&rig, &format!("/api/panes/{pane}/capture")).await;
    assert_eq!(status, 200, "{empty}");
    assert!(empty.is_empty());
    let sent = send(&rig, pane, "héllo\r").await;
    assert_eq!(sent["status"], "idle");
    let prompts = rig.ledger_rows("prompt");
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0]["text"], "héllo");
    assert_eq!(prompts[0]["model"], "opus[1m]");
    assert_eq!(prompts[0]["effort"], "high");
    assert_eq!(prompts[0]["permissionMode"], "bypassPermissions");
    assert_eq!(sent["submittedTurnId"], prompts[0]["uuid"]);
    assert_ne!(sent["submittedTurnId"], "rest-request");
    wait_for_saved_turn(&rig, id, sent["submittedTurnId"].as_str().unwrap()).await;
    observer
        .wait_for("REST turn completion", |frame| {
            frame["event"]["type"] == "freshAgent.turn.complete" && frame["sessionId"] == id
        })
        .await;
    let (status, text) = get(&rig, &format!("/api/panes/{pane}/capture")).await;
    assert_eq!(status, 200, "{text}");
    assert!(text.contains("user: héllo"), "{text}");
    assert!(text.contains("assistant: ok"), "{text}");
    let (status, bounded) = get(&rig, &format!("/api/panes/{pane}/capture?maxBytes=8")).await;
    assert_eq!(status, 200);
    assert!(bounded.len() <= 8);
    assert!(!bounded.is_empty());
    let noop = send(&rig, pane, "\r\n").await;
    assert_eq!(noop["status"], "noop");
    assert!(noop.get("submittedTurnId").is_none());
    assert_eq!(rig.ledger_rows("prompt").len(), 1);
    send(&rig, pane, "second\r\n").await;
    assert_eq!(
        rig.ledger_rows("prompt")[1]["text"],
        "second\r",
        "strip exactly one final line terminator"
    );
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_split_uses_kilroy_and_rolls_back_a_disabled_launch() {
    let rig = ClaudeRig::start_with_options(RigKind::Sim, options()).await;
    let mut observer = rig.connect().await;
    let original = create(&rig, "claude").await;
    let source = original["paneId"].as_str().unwrap();
    let (status, split) = rig.post_json(&format!("/api/panes/{source}/split"), &json!({"agent":"kilroy", "cwd":rig.workspace.to_str().unwrap(), "direction":"vertical"})).await;
    assert_eq!(status, 200, "{split}");
    let pane = split["data"]["paneId"].as_str().unwrap();
    let command = observer
        .wait_for("Kilroy split command", |frame| {
            frame["type"] == "ui.command" && frame["command"] == "pane.split"
        })
        .await;
    assert_eq!(command["payload"]["newContent"]["sessionType"], "kilroy");
    assert_eq!(command["payload"]["newContent"]["provider"], "claude");
    assert!(command["payload"]["newContent"]
        .get("namingHandle")
        .is_none());
    let sent = send(&rig, pane, "kilroy hello").await;
    assert_eq!(sent["status"], "idle");
    wait_for_saved_turn(
        &rig,
        sent["sessionId"].as_str().unwrap(),
        sent["submittedTurnId"].as_str().unwrap(),
    )
    .await;
    let (status, capture) = get(&rig, &format!("/api/panes/{pane}/capture")).await;
    assert_eq!(status, 200, "{capture}");
    assert!(capture.contains("kilroy hello"), "{capture}");
    observer.read_for(Duration::from_millis(50)).await;
    let announcements = observer
        .frames
        .iter()
        .filter(|frame| frame["type"] == "ui.command")
        .count();
    let (_, before) = get(&rig, "/api/layout/snapshot").await;
    rig.fresh_codex.set_enabled(false);
    let (status, refused) = rig
        .post_json(
            &format!("/api/panes/{source}/split"),
            &json!({"agent":"claude"}),
        )
        .await;
    assert_eq!(status, 403, "{refused}");
    assert_eq!(refused["code"], "FRESH_AGENT_DISABLED");
    observer.read_for(Duration::from_millis(50)).await;
    assert_eq!(
        observer
            .frames
            .iter()
            .filter(|frame| frame["type"] == "ui.command")
            .count(),
        announcements,
        "a failed launch announces no pane create or split"
    );
    let (_, after) = get(&rig, "/api/layout/snapshot").await;
    let before: Value = serde_json::from_str(&before).unwrap();
    let after: Value = serde_json::from_str(&after).unwrap();
    assert_eq!(
        after["data"]["layouts"], before["data"]["layouts"],
        "failed split leaves the previous layout intact"
    );
    let (status, refused) = rig.post_json("/api/tabs", &json!({"agent":"claude"})).await;
    assert_eq!(status, 403, "{refused}");
    assert_eq!(rig.query_options().len(), 2);
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rest_controls_a_browser_created_pane_and_capture_survives_server_restart() {
    let mut rig = ClaudeRig::start_with_options(RigKind::Sim, options()).await;
    let mut browser = rig.connect().await;
    let answer = browser
        .request_create(
            "browser-create",
            json!({"tabId":"browser-tab", "paneId":"browser-pane"}),
        )
        .await;
    assert_eq!(answer["type"], "freshAgent.created", "{answer}");
    let id = answer["sessionId"].as_str().unwrap();
    browser.send(json!({
        "type":"ui.layout.sync", "tabs":[{"id":"browser-tab"}], "activeTabId":"browser-tab",
        "layouts":{"browser-tab":{"type":"leaf", "id":"browser-pane", "content":{
            "kind":"fresh-agent", "provider":"claude", "sessionType":"freshclaude", "sessionId":id,
            "sessionRef":{"provider":"claude", "sessionId":id}, "createRequestId":"browser-create",
        }}}, "activePane":{"browser-tab":"browser-pane"}, "timestamp":1,
    })).await;
    browser.send(json!({"type":"ping"})).await;
    browser
        .wait_for("layout sync ordering barrier", |frame| {
            frame["type"] == "pong"
        })
        .await;
    let sent = send(&rig, "browser-pane", "browser pane via REST").await;
    assert_eq!(sent["status"], "idle");
    wait_for_saved_turn(&rig, id, sent["submittedTurnId"].as_str().unwrap()).await;
    let (status, before) = get(&rig, "/api/panes/browser-pane/capture").await;
    assert_eq!(status, 200, "{before}");
    assert!(
        before.contains("browser pane via REST"),
        "capture after settlement: {before:?}; prompts: {:?}",
        rig.ledger_rows("prompt")
    );
    rig.restart().await;
    let (status, after) = get(&rig, "/api/panes/browser-pane/capture").await;
    assert_eq!(status, 200, "{after}");
    assert_eq!(after, before, "the restored layout resolves durable transcript capture without a REST pane row or live runtime");
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rest_deadline_is_approx_and_a_runtime_exit_is_a_retryable_conflict() {
    let mut config = options();
    config.env.push((
        "FRESHELL_CLAUDE_SIM_PROGRAM".into(),
        json!({"rules":[{
            "on":"msg:prompt", "match":{"text":"crash"}, "emit":[{"kind":"crash"}],
        }]})
        .to_string(),
    ));
    let rig = ClaudeRig::start_with_options(RigKind::Sim, config).await;
    let created = create(&rig, "claude").await;
    let pane = created["paneId"].as_str().unwrap();
    let (status, body) = rig
        .post_json(
            &format!("/api/panes/{pane}/send-keys"),
            &json!({"data":"HANG", "timeout":1}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "approx");
    assert_eq!(body["data"]["status"], "approx");
    assert!(body["data"]["submittedTurnId"].as_str().is_some());
    let crashing = create(&rig, "claude").await;
    let pane = crashing["paneId"].as_str().unwrap();
    let (status, ended) = rig
        .post_json(
            &format!("/api/panes/{pane}/send-keys"),
            &json!({"data":"crash", "timeout":10}),
        )
        .await;
    assert_eq!(status, 409, "{ended}");
    assert_eq!(ended["code"], "FRESH_AGENT_SESSION_ENDED");
    assert_eq!(ended["retryable"], true);
    assert!(ended["retryAfterMs"]
        .as_u64()
        .is_some_and(|delay| delay > 0));
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rest_recovery_does_not_reopen_an_explicitly_closed_session() {
    let rig = ClaudeRig::start_with_options(RigKind::Sim, options()).await;
    let mut browser = rig.connect().await;
    let created = create(&rig, "claude").await;
    let id = created["sessionId"].as_str().unwrap();
    let pane = created["paneId"].as_str().unwrap();
    browser.kill(id).await;
    let (status, refused) = rig
        .post_json(
            &format!("/api/panes/{pane}/send-keys"),
            &json!({"data":"a late prompt must stay unsent"}),
        )
        .await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(refused["code"], "SESSION_CLOSED");
    assert_eq!(refused["retryable"], false);
    assert!(refused.get("retryAfterMs").is_none(), "{refused}");
    assert_eq!(rig.query_options().len(), 1);
    assert!(rig.ledger_rows("prompt").is_empty());
    assert!(!rig.fresh_claude.has_live_session(id).await);
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_browser_close_before_its_debounce_releases_the_rest_split_publication() {
    let rig = ClaudeRig::start_with_options(RigKind::Sim, options()).await;
    let mut browser = rig.connect().await;
    let original = create(&rig, "claude").await;
    let source = original["paneId"].as_str().unwrap();
    let tab = original["tabId"].as_str().unwrap();
    let (_, snapshot) = get(&rig, "/api/layout/snapshot").await;
    let snapshot: Value = serde_json::from_str(&snapshot).unwrap();
    let before_split = json!({
        "type":"ui.layout.sync", "tabs":snapshot["data"]["tabs"], "activeTabId":tab,
        "layouts":snapshot["data"]["layouts"], "activePane":snapshot["data"]["activePane"], "timestamp":1,
    });
    browser.send(before_split.clone()).await;
    browser.send(json!({"type":"ping"})).await;
    browser
        .wait_for("initial layout sync", |frame| frame["type"] == "pong")
        .await;
    let (status, split) = rig
        .post_json(
            &format!("/api/panes/{source}/split"),
            &json!({"agent":"kilroy"}),
        )
        .await;
    assert_eq!(status, 200, "{split}");
    let pane = split["data"]["paneId"].as_str().unwrap();
    let announced = browser
        .wait_for("the unobserved split announcement", |frame| {
            frame["command"] == "pane.split"
        })
        .await;
    let create_id = announced["payload"]["newContent"]["createRequestId"]
        .as_str()
        .unwrap();
    browser
        .send(json!({"type":"pane.closed", "createRequestId":create_id}))
        .await;
    let closed = browser
        .wait_for("the close acknowledgement", |frame| {
            frame["type"] == "pane.closed.result" && frame["createRequestId"] == create_id
        })
        .await;
    assert_eq!(closed["success"], true, "{closed}");
    browser.frames.clear();
    browser.send(before_split).await;
    browser.send(json!({"type":"ping"})).await;
    browser
        .wait_for("closed layout sync", |frame| frame["type"] == "pong")
        .await;
    let (status, listed) = get(&rig, &format!("/api/panes?tabId={tab}")).await;
    assert_eq!(status, 200, "{listed}");
    let listed: Value = serde_json::from_str(&listed).unwrap();
    assert_eq!(
        listed["data"]["panes"].as_array().unwrap().len(),
        1,
        "{listed}"
    );
    assert_eq!(listed["data"]["panes"][0]["id"], source);
    assert_ne!(listed["data"]["panes"][0]["id"], pane);
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rest_recovery_reports_unreadable_storage_as_retryable_and_can_retry_after_repair() {
    let rig = ClaudeRig::start_with_options(RigKind::Sim, options()).await;
    let mut browser = rig.connect().await;
    let created = create(&rig, "claude").await;
    let id = created["sessionId"].as_str().unwrap();
    let pane = created["paneId"].as_str().unwrap();
    let first = send(&rig, pane, "the existing saved conversation").await;
    wait_for_saved_turn(&rig, id, first["submittedTurnId"].as_str().unwrap()).await;
    rig.wait_for_genesis_cleared(id).await;
    rig.kill_first_sidecar(&mut browser).await;
    let saved = rig.claude_config_dir.with_extension("saved");
    std::fs::rename(&rig.claude_config_dir, &saved).unwrap();
    std::fs::create_dir_all(&rig.claude_config_dir).unwrap();
    // An actual traversal failure remains an error even when tests run as root.
    std::os::unix::fs::symlink("projects", rig.claude_config_dir.join("projects")).unwrap();
    let (status, refused) = rig
        .post_json(
            &format!("/api/panes/{pane}/send-keys"),
            &json!({"data":"continue after storage is repaired"}),
        )
        .await;
    assert_eq!(status, 503, "{refused}");
    assert_eq!(refused["code"], "CLAUDE_ATTACH_RESUME_FAILED");
    assert_eq!(refused["retryable"], true);
    assert!(refused["retryAfterMs"]
        .as_u64()
        .is_some_and(|delay| delay > 0));
    assert_eq!(
        rig.query_options().len(),
        1,
        "unchecked history never starts a replacement"
    );
    assert_eq!(
        rig.ledger_rows("prompt").len(),
        1,
        "the refused prompt was not written"
    );
    std::fs::rename(
        &rig.claude_config_dir,
        rig.claude_config_dir.with_extension("unreadable"),
    )
    .unwrap();
    std::fs::rename(saved, &rig.claude_config_dir).unwrap();
    let retried = send(&rig, pane, "continue after storage is repaired").await;
    assert_eq!(retried["sessionId"], id);
    wait_for_saved_turn(&rig, id, retried["submittedTurnId"].as_str().unwrap()).await;
    let (status, capture) = get(&rig, &format!("/api/panes/{pane}/capture")).await;
    assert_eq!(status, 200, "{capture}");
    assert!(
        capture.contains("the existing saved conversation"),
        "{capture}"
    );
    assert!(
        capture.contains("continue after storage is repaired"),
        "{capture}"
    );
    assert_eq!(rig.query_options().len(), 2);
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rest_recovery_reports_a_positively_missing_conversation_as_permanent_not_found() {
    let rig = ClaudeRig::start_with_options(RigKind::Sim, options()).await;
    let mut browser = rig.connect().await;
    let created = create(&rig, "claude").await;
    let id = created["sessionId"].as_str().unwrap();
    let pane = created["paneId"].as_str().unwrap();
    let first = send(&rig, pane, "the conversation that later goes missing").await;
    wait_for_saved_turn(&rig, id, first["submittedTurnId"].as_str().unwrap()).await;
    rig.wait_for_genesis_cleared(id).await;
    rig.kill_first_sidecar(&mut browser).await;
    std::fs::rename(
        rig.claude_config_dir.join("projects"),
        rig.claude_config_dir.with_extension("projects-saved"),
    )
    .unwrap();
    let (status, refused) = rig
        .post_json(
            &format!("/api/panes/{pane}/send-keys"),
            &json!({"data":"never replace missing saved history"}),
        )
        .await;
    assert_eq!(status, 404, "{refused}");
    assert_eq!(refused["code"], "INVALID_SESSION_ID");
    assert_eq!(refused["retryable"], false);
    assert!(refused.get("retryAfterMs").is_none(), "{refused}");
    assert_eq!(rig.query_options().len(), 1);
    assert_eq!(rig.ledger_rows("prompt").len(), 1);
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_fenced_send_refusal_reports_its_owner_and_keeps_the_prompt_unsent() {
    let rig = ClaudeRig::start_with_options(RigKind::Sim, options()).await;
    let created = create(&rig, "claude").await;
    let id = created["sessionId"].as_str().unwrap();
    let pane = created["paneId"].as_str().unwrap();
    let owner = rig.fresh_claude.ownership_snapshot("claude", id);
    assert!(
        owner.generation > 0,
        "the runtime owns a committed generation"
    );
    let route = format!("/api/panes/{pane}/send-keys");
    let (status, refused) = rig.post_json(&route, &json!({
        "data":"stale prompt", "observedEpoch":owner.epoch, "observedGeneration":owner.generation - 1,
    })).await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(refused["code"], "SESSION_RESERVED");
    assert_eq!(refused["retryable"], true);
    assert_eq!(refused["ownerKind"], "fresh-agent");
    assert_eq!(refused["ownerEpoch"], owner.epoch);
    assert_eq!(refused["ownerGeneration"], owner.generation);
    assert!(refused["retryAfterMs"]
        .as_u64()
        .is_some_and(|delay| delay > 0));
    assert!(rig.ledger_rows("prompt").is_empty());
    let (status, sent) = rig.post_json(&route, &json!({
        "data":"current prompt", "observedEpoch":owner.epoch, "observedGeneration":owner.generation, "timeout":5,
    })).await;
    assert_eq!(status, 200, "{sent}");
    assert_eq!(sent["data"]["status"], "idle");
    assert_eq!(rig.ledger_rows("prompt").len(), 1);
    assert_eq!(rig.ledger_rows("prompt")[0]["text"], "current prompt");
    rig.fresh_claude.shutdown().await;
}

async fn clear_rekeys_the_headless_rest_pane(kind: RigKind) {
    let rig = ClaudeRig::start_with_options(kind, options()).await;
    let created = create(&rig, "claude").await;
    let old_id = created["sessionId"].as_str().unwrap();
    let pane = created["paneId"].as_str().unwrap();
    let route = format!("/api/panes/{pane}/send-keys");
    let first = send(&rig, pane, "before clear conversation").await;
    wait_for_saved_turn(&rig, old_id, first["submittedTurnId"].as_str().unwrap()).await;
    let (_, old_capture) = get(&rig, &format!("/api/panes/{pane}/capture")).await;
    assert!(
        old_capture.contains("before clear conversation"),
        "{old_capture}"
    );
    let (status, cleared) = rig
        .post_json(
            &route,
            &json!({"data":"/clear", "requestId":"rest-request", "timeout":15}),
        )
        .await;
    assert_eq!(status, 200, "{cleared}");
    assert_eq!(cleared["data"]["status"], "idle", "{cleared}");
    let new_id = cleared["data"]["sessionId"].as_str().unwrap();
    assert_ne!(new_id, old_id, "clear chooses a new conversation");
    assert!(uuid::Uuid::parse_str(new_id).is_ok());
    assert_eq!(
        cleared["data"]["sessionRef"],
        json!({"provider":"claude", "sessionId":new_id})
    );
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    let fresh_capture = loop {
        let (status, capture) = get(&rig, &format!("/api/panes/{pane}/capture")).await;
        assert_eq!(status, 200, "{capture}");
        assert!(
            !capture.contains("before clear conversation"),
            "the new conversation must never expose its parent's dialogue: {capture}"
        );
        if capture.trim() == "user: /clear" {
            break capture;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the CLI's buffered local-command rows never reached capture: {capture}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(
        fresh_capture.trim(),
        "user: /clear",
        "the new saved history holds only its own local command"
    );
    let next = send(&rig, pane, "after clear conversation").await;
    assert_eq!(next["status"], "idle");
    assert_eq!(next["sessionId"], new_id);
    wait_for_saved_turn(&rig, new_id, next["submittedTurnId"].as_str().unwrap()).await;
    let (status, next_capture) = get(&rig, &format!("/api/panes/{pane}/capture")).await;
    assert_eq!(status, 200, "{next_capture}");
    assert!(
        next_capture.contains("after clear conversation"),
        "{next_capture}"
    );
    assert!(
        !next_capture.contains("before clear conversation"),
        "{next_capture}"
    );
    let old_path = rig.wait_for_transcript(old_id).await;
    let old_lines: Vec<Value> = std::fs::read_to_string(old_path)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    assert!(old_lines.iter().any(|line| line["type"] == "user"));
    assert!(
        old_lines.iter().any(|line| line["type"] == "assistant"),
        "clear preserves the previous conversation"
    );
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clear_sim_rekeys_the_headless_rest_pane_before_capture_and_next_send() {
    clear_rekeys_the_headless_rest_pane(RigKind::Sim).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clear_pinned_cli_rekeys_the_headless_rest_pane_before_capture_and_next_send() {
    clear_rekeys_the_headless_rest_pane(RigKind::Cli).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_timed_out_send_reports_the_accepted_replacement_and_updates_headless_capture() {
    let rig = ClaudeRig::start_with_options(RigKind::Sim, options()).await;
    let created = create(&rig, "claude").await;
    let original = created["sessionId"].as_str().unwrap();
    let pane = created["paneId"].as_str().unwrap();
    for text in ["kept timeout conversation", "removed timeout conversation"] {
        let sent = send(&rig, pane, text).await;
        wait_for_saved_turn(&rig, original, sent["submittedTurnId"].as_str().unwrap()).await;
    }
    // A protocol client performs the undo but never mirrors a browser layout.
    // The REST pane still addresses A when the runtime supersedes it with B.
    let mut control = rig.connect().await;
    let owner = rig.fresh_claude.ownership_snapshot("claude", original);
    control.send(json!({
        "type":"freshAgent.undo", "provider":"claude", "sessionType":"freshclaude", "sessionId":original,
        "requestId":"undo-before-timeout", "mode":"step", "observedEpoch":owner.epoch, "observedGeneration":owner.generation,
    })).await;
    let ack = control
        .wait_for("undo replacement", |frame| {
            frame["event"]["requestId"] == "undo-before-timeout"
                && matches!(
                    frame["event"]["type"].as_str(),
                    Some("freshAgent.rolledBack" | "freshAgent.error")
                )
        })
        .await;
    assert_eq!(ack["event"]["type"], "freshAgent.rolledBack", "{ack}");
    let replacement = ack["event"]["newSessionId"].as_str().unwrap();
    assert_ne!(replacement, original);
    let (status, body) = rig
        .post_json(
            &format!("/api/panes/{pane}/send-keys"),
            &json!({"data":"HANG", "timeout":1}),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["status"], "approx");
    assert_eq!(body["data"]["sessionId"], replacement);
    assert_eq!(body["data"]["sessionRef"]["sessionId"], replacement);
    let (status, captured) = get(&rig, &format!("/api/panes/{pane}/capture")).await;
    assert_eq!(status, 200, "{captured}");
    assert!(captured.contains("kept timeout conversation"), "{captured}");
    assert!(
        !captured.contains("removed timeout conversation"),
        "{captured}"
    );
    rig.fresh_claude.shutdown().await;
}
