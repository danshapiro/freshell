//! Transparent recovery uses the production sidecar and launch/ownership path.
//! Deliberate child crashes run only in the disposable runtime sandbox.

#![cfg(unix)]

mod common;

use common::claude_rig::{ClaudeRig, RigConnection, RigKind, RigOptions, RIG_FRAME_BUDGET};
use serde_json::{json, Value};
use std::time::Duration;

async fn crash_runtime(rig: &ClaudeRig, conn: &mut RigConnection, id: &str) {
    let owner = rig.fresh_claude.ownership_snapshot("claude", id);
    let freshell_ownership::OwnershipState::Live { owner, .. } = owner.state else {
        panic!("the rig must own a live runtime before crashing it");
    };
    let pid = owner.pid.expect("the registered rig sidecar's pid") as i32;
    // SAFETY: this pid is the live sidecar registered by this isolated rig.
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
    conn.wait_for("the sidecar's exit", |frame| {
        frame["event"]["code"] == "SIDECAR_EXITED"
    })
    .await;
    // wait_for also searches recorded frames. Subsequent control assertions
    // must observe this recovery, not the prior turn or its exit report.
    conn.frames.clear();
}

async fn send_after_crash(zero_turn: bool, durable_ledger: bool, kind: RigKind) {
    let rig = ClaudeRig::start_with_options(
        kind,
        RigOptions {
            durable_ledger,
            ..RigOptions::default()
        },
    )
    .await;
    let mut first = rig.connect().await;
    let pane = first.create("create-recovery").await;
    let durable_before = if zero_turn {
        None
    } else {
        Some(rig.converse(&mut first, &pane, &["before the crash"]).await)
    };
    crash_runtime(&rig, &mut first, &pane).await;
    if zero_turn {
        let (status, snapshot) = rig.snapshot(&pane).await;
        assert_eq!(
            status, 200,
            "a stopped zero-turn conversation remains readable: {snapshot}"
        );
        assert_eq!(snapshot["status"], "exited", "{snapshot}");
    }
    let mut second = rig.connect().await;
    second
        .send_text(&pane, "after-crash", "continue after the crash")
        .await;
    let reply = second
        .wait_for("the second device's send outcome", |frame| {
            frame["requestId"] == "after-crash"
                && (frame["type"] == "freshAgent.send.accepted" || frame["type"] == "error")
        })
        .await;
    assert_eq!(reply["type"], "freshAgent.send.accepted", "{reply}");
    second
        .wait_for("the recovered turn's result", |frame| {
            frame["sessionId"] == pane && frame["event"]["type"] == "freshAgent.result"
        })
        .await;
    second
        .wait_for("the recovered turn's completion", |frame| {
            frame["sessionId"] == pane && frame["event"]["type"] == "freshAgent.turn.complete"
        })
        .await;
    let durable_after = second.init_session_id(&pane);
    if let Some(before) = durable_before {
        assert_eq!(
            durable_after, before,
            "recovery resumes the original conversation"
        );
        let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
        loop {
            let (status, snapshot) = rig.snapshot(&durable_after).await;
            let text = snapshot.to_string();
            if status == 200
                && text.contains("before the crash")
                && text.contains("continue after the crash")
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the recovered conversation never persisted both messages: {snapshot}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    if kind == RigKind::Sim {
        let launches: Vec<Value> = rig.ledger_rows("query");
        assert_eq!(
            launches.len(),
            2,
            "one initial launch and one recovery launch"
        );
        if zero_turn {
            assert_eq!(
                durable_after, pane,
                "zero-turn recovery keeps its create-time UUID"
            );
            assert_eq!(launches[1]["options"]["sessionId"], pane);
            assert!(
                launches[1]["options"]["resume"].is_null(),
                "a zero-turn session boots Fresh"
            );
        } else {
            assert_eq!(launches[1]["options"]["resume"], durable_after);
        }
    }
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_device_send_transparently_resumes_a_crashed_conversation() {
    send_after_crash(false, true, RigKind::Sim).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_zero_turn_crash_transparently_reboots_fresh_on_send() {
    send_after_crash(true, true, RigKind::Sim).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hosted_zero_turn_crash_recovers_from_its_retained_genesis() {
    send_after_crash(true, false, RigKind::Sim).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_cli_resumes_on_a_second_device_send_after_a_crash() {
    send_after_crash(false, true, RigKind::Cli).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_concurrent_send_and_attach_share_one_recovery_launch() {
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut first = rig.connect().await;
    let id = first.create("concurrent-recovery-create").await;
    rig.converse(&mut first, &id, &["before concurrent recovery"])
        .await;
    rig.kill_first_sidecar(&mut first).await;
    let mut sender = rig.connect().await;
    let mut observer = rig.connect().await;
    tokio::join!(
        async {
            sender
                .send_text(&id, "concurrent-recovery-send", "continue once")
                .await;
            let accepted = sender
                .wait_for("the recovering send", |frame| {
                    frame["requestId"] == "concurrent-recovery-send"
                        && (frame["type"] == "freshAgent.send.accepted" || frame["type"] == "error")
                })
                .await;
            assert_eq!(accepted["type"], "freshAgent.send.accepted", "{accepted}");
            sender.wait_for_event("freshAgent.result").await;
        },
        async {
            observer.attach(&id).await;
        }
    );
    assert_eq!(
        rig.ledger_rows("query").len(),
        2,
        "only one claimant may relaunch the runtime"
    );
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hosted_recovery_keeps_the_last_model_effort_and_permission_mode() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut first = rig.connect().await;
    let created = first
        .request_create(
            "hosted-settings-create",
            json!({
                "model":"sonnet", "effort":"high", "permissionMode":"plan",
            }),
        )
        .await;
    let id = created["sessionId"].as_str().unwrap();
    rig.converse(&mut first, id, &["persist this conversation"])
        .await;
    rig.kill_first_sidecar(&mut first).await;
    let mut second = rig.connect().await;
    second
        .send_text(
            id,
            "restore-hosted-settings",
            "continue with the same settings",
        )
        .await;
    second.wait_for_event("freshAgent.result").await;
    let queries = rig.ledger_rows("query");
    assert_eq!(queries.len(), 2);
    assert_eq!(
        queries[1]["options"]["model"],
        queries[0]["options"]["model"]
    );
    let (_, snapshot) = rig.snapshot(id).await;
    assert_eq!(snapshot["settings"]["model"], "sonnet", "{snapshot}");
    assert_eq!(snapshot["settings"]["effort"], "high", "{snapshot}");
    assert_eq!(snapshot["settings"]["permissionMode"], "plan", "{snapshot}");
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configuring_a_dead_session_stores_settings_without_starting_a_process() {
    for durable_ledger in [true, false] {
        let mut rig = ClaudeRig::start_with_options(
            RigKind::Sim,
            RigOptions {
                durable_ledger,
                ..RigOptions::default()
            },
        )
        .await;
        let mut conn = rig.connect().await;
        let id = conn.create("dead-configure-create").await;
        crash_runtime(&rig, &mut conn, &id).await;
        conn.send(
            json!({"type":"freshAgent.configure", "provider":"claude", "sessionType":"freshclaude",
            "sessionId":id, "requestId":"dead-configure", "settings":{
                "model":"sonnet", "effort":"high", "permissionMode":"plan",
            }}),
        )
        .await;
        let answer = conn
            .wait_for("the stored settings", |frame| {
                frame["event"]["type"] == "freshAgent.session.metadata"
                    || frame["event"]["type"] == "freshAgent.error"
                    || (frame["type"] == "error" && frame["requestId"] == "dead-configure")
            })
            .await;
        assert_eq!(
            answer["event"]["type"], "freshAgent.session.metadata",
            "{answer}"
        );
        assert_eq!(answer["event"]["model"], "sonnet");
        assert_eq!(answer["event"]["effort"], "high");
        assert_eq!(answer["event"]["permissionMode"], "plan");
        assert_eq!(
            rig.ledger_rows("query").len(),
            1,
            "settings alone must not relaunch"
        );
        assert!(!rig.fresh_claude.has_live_session(&id).await);
        if durable_ledger {
            rig.restart().await;
            conn = rig.connect().await;
        }
        conn.send_text(&id, "send-after-dead-configure", "use the stored settings")
            .await;
        conn.wait_for_event("freshAgent.result").await;
        let queries = rig.ledger_rows("query");
        assert_eq!(queries.len(), 2);
        assert_eq!(queries[1]["options"]["model"], "sonnet");
        let (_, snapshot) = rig.snapshot(&id).await;
        assert_eq!(snapshot["settings"]["effort"], "high", "{snapshot}");
        assert_eq!(snapshot["settings"]["permissionMode"], "plan", "{snapshot}");
        rig.fresh_claude.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compaction_resumes_a_dead_conversation_through_the_same_runtime_path() {
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut conn = rig.connect().await;
    let id = conn.create("dead-compact-create").await;
    rig.converse(&mut conn, &id, &["before compaction recovery"])
        .await;
    crash_runtime(&rig, &mut conn, &id).await;
    conn.send(
        json!({"type":"freshAgent.compact", "provider":"claude", "sessionType":"freshclaude",
        "sessionId":id, "requestId":"dead-compact", "instructions":"keep the conclusion"}),
    )
    .await;
    let answer = conn
        .wait_for("the compact outcome", |frame| {
            frame["event"]["type"] == "freshAgent.result"
                || frame["event"]["type"] == "freshAgent.error"
        })
        .await;
    assert_eq!(answer["event"]["type"], "freshAgent.result", "{answer}");
    assert_eq!(rig.ledger_rows("query").len(), 2);
    let prompts = rig.ledger_rows("prompt");
    assert_eq!(
        prompts.last().unwrap()["text"],
        "/compact keep the conclusion"
    );
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreadable_store_is_a_transient_recovery_error_and_never_a_lost_session() {
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut conn = rig.connect().await;
    let id = conn.create("transient-recovery-create").await;
    crash_runtime(&rig, &mut conn, &id).await;
    std::fs::create_dir_all(&rig.claude_config_dir).unwrap();
    let saved = rig.claude_config_dir.with_extension("saved");
    std::fs::rename(&rig.claude_config_dir, &saved).unwrap();
    std::fs::create_dir_all(&rig.claude_config_dir).unwrap();
    // A loop is an actual read failure even as root; NotADirectory is an
    // expected clean absence in the transcript-store contract.
    std::os::unix::fs::symlink("projects", rig.claude_config_dir.join("projects")).unwrap();
    conn.send_text(&id, "transient-recovery-send", "keep this prompt")
        .await;
    let error = conn
        .wait_for("the transient send refusal", |frame| {
            frame["type"] == "error" && frame["requestId"] == "transient-recovery-send"
        })
        .await;
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .contains("CLAUDE_ATTACH_RESUME_FAILED"),
        "{error}"
    );
    conn.read_for(Duration::from_millis(100)).await;
    assert!(!conn
        .frames
        .iter()
        .any(|frame| frame["event"]["code"] == "INVALID_SESSION_ID"));
    assert_eq!(
        rig.ledger_rows("query").len(),
        1,
        "an unchecked conversation never launches"
    );
    std::fs::rename(
        &rig.claude_config_dir,
        rig.claude_config_dir.with_extension("unreadable"),
    )
    .unwrap();
    std::fs::rename(saved, &rig.claude_config_dir).unwrap();
    conn.send_text(&id, "retry-after-transient", "keep this prompt")
        .await;
    conn.wait_for_event("freshAgent.result").await;
    assert_eq!(
        rig.ledger_rows("query").len(),
        2,
        "a refused recovery must release its flight and lease"
    );
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cold_hosted_configuration_has_a_runtime_to_retain_its_settings() {
    let mut rig = ClaudeRig::start(RigKind::Sim).await;
    let mut conn = rig.connect().await;
    let id = conn.create("cold-hosted-create").await;
    rig.converse(&mut conn, &id, &["an existing hosted conversation"])
        .await;
    rig.restart().await;
    let mut conn = rig.connect().await;
    conn.send(
        json!({"type":"freshAgent.configure", "provider":"claude", "sessionType":"freshclaude",
        "sessionId":id, "requestId":"cold-hosted-configure", "settings":{"model":"sonnet"}}),
    )
    .await;
    let answer = conn
        .wait_for("the cold hosted settings outcome", |frame| {
            frame["event"]["type"] == "freshAgent.session.metadata"
                || frame["event"]["type"] == "freshAgent.error"
        })
        .await;
    assert_eq!(answer["event"]["model"], "sonnet", "{answer}");
    assert!(rig.fresh_claude.has_live_session(&id).await);
    assert_eq!(rig.ledger_rows("query").len(), 2);
    let (_, snapshot) = rig.snapshot(&id).await;
    assert_eq!(snapshot["settings"]["model"], "sonnet", "{snapshot}");
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cleanly_missing_conversation_is_lost_without_starting_a_new_one() {
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut conn = rig.connect().await;
    let id = conn.create("missing-recovery-create").await;
    rig.converse(&mut conn, &id, &["a conversation that had a transcript"])
        .await;
    rig.wait_for_genesis_cleared(&id).await;
    crash_runtime(&rig, &mut conn, &id).await;
    let projects = rig.claude_config_dir.join("projects");
    std::fs::rename(
        &projects,
        rig.claude_config_dir.with_extension("projects-saved"),
    )
    .unwrap();
    conn.send_text(&id, "missing-recovery-send", "do not reset my conversation")
        .await;
    let lost = conn
        .wait_for("the nested lost conversation", |frame| {
            frame["event"]["code"] == "INVALID_SESSION_ID"
        })
        .await;
    assert_eq!(lost["sessionId"], id);
    let refusal = conn
        .wait_for("the correlated unsent prompt", |frame| {
            frame["type"] == "error" && frame["requestId"] == "missing-recovery-send"
        })
        .await;
    assert_eq!(refusal["code"], "INVALID_SESSION_ID");
    assert_eq!(rig.ledger_rows("query").len(), 1);
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_late_send_does_not_reopen_a_session_that_was_explicitly_closed() {
    let rig = ClaudeRig::start_with_options(
        RigKind::Sim,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut conn = rig.connect().await;
    let id = conn.create("closed-recovery-create").await;
    conn.kill(&id).await;
    conn.frames.clear();
    conn.send_text(
        &id,
        "closed-recovery-send",
        "a late message from another device",
    )
    .await;
    let answer = conn
        .wait_for("the closed-session send outcome", |frame| {
            frame["requestId"] == "closed-recovery-send"
                && (frame["type"] == "error" || frame["type"] == "freshAgent.send.accepted")
        })
        .await;
    assert_eq!(
        answer["type"], "error",
        "a late send must not undo an explicit close: {answer}"
    );
    assert_eq!(rig.ledger_rows("query").len(), 1);
    assert!(!rig.fresh_claude.has_live_session(&id).await);
    // Opening the saved session is an explicit recovery action.
    conn.attach(&id).await;
    assert!(rig.fresh_claude.has_live_session(&id).await);
    assert_eq!(rig.ledger_rows("query").len(), 2);
    rig.fresh_claude.shutdown().await;
}
