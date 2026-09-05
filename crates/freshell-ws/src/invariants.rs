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
//! For `mode == "opencode"` the alarm additionally requires STALE locator
//! resolvability evidence (danshapiro/freshell#702): opencode terminal-pane
//! identity is answer-triggered — the `ses_*` row in opencode.db provably
//! does not exist until the first prompt — so create-age alone cannot alarm
//! on opencode rows. The evidence comes from either the locator's
//! candidate-evidence latch (an evaluated correlation window that ended
//! ambiguous/contested) or, for ever-submitted panes past the create-age
//! grace, the alarm-time `probe_resolvable` read (the late-row /
//! swallowed-DB-error hole). A fresh opencode pane with neither has nothing
//! resolvable and is never alarmed.
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
/// session identity before the invariant alarm fires once. For claude and
/// amplifier identity is launcher-assigned at create time, and the codex
/// locator correlates within its own ~2s window, so for those modes the
/// grace is measured from CREATE. opencode terminal panes are
/// ANSWER-triggered: opencode writes its `session` row lazily at the first
/// prompt, so before that moment nothing is resolvable and any create-age
/// alarm is pure noise (danshapiro/freshell#702 — 12/12 real panes fired the
/// old gate). For opencode rows the grace therefore runs from the locator's
/// first CANDIDATE EVIDENCE (`identity_resolvable_since`), whether it came
/// from an evaluated correlation window or from the alarm-time
/// `probe_resolvable` read for ever-submitted panes (the late-row /
/// swallowed-DB-error hole): the moment an in-cwd correlatable row provably
/// existed yet never bound. When the locator is unavailable at boot,
/// opencode keeps the create-age tripwire so a broken topology still alarms.
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
            let state = state.clone(); // WsState: Clone; Arc-backed fields
            let mut warned = std::mem::take(&mut identity_warned);
            // The pass can issue ONE bounded SQLite read per rare
            // submitted-but-unbound opencode row (the probe), so it runs on
            // the blocking pool (the `drain_and_associate` precedent,
            // opencode_association.rs).
            identity_warned = match tokio::task::spawn_blocking(move || {
                warn_unresolved_terminal_identities(
                    &state.registry.identity_probe_rows(),
                    &state.identity,
                    &mut warned,
                    crate::terminal::now_ms(),
                    state.opencode_locator.as_deref(),
                    &state.pane_ledger,
                );
                warned
            })
            .await
            {
                Ok(warned) => warned,
                Err(join_error) => {
                    // A pass panicked — a bug, not a routine condition. Skip
                    // the cycle and continue with a FRESH warned set (bounded
                    // re-warn noise beats silently losing the sweep; mirrors
                    // the locator tick panic handling).
                    tracing::warn!(
                        error = %join_error,
                        "identity_invariant_sweep_pass_panicked: skip this cycle; warned-set reset \
                         (terminals may re-warn once)"
                    );
                    std::collections::HashSet::new()
                }
            };
        }
    });
}

/// One sweep pass: WARN (once per terminal, tracked in `warned`) for every
/// RUNNING non-shell terminal whose identity is past its provider's overdue
/// window with no resolvable identity in either identity home. Exited
/// terminals are skipped (their identity story is over); shell terminals
/// never carry session identity by design. opencode rows are gated on
/// locator RESOLVABILITY evidence (see the grace-constant doc): window-latch
/// first, probe fallback for the late-row/DB-error hole (plan-review R1);
/// a pane with neither has nothing resolvable and is never alarmed
/// (issue #702). The probe's `is_unavailable` predicate keeps sessions
/// already claimed by any live-or-retired terminal and fresh-agent ledger
/// rows from ever counting as evidence.
pub(crate) fn warn_unresolved_terminal_identities(
    rows: &[IdentityProbeRow],
    identity: &TerminalIdentityRegistry,
    warned: &mut HashSet<String>,
    now_ms: i64,
    opencode_locator: Option<&freshell_sessions::opencode_locator::OpencodeLocator>,
    pane_ledger: &crate::pane_ledger::PaneLedger,
) {
    for row in rows {
        if row.mode == "shell"
            || row.status != TerminalRunStatus::Running
            || row.resume_session_id.is_some()
            || warned.contains(&row.terminal_id)
        {
            continue;
        }
        if identity.session_ref_for(&row.terminal_id).is_some() {
            continue;
        }
        let overdue_ms = match row.mode.as_str() {
            "opencode" => match opencode_locator {
                Some(locator) => {
                    let latched = locator.identity_resolvable_since(&row.terminal_id);
                    let since = match latched {
                        Some(t) => Some(t),
                        // Latch miss: probe only once the pane is past the
                        // create-age grace (R2 finding 2 — young panes are the
                        // binding lanes' business; never probe them).
                        None if now_ms - row.created_at > IDENTITY_RESOLUTION_GRACE_MS => locator
                            .probe_resolvable(&row.terminal_id, now_ms, &|session_id| {
                                identity
                                    .find_by_session_including_retired("opencode", session_id)
                                    .is_some()
                                    || pane_ledger
                                        .lookup_by_session("opencode", session_id)
                                        .is_some_and(|r| {
                                            r.row.pane_kind.as_deref() == Some("fresh-agent")
                                        })
                            }),
                        None => None,
                    };
                    match since {
                        Some(since_ms) => now_ms - since_ms,
                        None => continue, // nothing resolvable exists for this pane
                    }
                }
                None => now_ms - row.created_at,
            },
            _ => now_ms - row.created_at,
        };
        if overdue_ms <= IDENTITY_RESOLUTION_GRACE_MS {
            continue;
        }
        warned.insert(row.terminal_id.clone());
        tracing::warn!(
            target: "freshell_ws::invariants",
            terminal_id = %row.terminal_id,
            mode = %row.mode,
            age_ms = now_ms - row.created_at,
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

    fn seed_opencode_db(data_home: &std::path::Path) -> rusqlite::Connection {
        std::fs::create_dir_all(data_home).unwrap();
        let conn = rusqlite::Connection::open(data_home.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                parent_id TEXT,
                slug TEXT NOT NULL,
                directory TEXT NOT NULL,
                title TEXT NOT NULL,
                version TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                time_archived INTEGER
             );",
        )
        .unwrap();
        conn
    }

    fn insert_opencode_session(
        conn: &rusqlite::Connection,
        id: &str,
        cwd: &str,
        time_created: i64,
    ) {
        conn.execute(
            "INSERT INTO project (id, worktree) VALUES (?1, ?2)",
            rusqlite::params![format!("proj-{id}"), cwd],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session
                (id, project_id, parent_id, slug, directory, title, version,
                 time_created, time_updated, time_archived)
             VALUES (?1, ?2, NULL, ?1, ?3, ?1, 'test', ?4, ?4, NULL)",
            rusqlite::params![id, format!("proj-{id}"), cwd, time_created],
        )
        .unwrap();
    }

    /// This module + the next test share a temp-dir discipline identical to
    /// opencode_association.rs's `unique_temp_dir`.
    fn unique_opencode_home(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "freshell-invariants-opencode-test-{label}-{}-{n}",
            std::process::id()
        ))
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
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-lost",
            "amplifier",
            TerminalRunStatus::Running,
            1_000,
            None,
        )];
        let now = 1_000 + IDENTITY_RESOLUTION_GRACE_MS + 1;

        warn_unresolved_terminal_identities(&rows, &identity, &mut warned, now, None, &ledger);
        // Bounded: a second sweep must NOT warn again for the same terminal.
        warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            now + 5_000,
            None,
            &ledger,
        );

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
        let ledger = crate::pane_ledger::PaneLedger::disabled();
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
            None,
            &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
    }

    #[test]
    fn never_warns_for_shell_or_exited_terminals() {
        let (events, _guard) = capture::capture();
        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![
            row("t-shell", "shell", TerminalRunStatus::Running, 0, None),
            row("t-gone", "amplifier", TerminalRunStatus::Exited, 0, None),
        ];

        warn_unresolved_terminal_identities(&rows, &identity, &mut warned, i64::MAX, None, &ledger);

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
        let ledger = crate::pane_ledger::PaneLedger::disabled();
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

        warn_unresolved_terminal_identities(&rows, &identity, &mut warned, i64::MAX, None, &ledger);

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
    }

    #[test]
    fn opencode_pane_idle_beyond_the_create_age_grace_is_not_unresolved() {
        // danshapiro/freshell#702: a fresh opencode pane whose user has not
        // submitted a prompt has NO session row anywhere (opencode creates it
        // lazily at first prompt) -- nothing is resolvable, and the old
        // create-age gate false-fired on 100% of real usage (61s+ to first
        // prompt in the incident timeline). With a live locator holding no
        // candidate evidence, age alone must never warn.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("idle");
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        // The production shape: create+arm, NO submit, spawn window closes empty.
        assert!(locator.arm("t-idle", "opencode", true, None, Some("/proj"), 10_000));
        let _ =
            locator.tick(10_000 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 500);
        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-idle",
            "opencode",
            TerminalRunStatus::Running,
            10_000,
            None,
        )];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            10_000 + 61_000, // +61s: the incident's first-prompt delay
            Some(&locator),
            &ledger,
        );

        assert!(
            unresolved_warnings(&events.lock().unwrap()).is_empty(),
            "no evidence == nothing resolvable == no alarm (#702)"
        );
        assert!(warned.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_pane_with_stale_candidate_evidence_still_warns() {
        // The real defect class stays armed: a window SAW correlatable rows
        // but no bind landed (ambiguous locator refusal here; contested
        // refusals latch the same way — R2: sole-candidate emissions and
        // drain-side guard refusals deliberately do NOT, they are foreign
        // sessions) and identity is still absent past the grace.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("stale-evidence");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-ev", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-ev", 100));
        insert_opencode_session(&db, "ses_a", "/proj", 150);
        insert_opencode_session(&db, "ses_b", "/proj", 160); // ambiguous refusal
        let evidence_at = 100 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(evidence_at).is_empty());

        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row("t-ev", "opencode", TerminalRunStatus::Running, 0, None)];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            evidence_at + IDENTITY_RESOLUTION_GRACE_MS + 1,
            Some(&locator),
            &ledger,
        );

        let warnings = unresolved_warnings(&events.lock().unwrap());
        assert_eq!(warnings.len(), 1, "resolvable-but-unbound must warn");
        assert_eq!(
            warnings[0].fields.get("terminal_id").map(String::as_str),
            Some("t-ev")
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_pane_with_fresh_candidate_evidence_does_not_warn_yet() {
        // Evidence observed < grace ago: the 150ms locator sweep binds within
        // a tick or two in the healthy path, but the alarm must not outrun
        // the binding lanes.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("fresh-evidence");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-ev", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-ev", 100));
        insert_opencode_session(&db, "ses_a", "/proj", 150);
        insert_opencode_session(&db, "ses_b", "/proj", 160);
        let evidence_at = 100 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(evidence_at).is_empty());

        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row("t-ev", "opencode", TerminalRunStatus::Running, 0, None)];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            evidence_at + IDENTITY_RESOLUTION_GRACE_MS, // boundary: not yet overdue
            Some(&locator),
            &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_pane_with_evidence_but_resolved_identity_never_warns() {
        // The issue-702 HAPPY path must stay silent even though evidence was
        // latched: the signal lane (or locator lane) bound the identity, so
        // the identity check discharges the row before the evidence gate
        // matters (the `terminal_already_bound` arbitration case).
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("resolved-after-evidence");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-bound", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-bound", 100));
        insert_opencode_session(&db, "ses_a", "/proj", 150);
        insert_opencode_session(&db, "ses_b", "/proj", 160);
        let evidence_at = 100 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(evidence_at).is_empty());

        let identity = TerminalIdentityRegistry::new();
        identity.upsert("t-bound", Some("opencode"), Some("ses_a"), Some("/proj"), 1);
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-bound",
            "opencode",
            TerminalRunStatus::Running,
            0,
            None,
        )];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            i64::MAX,
            Some(&locator),
            &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_pane_warns_on_create_age_when_locator_unavailable() {
        // A boot with an unresolvable opencode data home (WsState.
        // opencode_locator == None) keeps the create-age tripwire: the
        // topology itself is broken and must stay loud.
        let (events, _guard) = capture::capture();
        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-noloc",
            "opencode",
            TerminalRunStatus::Running,
            0,
            None,
        )];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            i64::MAX,
            None,
            &ledger,
        );

        let warnings = unresolved_warnings(&events.lock().unwrap());
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn opencode_row_with_resume_identity_still_skips_with_locator_present() {
        // The resume_session_id skip rule is unchanged by the new gate.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("resume-skip");
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-resume",
            "opencode",
            TerminalRunStatus::Running,
            0,
            Some("ses_existing"),
        )];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            i64::MAX,
            Some(&locator),
            &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_probe_closes_the_late_row_and_db_error_hole() {
        // Plan-review R1 hole: the pane DID submit; its Enter-anchored window
        // closed empty; the row then landed LATE (or the window's read hit a
        // transient DB error that query_candidates swallows to empty) and the
        // TUI signal was lost (the rebind plugin marks `lastEmitted` BEFORE
        // its possibly-throwing write, so a lost signal never retries). The
        // probe must find the row per se: first pass past the create-age
        // grace LATCHES evidence (too fresh to warn); once the evidence ages
        // past the grace the alarm fires.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("late-row-hole");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-late", "opencode", true, None, Some("/proj"), 10_000));
        assert!(locator.note_submit("t-late", 10_100));
        let window_closed = 10_100 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(window_closed).is_empty(), "window saw nothing");
        insert_opencode_session(&db, "ses_late", "/proj", window_closed + 500);

        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-late",
            "opencode",
            TerminalRunStatus::Running,
            10_000,
            None,
        )];

        let probe_at = 10_000 + 61_000;
        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            probe_at,
            Some(&locator),
            &ledger,
        );
        assert!(
            unresolved_warnings(&events.lock().unwrap()).is_empty(),
            "evidence JUST latched: inside the grace, no warn yet"
        );
        assert_eq!(locator.identity_resolvable_since("t-late"), Some(probe_at));

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            probe_at + IDENTITY_RESOLUTION_GRACE_MS + 1,
            Some(&locator),
            &ledger,
        );
        let warnings = unresolved_warnings(&events.lock().unwrap());
        assert_eq!(
            warnings.len(),
            1,
            "resolvable-but-unbound must warn (R1 hole)"
        );
        assert_eq!(
            warnings[0].fields.get("terminal_id").map(String::as_str),
            Some("t-late")
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_probe_waits_for_the_create_age_grace_before_reading() {
        // Plan-review R2, finding 2: a pane still inside the create-age
        // grace never triggers the probe's DB read — rows that young are the
        // binding lanes' business; evidence arrives via the window latch.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("young-no-probe");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-young", "opencode", true, None, Some("/proj"), 10_000));
        assert!(locator.note_submit("t-young", 10_100));
        let window_closed = 10_100 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(window_closed).is_empty());
        insert_opencode_session(&db, "ses_late", "/proj", window_closed + 500);
        let scans_before = locator.db_scan_count();

        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-young",
            "opencode",
            TerminalRunStatus::Running,
            10_000,
            None,
        )];

        // Exactly AT the create-age boundary: not yet `> grace`, so no probe.
        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            10_000 + IDENTITY_RESOLUTION_GRACE_MS,
            Some(&locator),
            &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        assert_eq!(locator.identity_resolvable_since("t-young"), None);
        assert_eq!(
            locator.db_scan_count(),
            scans_before,
            "inside the create-age grace the sweep must not probe the DB"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_idle_pane_stays_silent_with_a_foreign_row_in_cwd() {
        // Never-submitted pane; somebody ELSE's unclaimed row exists in the
        // same cwd. The probe's never-submitted short-circuit runs BEFORE
        // any read: an idle pane has no session of its own, so nothing may
        // be attributed to it -- no evidence, no alarm, no DB read.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("idle-foreign-row");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-idle", "opencode", true, None, Some("/proj"), 0));
        insert_opencode_session(&db, "ses_foreign", "/proj", 5_000);

        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-idle",
            "opencode",
            TerminalRunStatus::Running,
            0,
            None,
        )];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            i64::MAX,
            Some(&locator),
            &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        assert_eq!(locator.identity_resolvable_since("t-idle"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_probe_never_latches_a_session_claimed_by_another_terminal() {
        // Two panes share a cwd; the row already belongs to the sibling.
        // The ws-side claim exclusion (identity registry, retired-inclusive)
        // must keep the probe from inventing evidence for this pane.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("claimed-row");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-pending", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-pending", 100));
        insert_opencode_session(&db, "ses_sibling", "/proj", 150);

        let identity = TerminalIdentityRegistry::new();
        identity.upsert(
            "t-sibling",
            Some("opencode"),
            Some("ses_sibling"),
            Some("/proj"),
            1,
        );
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-pending",
            "opencode",
            TerminalRunStatus::Running,
            0,
            None,
        )];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            i64::MAX,
            Some(&locator),
            &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        assert_eq!(locator.identity_resolvable_since("t-pending"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_probe_never_latches_a_freshagent_session() {
        // fresh-agent `opencode serve` rows land in the same opencode.db;
        // the kind:fresh-agent ledger row excludes them (mirrors the
        // association guards' `freshagent_ledger_row` refusal).
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("freshagent-row");
        let ledger_home = unique_opencode_home("freshagent-ledger");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-pending", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-pending", 100));
        insert_opencode_session(&db, "ses_freshagent", "/proj", 150);

        std::fs::create_dir_all(&ledger_home).unwrap();
        let ledger = crate::pane_ledger::PaneLedger::new(Some(ledger_home.clone()));
        ledger
            .record_fresh_agent_binding(&crate::pane_ledger::FreshAgentBindingWrite {
                provider: "opencode",
                session_id: "ses_freshagent",
                mode: "freshopencode",
                cwd: Some("/proj"),
                create_request_id: None,
                model: None,
                sandbox: None,
                permission_mode: None,
                effort: None,
                supersedes: None,
                now_ms: 1,
            })
            .expect("seed fresh-agent ledger row");

        let identity = TerminalIdentityRegistry::new();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-pending",
            "opencode",
            TerminalRunStatus::Running,
            0,
            None,
        )];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            i64::MAX,
            Some(&locator),
            &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        assert_eq!(locator.identity_resolvable_since("t-pending"), None);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ledger_home);
    }
}
