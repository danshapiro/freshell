//! The 2 s naming tick: adopt another same-home process's committed name
//! document, then bind still-pending Claude handles whose transcripts now
//! exist.
//!
//! (1) Adoption is a stat of the document against the adopted stamp; the
//! strict locked full read runs only when the stamp changed or its 30 s
//! full-check window elapsed (name-reliability Task 11,
//! `session_name_store_view`). (2) Claude binds go through the transcript
//! locator (the signal-first and zero-turn create lanes bind as soon as the
//! transcript exists). Codex and OpenCode own their verified binds on their
//! runtime edges (the rollout walk, the DB row); the tick never fabricates
//! one.

use std::sync::Arc;
use std::time::Duration;

use freshell_terminal::TerminalRegistry;
use freshell_ws::identity::TerminalIdentityRegistry;

use crate::session_names::SessionNames;

/// How often the tick runs in the server.
pub(crate) const NAMING_TICK_PERIOD: Duration = Duration::from_secs(2);

/// Run the tick every `period` until the task is dropped. A tick that
/// overruns skips the missed ticks instead of bunching them up.
pub(crate) async fn run_naming_tick(
    names: Arc<SessionNames>,
    identity: TerminalIdentityRegistry,
    registry: TerminalRegistry,
    period: Duration,
) {
    let mut tick = tokio::time::interval(period);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        adopt_external_commits(&names).await;
        bind_pending_claude_transcripts(&identity, &registry).await;
    }
}

/// Adopt a cooperating process's newer generation when the cheap stamp
/// peek says the document changed. A failure is logged and retried on the
/// next tick.
async fn adopt_external_commits(names: &SessionNames) {
    if let Err(error) = names.adopt_external_if_changed().await {
        tracing::warn!(
            target: "freshell_server::session_names",
            op = "adopt_external_if_changed",
            name_ref = "-",
            revision = 0,
            class = %error.code(),
            "session_names.operation_failed: {error}"
        );
    }
}

/// One bounded locate + bind per still-pending Claude row. A miss or failure
/// keeps the row pending for the next tick's retry (the helper logs its own
/// failure classes).
async fn bind_pending_claude_transcripts(
    identity: &TerminalIdentityRegistry,
    registry: &TerminalRegistry,
) {
    for (terminal_id, provider, session_id, _handle) in identity.pending_naming_binds() {
        if provider != "claude" {
            continue;
        }
        let _ = freshell_ws::identity::bind_pending_claude_transcript(
            identity,
            registry,
            &terminal_id,
            &session_id,
        )
        .await;
    }
}

#[cfg(test)]
#[path = "session_name_tick_tests.rs"]
mod tests;
