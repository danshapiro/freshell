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
            "resumeSessionId": "sess-identity-1",
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
