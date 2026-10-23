//! # freshell-freshagent :: session_metadata — the live-settings convergence frame
//!
//! The `freshAgent.session.metadata` broadcast is the ONE wire event that keeps
//! every device's model surfaces (status-strip chip, gear popover, tooltips) in
//! sync with the LIVE session's effective settings. The frame and the client
//! fold have existed since the protocol's first cut — but no server ever
//! EMITTED it, so a model change staged on one device never propagated to the
//! session record (or any other device), leaving the chip showing stale
//! session truth (the codex snapshot-settings mask) or a raw init id with no
//! label (the claude init mask).
//!
//! Emission sites (every place the LIVE session's effective model/effort can
//! change — see the per-slice `handle_configure` and `handle_send`):
//!
//! * `freshAgent.configure` — the client's model dialog / settings popover
//!   committing a change to a LIVE session. Claude/kilroy apply it for real
//!   through the sidecar's configure lane (`setModel` et al.); codex and
//!   opencode record it as the next turn's per-send settings (their advertised
//!   `per-send` scope).
//! * `freshAgent.send` carrying settings that CHANGE the session record — the
//!   turn-accept apply path (codex/opencode) or the sidecar configure-for-send
//!   path (claude). A device that missed the configure still converges here.
//!
//! The event ALWAYS states the post-apply effective pair: `model` and `effort`
//! are serialized as strings, with JSON `null` meaning "explicitly no value"
//! (e.g. opencode's Default thinking row clears effort; an opencode configure
//! with no model clears the model). An ABSENT key is "no statement" — the
//! client keeps whatever it has — which is exactly what an older server's
//! silence degrades to.
//!
//! Claude also states `permissionMode`, a live setting of its session: its
//! configure and send paths broadcast when the model, effort or permission
//! mode changed, and the stdout consumer relays the sidecar's own
//! `{permissionMode}` frame when the CLI changes mode by itself (an approved
//! ExitPlanMode). Codex and opencode never state it (the key is absent).
//!
//! The envelope is stamped with the CLIENT-ADDRESSED session id (the id the
//! configure/send named), never an internal alias: the client's fold resolves
//! the sessions-map entry by that id, and alias-aware resolution (claude's
//! placeholder ↔ durable cli_index) is a server-side concern.

use freshell_protocol::{FreshAgentEvent, ServerMessage};
use serde_json::json;

/// Build the `freshAgent.event { freshAgent.session.metadata }` broadcast.
///
/// `model` / `effort` are the post-apply EFFECTIVE values the event states
/// (`None` serializes as JSON null — an explicit clear). Broadcast only on an
/// actual change: the slices diff their session record around the apply.
///
/// `permission_mode` is stated only when `Some` (claude, whose permission
/// mode is a live session setting); `None` leaves the key out — no
/// statement — which is what codex and opencode send.
pub fn session_metadata_frame(
    provider: &str,
    session_type: &str,
    session_id: &str,
    model: Option<&str>,
    effort: Option<&str>,
    permission_mode: Option<&str>,
) -> ServerMessage {
    let mut event = json!({
        "type": "freshAgent.session.metadata",
        "sessionId": session_id,
        "model": model,
        "effort": effort,
    });
    if let Some(permission_mode) = permission_mode {
        event["permissionMode"] = json!(permission_mode);
    }
    ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event,
        provider: provider.to_string(),
        session_id: session_id.to_string(),
        session_type: session_type.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_frame_states_the_effective_pair_with_explicit_nulls() {
        let frame = session_metadata_frame(
            "codex",
            "freshcodex",
            "thread-1",
            Some("gpt-5.6-luna"),
            None,
            None,
        );
        let ServerMessage::FreshAgentEvent(inner) = &frame else {
            panic!("metadata rides the freshAgent.event envelope");
        };
        assert_eq!(inner.provider, "codex");
        assert_eq!(inner.session_type, "freshcodex");
        assert_eq!(inner.session_id, "thread-1");
        assert_eq!(inner.event["type"], "freshAgent.session.metadata");
        assert_eq!(inner.event["sessionId"], "thread-1");
        assert_eq!(inner.event["model"], "gpt-5.6-luna");
        // An explicit clear serializes as null, never as an absent key.
        assert_eq!(inner.event["effort"], serde_json::Value::Null);
    }

    #[test]
    fn metadata_frame_states_a_permission_mode_only_when_given() {
        let stated = session_metadata_frame(
            "claude",
            "freshclaude",
            "pane-1",
            Some("opus"),
            None,
            Some("plan"),
        );
        let ServerMessage::FreshAgentEvent(stated) = &stated else {
            panic!("metadata rides the freshAgent.event envelope");
        };
        assert_eq!(stated.event["permissionMode"], "plan");

        // No statement: the key is absent, so the client keeps what it has.
        let silent =
            session_metadata_frame("codex", "freshcodex", "thread-1", Some("m"), None, None);
        let ServerMessage::FreshAgentEvent(silent) = &silent else {
            panic!("metadata rides the freshAgent.event envelope");
        };
        assert!(
            silent.event.get("permissionMode").is_none(),
            "{:?}",
            silent.event
        );
    }

    #[test]
    fn metadata_frame_survives_a_wire_roundtrip() {
        let frame = session_metadata_frame(
            "opencode",
            "freshopencode",
            "ses_1",
            Some("prov/mdl"),
            Some("low"),
            None,
        );
        let wire = serde_json::to_string(&frame).expect("serializes");
        let back: serde_json::Value = serde_json::from_str(&wire).expect("parses");
        assert_eq!(back["type"], "freshAgent.event");
        assert_eq!(back["event"]["type"], "freshAgent.session.metadata");
        assert_eq!(back["event"]["model"], "prov/mdl");
        assert_eq!(back["event"]["effort"], "low");
    }
}
