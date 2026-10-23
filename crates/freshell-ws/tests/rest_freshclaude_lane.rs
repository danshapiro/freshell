//! The default REST/MCP door controls the real WebSocket Claude runtime.
#![cfg(unix)]

mod common;

use common::claude_rig::{ClaudeRig, RigKind, RigOptions, RIG_FRAME_BUDGET};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn options() -> RigOptions {
    RigOptions {
        rest_api: true,
        durable_ledger: true,
        ..Default::default()
    }
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
    let (status, fresh_capture) = get(&rig, &format!("/api/panes/{pane}/capture")).await;
    assert_eq!(status, 200, "{fresh_capture}");
    assert!(
        fresh_capture.is_empty(),
        "the same headless pane now captures the new empty conversation: {fresh_capture}"
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
