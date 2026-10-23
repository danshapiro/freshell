//! Missing recovery contracts on the pinned CLI and loopback provider.
#![cfg(unix)]

mod common;

#[cfg(target_os = "linux")]
use common::claude_rig::repo_root;
use common::claude_rig::{ClaudeRig, RigKind, RigOptions, RIG_FRAME_BUDGET};
#[cfg(target_os = "linux")]
use common::process_probe::ProcessProbe;
#[cfg(target_os = "linux")]
use freshell_freshagent::ClaudeSendOutcome;
use freshell_ws::pane_ledger::RowState;
use serde_json::{json, Value};
use std::time::Duration;

async fn snapshot_containing(rig: &ClaudeRig, id: &str, text: &str) -> Value {
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        let (status, snapshot) = rig.snapshot(id).await;
        if status == 200 && snapshot.to_string().contains(text) {
            return snapshot;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the transcript never contained {text:?}: {snapshot}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(target_os = "linux")]
fn children(pid: u32) -> Vec<u32> {
    // The native CLI can spawn MCP from a worker thread. A thread's children
    // file covers only that thread, so inspect every task in this process.
    let mut children = std::collections::BTreeSet::new();
    if let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) {
        for task in tasks.flatten() {
            if let Ok(text) = std::fs::read_to_string(task.path().join("children")) {
                children.extend(
                    text.split_whitespace()
                        .filter_map(|pid| pid.parse::<u32>().ok()),
                );
            }
        }
    }
    children.into_iter().collect()
}

#[cfg(target_os = "linux")]
async fn native_cli(rig: &ClaudeRig, id: &str, ownership_id: &str) -> (u32, u32) {
    let freshell_ownership::OwnershipState::Live { owner, .. } =
        rig.fresh_claude.ownership_snapshot("claude", id).state
    else {
        panic!("the rig must own the live sidecar");
    };
    let sidecar = owner.pid.unwrap();
    let tag = format!(
        "{}={ownership_id}",
        freshell_freshagent::claude_spawn::CLAUDE_SIDECAR_OWNERSHIP_ENV
    );
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    loop {
        for pid in children(sidecar) {
            let args = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
            let is_cli = args
                .split(|byte| *byte == 0)
                .any(|arg| arg == b"claude" || arg.ends_with(b"/claude"));
            let environment = std::fs::read(format!("/proc/{pid}/environ")).unwrap_or_default();
            if is_cli
                && environment
                    .split(|byte| *byte == 0)
                    .any(|entry| entry == tag.as_bytes())
            {
                return (sidecar, pid);
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no owned native CLI child of sidecar {sidecar}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn killing_the_native_cli_mid_turn_rings_once_and_recovers_the_same_conversation() {
    let rig = ClaudeRig::start_with_options(
        RigKind::Cli,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut first = rig.connect().await;
    let id = first.create("actual-mid-turn-crash").await;
    let outcome = rig
        .fresh_claude
        .handle_send(
            serde_json::from_value(json!({
                "provider":"claude", "sessionType":"freshclaude", "sessionId":id,
                "requestId":"native-hanging-turn", "text":"HANG before the native CLI crash",
            }))
            .unwrap(),
        )
        .await;
    let ClaudeSendOutcome::Accepted { ownership_id, .. } = outcome else {
        panic!("{outcome:?}");
    };
    snapshot_containing(&rig, &id, "HANG before the native CLI crash").await;
    let (sidecar, cli) = native_cli(&rig, &id, &ownership_id).await;
    assert_ne!(sidecar, cli);
    let cli_probe = ProcessProbe::open(cli);
    assert!(cli_probe.running());
    // SAFETY: this is the tagged native CLI child of this rig's registered sidecar.
    assert_eq!(unsafe { libc::kill(cli as i32, libc::SIGKILL) }, 0);
    first
        .wait_for("the native CLI death report", |frame| {
            frame["event"]["code"] == "SIDECAR_EXITED"
        })
        .await;
    first.wait_for_event("freshAgent.turn.complete").await;
    first.read_for(Duration::from_millis(200)).await;
    assert_eq!(first.events_seen("freshAgent.turn.complete"), 1);
    assert!(cli_probe.exited());
    assert_eq!(
        rig.fresh_claude.live_snapshot_overlay(&id).await["status"],
        "exited"
    );
    let mut second = rig.connect().await;
    second
        .send_text(
            &id,
            "continue-after-native-crash",
            "continue the same conversation after the native CLI crash",
        )
        .await;
    second.wait_for_event("freshAgent.result").await;
    second.wait_for_event("freshAgent.turn.complete").await;
    assert_eq!(second.init_session_id(&id), id);
    let snapshot = snapshot_containing(
        &rig,
        &id,
        "continue the same conversation after the native CLI crash",
    )
    .await;
    assert!(snapshot
        .to_string()
        .contains("HANG before the native CLI crash"));
    rig.fresh_claude.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_actual_zero_turn_create_survives_a_server_restart_with_the_same_uuid() {
    let mut rig = ClaudeRig::start_with_options(
        RigKind::Cli,
        RigOptions {
            durable_ledger: true,
            ..RigOptions::default()
        },
    )
    .await;
    let mut first = rig.connect().await;
    let id = first.create("actual-zero-turn-restart").await;
    assert!(uuid::Uuid::parse_str(&id).is_ok());
    assert_eq!(
        rig.pane_ledger
            .as_ref()
            .unwrap()
            .binding_genesis("claude", &id),
        Some(json!({"kind":"fresh"}))
    );
    rig.restart().await;
    let mut second = rig.connect().await;
    second.attach(&id).await;
    second
        .send_text(
            &id,
            "first-turn-after-restart",
            "the first prompt after an actual zero-turn restart",
        )
        .await;
    second.wait_for_event("freshAgent.result").await;
    assert_eq!(second.init_session_id(&id), id);
    snapshot_containing(
        &rig,
        &id,
        "the first prompt after an actual zero-turn restart",
    )
    .await;
    rig.wait_for_genesis_cleared(&id).await;
    assert_eq!(
        rig.pane_ledger
            .as_ref()
            .unwrap()
            .lookup_by_session("claude", &id)
            .unwrap()
            .row
            .state,
        RowState::Bound
    );
    rig.fresh_claude.shutdown().await;
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_real_hung_stdio_mcp_tool_becomes_stuck_and_recovers_without_closing_its_binding() {
    let module = repo_root().join("test/integration/providers/claude-sdk-with-hung-mcp.mjs");
    let rig = ClaudeRig::start_with_options(
        RigKind::Cli,
        RigOptions {
            durable_ledger: true,
            env: vec![
                (
                    "FRESHELL_CLAUDE_SDK_QUERY_MODULE".into(),
                    module.to_string_lossy().into(),
                ),
                ("FRESHELL_FRESHCLAUDE_QUIET_WINDOW_MS".into(), "5000".into()),
                (
                    "FRESHELL_FRESHCLAUDE_TOOL_HEARTBEAT_CAP_MS".into(),
                    "1000".into(),
                ),
            ],
            ..RigOptions::default()
        },
    )
    .await;
    let mut conn = rig.connect().await;
    let created = conn
        .request_create(
            "actual-hung-mcp",
            json!({"permissionMode":"bypassPermissions"}),
        )
        .await;
    let id = created["sessionId"]
        .as_str()
        .expect("the pinned CLI booted with its MCP server");
    let outcome = rig
        .fresh_claude
        .handle_send(
            serde_json::from_value(json!({
                "provider":"claude", "sessionType":"freshclaude", "sessionId":id,
                "requestId":"native-hung-mcp-turn", "text":"MCP:hang",
            }))
            .unwrap(),
        )
        .await;
    let ClaudeSendOutcome::Accepted { ownership_id, .. } = outcome else {
        panic!("{outcome:?}");
    };
    conn.wait_for("the real MCP tool call", |frame| {
        frame["event"]["content"].as_array().is_some_and(|blocks| {
            blocks
                .iter()
                .any(|block| block["type"] == "tool_use" && block["name"] == "mcp__hang__wait")
        })
    })
    .await;
    let (sidecar, cli) = native_cli(&rig, id, &ownership_id).await;
    let mcp_script = repo_root()
        .join("test/integration/providers/claude-hang-mcp-server.mjs")
        .canonicalize()
        .unwrap();
    let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
    let mcp = loop {
        let mut descendants = children(cli);
        let mut found = None;
        while let Some(pid) = descendants.pop() {
            let args = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
            if args
                .split(|byte| *byte == 0)
                .any(|arg| arg == mcp_script.to_string_lossy().as_bytes())
            {
                found = Some(pid);
                break;
            }
            descendants.extend(children(pid));
        }
        if let Some(pid) = found {
            break pid;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the real hung stdio MCP process never became a child of the owned CLI"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let probes = [sidecar, cli, mcp].map(ProcessProbe::open);
    assert!(probes.iter().all(ProcessProbe::running));
    conn.wait_for("the real hung tool's quiet timeout", |frame| {
        frame["event"]["status"] == "stuck"
    })
    .await;
    let edge = conn.wait_for_event("freshAgent.turn.complete").await;
    let first_at = edge["event"]["at"].as_i64().unwrap();
    conn.read_for(Duration::from_millis(250)).await;
    assert_eq!(conn.events_seen("freshAgent.turn.complete"), 1);
    assert_eq!(conn.events_seen("freshAgent.result"), 0);
    conn.send(
        json!({"type":"freshAgent.recovery.stop", "provider":"claude", "sessionType":"freshclaude",
        "sessionId":id, "requestId":"recover-native-mcp"}),
    )
    .await;
    let stopped = conn
        .wait_for("the native MCP recovery stop", |frame| {
            frame["type"] == "freshAgent.recovery.stopped"
                && frame["requestId"] == "recover-native-mcp"
        })
        .await;
    assert_eq!(stopped["success"], true, "{stopped}");
    assert!(
        probes.iter().all(ProcessProbe::exited),
        "confirmation covers the sidecar, native CLI, and hung MCP server"
    );
    assert_eq!(
        rig.pane_ledger
            .as_ref()
            .unwrap()
            .lookup_by_session("claude", id)
            .unwrap()
            .row
            .state,
        RowState::Bound
    );
    assert_eq!(
        conn.events_seen("freshAgent.turn.complete"),
        1,
        "the requested stop adds no bell"
    );
    conn.frames.clear();
    conn.attach(id).await;
    conn.send_text(
        id,
        "after-native-mcp-recovery",
        "after the hung MCP process was stopped",
    )
    .await;
    conn.wait_for_event("freshAgent.result").await;
    let completed = conn.wait_for_event("freshAgent.turn.complete").await;
    assert!(
        completed["event"]["at"].as_i64().unwrap() > first_at,
        "recovery retains the attention clock"
    );
    assert_eq!(conn.init_session_id(id), id);
    rig.fresh_claude.shutdown().await;
}
