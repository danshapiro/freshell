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
/// `amplifier resume <id>`.
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
/// `amplifier resume terminal:...` that hangs forever.
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
