//! Lane B2 / campaign §2.3.2: terminal.codex.candidate.persisted is RETIRED
//! as a writer. The frozen client still SENDS it (TerminalView.tsx:4009-4018),
//! so the server must accept-and-ignore with a debug log — never an error to
//! the client, and NEVER an identity write.

mod common;

use common::{connect_and_capture_inventory, next_frame_of_type, spawn_server_with_ledger};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const THREAD: &str = "0192cccc-dddd-4eee-8fff-000011112222";

/// Fake codex: records argv to $CODEX_ARGV_CAPTURE_PATH (atomic tmp+mv) then
/// sleeps. Copied from the retired tests/codex_candidate_persisted.rs (which
/// copied it from tests/codex_session_ref_resume.rs:85-103).
fn write_fake_codex() -> std::path::PathBuf {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-codex-inert-fake-{}.sh",
        std::process::id()
    ));
    let script = "#!/bin/sh\n\
        printf '%s\\n' \"$@\" > \"$CODEX_ARGV_CAPTURE_PATH.tmp\"\n\
        mv \"$CODEX_ARGV_CAPTURE_PATH.tmp\" \"$CODEX_ARGV_CAPTURE_PATH\"\n\
        exec sleep 300\n";
    std::fs::write(&script_path, script).expect("write fake codex script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }
    script_path
}

fn codex_capture_spec() -> freshell_platform::CliCommandSpec {
    freshell_platform::CliCommandSpec {
        name: "codex".to_string(),
        label: "Codex CLI".to_string(),
        env_var: None,
        default_cmd: write_fake_codex().to_string_lossy().to_string(),
        base_args: vec![],
        base_env: std::collections::BTreeMap::new(),
        // Real codex manifest shape: resume subcommand, no createSessionArgs.
        resume_args: Some(vec!["resume".to_string(), "{{sessionId}}".to_string()]),
        create_session_args: None,
        model_args: None,
        effort_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

fn registry_resume_id(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
) -> Option<String> {
    registry
        .identity_probe_rows()
        .into_iter()
        .find(|row| row.terminal_id == terminal_id)
        .unwrap_or_else(|| panic!("registry must list {terminal_id}"))
        .resume_session_id
}

/// Send a candidate that must be IGNORED: the ping/pong round-trip proves the
/// frame was consumed AND that nothing was sent back (silence proof --
/// precedent: pane_reconcile.rs uses exactly this to prove nothing was sent).
/// Copied from the retired tests/codex_candidate_persisted.rs:112-131.
async fn send_candidate_expect_silence(
    ws: &mut common::TestWs,
    terminal_id: &str,
    thread_id: &str,
    rollout_path: &str,
) {
    ws.send(WsMessage::Text(
        json!({
            "type": "terminal.codex.candidate.persisted",
            "terminalId": terminal_id,
            "candidateThreadId": thread_id,
            "rolloutPath": rollout_path,
            "capturedAt": 1_753_300_000_000i64,
        })
        .to_string(),
    ))
    .await
    .expect("send candidate");
    ws.send(WsMessage::Text(json!({"type": "ping"}).to_string()))
        .await
        .expect("send ping");
    let _pong = next_frame_of_type(ws, "pong").await;
}

/// Ping, then read frames until the pong arrives — panicking on any `error`
/// frame in between (the connection must stay healthy; broadcasts like
/// `terminals.changed` are fine and skipped).
async fn expect_no_error_until_pong(ws: &mut common::TestWs) {
    ws.send(WsMessage::Text(json!({"type": "ping"}).to_string()))
        .await
        .expect("send ping");
    for _ in 0..20u8 {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .expect("frame within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            assert_ne!(
                value["type"],
                json!("error"),
                "connection must stay error-free: {value}"
            );
            if value["type"] == json!("pong") {
                return;
            }
        }
    }
    panic!("no pong frame within 20 messages");
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn candidate_frame_is_accepted_ignored_and_writes_nothing() {
    // ---- env setup (single sequential test: this binary owns process env) ----
    let codex_home = tempfile::tempdir().expect("codex home");
    let sessions_day = codex_home
        .path()
        .join("sessions")
        .join("2026")
        .join("07")
        .join("24");
    std::fs::create_dir_all(&sessions_day).expect("sessions tree");
    std::env::set_var("CODEX_HOME", codex_home.path());
    // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
    // plain-CLI codex path (sh-script fake codex, no app-server), so pin OFF.
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    let capture = std::env::temp_dir().join(format!("codex-inert-argv-{}.txt", std::process::id()));
    let _ = std::fs::remove_file(&capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);

    // A VALID rollout for THREAD — one that would have passed all four old
    // guards. Written BEFORE the terminal exists, so the locator's arm-time
    // snapshot excludes it forever: any identity write observed below could
    // only have come from the candidate channel.
    let rollout = sessions_day.join(format!("rollout-2026-07-24T12-00-00-{THREAD}.jsonl"));
    std::fs::write(
        &rollout,
        format!("{{\"timestamp\":\"2026-07-24T12:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{THREAD}\"}}}}\n"),
    )
    .unwrap();
    let rollout = rollout.to_string_lossy().to_string();

    // A REAL ledger dir so "writes nothing" covers the durable home too.
    let ledger_dir =
        std::env::temp_dir().join(format!("codex-inert-ledger-{}", std::process::id()));
    std::fs::create_dir_all(&ledger_dir).unwrap();
    let (url, registry, _server_ledger) =
        spawn_server_with_ledger(vec![codex_capture_spec()], &ledger_dir).await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    // A REAL fresh codex terminal with NO identity (no sessionRef, no resume).
    ws.send(WsMessage::Text(
        json!({
            "type": "terminal.create",
            "requestId": "req-codex-inert-1",
            "mode": "codex",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let codex_tid = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    assert_eq!(
        registry_resume_id(&registry, &codex_tid),
        None,
        "fresh codex must start unbound"
    );

    // The frozen client's durability announce: a candidate that the OLD
    // handler would have adopted. Retired channel: accept-and-ignore,
    // nothing sent back, connection healthy.
    send_candidate_expect_silence(&mut ws, &codex_tid, THREAD, &rollout).await;

    // NO identity write in ANY home: registry meta stays unbound...
    assert_eq!(
        registry_resume_id(&registry, &codex_tid),
        None,
        "retired candidate channel must never write identity"
    );
    // ...and the durable ledger holds no binding row for the thread id
    // (fresh reader instance: construction-time scan sees disk truth).
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(ledger_dir.clone()));
    assert!(
        ledger.load_binding("codex", THREAD).is_none(),
        "retired candidate channel must never write a ledger binding"
    );

    // The terminal still works: input flows and no protocol error comes back.
    ws.send(WsMessage::Text(
        json!({
            "type": "terminal.input",
            "terminalId": codex_tid,
            "data": "\r",
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.input");
    expect_no_error_until_pong(&mut ws).await;

    registry.kill(&codex_tid);
    std::env::remove_var("CODEX_HOME");
    std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
    std::fs::remove_dir_all(&ledger_dir).ok();
}
