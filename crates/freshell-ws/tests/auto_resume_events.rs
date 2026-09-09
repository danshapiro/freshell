//! CrashEvents are sent for natural exits only — never for user kills.
//!
//! Raw-WS (tokio-tungstenite) integration against an in-process axum server
//! on an ephemeral loopback port (shared `common` harness convention, see
//! `pane_reconcile.rs:1-21`). The auto-resume hub (Task 5) is not wired yet,
//! so these tests drain `WsState.auto_resume_tx`'s receiver directly via the
//! harness builder that hands it back.

mod common;

use std::time::Duration;

use common::{connect_and_capture_inventory, next_frame_of_type, sleeper_cli_spec};
use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// A claude-shaped CLI spec whose command exits `code` immediately — the
/// crash-side sibling of [`common::sleeper_cli_spec`] (same plain-`sh`
/// recording-script convention as `codex_session_ref_resume.rs`).
fn exiting_cli_spec(name: &str, code: i32) -> freshell_platform::CliCommandSpec {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-auto-resume-exiting-{name}-{code}-{}.sh",
        std::process::id()
    ));
    std::fs::write(&script_path, format!("#!/bin/sh\nexit {code}\n"))
        .expect("write exiting script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }
    freshell_platform::CliCommandSpec {
        name: name.to_string(),
        label: format!("{name}-label"),
        env_var: None,
        default_cmd: script_path.to_string_lossy().to_string(),
        base_args: vec![],
        base_env: std::collections::BTreeMap::new(),
        resume_args: Some(vec!["--resume".to_string(), "{{sessionId}}".to_string()]),
        // The fresh-claude preallocation path THROWS without
        // `create_session_args` (`cli_launch.rs:436-441`); same shape as
        // `common::sleeper_cli_spec`.
        create_session_args: Some(vec![
            "--session-id".to_string(),
            "{{sessionId}}".to_string(),
        ]),
        model_args: None,
        effort_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// `terminal.create { mode: "claude" }` round-trip (mirrors
/// `pane_ledger_triggers.rs`'s create shape), returning the `terminalId`.
async fn create_claude_terminal(ws: &mut common::TestWs, request_id: &str) -> String {
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(WsMessage::Text(create.to_string()))
        .await
        .expect("send terminal.create");
    let created = next_frame_of_type(ws, "terminal.created").await;
    created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn natural_nonzero_exit_sends_crash_event_with_code_and_mode() {
    let (url, _registry, mut rx) =
        common::spawn_server_with_specs_and_auto_resume_rx(vec![exiting_cli_spec("claude", 1)])
            .await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let tid = create_claude_terminal(&mut ws, "req-crash-1").await;
    let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("crash event within 10s")
        .expect("auto-resume channel open");
    assert_eq!(ev.terminal_id, tid);
    assert_eq!(ev.exit_code, 1);
    assert_eq!(ev.mode, "claude");
    assert_eq!(ev.create_request_id.as_deref(), Some("req-crash-1"));
    // The generation's lifetime comes from the pre-finish `probe` read — a
    // missing probe would surface as the `i64::MAX` sentinel here.
    assert!(
        (0..60_000).contains(&ev.lifetime_ms),
        "lifetime_ms should be a real short lifetime, got {}",
        ev.lifetime_ms
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn user_kill_sends_no_crash_event() {
    let (url, _registry, mut rx) =
        common::spawn_server_with_specs_and_auto_resume_rx(vec![sleeper_cli_spec("claude")]).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let tid = create_claude_terminal(&mut ws, "req-kill-1").await;
    let kill = serde_json::json!({ "type": "terminal.kill", "terminalId": tid });
    ws.send(WsMessage::Text(kill.to_string()))
        .await
        .expect("send terminal.kill");
    // The PTY EOF hook still runs, but `finish_pty_exit` returns false (the
    // kill already removed the registry row) — so no CrashEvent.
    assert!(
        tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .is_err(),
        "kill must not produce a CrashEvent"
    );
}
