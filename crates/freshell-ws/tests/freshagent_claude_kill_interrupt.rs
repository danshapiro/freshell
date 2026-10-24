//! WebSocket kill and interrupt dispatch through the production Claude sidecar.
//! The contract simulator supplies the SDK boundary and records actual CLI
//! controls; every test uses an isolated rig and the real WS dispatcher.

use common::claude_rig::{ClaudeRig, RigKind, RIG_FRAME_BUDGET};
use serde_json::json;
use std::time::Duration;

mod common;

// Retained for the existing control-outcome cases, which also install log capture.
#[cfg(unix)]
static CLAUDE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_kill_frame_reaches_handle_kill_and_evicts_the_create_dedup_cache() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut conn = rig.connect().await;
    let request = "req-claude-ws-kill-dedup";
    let first = conn.create(request).await;
    let processes = rig.runtime_processes(&first);
    conn.kill(&first).await;
    processes
        .wait_until_exited("the WS-killed sidecar and CLI")
        .await;
    let recreated = conn.request_create(request, json!({})).await;
    assert_eq!(recreated["type"], "freshAgent.created", "{recreated}");
    assert_ne!(
        recreated["sessionId"], first,
        "kill must evict create dedup, so the same request creates a fresh runtime"
    );
    assert_eq!(rig.ledger_rows("query").len(), 2);
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_interrupt_frame_reaches_the_sidecar_for_a_known_session() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut conn = rig.connect().await;
    let id = conn.create("req-claude-ws-interrupt").await;
    conn.send_text(&id, "req-claude-ws-send", "HANG").await;
    let accepted = conn
        .wait_for("the accepted turn", |frame| {
            frame["type"] == "freshAgent.send.accepted"
                && frame["requestId"] == "req-claude-ws-send"
        })
        .await;
    tokio::time::timeout(RIG_FRAME_BUDGET, async {
        while !rig
            .ledger_rows("prompt")
            .iter()
            .any(|row| row["sessionId"] == id && row["uuid"] == accepted["submittedTurnId"])
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the accepted command reached the simulated CLI");
    conn.send(
        json!({"type":"freshAgent.interrupt", "provider":"claude", "sessionType":"freshclaude",
        "sessionId":id, "requestId":"req-claude-ws-stop"}),
    )
    .await;
    conn.wait_for_event("freshAgent.result").await;
    let controls = rig.ledger_rows("interrupt");
    assert_eq!(
        controls.len(),
        1,
        "the production sidecar called SDK interrupt: {controls:?}"
    );
    assert_eq!(controls[0]["running"], true);
    assert_eq!(
        rig.fresh_claude.live_snapshot_overlay(&id).await["status"],
        "idle"
    );
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        0,
        "the user's own Stop ends the turn silently"
    );
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_interrupt_frame_errors_for_an_unknown_session() {
    let rig = ClaudeRig::start(RigKind::Sim).await;
    let mut conn = rig.connect().await;
    conn.send(
        json!({"type":"freshAgent.interrupt", "provider":"claude", "sessionType":"freshclaude",
        "sessionId":"does-not-exist"}),
    )
    .await;
    let failure = conn.wait_for_event("freshAgent.error").await;
    assert_eq!(failure["event"]["code"], "INVALID_SESSION_ID", "{failure}");
    assert_eq!(failure["sessionId"], "does-not-exist");
    assert!(
        rig.ledger_rows("query").is_empty(),
        "an unknown Stop creates no runtime"
    );
    rig.fresh_claude.shutdown().await;
}

#[cfg(unix)]
mod control_outcomes {
    use super::*;
    use common::claude_rig::{ClaudeRig, RigKind};
    use serde_json::json;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unknown_configure_and_interrupt_requests_report_correlated_session_errors() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut conn = rig.connect().await;
        for session_type in ["freshclaude", "kilroy"] {
            for control in ["configure", "interrupt"] {
                let id = uuid::Uuid::new_v4().to_string();
                let request_id = format!("unknown-{session_type}-{control}");
                let mut request = json!({"type":format!("freshAgent.{control}"),
                "provider":"claude", "sessionType":session_type, "sessionId":id, "requestId":request_id});
                if control == "configure" {
                    request["settings"] = json!({"model":"sonnet"});
                }
                conn.send(request).await;
                let reply = conn
                    .wait_for("the unknown control refusal", |frame| {
                        frame["type"] == "error" || frame["event"]["type"] == "freshAgent.error"
                    })
                    .await;
                assert_eq!(reply["event"]["code"], "INVALID_SESSION_ID", "{reply}");
                assert_eq!(reply["event"]["requestId"], request_id, "{reply}");
                assert_eq!(reply["sessionId"], id);
                assert_eq!(reply["sessionType"], session_type);
                conn.frames.clear();
            }
        }
        assert!(rig.ledger_rows("query").is_empty());
        rig.fresh_claude.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn interrupting_a_dead_session_repeats_exited_without_restarting_it() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let rig = ClaudeRig::start(RigKind::Sim).await;
        let mut conn = rig.connect().await;
        let id = conn.create("dead-control-create").await;
        rig.kill_first_sidecar(&mut conn).await;
        conn.frames.clear();
        conn.send(
            json!({"type":"freshAgent.interrupt", "provider":"claude", "sessionType":"freshclaude",
        "sessionId":id, "requestId":"dead-control-stop"}),
        )
        .await;
        let reply = conn
            .wait_for("the dead Stop outcome", |frame| {
                frame["type"] == "error"
                    || frame["event"]["type"] == "freshAgent.error"
                    || frame["event"]["type"] == "freshAgent.status"
            })
            .await;
        assert_eq!(reply["event"]["status"], "exited", "{reply}");
        assert_eq!(reply["sessionId"], id);
        assert_eq!(
            rig.ledger_rows("query").len(),
            1,
            "Stop alone must not recover a process"
        );
        assert!(!rig.fresh_claude.has_live_session(&id).await);
        rig.fresh_claude.shutdown().await;
    }

    async fn refused_interrupt_reports_the_request_and_does_not_silence_completion(reissued: bool) {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let wrapper = tempfile::tempdir().unwrap();
        let module = wrapper.path().join("refuse-interrupt.mjs");
        let simulator =
            common::claude_rig::repo_root().join("test/fixtures/claude-cli-sim/query.mjs");
        std::fs::write(
            &module,
            format!(
                r#"
import {{ query as originalQuery }} from {};
export function query(params) {{
  const running = originalQuery(params);
  const interrupt = running.interrupt.bind(running);
  let calls = 0;
  running.interrupt = async (...args) => {{
    calls += 1;
    if (calls === {}) throw new Error('injected interrupt refusal');
    return interrupt(...args);
  }};
  return running;
}}
"#,
                serde_json::to_string(&format!("file://{}", simulator.display())).unwrap(),
                if reissued { 2 } else { 1 }
            ),
        )
        .unwrap();
        let logs = common::log_capture::install();
        let mut extra = vec![("FRESHELL_CLAUDE_SDK_QUERY_MODULE", module.to_str().unwrap())];
        if reissued {
            extra.push(("FRESHELL_CLAUDE_SIM_COLD_COMMAND", "queued"));
        }
        let rig = ClaudeRig::start_with_env(RigKind::Sim, &extra).await;
        let mut conn = rig.connect().await;
        let id = conn.create("refused-stop-create").await;
        conn.send_text(&id, "the-running-turn", "TOOL:sleep=0.5")
            .await;
        if !reissued {
            conn.wait_for("the running tool", |frame| {
                frame["event"]["content"]
                    .as_array()
                    .is_some_and(|content| content.iter().any(|block| block["type"] == "tool_use"))
            })
            .await;
        }
        conn.send(
            json!({"type":"freshAgent.interrupt", "provider":"claude", "sessionType":"freshclaude",
        "sessionId":id, "requestId":"refused-stop-request"}),
        )
        .await;
        logs.wait_for("the refused interrupt receipt", |event| {
            event.message == "freshagent.claude.stop"
                && event.field("session_id") == Some(&id)
                && event.field("outcome") == Some("refused")
        })
        .await;
        conn.read_for(Duration::from_millis(100)).await;
        let failure = conn
            .frames
            .iter()
            .find(|frame| frame["event"]["code"] == "CLAUDE_INTERRUPT_FAILED")
            .expect("a refused Stop must report a nested session error");
        assert_eq!(failure["event"]["requestId"], "refused-stop-request");
        conn.wait_for_event("freshAgent.result").await;
        conn.wait_for_event("freshAgent.turn.complete").await;
        conn.read_for(Duration::from_millis(50)).await;
        assert_eq!(
            conn.events_seen("freshAgent.turn.complete"),
            1,
            "the failed Stop never suppresses completion"
        );
        assert_eq!(
            rig.fresh_claude.live_snapshot_overlay(&id).await["status"],
            "idle"
        );
        rig.fresh_claude.shutdown().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refused_interrupt_is_visible_and_does_not_silence_the_turns_result() {
        refused_interrupt_reports_the_request_and_does_not_silence_completion(false).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refused_reissued_interrupt_reports_the_original_request_and_does_not_silence_completion(
    ) {
        refused_interrupt_reports_the_request_and_does_not_silence_completion(true).await;
    }
}
