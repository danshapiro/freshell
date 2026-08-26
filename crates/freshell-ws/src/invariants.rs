//! STATE-SYNC FIX 1 / Increment 2(b): identity invariant alarms.
//!
//! The four state-sync incidents (`docs/plans/2026-07-19-state-sync-cartography.md`
//! Part 4) were all contract bugs between an identity WRITER and the matcher
//! that consumes it — none were caught at the moment the invariant broke.
//! This module is the observability side of the fix: a bounded (once per
//! terminal) WARN on the `freshell_ws::invariants` target whenever a
//! non-shell coding-CLI terminal ends up with NO resolvable session identity
//! after the locator correlation window has had time to run. Grep target:
//! `terminal_identity_unresolved`.
//!
//! "Resolvable identity" means EITHER of the two identity homes knows the
//! terminal's session:
//! * the shared [`crate::identity::TerminalIdentityRegistry`] (create-time
//!   resume ids stamped by the WS `terminal.create` path, and
//!   locator-associated ids stamped by the amplifier/opencode sweeps), or
//! * the terminal registry's own `resume_session_id` meta (REST-created
//!   resumes, whose create path cannot reach the WS-owned identity registry
//!   across the crate boundary — see `terminal_tabs.rs`'s exit-hook doc).
//!
//! The sibling alarm (a `ui.command tab.create` for a session-provider mode
//! carrying neither `sessionRef` nor `resumeSessionId`) fires at the single
//! place such payloads are minted, `freshell-freshagent`'s
//! `create_terminal_tab`, on this same tracing target.

use std::collections::HashSet;

use freshell_protocol::TerminalRunStatus;
use freshell_terminal::registry::IdentityProbeRow;

use crate::identity::TerminalIdentityRegistry;

/// How long a non-shell coding-CLI terminal may run without a resolvable
/// session identity before the invariant alarm fires once. 10s: identity is
/// launcher-assigned at create time for claude and amplifier; the codex and
/// opencode locators resolve within their own ~2s correlation windows, so
/// anything unresolved after 10s is a real defect, not a race.
/// (Previously derived from the deleted amplifier locator's
/// AMPLIFIER_DIR_APPEAR_WINDOW_MS; the alarm also previously rode the
/// amplifier locator sweep's 150ms ticker and silently never ran when no
/// provider home existed — it now owns its sweep unconditionally.)
pub(crate) const IDENTITY_RESOLUTION_GRACE_MS: i64 = 10_000;

/// Own sweep for the terminal_identity_unresolved alarm (re-homed off the
/// deleted amplifier locator sweep, kata qmpk). Spawned UNCONDITIONALLY at
/// boot — the old home only ran `if amplifier_locator.is_some()`, so a
/// missing provider home silently disabled the alarm for every provider.
pub fn spawn_identity_invariant_sweep(state: crate::WsState, interval: std::time::Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // Once-per-terminal bound, sweep-task-lifetime scoped.
        let mut identity_warned = std::collections::HashSet::new();
        loop {
            ticker.tick().await;
            warn_unresolved_terminal_identities(
                &state.registry.identity_probe_rows(),
                &state.identity,
                &mut identity_warned,
                crate::terminal::now_ms(),
            );
        }
    });
}

/// One sweep pass: WARN (once per terminal, tracked in `warned`) for every
/// RUNNING non-shell terminal older than [`IDENTITY_RESOLUTION_GRACE_MS`]
/// with no resolvable identity in either identity home. Exited terminals are
/// skipped (their identity story is over); shell terminals never carry
/// session identity by design.
pub(crate) fn warn_unresolved_terminal_identities(
    rows: &[IdentityProbeRow],
    identity: &TerminalIdentityRegistry,
    warned: &mut HashSet<String>,
    now_ms: i64,
) {
    for row in rows {
        if row.mode == "shell"
            || row.status != TerminalRunStatus::Running
            || row.resume_session_id.is_some()
            || warned.contains(&row.terminal_id)
        {
            continue;
        }
        let age_ms = now_ms - row.created_at;
        if age_ms <= IDENTITY_RESOLUTION_GRACE_MS {
            continue;
        }
        if identity.session_ref_for(&row.terminal_id).is_some() {
            continue;
        }
        warned.insert(row.terminal_id.clone());
        tracing::warn!(
            target: "freshell_ws::invariants",
            terminal_id = %row.terminal_id,
            mode = %row.mode,
            age_ms = age_ms,
            "terminal_identity_unresolved: non-shell coding-CLI terminal has no resolvable \
             session identity after the locator window; its panes cannot be matched to a \
             session (sidebar grey / duplicate tabs / no restore identity)"
        );
    }
}

/// P0.4 fail-loud (campaign plan §2.2): a `restore:true` claude create carried
/// no client id AND no server-side identity source could resolve one -- an
/// invariant-violation ("never happens") state. The create is rejected with
/// `error{RESTORE_UNAVAILABLE}` instead of silently spawning claude with
/// neither `--session-id` nor `--resume` (an unidentifiable, permanently
/// un-resumable session). ERROR, not WARN: unlike the sweep alarms above,
/// this is a per-request hard failure the user sees. Grep target:
/// `claude_restore_identity_unresolved`.
pub(crate) fn error_claude_restore_unresolved(request_id: &str) {
    tracing::error!(
        target: "freshell_ws::invariants",
        request_id = %request_id,
        "claude_restore_identity_unresolved: restore:true claude create had no \
         sessionRef/resumeSessionId and no server-resolvable identity; rejected with \
         RESTORE_UNAVAILABLE instead of spawning an unidentifiable claude session"
    );
}

/// P1.8 (spec §4.2 write-failure policy): a ledger write failed. The event
/// itself proceeded (fail loud, degrade to status quo) — but this pane may
/// not survive a restart, and the live `durability.degraded` frame was
/// pushed at failure time.
pub(crate) fn error_pane_ledger_write_failed(terminal_id: &str, err: &std::io::Error) {
    tracing::error!(
        target: "freshell_ws::invariants",
        terminal_id = %terminal_id,
        error = %err,
        "pane_ledger_write_failed: identity event could not be durably recorded; \
         durability.degraded broadcast live to all connected clients"
    );
}

#[cfg(test)]
pub(crate) mod capture {
    //! Thread-local capturing subscriber recording TARGET + message +
    //! fields (the `freshell-freshagent` DIAG-01 convention, extended
    //! with `metadata().target()` since these alarms are target-scoped).
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};
    use tracing::field::{Field, Visit};
    use tracing::{Event, Subscriber};
    use tracing_subscriber::layer::{Context, SubscriberExt};
    use tracing_subscriber::Layer;

    #[derive(Debug, Clone, Default)]
    pub struct CapturedEvent {
        pub target: String,
        pub message: String,
        pub fields: BTreeMap<String, String>,
    }

    #[derive(Default)]
    struct FieldVisitor {
        message: String,
        fields: BTreeMap<String, String>,
    }

    impl Visit for FieldVisitor {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            let rendered = format!("{value:?}");
            if field.name() == "message" {
                self.message = rendered;
            } else {
                self.fields.insert(field.name().to_string(), rendered);
            }
        }
        fn record_str(&mut self, field: &Field, value: &str) {
            if field.name() == "message" {
                self.message = value.to_string();
            } else {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }
        }
        fn record_i64(&mut self, field: &Field, value: i64) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }
    }

    struct CaptureLayer {
        events: Arc<Mutex<Vec<CapturedEvent>>>,
    }

    impl<S: Subscriber> Layer<S> for CaptureLayer {
        fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
            let mut visitor = FieldVisitor::default();
            event.record(&mut visitor);
            self.events
                .lock()
                .expect("capture lock")
                .push(CapturedEvent {
                    target: event.metadata().target().to_string(),
                    message: visitor.message,
                    fields: visitor.fields,
                });
        }
    }

    pub fn capture() -> (
        Arc<Mutex<Vec<CapturedEvent>>>,
        tracing::subscriber::DefaultGuard,
    ) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let layer = CaptureLayer {
            events: Arc::clone(&events),
        };
        let subscriber = tracing_subscriber::registry().with(layer);
        let guard = tracing::subscriber::set_default(subscriber);
        (events, guard)
    }
}

#[cfg(test)]
mod tests {
    use super::capture;
    use super::*;

    fn row(
        terminal_id: &str,
        mode: &str,
        status: TerminalRunStatus,
        created_at: i64,
        resume_session_id: Option<&str>,
    ) -> IdentityProbeRow {
        IdentityProbeRow {
            terminal_id: terminal_id.to_string(),
            mode: mode.to_string(),
            status,
            created_at,
            resume_session_id: resume_session_id.map(str::to_string),
            cwd: None,
            restart_launch: None,
        }
    }

    fn unresolved_warnings(events: &[capture::CapturedEvent]) -> Vec<capture::CapturedEvent> {
        events
            .iter()
            .filter(|e| {
                e.target == "freshell_ws::invariants"
                    && e.message.contains("terminal_identity_unresolved")
            })
            .cloned()
            .collect()
    }

    #[test]
    fn identity_resolution_grace_is_a_standalone_constant() {
        // Re-homed from 5 * AMPLIFIER_DIR_APPEAR_WINDOW_MS when the amplifier
        // correlation-window locator was deleted (kata qmpk). 10s: generous
        // for every provider's identity to land at create time (identity is
        // launcher-assigned for claude and amplifier; codex/opencode locators
        // resolve within their own ~2s windows).
        assert_eq!(IDENTITY_RESOLUTION_GRACE_MS, 10_000);
    }

    #[test]
    fn warns_once_per_unresolved_non_shell_terminal_past_the_grace_window() {
        let (events, _guard) = capture::capture();
        let identity = TerminalIdentityRegistry::new();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-lost",
            "amplifier",
            TerminalRunStatus::Running,
            1_000,
            None,
        )];
        let now = 1_000 + IDENTITY_RESOLUTION_GRACE_MS + 1;

        warn_unresolved_terminal_identities(&rows, &identity, &mut warned, now);
        // Bounded: a second sweep must NOT warn again for the same terminal.
        warn_unresolved_terminal_identities(&rows, &identity, &mut warned, now + 5_000);

        let warnings = unresolved_warnings(&events.lock().unwrap());
        assert_eq!(warnings.len(), 1, "exactly one warn per terminal");
        assert_eq!(
            warnings[0].fields.get("terminal_id").map(String::as_str),
            Some("t-lost")
        );
        assert_eq!(
            warnings[0].fields.get("mode").map(String::as_str),
            Some("amplifier")
        );
    }

    #[test]
    fn never_warns_inside_the_grace_window() {
        let (events, _guard) = capture::capture();
        let identity = TerminalIdentityRegistry::new();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-young",
            "amplifier",
            TerminalRunStatus::Running,
            1_000,
            None,
        )];

        warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            1_000 + IDENTITY_RESOLUTION_GRACE_MS,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
    }

    #[test]
    fn never_warns_for_shell_or_exited_terminals() {
        let (events, _guard) = capture::capture();
        let identity = TerminalIdentityRegistry::new();
        let mut warned = HashSet::new();
        let rows = vec![
            row("t-shell", "shell", TerminalRunStatus::Running, 0, None),
            row("t-gone", "amplifier", TerminalRunStatus::Exited, 0, None),
        ];

        warn_unresolved_terminal_identities(&rows, &identity, &mut warned, i64::MAX);

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
    }

    #[test]
    fn error_claude_restore_unresolved_emits_on_invariants_target() {
        let (events, _guard) = capture::capture();

        super::error_claude_restore_unresolved("req-lost-42");

        let captured: Vec<capture::CapturedEvent> = events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.target == "freshell_ws::invariants")
            .cloned()
            .collect();
        assert_eq!(captured.len(), 1, "exactly one emission: {captured:?}");
        assert!(
            captured[0]
                .message
                .starts_with("claude_restore_identity_unresolved:"),
            "message must lead with the grep-target invariant name: {}",
            captured[0].message
        );
        assert_eq!(
            captured[0].fields.get("request_id").map(String::as_str),
            Some("req-lost-42"),
            "request_id must be a structured field: {:?}",
            captured[0]
        );
    }

    #[test]
    fn never_warns_when_either_identity_home_resolves_the_terminal() {
        let (events, _guard) = capture::capture();
        let identity = TerminalIdentityRegistry::new();
        identity.upsert("t-identity", Some("amplifier"), Some("sess-1"), None, 1);
        let mut warned = HashSet::new();
        let rows = vec![
            // Resolved via the WS identity registry.
            row(
                "t-identity",
                "amplifier",
                TerminalRunStatus::Running,
                0,
                None,
            ),
            // Resolved via the terminal registry's own resume meta (the
            // REST-created resume case).
            row(
                "t-rest-resume",
                "amplifier",
                TerminalRunStatus::Running,
                0,
                Some("sess-2"),
            ),
        ];

        warn_unresolved_terminal_identities(&rows, &identity, &mut warned, i64::MAX);

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
    }
}
