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
//! grace, the sweep's async probe phase (the late-row / swallowed-DB-error
//! hole): the pure warn pass QUEUES such panes (via the locator's
//! `probe_eligible` gate — a never-submitted pane is never queued, delta
//! repair 4), and the phase runs the locator's bounded candidate read and
//! then applies every availability
//! exclusion against CURRENT async state — `fresh_opencode.has_live_session`
//! included (as the phase's injected per-candidate live check, delta repair
//! 3), consulted AFTER the read precisely because a live-set snapshot taken
//! BEFORE the read is stale by probe time (delta repair 2). A fresh
//! opencode pane with neither has nothing resolvable and is never alarmed.
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
/// from an evaluated correlation window or from the sweep's async probe
/// phase for ever-submitted panes (the late-row / swallowed-DB-error hole):
/// the moment an in-cwd correlatable row provably existed yet never bound.
/// The phase's ORDERING is load-bearing (delta repair 2): the locator's
/// bounded DB read runs FIRST, then every availability exclusion —
/// identity registry (retired-inclusive), fresh-agent ledger rows, and
/// `fresh_opencode.has_live_session` — is applied against CURRENT async
/// state, never against a pre-read snapshot (a materializing fresh-opencode
/// session keys the live sessions map BEFORE its awaited ledger write, and
/// the opencode serve row exists before both, so a pre-read snapshot blinds
/// the probe to exactly the sessions it must exclude — the focused-round-2
/// finding). The accepted residual is the microseconds-scale interleave in
/// which the serve-side row exists but `handle_send` has not keyed the
/// live map (or ledgered) yet — nothing local can see that session yet at
/// any check ordering. When the locator is unavailable at boot, opencode
/// keeps the create-age tripwire so a broken topology still alarms.
/// A rarer residual is deliberate: a fresh opencode pane that never ARMS
/// (create carried no resolvable cwd) neither latches nor probes, so it
/// stays alarm-silent while the locator is present — no row can ever be
/// attributed to it, and the TUI signal lane covers its identity.
/// (Previously derived from the deleted amplifier locator's
/// AMPLIFIER_DIR_APPEAR_WINDOW_MS; the alarm also previously rode the
/// amplifier locator sweep's 150ms ticker and silently never ran when no
/// provider home existed — it now owns its sweep unconditionally.)
pub(crate) const IDENTITY_RESOLUTION_GRACE_MS: i64 = 10_000;

/// Own sweep for the terminal_identity_unresolved alarm (re-homed off the
/// deleted amplifier locator sweep, kata qmpk). Spawned UNCONDITIONALLY at
/// boot — the old home only ran `if amplifier_locator.is_some()`, so a
/// missing provider home silently disabled the alarm for every provider.
///
/// Per tick: the PURE warn pass (no SQLite reads; the registry walk runs on
/// the blocking pool, the `drain_and_associate` precedent) returns the
/// updated warned-set plus the "probe-wanted" queue — opencode panes past
/// the create-age grace with no latched evidence that are probe-eligible
/// (`OpencodeLocator::probe_eligible`: armed, ever-submitted, unthrottled —
/// a never-submitted pane is never queued, delta repair 4). The sweep then
/// runs [`opencode_probe_phase`] in the SAME tick, BEFORE the next ticker, so
/// the phase's availability exclusions (including the awaited
/// `fresh_opencode.has_live_session`) consult CURRENT live state AFTER the
/// locator's DB read — a pre-pass live snapshot is stale by probe time
/// (delta repair 2: `handle_send` materialization keys the live sessions
/// map mid-tick).
pub fn spawn_identity_invariant_sweep(state: crate::WsState, interval: std::time::Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // Once-per-terminal bound, sweep-task-lifetime scoped.
        let mut identity_warned = std::collections::HashSet::new();
        loop {
            ticker.tick().await;
            let pass_state = state.clone(); // WsState: Clone; Arc-backed fields
            let mut warned = std::mem::take(&mut identity_warned);
            let (warned_back, probe_wanted) = match tokio::task::spawn_blocking(move || {
                let wanted = warn_unresolved_terminal_identities(
                    &pass_state.registry.identity_probe_rows(),
                    &pass_state.identity,
                    &mut warned,
                    crate::terminal::now_ms(),
                    pass_state.opencode_locator.as_deref(),
                );
                (warned, wanted)
            })
            .await
            {
                Ok(outcome) => outcome,
                Err(join_error) => {
                    // A pass panicked — a bug, not a routine condition. Skip
                    // the WHOLE cycle (warn pass AND probe phase — the pass's
                    // outputs are kept atomic) and continue with a FRESH
                    // warned set (bounded re-warn noise beats silently losing
                    // the sweep; mirrors the locator tick panic handling).
                    // The dropped probe-wanted vec is simply re-collected
                    // next cycle.
                    tracing::warn!(
                        error = %join_error,
                        "identity_invariant_sweep_pass_panicked: skip this cycle; warned-set reset \
                         (terminals may re-warn once) and probe-wanted dropped (re-collected next \
                         cycle)"
                    );
                    (std::collections::HashSet::new(), Vec::new())
                }
            };
            identity_warned = warned_back;
            if !probe_wanted.is_empty() {
                // Production wiring of the phase's injected per-candidate
                // live check (delta repair 3): delegate to
                // `fresh_opencode.has_live_session` — awaited per candidate
                // AFTER the phase's DB read, against CURRENT live state.
                let fresh_opencode = &state.fresh_opencode;
                let mut live_check = move |session_id: String| async move {
                    fresh_opencode.has_live_session(&session_id).await
                };
                opencode_probe_phase(&state, probe_wanted, &mut live_check).await;
            }
        }
    });
}

/// One sweep pass: WARN (once per terminal, tracked in `warned`) for every
/// RUNNING non-shell terminal whose identity is past its provider's overdue
/// window with no resolvable identity in either identity home, and return
/// the "probe-wanted" queue — opencode terminals past the create-age grace
/// with NO latched resolvability evidence that are probe-eligible
/// (`OpencodeLocator::probe_eligible`: armed, ever-submitted, unthrottled —
/// a never-submitted idle pane is never queued, delta repair 4). Exited
/// terminals are skipped (their identity story is over); shell terminals
/// never carry session identity by design. opencode rows are gated on
/// locator RESOLVABILITY evidence (see the grace-constant doc): window-latch
/// first, probe queue
/// for the late-row/DB-error hole (plan-review R1); a pane with neither has
/// nothing resolvable and is never alarmed (issue #702).
///
/// A PURE DECISION function again (delta repair 2): it performs NO SQLite
/// reads and never latches evidence — both moved to the sweep's async
/// [`opencode_probe_phase`], which applies the availability exclusions
/// (identity registry retired-inclusive, fresh-agent pane-ledger rows, and
/// LIVE fresh-opencode sessions via `has_live_session`) against CURRENT
/// state AFTER the locator's bounded read. The previous in-line probe ran
/// its live-session check against a snapshot captured BEFORE the read —
/// blind to a fresh-opencode session that materialized in between (the
/// focused-round-2 finding).
pub(crate) fn warn_unresolved_terminal_identities(
    rows: &[IdentityProbeRow],
    identity: &TerminalIdentityRegistry,
    warned: &mut HashSet<String>,
    now_ms: i64,
    opencode_locator: Option<&freshell_sessions::opencode_locator::OpencodeLocator>,
) -> Vec<String> {
    // The probe-wanted queue (opencode latch-miss panes past the create-age
    // grace), in row order; consumed by `opencode_probe_phase`.
    let mut probe_wanted = Vec::new();
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
                Some(locator) => match locator.identity_resolvable_since(&row.terminal_id) {
                    Some(since_ms) => now_ms - since_ms,
                    // Latch-miss: nothing resolvable is known for this pane.
                    // Once it is past the create-age grace (R2 finding 2 —
                    // young panes are the binding lanes' business; never
                    // probe them), queue it for the sweep's async probe
                    // phase — but only when the pane is probe-eligible
                    // (delta repair 4: armed, unlatched, ever-submitted,
                    // unthrottled), so a never-submitted idle pane never
                    // enters the queue at all; never warn inline.
                    None => {
                        if now_ms - row.created_at > IDENTITY_RESOLUTION_GRACE_MS
                            && locator.probe_eligible(&row.terminal_id, now_ms)
                        {
                            probe_wanted.push(row.terminal_id.clone());
                        }
                        continue;
                    }
                },
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
    probe_wanted
}

/// The async probe phase of the opencode identity gate (delta repairs 2
/// and 3), run by the sweep in the SAME tick as the warn pass that queued
/// `probe_wanted`. Per terminal: the locator's bounded
/// [`freshell_sessions::opencode_locator::OpencodeLocator::probe_candidates`]
/// read runs on the blocking pool (the `drain_and_associate` precedent; a
/// panicking probe task is a bug, warn-logged as
/// `identity_invariant_probe_panicked` and skipped for this cycle), then
/// EVERY candidate is filtered through the full availability exclusion set
/// against CURRENT async state: the identity registry (retired-inclusive),
/// fresh-agent pane-ledger rows, and the injected per-candidate
/// `live_check` — awaited AFTER the DB read, once per candidate, so a
/// fresh-opencode session that materialized mid-tick (its `ses_*` row
/// visible to the read, its ledger write still pending) is excluded by its
/// live-map key — the exact gap a pre-read snapshot could not close.
/// Production wires `live_check` to
/// `state.fresh_opencode.has_live_session(...)`; the parameter is INJECTED
/// (delta repair 3) so the phase's check-per-candidate-after-the-read
/// ORDER is a contractual, test-exercisable property of the phase itself,
/// not an incidental detail of how it reached live state. Any surviving
/// candidate means an unbound correlatable row provably exists: latch the
/// pane's resolvable evidence via
/// [`freshell_sessions::opencode_locator::OpencodeLocator::note_resolvable_evidence`]
/// (first-evidence-wins; dropped when the pane disarmed mid-flight).
pub(crate) async fn opencode_probe_phase<F, Fut>(
    state: &crate::WsState,
    probe_wanted: Vec<String>,
    live_check: &mut F,
) where
    F: FnMut(String) -> Fut + Send,
    Fut: std::future::Future<Output = bool> + Send,
{
    let Some(locator) = state.opencode_locator.clone() else {
        return;
    };
    for terminal_id in probe_wanted {
        let probe_locator = std::sync::Arc::clone(&locator);
        let probe_terminal_id = terminal_id.clone();
        let candidates = match tokio::task::spawn_blocking(move || {
            probe_locator.probe_candidates(&probe_terminal_id)
        })
        .await
        {
            Ok(candidates) => candidates,
            Err(join_error) => {
                tracing::warn!(
                    error = %join_error,
                    terminal_id = %terminal_id,
                    "identity_invariant_probe_panicked: probe task panicked, skipping this \
                     terminal this cycle (re-queued next tick)"
                );
                continue;
            }
        };
        // `None`: unarmed / never submitted / throttled / disarmed mid-probe
        // (zero reads for the first three) — nothing to do for this pane.
        let Some(candidates) = candidates else {
            continue;
        };
        let mut any_resolvable = false;
        for session_id in candidates {
            // ORDER IS LOAD-BEARING (delta repair 3): every exclusion runs
            // against state visible AFTER `probe_candidates` returned, and
            // the live check is consulted per candidate — never a pre-read
            // live-set snapshot (a `handle_send` materialization between a
            // snapshot and this loop is invisible to the snapshot but seen
            // here).
            let excluded = state
                .identity
                .find_by_session_including_retired("opencode", &session_id)
                .is_some()
                || state
                    .pane_ledger
                    .lookup_by_session("opencode", &session_id)
                    .is_some_and(|r| r.row.pane_kind.as_deref() == Some("fresh-agent"))
                || live_check(session_id.clone()).await;
            if !excluded {
                any_resolvable = true;
                break;
            }
        }
        if any_resolvable {
            locator.note_resolvable_evidence(&terminal_id, crate::terminal::now_ms());
        }
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
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-lost",
            "amplifier",
            TerminalRunStatus::Running,
            1_000,
            None,
        )];
        let now = 1_000 + IDENTITY_RESOLUTION_GRACE_MS + 1;

        let wanted =
            super::warn_unresolved_terminal_identities(&rows, &identity, &mut warned, now, None);
        // Bounded: a second sweep must NOT warn again for the same terminal.
        let wanted_again = super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            now + 5_000,
            None,
        );

        assert!(
            wanted.is_empty() && wanted_again.is_empty(),
            "the probe-wanted queue is opencode-only"
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
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-young",
            "amplifier",
            TerminalRunStatus::Running,
            1_000,
            None,
        )];

        let wanted = super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            1_000 + IDENTITY_RESOLUTION_GRACE_MS,
            None,
        );

        assert!(wanted.is_empty());
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

        let wanted = super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            i64::MAX,
            None,
        );

        assert!(wanted.is_empty());
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

        let wanted = super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            i64::MAX,
            None,
        );

        assert!(wanted.is_empty());
        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
    }

    #[test]
    fn opencode_idle_pane_past_create_age_grace_stays_silent_and_unqueued() {
        // danshapiro/freshell#702, delta repair 4: a fresh opencode pane
        // whose user has not submitted a prompt has NO session row anywhere
        // (opencode creates it lazily at first prompt) -- nothing is
        // resolvable, and the old create-age gate false-fired on 100% of
        // real usage (61s+ to first prompt in the incident timeline). With a
        // live locator holding no candidate evidence, age alone must never
        // warn -- AND the pane must never enter the probe-wanted queue
        // (`probe_eligible`: never-submitted panes can yield no candidates,
        // so queuing them was a per-sweep spawn_blocking round-trip that
        // could only ever return None).
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("idle");
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        // The production shape: create+arm, NO submit, spawn window closes empty.
        assert!(locator.arm("t-idle", "opencode", true, None, Some("/proj"), 10_000));
        let _ =
            locator.tick(10_000 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 500);
        let identity = TerminalIdentityRegistry::new();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-idle",
            "opencode",
            TerminalRunStatus::Running,
            10_000,
            None,
        )];

        // The every-sweep shape (the defect was queueing EVERY 2s sweep
        // forever): two consecutive passes, both silent and empty-handed.
        for now in [10_000 + 61_000, 10_000 + 63_000] {
            // +61s in the incident timeline: first prompt arrived long past
            // the grace on real panes.
            let wanted = super::warn_unresolved_terminal_identities(
                &rows,
                &identity,
                &mut warned,
                now,
                Some(&locator),
            );
            assert!(
                wanted.is_empty(),
                "a never-submitted pane is never queued for probing; wanted: {wanted:?}"
            );
        }

        assert!(
            unresolved_warnings(&events.lock().unwrap()).is_empty(),
            "no evidence == nothing resolvable == no warn (#702)"
        );
        assert!(warned.is_empty());
        assert_eq!(locator.identity_resolvable_since("t-idle"), None);
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
        let mut warned = HashSet::new();
        let rows = vec![row("t-ev", "opencode", TerminalRunStatus::Running, 0, None)];

        let wanted = super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            evidence_at + IDENTITY_RESOLUTION_GRACE_MS + 1,
            Some(&locator),
        );

        assert!(
            wanted.is_empty(),
            "a pane with latched evidence is never queued for probing"
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
        let mut warned = HashSet::new();
        let rows = vec![row("t-ev", "opencode", TerminalRunStatus::Running, 0, None)];

        let wanted = super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            evidence_at + IDENTITY_RESOLUTION_GRACE_MS, // boundary: not yet overdue
            Some(&locator),
        );

        assert!(wanted.is_empty());
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
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-bound",
            "opencode",
            TerminalRunStatus::Running,
            0,
            None,
        )];

        let wanted = super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            i64::MAX,
            Some(&locator),
        );

        assert!(wanted.is_empty());
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
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-noloc",
            "opencode",
            TerminalRunStatus::Running,
            0,
            None,
        )];

        let wanted = super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            i64::MAX,
            None,
        );

        assert!(wanted.is_empty(), "no locator, no probe phase");
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
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-resume",
            "opencode",
            TerminalRunStatus::Running,
            0,
            Some("ses_existing"),
        )];

        let wanted = super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            i64::MAX,
            Some(&locator),
        );

        assert!(wanted.is_empty());
        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_latch_miss_past_the_create_age_grace_requests_a_probe() {
        // Plan-review R1 hole: the pane DID submit; its Enter-anchored window
        // closed empty; the row then landed LATE (or the window's read hit a
        // transient DB error that query_candidates swallows to empty) and the
        // TUI signal was lost (the rebind plugin marks `lastEmitted` BEFORE
        // its possibly-throwing write, so a lost signal never retries). The
        // pass is a pure decision again (delta repair 2): it must NOT read
        // the DB or latch inline — it queues the pane for the sweep's async
        // probe phase (covered end-to-end in
        // `probe_phase_closes_the_late_row_hole_and_the_next_pass_warns`).
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("late-row-hole");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-late", "opencode", true, None, Some("/proj"), 10_000));
        assert!(locator.note_submit("t-late", 10_100));
        let window_closed = 10_100 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(window_closed).is_empty(), "window saw nothing");
        insert_opencode_session(&db, "ses_late", "/proj", window_closed + 500);
        let scans_before = locator.db_scan_count();

        let identity = TerminalIdentityRegistry::new();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-late",
            "opencode",
            TerminalRunStatus::Running,
            10_000,
            None,
        )];

        let probe_at = 10_000 + 61_000;
        let wanted = super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            probe_at,
            Some(&locator),
        );

        assert_eq!(wanted, vec!["t-late".to_string()]);
        assert!(
            unresolved_warnings(&events.lock().unwrap()).is_empty(),
            "nothing latched yet: no warn"
        );
        assert_eq!(
            locator.identity_resolvable_since("t-late"),
            None,
            "the pure pass never latches — latching is the probe phase's write"
        );
        assert_eq!(
            locator.db_scan_count(),
            scans_before,
            "the pure pass never reads the DB"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_probe_not_wanted_before_the_create_age_boundary() {
        // Plan-review R2, finding 2: a pane still inside the create-age
        // grace is the binding lanes' business; never queue a probe for it
        // (evidence arrives via the window latch instead).
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
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-young",
            "opencode",
            TerminalRunStatus::Running,
            10_000,
            None,
        )];

        // Exactly AT the create-age boundary: not yet `> grace`, so no probe.
        let wanted = super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            10_000 + IDENTITY_RESOLUTION_GRACE_MS,
            Some(&locator),
        );

        assert!(wanted.is_empty());
        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        assert_eq!(locator.identity_resolvable_since("t-young"), None);
        assert_eq!(
            locator.db_scan_count(),
            scans_before,
            "inside the create-age grace the sweep must not probe the DB"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // ── The async probe phase (delta repairs 2 and 3) ──────────────────
    //
    // These tests drive `opencode_probe_phase` directly against a full
    // `WsState` (fixtures mirror `opencode_association.rs`'s
    // `state_with_locator*` patterns). The phase's ordering guarantee: the
    // locator's bounded DB read runs first, then EVERY availability
    // exclusion is applied against CURRENT async state — the identity
    // registry (retired-inclusive), the fresh-agent pane-ledger rows, and
    // the per-candidate live check, the last one AFTER the read by
    // construction, which is what closes the stale-snapshot hole. The live
    // check is INJECTED (delta repair 3) so its call ORDER and per-
    // candidate currency are exercisable without touching
    // `FreshOpencodeState` internals. The first (sync) test pins the queue
    // GATE instead (delta repair 4): a never-submitted pane never even
    // REACHES the phase.

    /// Full-`WsState` fixture with a real opencode locator rooted at
    /// `data_home` (mirrors `opencode_association.rs`'s `state_with_locator`,
    /// minus the broadcast receiver these tests never consume).
    fn state_with_locator(data_home: std::path::PathBuf) -> crate::WsState {
        let auth_token = std::sync::Arc::new("s3cr3t-token-abcdef".to_string());
        let broadcast_tx = std::sync::Arc::new(tokio::sync::broadcast::channel::<String>(16).0);
        crate::WsState {
            pane_ledger: std::sync::Arc::new(crate::pane_ledger::PaneLedger::disabled()),
            layout: Default::default(),
            identity: TerminalIdentityRegistry::new(),
            terminal_meta: Default::default(),
            auth_token: std::sync::Arc::clone(&auth_token),
            server_instance_id: std::sync::Arc::new("srv-1111".to_string()),
            boot_id: std::sync::Arc::new("boot-2222".to_string()),
            settings: std::sync::Arc::new(crate::test_settings()),
            handshake_settings: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::test_settings(),
            )),
            broadcast_tx: std::sync::Arc::clone(&broadcast_tx),
            auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
            auto_resume_cancels: Default::default(),
            fresh_codex: freshell_freshagent::FreshCodexState::new(
                std::sync::Arc::clone(&auth_token),
                std::sync::Arc::clone(&broadcast_tx),
                serde_json::json!({ "freshAgent": { "enabled": false } }),
            ),
            fresh_claude: freshell_freshagent::FreshClaudeState::new(std::sync::Arc::clone(
                &broadcast_tx,
            )),
            fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
                freshell_freshagent::FreshAgentState::new(
                    auth_token,
                    std::sync::Arc::clone(&broadcast_tx),
                ),
            ),
            registry: freshell_terminal::TerminalRegistry::new(),
            shutdown: std::sync::Arc::new(tokio::sync::Notify::new()),
            tabs: crate::tabs::TabsRegistry::new(),
            screenshots: crate::screenshot::ScreenshotBroker::new(broadcast_tx),
            subagent_interest: Default::default(),
            host_stats: Default::default(),
            terminals_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            sessions_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            cli_commands: std::sync::Arc::new(Vec::new()),
            ping_interval_ms: 30_000,
            hello_timeout_ms: 5_000,
            allowed_origins: std::sync::Arc::new(crate::origin::default_allowed_origins()),
            ws_max_payload_bytes: 16 * 1024 * 1024,
            term09: crate::backpressure::Term09Config::default(),
            create_protect: crate::create_limit::CreateProtectConfig::default(),
            spawn_gate: std::sync::Arc::new(crate::spawn_gate::SpawnGate::new(4, 64)),
            shutdown_started: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            create_dedupe: std::sync::Arc::new(crate::create_dedupe::CreateDedupe::default()),
            config_fallback: None,
            opencode_locator: Some(std::sync::Arc::new(
                freshell_sessions::opencode_locator::OpencodeLocator::new(data_home),
            )),
            codex_locator: None,
            activity: None,
            session_existence: std::sync::Arc::new(crate::existence::NoIndexProbe::default()),
            reconcile_deferral_budget_ms: crate::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
            fresh_agent_respawn_counts: Default::default(),
        }
    }

    /// Sibling of `state_with_locator` with a REAL (enabled) pane ledger
    /// rooted at `ledger_dir` (mirrors
    /// `opencode_association.rs::state_with_locator_and_ledger`).
    fn state_with_locator_and_ledger(
        data_home: std::path::PathBuf,
        ledger_dir: &std::path::Path,
    ) -> crate::WsState {
        let mut state = state_with_locator(data_home);
        state.pane_ledger = std::sync::Arc::new(crate::pane_ledger::PaneLedger::new(Some(
            ledger_dir.to_path_buf(),
        )));
        state
    }

    /// The production live check, constructed from the real fixture state
    /// exactly as the sweep wires it: per candidate, delegate to
    /// `state.fresh_opencode.has_live_session(...)`. Boxed so the returned
    /// closure has a nameable future type.
    fn production_live_check<'a>(
        state: &'a crate::WsState,
    ) -> impl FnMut(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>>
           + Send
           + 'a {
        let fresh_opencode = &state.fresh_opencode;
        move |session_id: String| {
            Box::pin(async move { fresh_opencode.has_live_session(&session_id).await })
                as std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>>
        }
    }

    #[tokio::test]
    async fn probe_phase_closes_the_late_row_hole_and_the_next_pass_warns() {
        // Plan-review R1 hole, end-to-end through the new boundary (delta
        // repair 2): the pane DID submit; its Enter-anchored window closed
        // empty; the row landed LATE (or the window's read hit a transient
        // DB error that query_candidates swallows to empty) and the TUI
        // signal was lost. The pure pass requests the probe; the phase
        // latches evidence; once the evidence ages past the grace the
        // alarm fires exactly once.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("phase-late-row");
        let db = seed_opencode_db(&home);
        let state = state_with_locator(home.clone());
        let locator = std::sync::Arc::clone(state.opencode_locator.as_ref().unwrap());
        assert!(locator.arm("t-late", "opencode", true, None, Some("/proj"), 10_000));
        assert!(locator.note_submit("t-late", 10_100));
        let window_closed = 10_100 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(window_closed).is_empty(), "window saw nothing");
        insert_opencode_session(&db, "ses_late", "/proj", window_closed + 500);

        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-late",
            "opencode",
            TerminalRunStatus::Running,
            10_000,
            None,
        )];

        let probe_at = 10_000 + 61_000;
        let wanted = super::warn_unresolved_terminal_identities(
            &rows,
            &state.identity,
            &mut warned,
            probe_at,
            state.opencode_locator.as_deref(),
        );
        assert_eq!(wanted, vec!["t-late".to_string()]);
        assert!(
            unresolved_warnings(&events.lock().unwrap()).is_empty(),
            "nothing latched yet: no warn"
        );
        assert_eq!(locator.identity_resolvable_since("t-late"), None);

        // The async probe phase latches the late, surviving row (checked
        // against CURRENT live/ledger/identity state AFTER the DB read).
        let mut live_check = production_live_check(&state);
        super::opencode_probe_phase(&state, wanted, &mut live_check).await;
        let latched = locator
            .identity_resolvable_since("t-late")
            .expect("the phase latches the surviving late row as evidence");

        // Once that evidence ages past the grace, the alarm fires exactly once.
        let wanted_after = super::warn_unresolved_terminal_identities(
            &rows,
            &state.identity,
            &mut warned,
            latched + IDENTITY_RESOLUTION_GRACE_MS + 1,
            state.opencode_locator.as_deref(),
        );
        assert!(
            wanted_after.is_empty(),
            "a latched pane is never re-queued for probing"
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
    fn idle_never_submitted_pane_is_never_queued_for_probing() {
        // Delta repair 4 — the queue-shape pin for the #702 false-fire
        // class. A fresh pane whose user has not submitted a prompt has NO
        // session row anywhere (opencode writes it lazily at first prompt).
        // Even with a FOREIGN row sitting in the pane's cwd, nothing is
        // attributable to the idle pane — so the pass must keep it OUT of
        // the probe-wanted queue entirely: queuing it cost a per-sweep
        // spawn_blocking round-trip forever while `probe_candidates` could
        // only ever answer None. The idle pane being ABSENT from the queue
        // is the stronger statement of the old "the phase latches nothing"
        // pin: it never even reaches the phase.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("phase-idle-foreign-row");
        let db = seed_opencode_db(&home);
        let state = state_with_locator(home.clone());
        let locator = std::sync::Arc::clone(state.opencode_locator.as_ref().unwrap());
        assert!(locator.arm("t-idle", "opencode", true, None, Some("/proj"), 0));
        insert_opencode_session(&db, "ses_foreign", "/proj", 5_000);

        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-idle",
            "opencode",
            TerminalRunStatus::Running,
            0,
            None,
        )];
        let wanted = super::warn_unresolved_terminal_identities(
            &rows,
            &state.identity,
            &mut warned,
            i64::MAX,
            state.opencode_locator.as_deref(),
        );

        assert!(
            wanted.is_empty(),
            "a never-submitted pane is never queued for probing; wanted: {wanted:?}"
        );
        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        assert_eq!(locator.identity_resolvable_since("t-idle"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn probe_phase_excludes_a_row_claimed_by_another_terminal() {
        // Two panes share a cwd; the row already belongs to the sibling. The
        // identity-registry claim exclusion (retired-inclusive) must keep the
        // phase from inventing evidence for this pane.
        let home = unique_opencode_home("phase-claimed-row");
        let db = seed_opencode_db(&home);
        let state = state_with_locator(home.clone());
        let locator = std::sync::Arc::clone(state.opencode_locator.as_ref().unwrap());
        assert!(locator.arm("t-pending", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-pending", 100));
        insert_opencode_session(&db, "ses_sibling", "/proj", 150);

        state.identity.upsert(
            "t-sibling",
            Some("opencode"),
            Some("ses_sibling"),
            Some("/proj"),
            1,
        );

        let mut live_check = production_live_check(&state);
        super::opencode_probe_phase(&state, vec!["t-pending".to_string()], &mut live_check).await;

        assert_eq!(
            locator.identity_resolvable_since("t-pending"),
            None,
            "a row claimed by another terminal is not this pane's evidence"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn probe_phase_excludes_a_fresh_agent_ledger_row() {
        // fresh-agent `opencode serve` rows land in the same opencode.db;
        // the kind:fresh-agent ledger row excludes them (mirrors the
        // association guards' `freshagent_ledger_row` refusal).
        let home = unique_opencode_home("phase-freshagent-row");
        let ledger_home = unique_opencode_home("phase-freshagent-ledger");
        let db = seed_opencode_db(&home);
        std::fs::create_dir_all(&ledger_home).unwrap();
        let state = state_with_locator_and_ledger(home.clone(), &ledger_home);
        let locator = std::sync::Arc::clone(state.opencode_locator.as_ref().unwrap());
        assert!(locator.arm("t-pending", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-pending", 100));
        insert_opencode_session(&db, "ses_freshagent", "/proj", 150);

        state
            .pane_ledger
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

        let mut live_check = production_live_check(&state);
        super::opencode_probe_phase(&state, vec!["t-pending".to_string()], &mut live_check).await;

        assert_eq!(
            locator.identity_resolvable_since("t-pending"),
            None,
            "a fresh-agent ledger row is excluded from evidence"
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ledger_home);
    }

    #[tokio::test]
    async fn probe_phase_checks_each_candidate_against_post_read_live_state() {
        // DELTA REPAIR 3 — the discriminating form of the round-2 finding.
        // What this test protects is the phase's CALL ORDER and the
        // per-candidate CURRENCY of its live check — not any
        // `FreshOpencodeState` internals (this test never touches a real
        // fresh-opencode state). The injected gate below models the
        // `handle_send` materialization timing from first principles:
        // nothing is live at seed time; the check's FIRST invocation IS
        // the materialization moment (both seeded rows become live), and
        // every candidate is reported live at its own check. Under the
        // correct post-read per-candidate shape, each candidate is
        // excluded by its own CURRENT check and no evidence latches.
        // Under the delta-repair-1 regression shape (a live-set snapshot
        // precomputed BEFORE the DB read, consulted after it) the snapshot
        // predates the materialization, BOTH candidates survive, and false
        // evidence latches — this test fails. Verified RED against exactly
        // that shape in the repair run; the failure was the latched
        // `identity_resolvable_since`, proving discrimination.
        let home = unique_opencode_home("phase-live-check-order");
        let db = seed_opencode_db(&home);
        let state = state_with_locator(home.clone()); // disabled ledger == the gap shape
        let locator = std::sync::Arc::clone(state.opencode_locator.as_ref().unwrap());
        assert!(locator.arm("t-pending", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-pending", 100));
        // TWO candidates for the same pane: the phase must ask about each.
        insert_opencode_session(&db, "ses_a", "/proj", 150);
        insert_opencode_session(&db, "ses_b", "/proj", 160);

        // The injected gate: invoked per candidate AFTER the DB read. It
        // does NOT consult any pre-seeded live map — its FIRST call
        // performs the "session becomes live" side effect (recording both
        // candidate ids) and reports live for every candidate thereafter,
        // which a pre-read snapshot can never observe.
        let mut invocations = 0u32;
        let mut became_live: Vec<String> = Vec::new();
        let mut live_check = |session_id: String| {
            invocations += 1;
            if became_live.is_empty() {
                became_live.push("ses_a".to_string());
                became_live.push("ses_b".to_string());
            }
            let live = became_live.contains(&session_id);
            async move { live }
        };

        super::opencode_probe_phase(&state, vec!["t-pending".to_string()], &mut live_check).await;

        assert_eq!(
            locator.identity_resolvable_since("t-pending"),
            None,
            "each candidate was live at its own post-read check: no evidence may latch"
        );
        assert!(
            invocations >= 2,
            "each candidate must get its OWN post-read live check; saw {invocations}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}
