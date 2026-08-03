//! Launcher-assigned amplifier identity (kata qmpk): a FRESH amplifier
//! `terminal.create` must (1) mint a server-side session UUID before spawn,
//! (2) pre-create the stub dir (metadata.json + empty transcript.jsonl +
//! empty events.jsonl) under
//! `FRESHELL_AMPLIFIER_HOME/projects/<slug>/sessions/<id>`, and (3) surface
//! the identity on `terminal.created.sessionRef` with provider "amplifier" —
//! all with ZERO client-supplied identity.
//!
//! REAL axum server + REAL tokio-tungstenite client, the
//! `session_identity_frames.rs` harness convention.

mod common;
use common::*;

use std::time::Duration;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

#[tokio::test]
async fn fresh_amplifier_create_carries_launcher_assigned_session_ref_and_stub() {
    // Defense in depth (V7 caveat): the common constructor isolates the
    // amplifier home too, but this test file must never depend on flowing
    // through it — set the var eagerly before anything can spawn.
    let amp_home = isolate_amplifier_home();

    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    // A dedicated, really-existing cwd: cwd is part of amplifier's session
    // identity contract (the stub slug is derived from it).
    let cwd = std::env::temp_dir().join(format!(
        "freshell-amp-launcher-identity-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&cwd).expect("create test cwd");

    // Send terminal.create { mode: "amplifier" } with NO sessionRef and NO
    // resumeSessionId — the launcher must assign the identity itself.
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-amp-launcher-identity-1",
            "mode": "amplifier",
            "shell": "system",
            "cwd": cwd.to_string_lossy(),
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");

    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    let session_ref = session_ref_of(&created).unwrap_or_else(|| {
        panic!("fresh amplifier terminal.created must carry sessionRef: {created}")
    });
    assert_eq!(session_ref["provider"], "amplifier");
    let sid = session_ref["sessionId"].as_str().expect("sessionId set");
    // Server-minted UUID, not a client value.
    assert!(
        uuid::Uuid::parse_str(sid).is_ok(),
        "sessionId must be a server-minted UUID, got {sid:?}"
    );

    // The stub exists on disk, under the slug of the create cwd.
    let canonical = std::fs::canonicalize(&cwd).unwrap();
    let stub_dir = amp_home
        .join("projects")
        .join(freshell_sessions::amplifier_stub::cwd_slug(
            &canonical.to_string_lossy(),
        ))
        .join("sessions")
        .join(sid);
    assert!(
        stub_dir.join("metadata.json").is_file(),
        "stub metadata.json must exist at {}",
        stub_dir.display()
    );
    assert_eq!(
        std::fs::metadata(stub_dir.join("transcript.jsonl"))
            .expect("transcript.jsonl exists")
            .len(),
        0,
        "transcript.jsonl must be empty"
    );
    assert_eq!(
        std::fs::metadata(stub_dir.join("events.jsonl"))
            .expect("events.jsonl exists")
            .len(),
        0,
        "events.jsonl must be empty"
    );
    let meta: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(stub_dir.join("metadata.json")).unwrap())
            .unwrap();
    assert_eq!(meta["session_id"], sid);
    assert!(
        meta.get("bundle").is_none(),
        "stub metadata must have NO bundle key so the user's default bundle resolves"
    );

    registry.kill(&terminal_id);
}

/// A requested amplifier RESUME whose session dir does not exist (e.g. a
/// GC'd never-used stub from a previous run) is RE-STUBBED under the SAME
/// id before spawn, so restore keeps working instead of hanging a doomed
/// `amplifier session resume --full-history <id>`.
#[tokio::test]
async fn requested_amplifier_resume_with_missing_dir_is_restubbed_under_same_id() {
    let amp_home = isolate_amplifier_home();

    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    let cwd = std::env::temp_dir().join(format!(
        "freshell-amp-launcher-identity-restub-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&cwd).expect("create test cwd");

    let requested = uuid::Uuid::new_v4().to_string();
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-amp-launcher-identity-2",
            "mode": "amplifier",
            "shell": "system",
            "cwd": cwd.to_string_lossy(),
            "resumeSessionId": requested,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");

    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    assert_eq!(
        session_ref_of(&created),
        Some(serde_json::json!({ "provider": "amplifier", "sessionId": requested })),
        "resume create keeps the requested identity: {created}"
    );

    let canonical = std::fs::canonicalize(&cwd).unwrap();
    let stub_dir = amp_home
        .join("projects")
        .join(freshell_sessions::amplifier_stub::cwd_slug(
            &canonical.to_string_lossy(),
        ))
        .join("sessions")
        .join(&requested);
    assert!(
        stub_dir.join("metadata.json").is_file(),
        "missing resume dir must be re-stubbed under the SAME id at {}",
        stub_dir.display()
    );

    registry.kill(&terminal_id);
}

/// An amplifier create whose cwd does not exist is rejected LOUDLY before
/// spawn — a stub under slug(<gone dir>) plus the PTY layer's cwd-less
/// spawn retry would be a silently doomed resume.
#[tokio::test]
async fn amplifier_create_with_vanished_cwd_is_rejected_before_spawn() {
    let amp_home = isolate_amplifier_home();

    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    let gone = std::env::temp_dir().join(format!(
        "freshell-amp-launcher-identity-gone-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&gone); // ensure it does NOT exist

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-amp-launcher-identity-3",
            "mode": "amplifier",
            "shell": "system",
            "cwd": gone.to_string_lossy(),
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");

    let err = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(err["code"], "PTY_SPAWN_FAILED", "loud reject: {err}");
    assert!(
        err["message"]
            .as_str()
            .unwrap_or_default()
            .contains("does not exist"),
        "message names the vanished dir: {err}"
    );

    // And no stub litter was written for the doomed create.
    let projects = amp_home.join("projects");
    let slug = freshell_sessions::amplifier_stub::cwd_slug(&gone.to_string_lossy());
    assert!(
        !projects.join(slug).exists(),
        "no stub may be written for a rejected create"
    );
}

/// Task 9 guard 1: `terminal:<id>` is Freshell's own synthetic sidebar
/// placeholder (the old correlation bug's poisoned persisted tab state) —
/// never a resumable amplifier session. A create carrying one must be
/// rejected LOUDLY before any stub is written, instead of spawning an
/// `amplifier session resume --full-history terminal:...` that hangs forever.
#[tokio::test]
async fn amplifier_create_rejects_synthetic_terminal_placeholder_refs() {
    let amp_home = isolate_amplifier_home();

    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    let cwd = std::env::temp_dir().join(format!(
        "freshell-amp-launcher-identity-poisoned-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&cwd).expect("create test cwd");

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-amp-launcher-identity-4",
            "mode": "amplifier",
            "shell": "system",
            "cwd": cwd.to_string_lossy(),
            "sessionRef": { "provider": "amplifier", "sessionId": "terminal:abc123" },
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");

    let err = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(err["code"], "PTY_SPAWN_FAILED", "loud reject: {err}");
    assert_eq!(err["requestId"], "req-amp-launcher-identity-4");
    assert!(
        err["message"]
            .as_str()
            .unwrap_or_default()
            .contains("synthetic terminal placeholder"),
        "message names the placeholder poisoning: {err}"
    );

    // The guard sits BEFORE the pre-create block: no stub litter for a
    // poisoned id.
    let canonical = std::fs::canonicalize(&cwd).unwrap();
    let slug = freshell_sessions::amplifier_stub::cwd_slug(&canonical.to_string_lossy());
    assert!(
        !amp_home.join("projects").join(slug).exists(),
        "no stub may be written for a rejected placeholder create"
    );
}

/// Task 9 guard 2: amplifier has no upstream concurrency guard — a second
/// create resuming a session id that a RUNNING terminal already owns must
/// be rejected, never a second live PTY interleaving writes into one
/// session dir.
///
/// The second create rides the legacy `resumeSessionId` carrier: the
/// wire-`sessionRef` carrier is already intercepted by the cross-mode D7
/// liveness guard (PR #540, "Session ... is still running on the server"),
/// which this amplifier-specific guard composes AFTER — sequentially, never
/// instead of. The message is asserted EXACTLY because the pre-Task-9 path
/// already rejected via the wrapped registry error ("Could not restore ...:
/// duplicate live resume: ..."), which contains the same substring — only
/// the friendly guard produces this exact frame.
#[tokio::test]
async fn amplifier_create_rejects_second_live_resume_of_same_session() {
    let _amp_home = isolate_amplifier_home();

    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    let cwd = std::env::temp_dir().join(format!(
        "freshell-amp-launcher-identity-double-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&cwd).expect("create test cwd");

    // 1) Fresh amplifier create → launcher-assigned sid, terminal Running.
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-amp-launcher-identity-5",
            "mode": "amplifier",
            "shell": "system",
            "cwd": cwd.to_string_lossy(),
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let sid = session_ref_of(&created).expect("fresh amplifier carries sessionRef")["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();

    // 2) Second create resuming the SAME id while the first is still running.
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-amp-launcher-identity-6",
            "mode": "amplifier",
            "shell": "system",
            "cwd": cwd.to_string_lossy(),
            "resumeSessionId": sid,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");

    let err = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(err["code"], "PTY_SPAWN_FAILED", "loud reject: {err}");
    assert_eq!(err["requestId"], "req-amp-launcher-identity-6");
    assert_eq!(
        err["message"],
        serde_json::json!(format!(
            "Amplifier session {sid} is already open in a live terminal."
        )),
        "the friendly guard frame, not the wrapped registry error: {err}"
    );

    // No duplicate spawn: exactly the original terminal owns sid.
    let rows = registry.identity_probe_rows();
    let owners: Vec<_> = rows
        .iter()
        .filter(|r| r.resume_session_id.as_deref() == Some(sid.as_str()))
        .collect();
    assert_eq!(
        owners.len(),
        1,
        "exactly one terminal may own {sid}: {rows:?}"
    );
    assert_eq!(owners[0].terminal_id, terminal_id);

    registry.kill(&terminal_id);
}

// ---------------------------------------------------------------------------
// Task 10: GC never-used stubs through the shared exit-hook contract.
// ---------------------------------------------------------------------------

/// An `amplifier` CLI spec whose process exits NATURALLY (exit 0) once the
/// test touches `<marker_dir>/<FRESHELL_TERMINAL_ID>` — a controlled natural
/// exit, so the PTY exit hook takes the `finish_pty_exit == true` path and
/// sends a Lane-D1 CrashEvent AFTER the amplifier stub-GC block has run.
/// Receiving that CrashEvent is the tests' deterministic "the GC decision
/// has been made" signal (no sleeps, no polling theater).
fn gated_exit_cli_spec(
    name: &str,
    test_tag: &str,
    marker_dir: &std::path::Path,
) -> freshell_platform::CliCommandSpec {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-amp-gc-gated-{test_tag}-{}.sh",
        std::process::id()
    ));
    std::fs::write(
        &script_path,
        format!(
            "#!/bin/sh\nwhile [ ! -f \"{}/${{FRESHELL_TERMINAL_ID}}\" ]; do sleep 0.05; done\nexit 0\n",
            marker_dir.display()
        ),
    )
    .expect("write gated-exit script");
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
        create_session_args: Some(vec![
            "--session-id".to_string(),
            "{{sessionId}}".to_string(),
        ]),
        model_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// Send a `terminal.create { mode: "amplifier" }` (optionally carrying a
/// `sessionRef`) and return `(terminal_id, session_id)` from the
/// `terminal.created` frame.
async fn create_amplifier_terminal(
    ws: &mut TestWs,
    request_id: &str,
    cwd: &std::path::Path,
    session_ref_id: Option<&str>,
) -> (String, String) {
    let mut msg = serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "amplifier",
        "shell": "system",
        "cwd": cwd.to_string_lossy(),
    });
    if let Some(sid) = session_ref_id {
        msg["sessionRef"] = serde_json::json!({ "provider": "amplifier", "sessionId": sid });
    }
    ws.send(WsMessage::Text(msg.to_string()))
        .await
        .expect("send terminal.create");
    let created = next_frame_of_type(ws, "terminal.created").await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let sid = session_ref_of(&created)
        .unwrap_or_else(|| panic!("amplifier terminal.created must carry sessionRef: {created}"))
        ["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();
    (terminal_id, sid)
}

/// The stub dir for `sid` under the slug of `cwd` in the isolated home.
fn stub_dir_for(
    amp_home: &std::path::Path,
    cwd: &std::path::Path,
    sid: &str,
) -> std::path::PathBuf {
    let canonical = std::fs::canonicalize(cwd).unwrap();
    amp_home
        .join("projects")
        .join(freshell_sessions::amplifier_stub::cwd_slug(
            &canonical.to_string_lossy(),
        ))
        .join("sessions")
        .join(sid)
}

/// Touch the exit marker for `terminal_id`, then await the exit hook's
/// CrashEvent — the deterministic happens-after signal for the GC decision.
async fn release_and_await_exit(
    marker_dir: &std::path::Path,
    terminal_id: &str,
    crash_rx: &mut tokio::sync::mpsc::UnboundedReceiver<freshell_ws::auto_resume::CrashEvent>,
) {
    std::fs::write(marker_dir.join(terminal_id), "").expect("touch exit marker");
    let event = tokio::time::timeout(Duration::from_secs(10), crash_rx.recv())
        .await
        .expect("CrashEvent within 10s")
        .expect("crash channel open");
    assert_eq!(event.terminal_id, terminal_id, "the terminal we released");
}

/// Task 10: a pre-created stub the user never typed into is pure litter —
/// the terminal's own exit hook must GC it (else every never-used amplifier
/// pane becomes a permanent '0 msgs' row in `amplifier session list`).
#[tokio::test]
async fn never_used_stub_is_gcd_when_the_terminal_exits() {
    let amp_home = isolate_amplifier_home();
    let marker_dir = std::env::temp_dir().join(format!(
        "freshell-amp-gc-markers-exit-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&marker_dir).expect("create marker dir");

    let (url, _registry, mut crash_rx) =
        spawn_server_with_specs_and_auto_resume_rx(vec![gated_exit_cli_spec(
            "amplifier",
            "gc-exit",
            &marker_dir,
        )])
        .await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    let cwd = std::env::temp_dir().join(format!("freshell-amp-gc-exit-cwd-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).expect("create test cwd");

    let (terminal_id, sid) = create_amplifier_terminal(&mut ws, "req-amp-gc-1", &cwd, None).await;
    let stub_dir = stub_dir_for(&amp_home, &cwd, &sid);
    assert!(
        stub_dir.join("metadata.json").is_file(),
        "pre-created stub must exist before exit at {}",
        stub_dir.display()
    );

    // Controlled NATURAL exit; the CrashEvent recv means the exit hook —
    // including its GC block — has already run.
    release_and_await_exit(&marker_dir, &terminal_id, &mut crash_rx).await;

    // Bounded poll (belt and suspenders on top of the happens-after signal).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while stub_dir.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        !stub_dir.exists(),
        "never-used stub must be GC'd when the terminal exits: {}",
        stub_dir.display()
    );
}

/// Task 10: the GC's never-used predicate must veto deletion the moment the
/// user has typed — a `prompt:submit` line in events.jsonl is the user's
/// data (the CLI persists nothing else on a kill mid-FIRST-turn).
#[tokio::test]
async fn used_stub_survives_terminal_exit() {
    let amp_home = isolate_amplifier_home();
    let marker_dir = std::env::temp_dir().join(format!(
        "freshell-amp-gc-markers-used-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&marker_dir).expect("create marker dir");

    let (url, _registry, mut crash_rx) =
        spawn_server_with_specs_and_auto_resume_rx(vec![gated_exit_cli_spec(
            "amplifier",
            "gc-used",
            &marker_dir,
        )])
        .await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    let cwd = std::env::temp_dir().join(format!("freshell-amp-gc-used-cwd-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).expect("create test cwd");

    let (terminal_id, sid) = create_amplifier_terminal(&mut ws, "req-amp-gc-2", &cwd, None).await;
    let stub_dir = stub_dir_for(&amp_home, &cwd, &sid);
    assert!(stub_dir.join("metadata.json").is_file());

    // Simulate "the user typed": the hooks-logging module writes the
    // prompt:submit event synchronously before any provider call.
    std::fs::write(
        stub_dir.join("events.jsonl"),
        "{\"event\":\"prompt:submit\"}\n",
    )
    .expect("write prompt:submit event");

    release_and_await_exit(&marker_dir, &terminal_id, &mut crash_rx).await;

    assert!(
        stub_dir.join("metadata.json").is_file(),
        "a stub with a prompt:submit trace must SURVIVE terminal exit: {}",
        stub_dir.display()
    );
}

/// Task 10 ensure-after-GC pin: resuming a session whose never-used stub was
/// GC'd re-stubs the SAME id before spawn, so restore keeps working.
#[tokio::test]
async fn resume_of_a_gcd_stub_is_restubbed_under_the_same_id() {
    let amp_home = isolate_amplifier_home();
    let marker_dir = std::env::temp_dir().join(format!(
        "freshell-amp-gc-markers-restub-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&marker_dir).expect("create marker dir");

    let (url, registry, mut crash_rx) =
        spawn_server_with_specs_and_auto_resume_rx(vec![gated_exit_cli_spec(
            "amplifier",
            "gc-restub",
            &marker_dir,
        )])
        .await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    let cwd =
        std::env::temp_dir().join(format!("freshell-amp-gc-restub-cwd-{}", std::process::id()));
    std::fs::create_dir_all(&cwd).expect("create test cwd");

    // 1) Fresh create → exit → stub GC'd.
    let (terminal_id, sid) = create_amplifier_terminal(&mut ws, "req-amp-gc-3a", &cwd, None).await;
    let stub_dir = stub_dir_for(&amp_home, &cwd, &sid);
    assert!(stub_dir.join("metadata.json").is_file());
    release_and_await_exit(&marker_dir, &terminal_id, &mut crash_rx).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while stub_dir.exists() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!stub_dir.exists(), "precondition: the stub was GC'd");

    // 2) Create AGAIN with sessionRef {provider:"amplifier", sessionId: sid}:
    //    SAME id on the created frame, stub dir re-created before spawn.
    let (terminal_id2, sid2) =
        create_amplifier_terminal(&mut ws, "req-amp-gc-3b", &cwd, Some(&sid)).await;
    assert_eq!(sid2, sid, "resume keeps the requested identity");
    assert!(
        stub_dir.join("metadata.json").is_file(),
        "a GC'd stub must be re-stubbed under the SAME id at {}",
        stub_dir.display()
    );

    registry.kill(&terminal_id2);
}
