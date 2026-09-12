//! Lane B2: a FRESH codex terminal (no resume id, NO client candidate frame)
//! gains identity from the server-side rollout locator, and its activity
//! frames carry the sessionId — closing the "terminals created before any
//! candidate" status gap.
//!
//! Harness copied from the (retired) codex_candidate_activity.rs: real
//! server, real socket, real PTY running a fake codex binary, CODEX_HOME
//! pointed at a tempdir. Both tests mutate process-wide env (`CODEX_HOME`,
//! `CODEX_ARGV_CAPTURE_PATH`) and share a PID-only fake-script path, so they
//! are serialized via `ENV_LOCK` (the repo's convention, e.g.
//! `codex_fork_rebind.rs`).

#[cfg(unix)]
mod common;

#[cfg(unix)]
use futures_util::{SinkExt, StreamExt};
#[cfg(unix)]
use serde_json::json;
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Serializes tests that mutate process-wide env (`CODEX_HOME`,
/// `CODEX_ARGV_CAPTURE_PATH`) and share the PID-only fake-script path.
#[cfg(unix)]
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Fake codex: records argv to $CODEX_ARGV_CAPTURE_PATH (atomic tmp+mv) then
/// sleeps. Copied from the (retired) tests/codex_candidate_persisted.rs.
#[cfg(unix)]
fn write_fake_codex() -> std::path::PathBuf {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-codex-locator-activity-fake-{}.sh",
        std::process::id()
    ));
    let script = "#!/bin/sh\n\
        printf '%s\\n' \"$@\" > \"$CODEX_ARGV_CAPTURE_PATH.tmp\"\n\
        mv \"$CODEX_ARGV_CAPTURE_PATH.tmp\" \"$CODEX_ARGV_CAPTURE_PATH\"\n\
        exec sleep 300\n";
    std::fs::write(&script_path, script).expect("write fake codex script");
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }
    script_path
}

#[cfg(unix)]
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
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// Send a fresh `terminal.create` (no sessionRef, no resume id) and await its
/// `terminal.created`, returning the terminalId.
#[cfg(unix)]
async fn send_create(ws: &mut common::TestWs, mode: &str) -> String {
    ws.send(WsMessage::Text(
        json!({
            "type": "terminal.create",
            "requestId": "req-codex-locator-activity-1",
            "mode": mode,
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    let created = common::next_frame_of_type(ws, "terminal.created").await;
    created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string()
}

/// Scan WS text frames until `pred` matches or the 120s budget elapses.
/// Non-matching frames are simply skipped (no drop-on-mismatch semantics).
///
/// DEFLAKE (f3wp refresh → pkvz): was 10s → 30s. Under workspace-level load
/// (full cargo-test parallelism on a 4-core CI runner) the inotify-driven
/// rollout read plus the locator adoption sweep latency was observed to
/// exceed 30s (kata pkvz, 3+ CI occurrences). Bumped to 120s to cover the
/// observed sweep latency under contention with margin. The assertions are
/// unchanged — only the wait budget grew; a genuinely missing frame still
/// fails, 120s later.
#[cfg(unix)]
async fn wait_for_frame(
    ws: &mut common::TestWs,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if pred(&value) {
                        return true;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => return false, // stream ended, ws error, or timed out
        }
    }
    false
}

/// Wall-clock ms — matches the tracker's `now_ms` timestamp domain.
#[cfg(unix)]
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64
}

/// A codex rollout `event_msg` line (shape copied from activity.rs's
/// `codex_event_line` test helper).
#[cfg(unix)]
fn codex_event_line(payload_type: &str, at_ms: i64) -> String {
    format!(r#"{{"timestamp":{at_ms},"type":"event_msg","payload":{{"type":"{payload_type}"}}}}"#)
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn fresh_pane_locator_identity_reaches_activity_and_turn_complete() {
    const THREAD: &str = "11111111-2222-3333-4444-555555555555";

    // Serialize env mutation with the one-batch test (both mutate CODEX_HOME
    // and share the PID-only fake-script path).
    let _env = ENV_LOCK.lock().await;

    // ---- env setup (serialized via ENV_LOCK: this binary owns process env) ----
    // CODEX_HOME tempdir; the sessions day tree exists but holds NO rollout
    // yet — the locator's FIRST-submit re-snapshot must see zero files.
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
    let capture = std::env::temp_dir().join(format!(
        "codex-locator-activity-argv-{}.txt",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);

    let (url, registry) = common::spawn_server_with_specs_activity_and_codex_locator(
        vec![codex_capture_spec()],
        &codex_home.path().join("sessions"),
    )
    .await;
    let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

    // 1. Create a FRESH codex terminal (no sessionRef, no resume id, and —
    //    unlike the retired candidate test — NO candidate frame ever sent).
    //    The create arms the locator server-side.
    let terminal_id = send_create(&mut ws, "codex").await;

    // 2a. First Enter: windows are Enter-anchored (no spawn window). This
    //     submit takes the FIRST-submit re-snapshot of known_files and opens
    //     the 2 s window — the rollout must NOT exist yet (a pre-seeded file
    //     would be captured by the re-snapshot and permanently excluded).
    common::send_input(&mut ws, &terminal_id, "\r").await;

    // 2b. Let that first window resolve with zero candidates (deadline 2 s +
    //     150 ms sweep, with margin).
    tokio::time::sleep(Duration::from_secs(3)).await;

    // 2c. NOW write the rollout the locator must find. payload.cwd must
    //     match the terminal's cwd (the value send_create passed).
    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let rollout = sessions_day.join(format!("rollout-2026-07-24T12-00-00-{THREAD}.jsonl"));
    std::fs::write(
        &rollout,
        format!("{{\"timestamp\":\"2026-07-24T12:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{THREAD}\",\"cwd\":\"{cwd}\"}}}}\n"),
    )
    .unwrap();

    // 2d. Second Enter: a later Enter re-opens a resolved window WITHOUT
    //     re-snapshotting (Task 2's later_enter_reopen_keeps_the_first_submit_snapshot),
    //     so the file written in 2c is deterministically the sole new candidate.
    common::send_input(&mut ws, &terminal_id, "\r").await;

    // 3. The locator sweep resolves and the adoption tail must emit
    //    codex.activity.updated with the sessionId. Collect frames by
    //    scanning (never drop-on-mismatch); the 10 s budget covers the ~2 s
    //    Enter-anchored deadline + 150 ms sweep.
    let bound = wait_for_frame(&mut ws, |v| {
        v["type"] == "codex.activity.updated"
            && v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter().any(|r| {
                        r["terminalId"] == terminal_id.as_str() && r["sessionId"] == THREAD
                    })
                })
                .unwrap_or(false)
    })
    .await;
    assert!(
        bound,
        "expected codex.activity.updated carrying the locator-resolved sessionId"
    );

    // 4. The adoption tail also attached the rollout to the status watcher
    //    (attach_codex_rollout). Append a task_started/task_complete pair to
    //    the SAME rollout — inotify drives the reads — and the completion
    //    frame must be stamped with the provider AND sessionId.
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&rollout)
            .expect("open rollout for append");
        writeln!(f, "{}", codex_event_line("task_started", now_ms())).expect("append task_started");
    }
    // Let the busy edge land before completing the turn (mirrors the
    // seed-then-append shape of activity.rs's rollout-lane unit tests).
    tokio::time::sleep(Duration::from_millis(300)).await;
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&rollout)
            .expect("open rollout for append");
        writeln!(f, "{}", codex_event_line("task_complete", now_ms()))
            .expect("append task_complete");
    }

    let completed = wait_for_frame(&mut ws, |v| {
        v["type"] == "terminal.turn.complete"
            && v["terminalId"] == terminal_id.as_str()
            && v["provider"] == "codex"
            && v["sessionId"] == THREAD
    })
    .await;
    assert!(
        completed,
        "expected terminal.turn.complete with provider=codex and sessionId stamped by the locator adoption"
    );

    registry.kill(&terminal_id);
    std::env::remove_var("CODEX_HOME");
    std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
}

/// pkvz end-to-end non-regression guard: proves the one-batch drain path
/// (session_meta + task_started + task_complete in one `reconcile_rollout`
/// call) produces a `terminal.turn.complete` end-to-end through the real
/// server, socket, PTY, inotify watcher, and activity hub. The deterministic
/// RED/GREEN evidence for the one-batch SUPPRESSION is in the three unit tests
/// in `freshell-activity/src/codex.rs` (which deterministically set the
/// `queued_submit_at` state the suppression requires). This integration test
/// does NOT reproduce the suppression (the queued-submit race is not
/// deterministically controllable from the WS client); it proves the
/// one-batch drain path works end-to-end after the fix.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn fresh_pane_locator_one_batch_drain_records_turn_complete() {
    const THREAD: &str = "22222222-3333-4444-5555-666666666666";

    // Serialize env mutation with the identity-reaches test (both mutate
    // CODEX_HOME and share the PID-only fake-script path).
    let _env = ENV_LOCK.lock().await;

    let codex_home = tempfile::tempdir().expect("codex home");
    let sessions_day = codex_home
        .path()
        .join("sessions")
        .join("2026")
        .join("07")
        .join("24");
    std::fs::create_dir_all(&sessions_day).expect("sessions tree");
    std::env::set_var("CODEX_HOME", codex_home.path());
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    let capture = std::env::temp_dir().join(format!(
        "codex-locator-one-batch-argv-{}.txt",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);

    let (url, registry) = common::spawn_server_with_specs_activity_and_codex_locator(
        vec![codex_capture_spec()],
        &codex_home.path().join("sessions"),
    )
    .await;
    let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

    let terminal_id = send_create(&mut ws, "codex").await;

    // First Enter: opens the 2s window, re-snapshots known_files (no rollout).
    // Wait for the server's `codex.activity.updated` with `phase: "pending"`
    // (proves note_possible_submit completed the re-snapshot AND note_input set
    // Pending) — the re-snapshot MUST finish before the rollout is written, or
    // it would be permanently excluded.
    common::send_input(&mut ws, &terminal_id, "\r").await;
    let pending = wait_for_frame(&mut ws, |v| {
        v["type"] == "codex.activity.updated"
            && v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == terminal_id.as_str() && r["phase"] == "pending")
                })
                .unwrap_or(false)
    })
    .await;
    assert!(
        pending,
        "expected codex.activity.updated with phase=pending after the first Enter"
    );

    // Write the rollout WITHIN the 2s window (the pending frame above proves
    // the re-snapshot completed, so this file is a new candidate). The 150ms
    // locator sweep will find it and bind it; CodexAttach's initial drain reads
    // all three lines in ONE reconcile_rollout call — the one-batch path.
    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let rollout = sessions_day.join(format!("rollout-2026-07-24T12-00-00-{THREAD}.jsonl"));
    let ts = 9_999_999_999_999;
    std::fs::write(
        &rollout,
        format!(
            "{{\"timestamp\":\"2026-07-24T12:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{THREAD}\",\"cwd\":\"{cwd}\"}}}}\n{}\n{}\n",
            codex_event_line("task_started", ts),
            codex_event_line("task_complete", ts + 100),
        ),
    )
    .unwrap();

    // The sweep (150ms) finds the rollout within the 2s window and binds it.
    let bound = wait_for_frame(&mut ws, |v| {
        v["type"] == "codex.activity.updated"
            && v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter().any(|r| {
                        r["terminalId"] == terminal_id.as_str() && r["sessionId"] == THREAD
                    })
                })
                .unwrap_or(false)
    })
    .await;
    assert!(
        bound,
        "expected codex.activity.updated carrying the locator-resolved sessionId"
    );

    // The one-batch initial drain records a `terminal.turn.complete`.
    let completed = wait_for_frame(&mut ws, |v| {
        v["type"] == "terminal.turn.complete"
            && v["terminalId"] == terminal_id.as_str()
            && v["provider"] == "codex"
            && v["sessionId"] == THREAD
    })
    .await;
    assert!(
        completed,
        "expected terminal.turn.complete from the one-batch initial drain"
    );

    registry.kill(&terminal_id);
    std::env::remove_var("CODEX_HOME");
    std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
}
