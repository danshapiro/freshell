//! Task 2b (recover-my-panes, D7 defense-in-depth): a `terminal.create` with
//! `restore:true` + a wire `sessionRef` whose `(provider, sessionId)` is
//! already owned by a currently-RUNNING terminal must be REFUSED loudly
//! (`RESTORE_UNAVAILABLE`) — never a second `claude --resume S` while the
//! original live PTY owns S (one-JSONL-writer doctrine, terminal.rs:933).
//!
//! Why the direct rung needs its own guard: every existing live-guard lives
//! inside the createRequestId-keyed ladder (terminal.rs:1690-1745), and the
//! direct wire-sessionRef rung (terminal.rs:1074-1078) bypasses the ladder
//! entirely. The D5 recovery path re-mints the createRequestId and carries
//! identity ONLY in `sessionRef`, so a session that goes live between the
//! inventory fetch and the user's accept would silently double-spawn without
//! this guard (the fetch→accept race client-side stripping cannot close).

mod common;

use common::{
    connect_and_capture_inventory, next_frame_of_type, session_ref_of, sleeper_cli_spec,
    spawn_server, spawn_server_with_specs,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMessage;

async fn send_create(ws: &mut common::TestWs, body: serde_json::Value) {
    ws.send(WsMessage::Text(body.to_string()))
        .await
        .expect("send terminal.create");
}

/// Read frames until either an `error` or a `terminal.created` correlated to
/// `request_id` arrives. Returns the frame. Panics if a `terminal.created`
/// for the request shows up — that IS the duplicate spawn this guard forbids.
async fn expect_refusal_for(ws: &mut common::TestWs, request_id: &str) -> serde_json::Value {
    for _ in 0..20u8 {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .expect("frame within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            match value["type"].as_str() {
                Some("terminal.created") if value["requestId"] == json!(request_id) => {
                    panic!("duplicate spawn: create must be refused, got {value}");
                }
                Some("error") if value["requestId"] == json!(request_id) => {
                    return value;
                }
                _ => {}
            }
        }
    }
    panic!("no error frame for {request_id} within 20 messages");
}

/// The D5 recovery wire shape against a LIVE session: restore:true +
/// sessionRef owned by a currently-Running terminal, under a fresh
/// (re-minted) requestId that has no ladder lineage. Must be refused loud;
/// the registry must still hold exactly ONE terminal owning S.
#[tokio::test]
async fn live_session_ref_create_is_refused_loudly() {
    let (url, registry) = spawn_server().await; // sleeper claude: stays Running
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    // A fresh claude terminal reaches Running, owning preallocated session S.
    send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-live-owner-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let tid1 = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let session_id = session_ref_of(&created).expect("fresh claude carries sessionRef")
        ["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();

    // The exact D5 recreation shape: fresh requestId (no lineage), restore,
    // wire sessionRef pointing at the LIVE session.
    send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-live-recreate-9f2a",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
            "sessionRef": { "provider": "claude", "sessionId": session_id },
        }),
    )
    .await;

    let err = expect_refusal_for(&mut ws, "req-live-recreate-9f2a").await;
    assert_eq!(
        err["code"],
        json!("RESTORE_UNAVAILABLE"),
        "exact wire code: {err}"
    );
    let message = err["message"].as_str().expect("error message");
    assert!(
        message.contains(&session_id),
        "message must name the live session {session_id}: {err}"
    );

    // No duplicate spawn: the registry still holds exactly ONE terminal, the
    // original owner of S.
    let rows = registry.identity_probe_rows();
    assert_eq!(
        rows.len(),
        1,
        "only the original live terminal may exist: {rows:?}"
    );
    assert_eq!(rows[0].terminal_id, tid1);
    assert_eq!(
        rows[0].resume_session_id.as_deref(),
        Some(session_id.as_str())
    );

    registry.kill(&tid1);
}

/// Reconnect-revive Task 7: the D7 refusal must NAME the live owner terminal
/// (`liveTerminalId`) so the client's create-error fold can reattach the pane
/// to it instead of dead-ending on "Session … is still running on the
/// server." Additive and omitted when no live terminal is nameable: every
/// other error frame stays byte-identical (frozen-client wire parity).
#[tokio::test]
async fn d7_refusal_names_the_live_owner_terminal() {
    let (url, registry) = spawn_server().await; // sleeper claude: stays Running
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    // A fresh claude terminal reaches Running, owning preallocated session S.
    send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-d7-owner-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let tid1 = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let session_id = session_ref_of(&created).expect("fresh claude carries sessionRef")
        ["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();

    // The close-and-reopen fallback shape: a restored create whose wire
    // sessionRef points at the STILL-RUNNING session.
    send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-d7-reopen-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
            "sessionRef": { "provider": "claude", "sessionId": session_id },
        }),
    )
    .await;

    let err = expect_refusal_for(&mut ws, "req-d7-reopen-1").await;
    assert_eq!(err["code"], json!("RESTORE_UNAVAILABLE"), "{err}");
    assert_eq!(
        err["message"],
        json!(format!(
            "Session {session_id} is still running on the server."
        )),
        "refusal text stays byte-identical (regexes and muscle memory depend on it): {err}"
    );
    assert_eq!(
        err["liveTerminalId"],
        json!(tid1),
        "the refusal must name the still-running owner so clients can reattach: {err}"
    );

    registry.kill(&tid1);
}

/// The legacy rung of the same doctrine (2026-08-16 duplicate-tab incident):
/// a `terminal.create` carrying ONLY the legacy `resumeSessionId` (no
/// `sessionRef`) used to arm D7 exactly like the sessionRef rung — a legacy
/// `mode` + `resumeSessionId` pair IS a sessionRef claim (`reconcile.rs`
/// §5.2 uniform promotion, `create_session_locator`).
///
/// Post-ejh6 the carrier never reaches D7: the raw pre-parse guard
/// (`handle_client_text`) rejects ANY `resumeSessionId` carry with
/// `INVALID_MESSAGE` + the frozen refusal text, before dedupe and before any
/// liveness planning. The live owner is never touched either way: exactly
/// one terminal still owns S.
#[tokio::test]
async fn legacy_resume_session_id_create_is_refused_loudly() {
    let (url, registry) = spawn_server().await; // sleeper claude: stays Running
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-legacy-live-owner-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let tid1 = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let session_id = session_ref_of(&created).expect("fresh claude carries sessionRef")
        ["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();

    // The CLI-shaped legacy carrier: identity ONLY in resumeSessionId.
    send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-legacy-recreate-7c1d",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "resumeSessionId": session_id,
        }),
    )
    .await;

    let err = expect_refusal_for(&mut ws, "req-legacy-recreate-7c1d").await;
    assert_eq!(
        err["code"],
        json!("INVALID_MESSAGE"),
        "post-ejh6 the legacy carrier is rejected at the door, not via D7: {err}"
    );
    assert_eq!(
        err["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
        "frozen text: {err}"
    );

    let rows = registry.identity_probe_rows();
    assert_eq!(
        rows.len(),
        1,
        "only the original live terminal may exist: {rows:?}"
    );
    assert_eq!(rows[0].terminal_id, tid1);

    registry.kill(&tid1);
}

/// Node parity (`server/ws-handler.ts:2170-2186`): a `restore:true` create
/// for a resume-supporting non-codex mode whose ONLY identity is the legacy
/// `resumeSessionId` is refused with `INVALID_MESSAGE` and the frozen
/// refusal text — restore identity must be a `sessionRef`. The Rust door
/// previously spawned `<cli> --resume <sid>` for this shape (deviation from
/// the Node contract).
#[tokio::test]
async fn legacy_only_restore_is_refused_invalid_message() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-legacy-restore-31ab",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
            "resumeSessionId": "9d1f6f5a-2b6e-4d0f-8a3c-5e7b2c9d4f10",
        }),
    )
    .await;

    let err = expect_refusal_for(&mut ws, "req-legacy-restore-31ab").await;
    assert_eq!(
        err["code"],
        json!("INVALID_MESSAGE"),
        "exact wire code: {err}"
    );
    assert_eq!(
        err["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
        "frozen Node refusal text: {err}"
    );

    assert!(
        registry.identity_probe_rows().is_empty(),
        "no terminal may spawn for a refused legacy-only restore"
    );
}

/// ejh6: a `terminal.create` carrying `resumeSessionId` is rejected with
/// `INVALID_MESSAGE` + frozen text on ANY mode, ANY restore state, and even
/// when a companion `sessionRef` is present. No spawn, no registry row.
/// Presence-based: `resumeSessionId: ""` is also rejected — and so are the
/// JSON value shapes the typed layer cannot even see: `null` (serde absorbs
/// it into `None`) and non-strings (they fail the typed parse into the
/// accept-and-strip arm — total silent drop).
#[tokio::test]
async fn legacy_reject_ws_terminal_create() {
    // A codex sleeper spec is registered too, so a SILENTLY ACCEPTED codex
    // carry really would spawn (the failure this test exists to forbid).
    let (url, registry) = spawn_server_with_specs(vec![
        sleeper_cli_spec("amplifier"),
        sleeper_cli_spec("claude"),
        sleeper_cli_spec("codex"),
    ])
    .await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let cases: Vec<(&str, &str, serde_json::Value)> = vec![
        (
            "claude-restore-true",
            "req-blanket-1",
            json!({
                "type": "terminal.create", "requestId": "req-blanket-1",
                "mode": "claude", "shell": "system",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "restore": true, "resumeSessionId": "9d1f6f5a-2b6e-4d0f-8a3c-5e7b2c9d4f10",
            }),
        ),
        (
            "codex-no-restore",
            "req-blanket-2",
            json!({
                "type": "terminal.create", "requestId": "req-blanket-2",
                "mode": "codex", "shell": "system",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "resumeSessionId": "thread-raw-codex",
            }),
        ),
        (
            "claude-with-companion-sessionref",
            "req-blanket-3",
            json!({
                "type": "terminal.create", "requestId": "req-blanket-3",
                "mode": "claude", "shell": "system",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "resumeSessionId": "legacy-should-still-reject",
                "sessionRef": {"provider": "claude", "sessionId": "canonical-session-id"},
            }),
        ),
        (
            "empty-string-presence",
            "req-blanket-4",
            json!({
                "type": "terminal.create", "requestId": "req-blanket-4",
                "mode": "claude", "shell": "system",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "resumeSessionId": "",
            }),
        ),
        (
            "null-presence",
            "req-blanket-5",
            json!({
                "type": "terminal.create", "requestId": "req-blanket-5",
                "mode": "claude", "shell": "system",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "resumeSessionId": null,
            }),
        ),
        (
            "number-presence",
            "req-blanket-6",
            json!({
                "type": "terminal.create", "requestId": "req-blanket-6",
                "mode": "claude", "shell": "system",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "resumeSessionId": 42,
            }),
        ),
        (
            "object-presence",
            "req-blanket-7",
            json!({
                "type": "terminal.create", "requestId": "req-blanket-7",
                "mode": "claude", "shell": "system",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "resumeSessionId": {"nested": true},
            }),
        ),
    ];
    for (label, req_id, body) in cases {
        send_create(&mut ws, body).await;
        let err = expect_refusal_for(&mut ws, req_id).await;
        assert_eq!(err["code"], json!("INVALID_MESSAGE"), "{label}: {err}");
        assert_eq!(
            err["message"],
            json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
            "{label}: frozen text must be byte-exact: {err}"
        );
    }
    assert!(
        registry.identity_probe_rows().is_empty(),
        "no terminal may spawn"
    );
}

/// ejh6: a duplicate-requestId replay carrying the legacy field gets
/// `INVALID_MESSAGE`, not the cached `terminal.created` — the raw guard fires
/// BEFORE `create_dedupe.begin`.
#[tokio::test]
async fn legacy_reject_ws_duplicate_request_id_with_legacy() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;
    // First: a successful shell create to seed the dedupe cache.
    send_create(
        &mut ws,
        json!({
            "type": "terminal.create", "requestId": "req-dup-seed",
            "mode": "shell", "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let _created = next_frame_of_type(&mut ws, "terminal.created").await;
    // Replay: same requestId but carrying legacy — must get INVALID_MESSAGE,
    // not the cached terminal.created.
    send_create(
        &mut ws,
        json!({
            "type": "terminal.create", "requestId": "req-dup-seed",
            "mode": "claude", "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "resumeSessionId": "legacy-dup",
        }),
    )
    .await;
    let err = expect_refusal_for(&mut ws, "req-dup-seed").await;
    assert_eq!(
        err["code"],
        json!("INVALID_MESSAGE"),
        "duplicate replay with legacy must reject: {err}"
    );
    assert_eq!(
        err["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
    );
    registry.kill_all();
}

/// ejh6: restore:true + codex + legacy is rejected BEFORE
/// `spawn_gated_restore_create` / `prepare_launch` — no disk-gate planning,
/// no sidecar planning slot burned.
#[tokio::test]
async fn legacy_reject_ws_restore_codex_legacy() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;
    send_create(
        &mut ws,
        json!({
            "type": "terminal.create", "requestId": "req-restore-codex-legacy",
            "mode": "codex", "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true, "resumeSessionId": "thread-raw-restore-codex",
        }),
    )
    .await;
    let err = expect_refusal_for(&mut ws, "req-restore-codex-legacy").await;
    assert_eq!(
        err["code"],
        json!("INVALID_MESSAGE"),
        "restore+codex+legacy must reject before disk gate: {err}"
    );
    assert_eq!(
        err["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
    );
    assert!(
        registry.identity_probe_rows().is_empty(),
        "no terminal may spawn"
    );
}

/// ejh6: a `codingcli.create` carrying the legacy field hits the raw-Value
/// guard with `INVALID_MESSAGE` + frozen text. Rust has no codingcli handler
/// (the `_ => true` arm of the dispatch) — without the guard this silently
/// no-ops; the guard is the loud rejector.
#[tokio::test]
async fn legacy_reject_ws_codingcli_create() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;
    send_create(
        &mut ws,
        json!({
            "type": "codingcli.create", "requestId": "req-codingcli-legacy",
            "prompt": "hi", "provider": "claude",
            "resumeSessionId": "legacy-codingcli",
        }),
    )
    .await;
    let err = expect_refusal_for(&mut ws, "req-codingcli-legacy").await;
    assert_eq!(err["code"], json!("INVALID_MESSAGE"), "{err}");
    assert_eq!(
        err["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
    );
}
