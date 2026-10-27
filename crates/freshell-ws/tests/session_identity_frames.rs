//! STATE-SYNC FIX 1 / Increment 2(a): server-authoritative session identity
//! on every terminal frame that names a `terminalId`.
//!
//! The state-sync cartography (`docs/plans/2026-07-19-state-sync-cartography.md`
//! §1.4, §5 weakness 3) proved the rust port's identity repair channels are
//! dead: `terminal.created` (`terminal.rs:1077`), `terminal.inventory`
//! (`registry.rs:258`), and `terminal.attach.ready` (`registry.rs:631`) all
//! hardcode `session_ref: None` even when the identity registry KNOWS the
//! terminal's provider/sessionId — so the frozen client's reconcile fold
//! (`src/App.tsx:946-985` → `reconcileTerminalSessionAssociation`) never fires
//! and an identity missed at create time is missed forever.
//!
//! These tests drive a REAL axum server + REAL tokio-tungstenite client (the
//! `keepalive.rs` harness convention) through the resume-create path and
//! assert the three frames carry the canonical `sessionRef` — and that shell
//! terminals are NEVER stamped.

mod common;
use common::*;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use std::time::Duration;

/// Task 18 (DEV-0008 closure): poll fresh connections until the handshake
/// inventory's `terminalMeta` carries a row for `terminal_id`, then return the
/// row. Polling (bounded) because the create path commits its record through
/// an ASYNC enrichment task — `terminal.created` deliberately does not wait
/// for the git probes.
async fn wait_for_inventory_meta_row(url: &str, terminal_id: &str) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let (_ws, inventory) = connect_and_capture_inventory(url).await;
        let row = inventory["terminalMeta"].as_array().and_then(|rows| {
            rows.iter()
                .find(|m| m["terminalId"] == serde_json::json!(terminal_id))
                .cloned()
        });
        if let Some(row) = row {
            return row;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no terminal.inventory terminalMeta row for {terminal_id} within 5s: {inventory}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// **RED for increment 2(a)**: a RESUME-created coding-CLI terminal's
/// `terminal.created`, `terminal.attach.ready`, and (reconnect-time)
/// `terminal.inventory` frames must all carry the canonical
/// `sessionRef {provider: mode, sessionId: resumeSessionId}` — the identity
/// the WS create path already stamps into the identity registry
/// (`terminal.rs`'s `terminal_meta_record_for_create` → `identity.upsert`)
/// but never put on these frames.
#[tokio::test]
async fn resume_created_terminal_frames_carry_session_ref() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-identity-1",
            "mode": "amplifier",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "amplifier", "sessionId": "sess-identity-1" },
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
    let expected_ref =
        serde_json::json!({ "provider": "amplifier", "sessionId": "sess-identity-1" });
    assert_eq!(
        session_ref_of(&created),
        Some(expected_ref.clone()),
        "terminal.created must carry the create-time resume identity: {created}"
    );

    // attach.ready carries it too (the reconnect/viewport-hydrate repair path).
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 120,
            "rows": 30,
            "attachRequestId": "att-identity-1",
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.attach");
    let ready = next_frame_of_type(&mut ws, "terminal.attach.ready").await;
    assert_eq!(
        session_ref_of(&ready),
        Some(expected_ref.clone()),
        "terminal.attach.ready must carry the identity: {ready}"
    );

    // A SECOND connection's handshake inventory row carries it (the
    // reconnect reconcile loop, App.tsx:976-985 — dead against the rust
    // server until now).
    let (_ws2, inventory) = connect_and_capture_inventory(&url).await;
    let row = inventory["terminals"]
        .as_array()
        .expect("terminals array")
        .iter()
        .find(|t| t["terminalId"] == serde_json::json!(terminal_id))
        .cloned()
        .unwrap_or_else(|| panic!("inventory must list {terminal_id}: {inventory}"));
    assert_eq!(
        session_ref_of(&row),
        Some(expected_ref),
        "terminal.inventory row must carry the identity: {row}"
    );

    // Task 18 (DEV-0008 closure): the handshake's `terminalMeta` ships the
    // registry's live records — the created terminal's row must be present
    // and carry a cwd (previously hardcoded `[]`).
    let meta_row = wait_for_inventory_meta_row(&url, &terminal_id).await;
    assert!(
        meta_row["cwd"].as_str().is_some_and(|c| !c.is_empty()),
        "terminalMeta row must carry the terminal's cwd: {meta_row}"
    );

    registry.kill(&terminal_id);
}

/// A FRESH `claude` terminal create (no `resumeSessionId`, no `sessionRef`,
/// no restore) takes the server-preallocation path (`terminal.rs:776-789`:
/// fresh claude ALWAYS gets a server-preallocated `--session-id` UUID) — and
/// that preallocated identity must flow onto the wire: `terminal.created`
/// carries `sessionRef {provider:'claude', sessionId:<the preallocated UUID>}`
/// and a second connection's `terminal.inventory` row carries the same ref.
/// Pins the (previously unpinned) wire-behavior change from the identity
/// stamping commit: preallocation used to be argv-only.
#[tokio::test]
async fn fresh_claude_create_frames_carry_preallocated_session_ref() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-fresh-claude-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
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
        panic!("fresh claude terminal.created must carry sessionRef: {created}")
    });
    assert_eq!(
        session_ref["provider"],
        serde_json::json!("claude"),
        "provider must be claude: {created}"
    );
    let session_id = session_ref["sessionId"]
        .as_str()
        .expect("sessionId string")
        .to_string();
    // The preallocated id is a randomUUID() (`ws:969-975` parity) — canonical
    // hyphenated UUID shape, NOT anything the client sent (it sent nothing).
    assert_eq!(
        session_id.len(),
        36,
        "preallocated UUID shape: {session_id}"
    );
    assert_eq!(
        session_id.chars().filter(|c| *c == '-').count(),
        4,
        "preallocated UUID shape: {session_id}"
    );

    // A SECOND connection's handshake inventory row carries the SAME ref.
    let (_ws2, inventory) = connect_and_capture_inventory(&url).await;
    let row = inventory["terminals"]
        .as_array()
        .expect("terminals array")
        .iter()
        .find(|t| t["terminalId"] == serde_json::json!(terminal_id))
        .cloned()
        .unwrap_or_else(|| panic!("inventory must list {terminal_id}: {inventory}"));
    assert_eq!(
        session_ref_of(&row),
        Some(serde_json::json!({ "provider": "claude", "sessionId": session_id })),
        "terminal.inventory row must carry the preallocated identity: {row}"
    );

    // Task 18 (DEV-0008 closure): the handshake's `terminalMeta` ships the
    // registry's live records — the created terminal's row must be present
    // and carry a cwd (previously hardcoded `[]`).
    let meta_row = wait_for_inventory_meta_row(&url, &terminal_id).await;
    assert!(
        meta_row["cwd"].as_str().is_some_and(|c| !c.is_empty()),
        "terminalMeta row must carry the terminal's cwd: {meta_row}"
    );

    registry.kill(&terminal_id);
}

/// Shell terminals are NEVER stamped: no provider identity exists (the
/// identity registry is only seeded for non-shell creates with a session id).
#[tokio::test]
async fn shell_terminal_frames_never_carry_session_ref() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-shell-1",
            "mode": "shell",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
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
        None,
        "a shell terminal.created must not carry a sessionRef: {created}"
    );

    let (_ws2, inventory) = connect_and_capture_inventory(&url).await;
    let row = inventory["terminals"]
        .as_array()
        .expect("terminals array")
        .iter()
        .find(|t| t["terminalId"] == serde_json::json!(terminal_id))
        .cloned()
        .unwrap_or_else(|| panic!("inventory must list {terminal_id}: {inventory}"));
    assert_eq!(
        session_ref_of(&row),
        None,
        "a shell inventory row must not carry a sessionRef: {row}"
    );

    registry.kill(&terminal_id);
}

// ── unified agent names (Task 2): the naming projection on the same frames ──

/// A fresh scoped create admits its PRE-DURABLE naming handle: the
/// server-minted `nh-<uuid>` rides `terminal.created` as the pending
/// `nameRef` with the directory-basename fallback record, the reconnect
/// inventory row carries the SAME binding, and a shell create is never
/// stamped. (The preallocated claude `--session-id` is prospective — the
/// verified-bind lanes transfer the handle onto the durable record at
/// materialization.)
#[tokio::test]
async fn scoped_claude_create_frames_carry_the_pending_naming_projection() {
    let (url, registry, _sink) = spawn_server_with_specs_and_naming(vec![
        sleeper_cli_spec("amplifier"),
        sleeper_cli_spec("claude"),
    ])
    .await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-naming-fresh-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
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
    let name_ref = created["nameRef"].clone();
    assert_eq!(
        name_ref["kind"],
        serde_json::json!("pending"),
        "a fresh scoped create names through its pre-durable handle: {created}"
    );
    let handle = name_ref["id"].as_str().expect("pending handle id");
    assert!(
        handle.starts_with("nh-"),
        "the server-minted handle shape: {created}"
    );
    assert!(
        created["sessionName"]["name"]
            .as_str()
            .is_some_and(|n| !n.is_empty()),
        "the fallback record rides the frame: {created}"
    );
    assert_eq!(
        created["sessionName"]["ref"], name_ref,
        "the record identifies the same ref: {created}"
    );

    // A shell create is NEVER stamped (out of naming scope).
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-naming-shell-1",
            "mode": "shell",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    let shell_created = next_frame_of_type(&mut ws, "terminal.created").await;
    assert!(
        shell_created.get("nameRef").is_none() && shell_created.get("sessionName").is_none(),
        "a shell terminal.created must not carry naming fields: {shell_created}"
    );

    // A SECOND connection's handshake inventory row carries the SAME pending
    // binding (the registry row's display cache).
    let (_ws2, inventory) = connect_and_capture_inventory(&url).await;
    let row = inventory["terminals"]
        .as_array()
        .expect("terminals array")
        .iter()
        .find(|t| t["terminalId"] == serde_json::json!(terminal_id))
        .cloned()
        .unwrap_or_else(|| panic!("inventory must list {terminal_id}: {inventory}"));
    assert_eq!(
        row["nameRef"], name_ref,
        "the inventory row carries the same pending binding: {row}"
    );
    assert_eq!(
        row["sessionName"]["name"], created["sessionName"]["name"],
        "the inventory row carries the same fallback record: {row}"
    );

    registry.kill(&terminal_id);
    if let Some(shell_id) = shell_created["terminalId"].as_str() {
        registry.kill(shell_id);
    }
}

/// A RESUME create (client-sent sessionRef) targets the DURABLE session's
/// OWN record — never a fresh pending admission: the pre-seeded record's
/// name and durable ref ride `terminal.created`, and the reconnect
/// inventory row carries the same binding.
#[tokio::test]
async fn scoped_claude_resume_create_frames_carry_the_durable_naming_projection() {
    const RESUME_ID: &str = "44444444-5555-4666-8777-888899990000";
    let (url, registry, sink) = spawn_server_with_specs_and_naming(vec![
        sleeper_cli_spec("amplifier"),
        sleeper_cli_spec("claude"),
    ])
    .await;

    // The durable record the resumed session already has (admitted + bound
    // through the same store-lane the create flow uses).
    use freshell_freshagent::naming::{
        BindNameInput, PendingNameInput, RenameNameInput, SessionNaming,
    };
    use freshell_protocol::native_location::{
        NativeAcquisition, NativeEvidenceKind, NativeLocation, NativePersistence,
    };
    use freshell_protocol::session_names::{NameIntent, NamedProvider, SessionNameRef};
    sink.ensure_pending(PendingNameInput {
        handle: "nh-resume-1".into(),
        provider: NamedProvider::Claude,
        cwd: None,
    })
    .await
    .expect("seed admission");
    sink.bind_pending(BindNameInput {
        pending: SessionNameRef::Pending {
            id: "nh-resume-1".into(),
        },
        target: SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: RESUME_ID.into(),
        },
        acquisition: NativeAcquisition {
            location: NativeLocation::Claude {
                config_root: "/h/.claude".into(),
                transcript_path: Some(format!("/h/.claude/projects/-p/{RESUME_ID}.jsonl")),
                project_directory_key: None,
                transcript_cwd: None,
                effective_project_key_override: None,
            },
            evidence: NativeEvidenceKind::SelectedTranscript,
            persistence: NativePersistence::Verified,
        },
    })
    .await
    .expect("seed bind");
    sink.rename(RenameNameInput {
        target: SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: RESUME_ID.into(),
        },
        name: "Preexisting Name".into(),
        intent: NameIntent::User,
        if_revision: None,
        cwd: None,
    })
    .await
    .expect("seed rename");

    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-naming-resume-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
            "sessionRef": { "provider": "claude", "sessionId": RESUME_ID },
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
        created["nameRef"],
        serde_json::json!({ "kind": "session", "provider": "claude", "sessionId": RESUME_ID }),
        "a resume create names through the durable session's own record: {created}"
    );
    assert_eq!(
        created["sessionName"]["name"],
        serde_json::json!("Preexisting Name"),
        "the durable record's accepted name rides the frame: {created}"
    );

    let (_ws2, inventory) = connect_and_capture_inventory(&url).await;
    let row = inventory["terminals"]
        .as_array()
        .expect("terminals array")
        .iter()
        .find(|t| t["terminalId"] == serde_json::json!(terminal_id))
        .cloned()
        .unwrap_or_else(|| panic!("inventory must list {terminal_id}: {inventory}"));
    assert_eq!(
        row["nameRef"],
        serde_json::json!({ "kind": "session", "provider": "claude", "sessionId": RESUME_ID }),
        "the inventory row carries the durable binding: {row}"
    );
    assert_eq!(
        row["sessionName"]["name"],
        serde_json::json!("Preexisting Name"),
        "the inventory row carries the accepted record: {row}"
    );

    registry.kill(&terminal_id);
}
