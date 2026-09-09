//! Mid-session rebind: a bound codex pane whose CLI forks via in-TUI /resume
//! (new rollout, forked_from_id == bound id) must be rebound end-to-end.
//! Contract under test (incident 2026-07-27, session 019fa60f -> 019fa613):
//!   1. terminal.session.associated arrives with sessionRef.sessionId == NEW
//!      id AND previousSessionId == OLD id.
//!   2. registry meta resume_session_id == NEW id.
//!   3. The status tailer follows the fork: turn events on rollout NEW emit
//!      frames keyed to NEW; the OLD rollout's tailer is gone.
//!   4. The restart story (the incident's actual harm): after the rebind, a
//!      recreate carrying sessionRef {codex, NEW} spawns `codex resume NEW`
//!      -- never `resume OLD`.
//!   5. Hijack guard: a forged fork whose child id is another pane's LIVE
//!      session is refused (A13).
//!
//! Harness copied from codex_locator_activity.rs (the adoption-flow
//! precedent): real server, real socket, real PTY running a fake codex
//! binary, locator rooted at a tempdir sessions tree.

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

/// Both tests mutate process-wide env (`CODEX_HOME`); serialize them (the
/// repo's `ENV_LOCK` convention, e.g. `cross_kind_liveness.rs`).
#[cfg(unix)]
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Fake codex: just parks the PTY (identity comes from the rollout files the
/// test writes into the locator's sessions root, never from the binary).
#[cfg(unix)]
fn write_fake_codex() -> std::path::PathBuf {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-codex-fork-rebind-fake-{}.sh",
        std::process::id()
    ));
    let script = "#!/bin/sh\nexec sleep 300\n";
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
fn codex_spec() -> freshell_platform::CliCommandSpec {
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

/// Fake codex that ALSO records its argv (one token per line, atomically via
/// tmp+mv) to `$CODEX_ARGV_CAPTURE_PATH` before parking -- the argv-capture
/// idiom copied verbatim from `codex_session_ref_resume.rs`. Tests using it
/// MUST set `CODEX_ARGV_CAPTURE_PATH` before every create (serialized by
/// `ENV_LOCK`, same as `CODEX_HOME`).
#[cfg(unix)]
fn write_fake_codex_capture() -> std::path::PathBuf {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-codex-fork-rebind-capture-fake-{}.sh",
        std::process::id()
    ));
    let script = "#!/bin/sh\n\
        printf '%s\\n' \"$@\" > \"$CODEX_ARGV_CAPTURE_PATH.tmp\"\n\
        mv \"$CODEX_ARGV_CAPTURE_PATH.tmp\" \"$CODEX_ARGV_CAPTURE_PATH\"\n\
        exec sleep 300\n";
    std::fs::write(&script_path, script).expect("write fake codex capture script");
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }
    script_path
}

/// [`codex_spec`], but with the argv-capturing fake as the binary.
#[cfg(unix)]
fn codex_capture_spec() -> freshell_platform::CliCommandSpec {
    freshell_platform::CliCommandSpec {
        default_cmd: write_fake_codex_capture().to_string_lossy().to_string(),
        ..codex_spec()
    }
}

/// Poll the capture file the fake writes until it appears, then return the
/// argv tokens (one per line). Copied from `codex_session_ref_resume.rs`.
#[cfg(unix)]
fn wait_for_captured_argv(path: &std::path::Path) -> Vec<String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if !raw.is_empty() {
                return raw.lines().map(str::to_string).collect();
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "spawned codex child never wrote its argv capture at {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Position of the adjacent `["resume", session_id]` pair in argv, if any.
/// Copied from `codex_session_ref_resume.rs`.
#[cfg(unix)]
fn resume_pair_position(argv: &[String], session_id: &str) -> Option<usize> {
    argv.windows(2)
        .position(|w| w[0] == "resume" && w[1] == session_id)
}

/// Send a fresh `terminal.create` (no sessionRef, no resume id) and await its
/// `terminal.created`, returning the terminalId.
#[cfg(unix)]
async fn send_create(ws: &mut common::TestWs, mode: &str) -> String {
    send_create_at(
        ws,
        mode,
        &std::env::temp_dir().to_string_lossy(),
        "req-codex-fork-rebind-1",
    )
    .await
}

/// [`send_create`] with an explicit cwd and requestId (multi-pane tests need
/// distinct requestIds -- the create-dedupe would fold a repeated id into the
/// FIRST create's terminal).
#[cfg(unix)]
async fn send_create_at(
    ws: &mut common::TestWs,
    mode: &str,
    cwd: &str,
    request_id: &str,
) -> String {
    ws.send(WsMessage::Text(
        json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": mode,
            "shell": "system",
            "cwd": cwd,
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

/// Send a `terminal.create` carrying the frozen client's resume shape --
/// `sessionRef {provider:"codex", sessionId}` + `restore:true` (the Phase-1
/// incident shape from `codex_session_ref_resume.rs`) -- and await its
/// `terminal.created`, returning the terminalId. The server derives
/// `resume_session_id` from the sessionRef and spawns `codex resume <id>`.
#[cfg(unix)]
async fn send_create_resume(ws: &mut common::TestWs, session_id: &str) -> String {
    ws.send(WsMessage::Text(
        json!({
            "type": "terminal.create",
            "requestId": "req-codex-fork-rebind-resume-1",
            "mode": "codex",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
            "sessionRef": { "provider": "codex", "sessionId": session_id },
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create (resume)");
    let created = common::next_frame_of_type(ws, "terminal.created").await;
    created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string()
}

/// Scan WS text frames until the next `terminal.session.associated` for
/// `terminal_id` arrives (10 s budget), returning the parsed frame.
/// Non-matching frames are simply skipped (no drop-on-mismatch semantics).
#[cfg(unix)]
async fn next_associated_frame(
    ws: &mut common::TestWs,
    terminal_id: &str,
    label: &str,
) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"] == "terminal.session.associated"
                        && value["terminalId"] == terminal_id
                    {
                        return value;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("[{label}] ws ended/errored/timed out awaiting associated: {other:?}"),
        }
    }
    panic!("[{label}] no terminal.session.associated frame for {terminal_id} within 10s");
}

/// Scan WS text frames until `pred` matches or `window` elapses, returning
/// whether a matching frame arrived. Copied from
/// `codex_locator_activity.rs::wait_for_frame` with the budget parametrized:
/// the SAME scan serves positive waits (generous window, assert true) and
/// absence proofs (short deadline past the fork window, assert false).
/// Non-matching frames are simply skipped (no drop-on-mismatch semantics).
#[cfg(unix)]
async fn frame_seen_within(
    ws: &mut common::TestWs,
    window: Duration,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> bool {
    let deadline = tokio::time::Instant::now() + window;
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

/// Wall-clock ms — matches the tracker's `now_ms` timestamp domain. Copied
/// from `codex_locator_activity.rs`.
#[cfg(unix)]
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64
}

/// A codex rollout `event_msg` line (shape copied from
/// `codex_locator_activity.rs`'s `codex_event_line` fixture — the exact line
/// shape that triggers the reconcile lane).
#[cfg(unix)]
fn codex_event_line(payload_type: &str, at_ms: i64) -> String {
    format!(r#"{{"timestamp":{at_ms},"type":"event_msg","payload":{{"type":"{payload_type}"}}}}"#)
}

/// Append one line to a rollout file (inotify drives the tailer's reads).
#[cfg(unix)]
fn append_rollout_line(path: &std::path::Path, line: &str) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .expect("open rollout for append");
    writeln!(f, "{line}").expect("append rollout line");
}

/// Append a `task_started`/`task_complete` turn to a rollout — the busy edge
/// lands first (300 ms, mirroring the seed-then-append shape of
/// `codex_locator_activity.rs`), then the completion.
#[cfg(unix)]
async fn append_turn(path: &std::path::Path) {
    append_rollout_line(path, &codex_event_line("task_started", now_ms()));
    tokio::time::sleep(Duration::from_millis(300)).await;
    append_rollout_line(path, &codex_event_line("task_complete", now_ms()));
}

/// The registry's `resume_session_id` for a terminal (meta probe).
#[cfg(unix)]
fn registry_resume_id(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
) -> Option<String> {
    registry
        .identity_probe_rows()
        .into_iter()
        .find(|r| r.terminal_id == terminal_id)
        .unwrap_or_else(|| panic!("registry must list {terminal_id}"))
        .resume_session_id
}

/// The session_meta first line, exactly the shape the real codex CLI writes
/// (fork-shaped when `forked_from` is set: forked_from_id + thread_source
/// "user" -- the verified 019fa613 USER-fork child shape from Task 3/4).
#[cfg(unix)]
fn session_meta_line(thread_id: &str, cwd: &str, forked_from: Option<&str>) -> String {
    let mut payload = json!({ "id": thread_id, "session_id": thread_id, "cwd": cwd });
    if let Some(f) = forked_from {
        payload["forked_from_id"] = json!(f);
        payload["originator"] = json!("codex-tui");
        payload["thread_source"] = json!("user");
        payload["source"] = json!("cli");
    }
    json!({
        "timestamp": "2026-07-24T12:00:00.000Z",
        "type": "session_meta",
        "payload": payload,
    })
    .to_string()
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn in_tui_fork_rebinds_the_pane_identity() {
    const OLD: &str = "019fa60f-aaaa-4bbb-8ccc-000000000001";
    const NEW: &str = "019fa613-dddd-4eee-8fff-000000000002";

    let _env = ENV_LOCK.lock().await;

    // ---- env setup (serialized via ENV_LOCK: this binary owns process env) ----
    let codex_home = tempfile::tempdir().expect("codex home");
    let sessions_root = codex_home.path().join("sessions");
    let sessions_day = sessions_root.join("2026").join("07").join("27");
    std::fs::create_dir_all(&sessions_day).expect("sessions tree");
    std::env::set_var("CODEX_HOME", codex_home.path());
    // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
    // plain-CLI codex path (sh-script fake codex, no app-server), so pin OFF.
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");

    // 1. Spawn server with codex locator rooted at the temp sessions dir.
    let (url, registry) = common::spawn_server_with_specs_activity_and_codex_locator(
        vec![codex_spec()],
        &sessions_root,
    )
    .await;
    let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

    // 2. Create a fresh codex terminal (fake codex spec). The create arms the
    //    locator server-side.
    let terminal_id = send_create(&mut ws, "codex").await;

    // 2a. First Enter: takes the FIRST-submit re-snapshot and opens the 2 s
    //     adoption window -- the rollout must NOT exist yet.
    common::send_input(&mut ws, &terminal_id, "\r").await;
    // 2b. Let that first window resolve with zero candidates (2 s deadline +
    //     150 ms sweep, with margin).
    tokio::time::sleep(Duration::from_secs(3)).await;
    // 2c. NOW write rollout A (id = OLD; payload.cwd matches the pane's cwd).
    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let rollout_a = sessions_day.join(format!("rollout-2026-07-27T12-00-00-{OLD}.jsonl"));
    std::fs::write(
        &rollout_a,
        format!("{}\n", session_meta_line(OLD, &cwd, None)),
    )
    .unwrap();
    // 2d. Second Enter re-opens the resolved window WITHOUT re-snapshotting;
    //     rollout A is deterministically the sole new candidate.
    common::send_input(&mut ws, &terminal_id, "\r").await;

    // 2e. Drain until the adoption broadcast (existing behavior).
    let adopted = next_associated_frame(&mut ws, &terminal_id, "adoption").await;
    assert_eq!(
        adopted["sessionRef"]["sessionId"], OLD,
        "adoption must bind the OLD id first"
    );

    // 2f. Positive tailer baseline BEFORE the fork: a turn on rollout A must
    //     reach the wire keyed to OLD -- without this, step 7's "no frame
    //     keyed to OLD" absence proof could pass vacuously (an OLD tailer
    //     that never worked is indistinguishable from one that was detached).
    append_turn(&rollout_a).await;
    let old_completed = frame_seen_within(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.turn.complete"
            && v["terminalId"] == terminal_id.as_str()
            && v["provider"] == "codex"
            && v["sessionId"] == OLD
    })
    .await;
    assert!(
        old_completed,
        "pre-fork baseline: the adoption-attached tailer must emit turn.complete keyed to OLD"
    );

    // 3. Drive Enter again (opens the fork-scan window), then write rollout B
    //    with payload.id == NEW and payload.forked_from_id == OLD.
    common::send_input(&mut ws, &terminal_id, "\r").await;
    let rollout_b = sessions_day.join(format!("rollout-2026-07-27T12-05-00-{NEW}.jsonl"));
    std::fs::write(
        &rollout_b,
        format!("{}\n", session_meta_line(NEW, &cwd, Some(OLD))),
    )
    .unwrap();

    // 4. The rebind broadcast: sessionRef.sessionId == NEW, and the frame
    //    names the identity it superseded.
    let rebound = next_associated_frame(&mut ws, &terminal_id, "fork-rebind").await;
    assert_eq!(
        rebound["sessionRef"]["sessionId"], NEW,
        "rebind must move the pane to the fork child"
    );
    assert_eq!(
        rebound["previousSessionId"], OLD,
        "rebind must carry previousSessionId == the superseded id"
    );

    // 5. Registry meta followed the move.
    let row = registry
        .identity_probe_rows()
        .into_iter()
        .find(|r| r.terminal_id == terminal_id)
        .expect("registry row for the pane");
    assert_eq!(
        row.resume_session_id.as_deref(),
        Some(NEW),
        "registry meta resume_session_id must be the NEW id"
    );

    // 6. Tailer follows the fork (stale-tailer defect): a turn appended to
    //    rollout NEW must reach the wire keyed to the NEW id -- the rebind
    //    re-attached the status tailer to the fork child's file.
    append_turn(&rollout_b).await;
    let completed = frame_seen_within(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.turn.complete"
            && v["terminalId"] == terminal_id.as_str()
            && v["provider"] == "codex"
            && v["sessionId"] == NEW
    })
    .await;
    assert!(
        completed,
        "expected terminal.turn.complete keyed to the NEW id after the rebind re-attached the tailer"
    );

    // 7. The OLD tailer is GONE: the same turn shape appended to rollout OLD
    //    must produce NO frame keyed to OLD (short-deadline absence drain --
    //    inotify would deliver within milliseconds if a stale tailer
    //    remained; step 2f proved this exact shape DID emit while attached).
    append_turn(&rollout_a).await;
    let stale = frame_seen_within(&mut ws, Duration::from_secs(3), |v| {
        (v["type"] == "terminal.turn.complete" && v["sessionId"] == OLD)
            || (v["type"] == "codex.activity.updated"
                && v["upsert"]
                    .as_array()
                    .map(|u| u.iter().any(|r| r["sessionId"] == OLD))
                    .unwrap_or(false))
    })
    .await;
    assert!(
        !stale,
        "no activity/turn frame may be keyed to the OLD id -- the superseded tailer must be detached"
    );

    registry.kill(&terminal_id);
    std::env::remove_var("CODEX_HOME");
}

/// Resume-LAUNCHED panes (spawned `codex resume <id>` from a create carrying
/// `sessionRef`) never pass through the adoption lane -- `arm()` refuses them
/// (correctly: their session already exists) and must keep refusing. They DO
/// need fork detection: an in-TUI /resume MAY fork to a NEW rollout
/// (intermittent, upstream openai/codex#34972) and the pane would otherwise
/// go permanently stale. The spawn-time `watch_fork` is the coverage under
/// test.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn resume_launched_pane_gets_fork_detection() {
    const OLD: &str = "019fa60f-aaaa-4bbb-8ccc-000000000011";
    const NEW: &str = "019fa613-dddd-4eee-8fff-000000000012";

    let _env = ENV_LOCK.lock().await;

    // ---- env setup (serialized via ENV_LOCK: this binary owns process env) ----
    let codex_home = tempfile::tempdir().expect("codex home");
    let sessions_root = codex_home.path().join("sessions");
    let sessions_day = sessions_root.join("2026").join("07").join("27");
    std::fs::create_dir_all(&sessions_day).expect("sessions tree");
    std::env::set_var("CODEX_HOME", codex_home.path());
    // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
    // plain-CLI codex path (sh-script fake codex, no app-server), so pin OFF.
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");

    // Rollout A (the resumed session's file) exists BEFORE the create -- a
    // resume targets a session already on disk. The spawn-time watch
    // snapshot must capture it as known (only NEW files are fork
    // candidates).
    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let rollout_a = sessions_day.join(format!("rollout-2026-07-27T12-00-00-{OLD}.jsonl"));
    std::fs::write(
        &rollout_a,
        format!("{}\n", session_meta_line(OLD, &cwd, None)),
    )
    .unwrap();

    // 1. Spawn server with codex locator rooted at the temp sessions dir.
    let (url, registry) = common::spawn_server_with_specs_activity_and_codex_locator(
        vec![codex_spec()],
        &sessions_root,
    )
    .await;
    let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

    // 2. Create a codex terminal WITH sessionRef {provider:"codex",
    //    sessionId: OLD} -- the resume path. The create writes
    //    identity.upsert + registry meta (resume_session_id == OLD), so this
    //    pane is the live owner of OLD; the fork watch must be armed at
    //    spawn.
    let terminal_id = send_create_resume(&mut ws, OLD).await;

    // 3. Drive Enter (opens the Enter-anchored fork-scan window), then write
    //    rollout B with payload.id == NEW and payload.forked_from_id == OLD.
    common::send_input(&mut ws, &terminal_id, "\r").await;
    let rollout_b = sessions_day.join(format!("rollout-2026-07-27T12-05-00-{NEW}.jsonl"));
    std::fs::write(
        &rollout_b,
        format!("{}\n", session_meta_line(NEW, &cwd, Some(OLD))),
    )
    .unwrap();

    // 4. The rebind broadcast: sessionRef.sessionId == NEW, and the frame
    //    names the identity it superseded.
    let rebound = next_associated_frame(&mut ws, &terminal_id, "resume-fork-rebind").await;
    assert_eq!(
        rebound["sessionRef"]["sessionId"], NEW,
        "rebind must move the resume-launched pane to the fork child"
    );
    assert_eq!(
        rebound["previousSessionId"], OLD,
        "rebind must carry previousSessionId == the superseded id"
    );

    // 5. Registry meta followed the move.
    let row = registry
        .identity_probe_rows()
        .into_iter()
        .find(|r| r.terminal_id == terminal_id)
        .expect("registry row for the pane");
    assert_eq!(
        row.resume_session_id.as_deref(),
        Some(NEW),
        "registry meta resume_session_id must be the NEW id"
    );

    registry.kill(&terminal_id);
    std::env::remove_var("CODEX_HOME");
}

/// The CROWN test -- the incident's actual harm, end to end: adopt OLD,
/// fork-rebind to NEW, then kill the pane and replay EXACTLY what a client
/// that accepted the Task-2 rebind persists and sends after a server restart
/// (`sessionRef {codex, NEW}` + `restore:true`). The respawned codex CLI must
/// be launched `resume NEW` -- and NEVER `resume OLD` (the incident: the pane
/// resumed the earlier fork, silently abandoning the user's newest turns).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn after_rebind_a_recreate_resumes_the_new_session_id() {
    const OLD: &str = "019fa60f-aaaa-4bbb-8ccc-000000000021";
    const NEW: &str = "019fa613-dddd-4eee-8fff-000000000022";

    let _env = ENV_LOCK.lock().await;

    // ---- env setup (serialized via ENV_LOCK: this binary owns process env) ----
    let codex_home = tempfile::tempdir().expect("codex home");
    let sessions_root = codex_home.path().join("sessions");
    let sessions_day = sessions_root.join("2026").join("07").join("27");
    std::fs::create_dir_all(&sessions_day).expect("sessions tree");
    std::env::set_var("CODEX_HOME", codex_home.path());
    // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
    // plain-CLI codex path (sh-script fake codex, no app-server), so pin OFF.
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    let capture_for = |phase: &str| {
        std::env::temp_dir().join(format!(
            "freshell-codex-fork-rebind-restart-argv-{phase}-{}.txt",
            std::process::id()
        ))
    };
    // The capture fake dereferences $CODEX_ARGV_CAPTURE_PATH on EVERY spawn,
    // so the var is set before the first create too (bind-phase argv is not
    // asserted -- a fresh create has no resume args by construction).
    let capture_bind = capture_for("bind");
    let _ = std::fs::remove_file(&capture_bind);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture_bind);

    let (url, registry) = common::spawn_server_with_specs_activity_and_codex_locator(
        vec![codex_capture_spec()],
        &sessions_root,
    )
    .await;
    let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

    // ── Phase 1 -- bind: fresh codex pane adopts OLD via the locator.
    let terminal_id = send_create(&mut ws, "codex").await;
    // First Enter: FIRST-submit re-snapshot + 2 s adoption window (the
    // rollout must NOT exist yet); let it resolve with zero candidates.
    common::send_input(&mut ws, &terminal_id, "\r").await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let rollout_a = sessions_day.join(format!("rollout-2026-07-27T12-00-00-{OLD}.jsonl"));
    std::fs::write(
        &rollout_a,
        format!("{}\n", session_meta_line(OLD, &cwd, None)),
    )
    .unwrap();
    // Second Enter re-opens the resolved window; rollout A is the sole new
    // candidate.
    common::send_input(&mut ws, &terminal_id, "\r").await;
    let adopted = next_associated_frame(&mut ws, &terminal_id, "restart/adoption").await;
    assert_eq!(
        adopted["sessionRef"]["sessionId"], OLD,
        "adoption must bind the OLD id first"
    );

    // ── Phase 2 -- fork: Enter opens the fork-scan window, rollout NEW
    // (forked_from_id == OLD) appears, the pane rebinds to NEW.
    common::send_input(&mut ws, &terminal_id, "\r").await;
    let rollout_b = sessions_day.join(format!("rollout-2026-07-27T12-05-00-{NEW}.jsonl"));
    std::fs::write(
        &rollout_b,
        format!("{}\n", session_meta_line(NEW, &cwd, Some(OLD))),
    )
    .unwrap();
    let rebound = next_associated_frame(&mut ws, &terminal_id, "restart/fork-rebind").await;
    assert_eq!(
        rebound["sessionRef"]["sessionId"], NEW,
        "rebind must move the pane to the fork child"
    );
    assert_eq!(
        rebound["previousSessionId"], OLD,
        "rebind must carry previousSessionId == the superseded id"
    );

    // ── Phase 3 -- the restart story: kill the pane, then create a NEW
    // terminal with sessionRef {codex, NEW} + restore:true -- exactly what a
    // client that accepted the Task-2 rebind persists and replays after a
    // server restart.
    registry.kill(&terminal_id);
    let capture = capture_for("respawn");
    let _ = std::fs::remove_file(&capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);

    let terminal_id2 = send_create_resume(&mut ws, NEW).await;

    let argv = wait_for_captured_argv(&capture);
    assert!(
        resume_pair_position(&argv, NEW).is_some(),
        "respawned codex argv must contain `resume {NEW}`: {argv:?}"
    );
    assert!(
        resume_pair_position(&argv, OLD).is_none(),
        "respawned codex argv must NOT resume the superseded OLD id \
         (the incident: the pane resumed the earlier fork): {argv:?}"
    );
    assert_eq!(
        registry_resume_id(&registry, &terminal_id2).as_deref(),
        Some(NEW),
        "registry meta resume_session_id must be the NEW id after the restart-style recreate"
    );

    registry.kill(&terminal_id2);
    std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
    std::env::remove_var("CODEX_HOME");
}

/// Hijack guard (A13): a forged fork whose child id is ANOTHER pane's LIVE
/// session must be refused. pane1 is bound to A, pane2 to C (two adoptions,
/// distinct cwds to stay out of each other's way); a rollout with
/// payload.id == C and forked_from_id == A (a forged fork of pane1 pointing
/// AT pane2's live session) passes the lineage filter but must die on the
/// rebind guard -- nothing moves pane1 to C.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn fork_targeting_a_live_owned_session_is_refused() {
    const A: &str = "019fa60f-aaaa-4bbb-8ccc-00000000000a";
    const C: &str = "019fa613-cccc-4ddd-8eee-00000000000c";

    let _env = ENV_LOCK.lock().await;

    // ---- env setup (serialized via ENV_LOCK: this binary owns process env) ----
    let codex_home = tempfile::tempdir().expect("codex home");
    let sessions_root = codex_home.path().join("sessions");
    let sessions_day = sessions_root.join("2026").join("07").join("27");
    std::fs::create_dir_all(&sessions_day).expect("sessions tree");
    std::env::set_var("CODEX_HOME", codex_home.path());
    // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
    // plain-CLI codex path (sh-script fake codex, no app-server), so pin OFF.
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");

    // Distinct cwds: the adoption lane's cwd match (and contested-cwd census)
    // must never couple the two panes.
    let cwd1_dir = tempfile::tempdir().expect("pane1 cwd");
    let cwd2_dir = tempfile::tempdir().expect("pane2 cwd");
    let cwd1 = cwd1_dir.path().to_string_lossy().to_string();
    let cwd2 = cwd2_dir.path().to_string_lossy().to_string();

    let (url, registry) = common::spawn_server_with_specs_activity_and_codex_locator(
        vec![codex_spec()],
        &sessions_root,
    )
    .await;
    let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

    // ── pane1 adopts A (the standard Enter / zero-candidate / Enter dance).
    let pane1 = send_create_at(&mut ws, "codex", &cwd1, "req-codex-fork-hijack-p1").await;
    common::send_input(&mut ws, &pane1, "\r").await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let rollout_a = sessions_day.join(format!("rollout-2026-07-27T12-00-00-{A}.jsonl"));
    std::fs::write(
        &rollout_a,
        format!("{}\n", session_meta_line(A, &cwd1, None)),
    )
    .unwrap();
    common::send_input(&mut ws, &pane1, "\r").await;
    let adopted1 = next_associated_frame(&mut ws, &pane1, "hijack/pane1-adoption").await;
    assert_eq!(adopted1["sessionRef"]["sessionId"], A);

    // ── pane2 adopts C, same dance at its own cwd.
    let pane2 = send_create_at(&mut ws, "codex", &cwd2, "req-codex-fork-hijack-p2").await;
    common::send_input(&mut ws, &pane2, "\r").await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let rollout_c = sessions_day.join(format!("rollout-2026-07-27T12-05-00-{C}.jsonl"));
    std::fs::write(
        &rollout_c,
        format!("{}\n", session_meta_line(C, &cwd2, None)),
    )
    .unwrap();
    common::send_input(&mut ws, &pane2, "\r").await;
    let adopted2 = next_associated_frame(&mut ws, &pane2, "hijack/pane2-adoption").await;
    assert_eq!(adopted2["sessionRef"]["sessionId"], C);

    // ── The forgery: pane1's Enter opens its fork-scan window, then a NEW
    // rollout file appears whose payload.id == C (pane2's LIVE session) and
    // forked_from_id == A (pane1's binding) -- lineage-valid, user-sourced,
    // uuid-shaped: it passes every locator filter and reaches the rebind
    // guard. (Genuineness proven by mutation: pointing the forgery at an
    // UNOWNED id rebinds pane1 and fails the absence assertion below.)
    common::send_input(&mut ws, &pane1, "\r").await;
    let forged = sessions_day.join(format!("rollout-2026-07-27T12-10-00-{C}.jsonl"));
    std::fs::write(
        &forged,
        format!("{}\n", session_meta_line(C, &cwd1, Some(A))),
    )
    .unwrap();

    // ── Absence proof: NO associated frame may move pane1 (3 s covers the
    // 2 s Enter-anchored fork window + the 150 ms sweep with margin).
    let moved = frame_seen_within(&mut ws, Duration::from_secs(3), |v| {
        v["type"] == "terminal.session.associated" && v["terminalId"] == pane1.as_str()
    })
    .await;
    assert!(
        !moved,
        "a forged fork targeting a live-owned session must never rebind pane1 (A13)"
    );

    // ── Registry truth held: pane1 == A, pane2 == C.
    assert_eq!(
        registry_resume_id(&registry, &pane1).as_deref(),
        Some(A),
        "pane1 must still be bound to A"
    );
    assert_eq!(
        registry_resume_id(&registry, &pane2).as_deref(),
        Some(C),
        "pane2 must still own C"
    );

    // ── Recovery: the refused rebind must have re-registered pane1's fork
    // watch with its REAL session (A) -- tick_forks had eagerly advanced the
    // watch to C before the guard refused. A subsequent GENUINE user fork of
    // A (child id D, unowned) must still be detected and rebind pane1;
    // without the recovery the watch would silently track C forever.
    const D: &str = "019fa620-eeee-4fff-8aaa-00000000000d";
    common::send_input(&mut ws, &pane1, "\r").await;
    let genuine = sessions_day.join(format!("rollout-2026-07-27T12-15-00-{D}.jsonl"));
    std::fs::write(
        &genuine,
        format!("{}\n", session_meta_line(D, &cwd1, Some(A))),
    )
    .unwrap();
    let rebound = next_associated_frame(&mut ws, &pane1, "hijack/recovery-rebind").await;
    assert_eq!(
        rebound["sessionRef"]["sessionId"], D,
        "after the refused hijack, a genuine fork of pane1's real session must still rebind"
    );
    assert_eq!(
        rebound["previousSessionId"], A,
        "the recovery rebind must supersede A (the id the restored watch tracked)"
    );
    assert_eq!(
        registry_resume_id(&registry, &pane1).as_deref(),
        Some(D),
        "pane1 must follow the genuine fork to D"
    );
    assert_eq!(
        registry_resume_id(&registry, &pane2).as_deref(),
        Some(C),
        "pane2 must still own C after pane1's recovery rebind"
    );

    registry.kill(&pane1);
    registry.kill(&pane2);
    std::env::remove_var("CODEX_HOME");
}
