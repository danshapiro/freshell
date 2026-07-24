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

/// How long after terminal creation an unresolved identity becomes
/// alarm-worthy. The amplifier locator's dir-appear correlation window is
/// [`freshell_sessions::amplifier_locator::AMPLIFIER_DIR_APPEAR_WINDOW_MS`]
/// (2s) after a submit; five windows of slack keeps the alarm quiet through
/// any normal association latency while still firing within seconds of a
/// genuinely-lost identity.
pub(crate) const IDENTITY_RESOLUTION_GRACE_MS: i64 =
    5 * freshell_sessions::amplifier_locator::AMPLIFIER_DIR_APPEAR_WINDOW_MS;

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

#[cfg(test)]
mod tests {
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
        }
    }

    mod capture {
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
