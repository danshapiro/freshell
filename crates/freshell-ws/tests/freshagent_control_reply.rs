//! Fresh-agent control-frame dispatch (Task 2 of the approval-respond run): the four
//! frames the frozen client really sends -- `freshAgent.approval.respond` (Approve/Deny
//! click), `freshAgent.question.respond` (question answer), `freshAgent.fork` and
//! `freshAgent.compact` -- no longer vanish into the typed dispatch's silent
//! `_ => true` catch-all. A provider x op refusal table
//! (`terminal.rs::fresh_agent_control_refusal`) answers the genuinely UNSUPPORTED
//! cells with the legacy parity text (`runtime-manager.ts`:
//! `"Approvals are not supported for <sessionType>"`, `"Questions are …"`,
//! `"Fork is …"`, `"Compact is …"`) under code `UNSUPPORTED_CAPABILITY`; every handled
//! cell routes to a real dispatch arm. Task 4 landed the codex/opencode compact arms
//! (their cells dropped from the table) and pins the unconditional amplifier x op
//! refusal cells; Task 5 landed the opencode fork arm, Task 6 the codex fork arm (both
//! cells dropped — the remaining fork refusals are claude [permanent] and amplifier).
//! The whole-branch-review follow-up completed the matrix (question.respond refusals
//! for codex/opencode, approval.respond refusal for opencode, claude question.respond
//! dispatch reachability) and flipped BOTH compact unknown-session legs to the nested
//! `INVALID_SESSION_ID` lost-session envelope (review findings I-1 opencode / M-1 codex).
//!
//! These tests drive a REAL axum server + REAL tokio-tungstenite client (same harness
//! as `unknown_terminal_reply.rs`, the kata-dtfn precedent).

mod common;
use common::*;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message as WsMessage;

async fn send_json(ws: &mut TestWs, value: serde_json::Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("send control frame");
}

/// Assert `frame` is the refusal-table's `freshAgent.event{freshAgent.error}` envelope
/// with the legacy parity capability text and the `UNSUPPORTED_CAPABILITY` code (any
/// code other than INVALID_SESSION_ID renders as a visible pane error client-side;
/// INVALID_SESSION_ID would instead mark the session lost and trigger recovery, which
/// a capability refusal is not).
fn assert_capability_refusal(
    frame: &serde_json::Value,
    session_id: &str,
    provider: &str,
    session_type: &str,
    message: &str,
) {
    assert_eq!(frame["provider"], serde_json::json!(provider));
    assert_eq!(frame["sessionId"], serde_json::json!(session_id));
    assert_eq!(frame["sessionType"], serde_json::json!(session_type));
    assert_eq!(
        frame["event"]["type"],
        serde_json::json!("freshAgent.error")
    );
    assert_eq!(frame["event"]["sessionId"], serde_json::json!(session_id));
    assert_eq!(
        frame["event"]["code"],
        serde_json::json!("UNSUPPORTED_CAPABILITY")
    );
    assert_eq!(frame["event"]["message"], serde_json::json!(message));
}

/// Codex approvals reach the runtime, which diagnoses an unknown session.
#[tokio::test]
async fn codex_approval_respond_dispatches_to_the_runtime() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    // The exact frame shape FreshAgentView.tsx sends on an Approve click.
    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.approval.respond",
            "provider": "codex",
            "sessionId": "ses-approve-1",
            "sessionType": "freshcodex",
            "decision": { "behavior": "allow" },
            "requestId": "perm-1",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_eq!(frame["provider"], "codex");
    assert_eq!(frame["sessionId"], "ses-approve-1");
    assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
}

/// Refusal-matrix cell (whole-branch review M-3): approvals belong to the claude
/// provider only — an opencode-provider approval.respond is refused with the parity
/// capability text.
#[tokio::test]
async fn opencode_approval_respond_is_refused_with_the_parity_capability_message() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.approval.respond",
            "provider": "opencode",
            "sessionId": "ses-oc-approve-1",
            "sessionType": "freshopencode",
            "decision": { "approved": true, "scope": "once" },
            "requestId": "perm-oc-1",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_capability_refusal(
        &frame,
        "ses-oc-approve-1",
        "opencode",
        "freshopencode",
        "Approvals are not supported for freshopencode",
    );
}

/// Codex questions reach the runtime, which diagnoses an unknown session.
#[tokio::test]
async fn codex_question_respond_dispatches_to_the_runtime() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.question.respond",
            "provider": "codex",
            "sessionId": "ses-cx-question-1",
            "sessionType": "freshcodex",
            "answers": { "Pick one": "A" },
            "requestId": "q-cx-1",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_eq!(frame["provider"], "codex");
    assert_eq!(frame["sessionId"], "ses-cx-question-1");
    assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
}

/// Refusal-matrix cell (whole-branch review M-3): questions belong to the claude
/// provider only — an opencode-provider question.respond is refused with the parity
/// capability text.
#[tokio::test]
async fn opencode_question_respond_is_refused_with_the_parity_capability_message() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.question.respond",
            "provider": "opencode",
            "sessionId": "ses-oc-question-1",
            "sessionType": "freshopencode",
            "answers": { "Pick one": "A" },
            "requestId": "q-oc-1",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_capability_refusal(
        &frame,
        "ses-oc-question-1",
        "opencode",
        "freshopencode",
        "Questions are not supported for freshopencode",
    );
}

/// Refusal-matrix cell: claude has no fork — refused with the parity capability text.
#[tokio::test]
async fn claude_fork_is_refused_with_the_parity_capability_message() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    // FreshAgentView.tsx's fork frame.
    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.fork",
            "provider": "claude",
            "sessionId": "ses-fork-1",
            "sessionType": "freshclaude",
            "requestId": "fork-req-1",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_capability_refusal(
        &frame,
        "ses-fork-1",
        "claude",
        "freshclaude",
        "Fork is not supported for freshclaude",
    );
}

/// Dispatch-matrix cell: kilroy rides the claude provider path (AGENT-24) — a kilroy
/// approval.respond is NOT refused; it reaches the claude handler, which answers an
/// unknown session with the nested INVALID_SESSION_ID lost-session shape (proving the
/// frame reached dispatch instead of hitting the refusal table).
#[tokio::test]
async fn kilroy_approval_respond_reaches_the_claude_dispatch_arm() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.approval.respond",
            "provider": "claude",
            "sessionId": "ses-kilroy-approve-1",
            "sessionType": "kilroy",
            "decision": { "approved": true, "scope": "once" },
            "requestId": "perm-9",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_eq!(frame["provider"], serde_json::json!("claude"));
    assert_eq!(frame["sessionType"], serde_json::json!("kilroy"));
    assert_eq!(
        frame["event"]["type"],
        serde_json::json!("freshAgent.error")
    );
    assert_eq!(
        frame["event"]["code"],
        serde_json::json!("INVALID_SESSION_ID"),
        "the frame reached the claude handler (a refusal-table answer would be UNSUPPORTED_CAPABILITY): {frame}"
    );
}

/// Dispatch-matrix cell (whole-branch review M-3): claude question.respond is NOT
/// refused — it reaches `FreshClaudeState::handle_question_respond`, which answers an
/// unknown session with the nested INVALID_SESSION_ID lost-session shape (the shared
/// `respond_session_guard` prologue), proving the frame reached dispatch instead of
/// hitting the refusal table.
#[tokio::test]
async fn claude_question_respond_reaches_the_claude_dispatch_arm() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.question.respond",
            "provider": "claude",
            "sessionId": "ses-cl-question-1",
            "sessionType": "freshclaude",
            "answers": { "Pick one": "A" },
            "requestId": "q-cl-1",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_eq!(frame["provider"], serde_json::json!("claude"));
    assert_eq!(frame["sessionType"], serde_json::json!("freshclaude"));
    assert_eq!(
        frame["event"]["type"],
        serde_json::json!("freshAgent.error")
    );
    assert_eq!(
        frame["event"]["code"],
        serde_json::json!("INVALID_SESSION_ID"),
        "the frame reached the claude handler (a refusal-table answer would be UNSUPPORTED_CAPABILITY): {frame}"
    );
}

/// Dispatch-matrix cell: claude compact reaches `FreshClaudeState::handle_compact`
/// (unknown session → nested INVALID_SESSION_ID lost-session shape, freshclaude flavour).
#[tokio::test]
async fn claude_compact_reaches_the_claude_dispatch_arm() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.compact",
            "provider": "claude",
            "sessionId": "ses-compact-1",
            "sessionType": "freshclaude",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_eq!(frame["provider"], serde_json::json!("claude"));
    assert_eq!(frame["sessionType"], serde_json::json!("freshclaude"));
    assert_eq!(
        frame["event"]["code"],
        serde_json::json!("INVALID_SESSION_ID"),
        "the frame reached the claude handler (a refusal-table answer would be UNSUPPORTED_CAPABILITY): {frame}"
    );
}

/// Dispatch-matrix cell (Task 4): codex compact is NO LONGER refused — it reaches
/// `FreshCodexState::handle_compact`, which answers an unknown session with the nested
/// `freshAgent.error{INVALID_SESSION_ID}` lost-session envelope (never
/// UNSUPPORTED_CAPABILITY; whole-branch-review M-1 switched SESSION_NOT_FOUND to the
/// lost-session code so the client engages `markSessionLost` recovery, matching codex
/// fork's own unknown-parent leg — the nested shape keeps every compact failure
/// pane-visible, matching the other arms).
#[tokio::test]
async fn codex_compact_reaches_the_codex_dispatch_arm() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.compact",
            "provider": "codex",
            "sessionId": "ses-cx-compact-1",
            "sessionType": "freshcodex",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_eq!(frame["provider"], serde_json::json!("codex"));
    assert_eq!(frame["sessionType"], serde_json::json!("freshcodex"));
    assert_eq!(
        frame["event"]["type"],
        serde_json::json!("freshAgent.error")
    );
    assert_eq!(
        frame["event"]["code"],
        serde_json::json!("INVALID_SESSION_ID"),
        "the frame reached the codex handler (a refusal-table answer would be UNSUPPORTED_CAPABILITY): {frame}"
    );
}

/// Dispatch-matrix cell (Task 4; whole-branch-review I-1): opencode compact reaches
/// `FreshOpencodeState::handle_compact`, which answers an unknown session with the
/// nested `freshAgent.error{INVALID_SESSION_ID}` lost-session envelope — mirroring
/// opencode fork's own unknown-session leg (broadcast is fine: the client routes
/// nested frames by sessionId). A request-less top-level `error` frame never reaches
/// any pane, so the leg MUST be nested.
#[tokio::test]
async fn opencode_compact_reaches_the_opencode_dispatch_arm() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.compact",
            "provider": "opencode",
            "sessionId": "ses-oc-compact-1",
            "sessionType": "freshopencode",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_eq!(frame["provider"], serde_json::json!("opencode"));
    assert_eq!(frame["sessionId"], serde_json::json!("ses-oc-compact-1"));
    assert_eq!(frame["sessionType"], serde_json::json!("freshopencode"));
    assert_eq!(
        frame["event"]["type"],
        serde_json::json!("freshAgent.error")
    );
    assert_eq!(
        frame["event"]["code"],
        serde_json::json!("INVALID_SESSION_ID"),
        "the frame reached the opencode handler with the lost-session shape (a refusal-table \
         answer would be UNSUPPORTED_CAPABILITY; the pre-I-1 top-level `error` frame was \
         invisible to every pane): {frame}"
    );
}

/// Dispatch-matrix cell (Task 5): opencode fork is NO LONGER refused — it reaches
/// `FreshOpencodeState::handle_fork`, which answers an unknown session with the nested
/// `freshAgent.error{INVALID_SESSION_ID}` lost-session shape ON THE REQUESTING
/// CONNECTION (never UNSUPPORTED_CAPABILITY, and never silence — the requesting sink
/// always gets an answer).
#[tokio::test]
async fn opencode_fork_reaches_the_opencode_dispatch_arm() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.fork",
            "provider": "opencode",
            "sessionId": "ses-oc-fork-1",
            "sessionType": "freshopencode",
            "requestId": "fork-oc-1",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_eq!(frame["provider"], serde_json::json!("opencode"));
    assert_eq!(frame["sessionType"], serde_json::json!("freshopencode"));
    assert_eq!(
        frame["event"]["type"],
        serde_json::json!("freshAgent.error")
    );
    assert_eq!(
        frame["event"]["code"],
        serde_json::json!("INVALID_SESSION_ID"),
        "the frame reached the opencode handler (a refusal-table answer would be UNSUPPORTED_CAPABILITY): {frame}"
    );
}

/// Dispatch-matrix cell (Task 6): codex fork is NO LONGER refused — it reaches
/// `FreshCodexState::handle_fork`, which answers an unknown parent session with the
/// nested `freshAgent.error{INVALID_SESSION_ID}` lost-session shape ON THE REQUESTING
/// CONNECTION (never UNSUPPORTED_CAPABILITY, and never silence — the requesting sink
/// always gets an answer). This pin began life (Task-5 carried minor) as
/// `codex_fork_is_refused_with_the_parity_capability_message` and flipped when Task 6
/// inverted the cell.
#[tokio::test]
async fn codex_fork_reaches_the_codex_dispatch_arm() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.fork",
            "provider": "codex",
            "sessionId": "ses-cx-fork-1",
            "sessionType": "freshcodex",
            "requestId": "fork-cx-1",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_eq!(frame["provider"], serde_json::json!("codex"));
    assert_eq!(frame["sessionType"], serde_json::json!("freshcodex"));
    assert_eq!(
        frame["event"]["type"],
        serde_json::json!("freshAgent.error")
    );
    assert_eq!(
        frame["event"]["code"],
        serde_json::json!("INVALID_SESSION_ID"),
        "the frame reached the codex handler (a refusal-table answer would be UNSUPPORTED_CAPABILITY): {frame}"
    );
}

/// Refusal-matrix pin (carried Task-2 nit, cleared in Task 4): there is no amplifier
/// FRESH-AGENT runtime, so EVERY control frame naming the amplifier provider is refused
/// with the parity capability text. (There is no amplifier `sessionType`; the sessionType
/// field here is filler the pin never consults.)
#[tokio::test]
async fn amplifier_approval_respond_is_refused_with_the_parity_capability_message() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.approval.respond",
            "provider": "amplifier",
            "sessionId": "ses-amp-approve",
            "sessionType": "freshclaude",
            "decision": { "approved": true, "scope": "once" },
            "requestId": "perm-amp-1",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_capability_refusal(
        &frame,
        "ses-amp-approve",
        "amplifier",
        "freshclaude",
        "Approvals are not supported for freshclaude",
    );
}

#[tokio::test]
async fn amplifier_question_respond_is_refused_with_the_parity_capability_message() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.question.respond",
            "provider": "amplifier",
            "sessionId": "ses-amp-question",
            "sessionType": "freshclaude",
            "answers": { "Pick one": "A" },
            "requestId": "q-amp-1",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_capability_refusal(
        &frame,
        "ses-amp-question",
        "amplifier",
        "freshclaude",
        "Questions are not supported for freshclaude",
    );
}

#[tokio::test]
async fn amplifier_fork_is_refused_with_the_parity_capability_message() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.fork",
            "provider": "amplifier",
            "sessionId": "ses-amp-fork",
            "sessionType": "freshcodex",
            "requestId": "fork-amp-1",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_capability_refusal(
        &frame,
        "ses-amp-fork",
        "amplifier",
        "freshcodex",
        "Fork is not supported for freshcodex",
    );
}

/// The Task-4 table shrink keeps exactly ONE compact refusal cell: amplifier.
#[tokio::test]
async fn amplifier_compact_is_refused_with_the_parity_capability_message() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws,
        serde_json::json!({
            "type": "freshAgent.compact",
            "provider": "amplifier",
            "sessionId": "ses-amp-compact",
            "sessionType": "freshopencode",
        }),
    )
    .await;

    let frame = next_frame_of_type(&mut ws, "freshAgent.event").await;
    assert_capability_refusal(
        &frame,
        "ses-amp-compact",
        "amplifier",
        "freshopencode",
        "Compact is not supported for freshopencode",
    );
}

#[tokio::test]
async fn handled_control_frames_still_reach_their_dispatch_arms() {
    // Guard: the refusal table must not swallow a HANDLED sibling -- `ping`
    // (the simplest round-trip control frame) still answers `pong`.
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    send_json(&mut ws, serde_json::json!({ "type": "ping" })).await;
    let frame = next_frame_of_type(&mut ws, "pong").await;
    assert!(frame["timestamp"].is_string(), "pong carries a timestamp");
}
