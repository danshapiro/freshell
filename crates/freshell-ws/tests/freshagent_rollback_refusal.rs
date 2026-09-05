//! Kata 1wxv Task 1: `freshAgent.undo` / `freshAgent.redo` landed contract-first —
//! as each provider leg (Tasks 2-4) shipped, its cell left this matrix for real
//! dispatch. What remains here is PERMANENT: codex x redo (decision 5 — codex
//! history revert is destructive; there is no redo primitive) and amplifier x op
//! (no amplifier fresh-agent runtime exists). Cell answers ride ON THE REQUESTING
//! CONNECTION with the nested `freshAgent.error{UNSUPPORTED_CAPABILITY}` shape
//! stamped `rollback:true` and echoing `requestId` (so the initiating pane routes
//! the rejection to its notice banner instead of the pane error surface).
//! Harness: `freshagent_control_reply.rs`.

mod common;
use common::*;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

async fn send_json(ws: &mut TestWs, value: serde_json::Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("send rollback frame");
}

fn assert_rollback_refusal(
    frame: &serde_json::Value,
    session_id: &str,
    provider: &str,
    session_type: &str,
    request_id: &str,
    message: &str,
) {
    assert_eq!(
        frame["type"],
        serde_json::json!("freshAgent.event"),
        "{frame}"
    );
    assert_eq!(frame["provider"], serde_json::json!(provider), "{frame}");
    assert_eq!(frame["sessionId"], serde_json::json!(session_id), "{frame}");
    assert_eq!(
        frame["sessionType"],
        serde_json::json!(session_type),
        "{frame}"
    );
    assert_eq!(
        frame["event"]["type"],
        serde_json::json!("freshAgent.error"),
        "{frame}"
    );
    assert_eq!(
        frame["event"]["code"],
        serde_json::json!("UNSUPPORTED_CAPABILITY"),
        "{frame}"
    );
    assert_eq!(
        frame["event"]["message"],
        serde_json::json!(message),
        "{frame}"
    );
    assert_eq!(
        frame["event"]["requestId"],
        serde_json::json!(request_id),
        "{frame}"
    );
    assert_eq!(
        frame["event"]["rollback"],
        serde_json::json!(true),
        "{frame}"
    );
}

/// Undo cells whose refusal is PERMANENT (Tasks 2-4 took codex/opencode/claude
/// undo to real dispatch): only amplifier remains — no amplifier fresh-agent
/// runtime exists, so its cells never leave this matrix.
#[tokio::test]
async fn undo_is_refused_permanently_for_amplifier_only() {
    let (url, _registry) = spawn_server().await;
    for (provider, session_type) in [("amplifier", "freshclaude")] {
        let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
        send_json(
            &mut ws,
            serde_json::json!({
                "type": "freshAgent.undo", "provider": provider, "sessionId": "s-rb",
                "sessionType": session_type, "requestId": "rb-u-1",
            }),
        )
        .await;
        let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
        assert_rollback_refusal(
            &frame,
            "s-rb",
            provider,
            session_type,
            "rb-u-1",
            &format!("Undo is not supported for {session_type}"),
        );
    }
}

/// Redo cells whose refusal is PERMANENT: codex x redo (decision 5) and
/// amplifier (no runtime). Task 3 dispatched opencode, Task 4 dispatched claude.
#[tokio::test]
async fn redo_is_refused_permanently_for_codex_and_amplifier() {
    let (url, _registry) = spawn_server().await;
    for (provider, session_type) in [
        // PERMANENT (decision 5): codex x redo.
        ("codex", "freshcodex"),
        // PERMANENT: no amplifier fresh-agent runtime exists.
        ("amplifier", "freshclaude"),
    ] {
        let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
        send_json(
            &mut ws,
            serde_json::json!({
                "type": "freshAgent.redo", "provider": provider, "sessionId": "s-rb",
                "sessionType": session_type, "requestId": "rb-r-1", "mode": "step",
            }),
        )
        .await;
        let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
        assert_rollback_refusal(
            &frame,
            "s-rb",
            provider,
            session_type,
            "rb-r-1",
            &format!("Redo is not supported for {session_type}"),
        );
    }
}
