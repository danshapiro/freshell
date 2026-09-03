//! Write-side pane-identity seam for the REST spawn pipeline (kata hbsa).
//!
//! `freshell-freshagent` cannot depend on `freshell-ws` (circular), so it
//! cannot write `TerminalIdentityRegistry` rows or `PaneLedger` bindings
//! directly — the exact gap that left REST claude panes un-resumable and
//! invisible to A13. This impl mirrors the WS create path's identity writes
//! (`terminal.rs` PIN2_CLAUDE_PRE_SPAWN_BINDING block, its failure-delete
//! twin, and the post-spawn identity/binding/pending block) behind the
//! `freshell_terminal::registry::PaneIdentityBinder` trait, wired into
//! `FreshAgentState` by `freshell-server::main` (the `SessionIdentityLookup`
//! precedent, read-side twin).
//!
//! Failure policy: ledger writes are best-effort — warn on the
//! `freshell_ws::invariants` target and proceed; a create is never blocked
//! by durability degradation. (The WS rung additionally broadcasts
//! `DurabilityDegraded` via `surface_write_failure`, which needs `&WsState`;
//! this seam has no `WsState`, and log-only is strictly better than the
//! nothing-at-all the REST lane wrote before.)

use std::sync::Arc;

use crate::identity::TerminalIdentityRegistry;
use crate::pane_ledger::{BindingWrite, PaneLedger};
use crate::terminal::now_ms;

/// Resume-target display classifier injected at construction (wraps
/// `OpencodeLocator::classify_resume_target`, Task 5): `Some(true)` = child
/// (subagent) session, `Some(false)` = definite root, `None` = unknown.
pub type ResumeTargetClassifier = Arc<dyn Fn(&str) -> Option<bool> + Send + Sync>;

pub struct LedgerPaneIdentityBinder {
    identity: TerminalIdentityRegistry,
    ledger: Arc<PaneLedger>,
    /// `None` when the opencode locator is disabled — REST-lane
    /// classification simply stays off (the seam's existing degradation
    /// policy). This seam has no `WsState`, so it cannot call
    /// `classify_and_mark_resume_target`; it gets the classifier injected
    /// instead.
    classify_resume_target: Option<ResumeTargetClassifier>,
}

impl LedgerPaneIdentityBinder {
    pub fn new(
        identity: TerminalIdentityRegistry,
        ledger: Arc<PaneLedger>,
        classify_resume_target: Option<ResumeTargetClassifier>,
    ) -> Self {
        Self {
            identity,
            ledger,
            classify_resume_target,
        }
    }

    fn warn_write_failure(terminal_id: &str, what: &str, err: &std::io::Error) {
        tracing::warn!(
            target: "freshell_ws::invariants",
            terminal_id = %terminal_id,
            error = %err,
            "pane_ledger_write_failed: {what} (REST rung; create proceeds, durability degraded)"
        );
    }
}

/// `PaneLedger`/`TerminalIdentityRegistry` internals are not `Debug`; the
/// trait's supertrait (matching `SessionIdentityLookup`) only needs the
/// object to be printable in `Debug`-derived state.
impl std::fmt::Debug for LedgerPaneIdentityBinder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LedgerPaneIdentityBinder")
    }
}

// The binder itself is plain sync: every PaneLedger writer is a sync
// `fn -> io::Result<()>` (pane_ledger.rs) and the identity registry is a
// sync RwLock (identity.rs). Async REST call sites hop the ledger-touching
// calls through spawn_blocking (Task 5), mirroring the WS create path's own
// idiom (terminal.rs PIN2_CLAUDE_PRE_SPAWN_BINDING block); the exit hook
// calls retire_pane_identity inline on the PTY reader thread, mirroring the
// WS exit hook's inline-sync retire (terminal.rs build_pty_exit_hook).
impl freshell_terminal::registry::PaneIdentityBinder for LedgerPaneIdentityBinder {
    fn record_prespawn_claude_binding(
        &self,
        session_id: &str,
        terminal_id: &str,
        mode: &str,
        cwd: Option<&str>,
        create_request_id: Option<&str>,
    ) {
        if let Err(err) = self.ledger.record_binding(&BindingWrite {
            provider: "claude",
            session_id,
            terminal_id,
            mode,
            cwd,
            create_request_id,
            // D8 (restore-open-sessions-only): REST/headless rows stamp NO
            // provenance — there is no browser connection to attribute at bind
            // time, and rows without attribution are never offered by the
            // recovery ledger-only judgment (`recovery_inventory.rs`).
            // Delta-r2 Finding 2: `Clear` (not merely no-stamps) — a headless
            // re-bind of a browser-stamped row must ERASE the stale browser
            // attribution instead of inheriting it under a refreshed
            // `updated_at`.
            provenance: crate::pane_ledger::ProvenancePolicy::Clear,
            attributed_at: None,
            now_ms: now_ms(),
        }) {
            Self::warn_write_failure(terminal_id, "pre-spawn claude binding (PIN 2)", &err);
        }
    }

    fn delete_prespawn_claude_binding(&self, session_id: &str) {
        if let Err(err) = self.ledger.delete_binding("claude", session_id) {
            Self::warn_write_failure("(spawn-failed)", "pre-spawn binding failure-delete", &err);
        }
    }

    fn register_create_identity(
        &self,
        terminal_id: &str,
        mode: &str,
        resume_session_id: Option<&str>,
        cwd: Option<&str>,
        create_request_id: Option<&str>,
    ) {
        // Mirrors terminal.rs's post-spawn block (the DEV-0008 create-time
        // slice): identity row + binding for any non-shell create carrying a
        // session id (terminal_meta_record_for_create semantics --
        // identity.upsert + record_binding), pending marker for the
        // identity-in-flight providers (the MARKER_MODES/record_pending arm),
        // substituting self.identity / self.ledger and warn_write_failure for
        // surface_write_failure, and dropping the spawn_blocking wrappers
        // (the async hop lives at the Task 5 call sites, not here).
        if mode == "shell" {
            return;
        }
        if let Some(session_id) = resume_session_id.filter(|s| !s.is_empty()) {
            self.identity
                .upsert(terminal_id, Some(mode), Some(session_id), cwd, now_ms());
            // Bug-1 (sidebar rail): classify the REST resume target. This call
            // site already runs inside the caller's spawn_blocking
            // (terminal_tabs.rs:1973), so the one-row SQLite read is off the
            // async path. Log-only on error / no ping — this seam has no
            // WsState (matching its existing degradation policy); the flag is
            // set before the create response returns, ahead of any client
            // refetch.
            if mode == "opencode" {
                if let Some(classify) = self.classify_resume_target.as_ref() {
                    if let Some(value) = classify(session_id) {
                        self.identity.set_is_subagent(terminal_id, Some(value));
                    }
                }
            }
            if let Err(err) = self.ledger.record_binding(&BindingWrite {
                provider: mode, // keep exactly what the WS block does (provider = mode)
                session_id,
                terminal_id,
                mode,
                cwd,
                create_request_id,
                // D8: REST/headless lineage rows stay UNATTRIBUTED by design
                // (no browser connection exists here) — unlike the WS create
                // lane, which stamps from the connection identity + `tabId`.
                // Delta-r2 Finding 2: `Clear` makes that an ERASE of any
                // earlier browser stamps, never an inherit-forever.
                provenance: crate::pane_ledger::ProvenancePolicy::Clear,
                attributed_at: None,
                now_ms: now_ms(),
            }) {
                Self::warn_write_failure(terminal_id, "post-spawn identity binding", &err);
            }
        } else if crate::terminal::MARKER_MODES.contains(&mode) {
            // The pending-marker arm (terminal.rs:2523-2540): identity-bearing
            // pane whose identity is still in flight (fresh codex/opencode/
            // amplifier -- trigger d): a durable pending marker from spawn
            // until resolution deletes it (binding-first order).
            // Delta-r3 Finding 2: NO provenance stamps here — this lane is
            // explicitly HEADLESS (no browser connection exists at create
            // time, exactly its binding-write `Clear` policy), so a later
            // locator/signal resolution of this marker still ends
            // unattributed and the D8 judgment correctly never offers it.
            if let Err(err) = self.ledger.record_pending(
                terminal_id,
                mode,
                cwd,
                crate::pane_ledger::ProvenanceStamps::default(),
                now_ms(),
            ) {
                Self::warn_write_failure(terminal_id, "spawn-time pending marker", &err);
            }
        }
    }

    fn retire_pane_identity(&self, terminal_id: &str) {
        // The WS pane EXIT hook ONLY (terminal.rs:1334-1342) -- identity
        // retire + pending-marker delete, both called directly (sync). Do
        // NOT port `retire_closed` from the kill path (handle_kill): that is
        // the explicit-user-close trigger (P1.8 trigger (e)); a natural exit
        // or crash must leave the ledger binding Bound, exactly like a WS
        // pane, so auto_resume::pre_respawn_guard (auto_resume.rs:445-450)
        // and the recovery inventory (RetiredReason::Closed keying,
        // recovery_inventory.rs:299-301) still read the row correctly.
        // This method MUST stay runtime-free: production calls it from the
        // PTY reader thread's exit hook, where blocking IO is safe and tokio
        // does not exist. The identity retire is an in-memory flag flip;
        // this method changes NO drain logic (the #573/#578-pinned drains
        // stay untouched).
        self.identity.retire(terminal_id);
        if let Err(err) = self.ledger.delete_pending(terminal_id) {
            Self::warn_write_failure(terminal_id, "pending-marker delete on exit", &err);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pane_ledger::{PaneLedger, RowState};
    use std::sync::Arc;

    fn temp_root(label: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "pane-identity-binder-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp root");
        dir
    }

    #[allow(clippy::type_complexity)]
    fn binder(
        label: &str,
    ) -> (
        LedgerPaneIdentityBinder,
        Arc<PaneLedger>,
        crate::identity::TerminalIdentityRegistry,
        std::path::PathBuf,
    ) {
        let dir = temp_root(label);
        let ledger = Arc::new(PaneLedger::new(Some(dir.clone())));
        let identity = crate::identity::TerminalIdentityRegistry::default();
        (
            LedgerPaneIdentityBinder::new(identity.clone(), Arc::clone(&ledger), None),
            ledger,
            identity,
            dir,
        )
    }

    const SID: &str = "29a53649-1111-4222-8333-444455556666";

    #[test]
    fn prespawn_binding_writes_a_bound_claude_row_and_delete_removes_it() {
        use freshell_terminal::registry::PaneIdentityBinder as _;
        let (b, ledger, _identity, dir) = binder("prespawn");
        b.record_prespawn_claude_binding(SID, "t-rest-1", "claude", Some("/tmp"), Some("req-1"));
        let row = ledger
            .load_binding("claude", SID)
            .expect("pre-spawn row exists (PIN 2)");
        assert_eq!(row.live_terminal_id.as_deref(), Some("t-rest-1"));
        assert_eq!(row.state, RowState::Bound);

        b.delete_prespawn_claude_binding(SID);
        assert!(
            ledger.load_binding("claude", SID).is_none(),
            "failure-delete removes the row"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn register_create_identity_writes_identity_row_and_binding() {
        use freshell_terminal::registry::PaneIdentityBinder as _;
        let (b, ledger, identity, dir) = binder("register");
        b.register_create_identity("t-rest-2", "claude", Some(SID), Some("/tmp"), Some("req-2"));
        let row = identity
            .get("t-rest-2")
            .expect("identity row (the A13/signal-drain prerequisite)");
        assert_eq!(row.provider.as_deref(), Some("claude"));
        assert_eq!(row.session_id.as_deref(), Some(SID));
        let binding = ledger
            .load_binding("claude", SID)
            .expect("post-spawn binding row");
        assert_eq!(binding.live_terminal_id.as_deref(), Some("t-rest-2"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn register_create_identity_classifies_opencode_resume_targets() {
        use freshell_terminal::registry::PaneIdentityBinder as _;
        // Build the binder as in `binder(...)` but pass a classifier wrapping
        // Task 5's classify_resume_target over a temp data home seeded with
        // ses_root (parent_id NULL) and ses_child (parent_id = 'ses_root') —
        // the same rusqlite temp-db seeding idiom as Task 5's tests.
        let dir = temp_root("classify");
        let data_home = dir.join("opencode-data");
        std::fs::create_dir_all(&data_home).unwrap();
        {
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
            for (id, parent_id) in [("ses_root", None), ("ses_child", Some("ses_root"))] {
                conn.execute(
                    "INSERT INTO project (id, worktree) VALUES (?1, ?2)",
                    rusqlite::params![format!("proj-{id}"), "/tmp"],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO session
                        (id, project_id, parent_id, slug, directory, title, version,
                         time_created, time_updated, time_archived)
                     VALUES (?1, ?2, ?3, ?1, '/tmp', ?1, 'test', 100, 100, NULL)",
                    rusqlite::params![id, format!("proj-{id}"), parent_id],
                )
                .unwrap();
            }
        }
        let ledger = Arc::new(PaneLedger::new(Some(dir.clone())));
        let identity = crate::identity::TerminalIdentityRegistry::default();
        let locator = Arc::new(freshell_sessions::opencode_locator::OpencodeLocator::new(
            data_home,
        ));
        let classifier: ResumeTargetClassifier =
            Arc::new(move |sid: &str| locator.classify_resume_target(sid));
        let b =
            LedgerPaneIdentityBinder::new(identity.clone(), Arc::clone(&ledger), Some(classifier));

        b.register_create_identity(
            "t-rest-child",
            "opencode",
            Some("ses_child"),
            Some("/tmp"),
            Some("req-c"),
        );
        assert_eq!(
            identity.get("t-rest-child").and_then(|i| i.is_subagent),
            Some(true),
            "REST-created child-target terminal must be classified"
        );
        b.register_create_identity(
            "t-rest-root",
            "opencode",
            Some("ses_root"),
            Some("/tmp"),
            Some("req-r"),
        );
        assert_eq!(
            identity.get("t-rest-root").and_then(|i| i.is_subagent),
            Some(false),
            "definite root classifies Some(false) (both-directions semantics)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn register_create_identity_skips_shell_and_marks_pending_for_marker_modes() {
        use freshell_terminal::registry::PaneIdentityBinder as _;
        let (b, ledger, identity, dir) = binder("markers");
        // shell: nothing at all
        b.register_create_identity("t-shell", "shell", None, None, None);
        assert!(identity.get("t-shell").is_none());
        assert!(ledger.pending_for_terminal("t-shell").is_none());
        // codex without an id: pending marker (locator lane resolves later),
        // exactly the WS MARKER_MODES arm (terminal.rs:2523-2540).
        b.register_create_identity("t-codex", "codex", None, Some("/tmp"), Some("req-3"));
        assert!(
            identity.get("t-codex").is_none(),
            "no premature identity row"
        );
        let marker = ledger
            .pending_for_terminal("t-codex")
            .expect("pending marker written");
        assert_eq!(marker.mode, "codex");
        assert_eq!(marker.cwd.as_deref(), Some("/tmp"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ledger_write_failure_never_panics_the_create() {
        use freshell_terminal::registry::PaneIdentityBinder as _;
        // A disabled ledger (or an unwritable root) must degrade to a warn,
        // never an Err/panic — failure never blocks the create.
        let identity = crate::identity::TerminalIdentityRegistry::default();
        let b =
            LedgerPaneIdentityBinder::new(identity.clone(), Arc::new(PaneLedger::disabled()), None);
        b.record_prespawn_claude_binding(SID, "t-x", "claude", None, None);
        b.register_create_identity("t-x", "claude", Some(SID), None, None);
        // identity row still lands even when durability is degraded:
        assert!(identity.get("t-x").is_some());
    }

    #[test]
    fn rest_lineage_rebind_clears_the_browser_stamps() {
        use freshell_terminal::registry::PaneIdentityBinder as _;
        // Delta-r2 Finding 2 (the laundering mechanism): a Bound row stamped
        // by a browser create must NOT keep that attribution when the
        // explicitly-HEADLESS REST/MCP lineage lane rebinds it — there is no
        // browser connection on this lane, so a kept stamp plus the refreshed
        // `updated_at` would keep the row inside the D8 grace window under a
        // stale parent forever, offering a session that was not open.
        let (b, ledger, _identity, dir) = binder("clear");
        // Seed the browser-stamped row (the WS create lane's shape).
        ledger
            .record_binding(&crate::pane_ledger::BindingWrite {
                provider: "claude",
                session_id: SID,
                terminal_id: "t-browser",
                mode: "claude",
                cwd: Some("/w"),
                create_request_id: None,
                provenance: crate::pane_ledger::ProvenancePolicy::Replace(
                    crate::pane_ledger::ProvenanceStamps {
                        client_instance_id: Some("client-1"),
                        device_id: Some("device-1"),
                        tab_key: Some("device-1:tab-1"),
                    },
                ),
                attributed_at: None,
                now_ms: 1_000,
            })
            .expect("seed browser-stamped row");
        // The headless lineage lane rebinds the SAME (provider, session_id).
        b.register_create_identity("t-rest-1", "claude", Some(SID), Some("/w"), Some("req-9"));
        let row = ledger
            .load_binding("claude", SID)
            .expect("row survives the rebind");
        assert_eq!(
            row.client_instance_id, None,
            "headless rebind clears the browser's clientInstanceId"
        );
        assert_eq!(row.device_id, None, "headless rebind clears the deviceId");
        assert_eq!(row.tab_key, None, "headless rebind clears the tabKey");
        assert_eq!(row.created_at, 1_000, "created_at is preserved on re-bind");
        assert!(
            row.updated_at > 1_000,
            "updated_at still refreshes (the row is rewritten, just unattributed)"
        );

        // The pre-spawn PIN-2 arm is the same `Clear` lane: re-seed the
        // stamps (a browser create), rebind headless, assert erased again.
        ledger
            .record_binding(&crate::pane_ledger::BindingWrite {
                provider: "claude",
                session_id: SID,
                terminal_id: "t-browser",
                mode: "claude",
                cwd: Some("/w"),
                create_request_id: None,
                provenance: crate::pane_ledger::ProvenancePolicy::Replace(
                    crate::pane_ledger::ProvenanceStamps {
                        client_instance_id: Some("client-1"),
                        device_id: Some("device-1"),
                        tab_key: Some("device-1:tab-1"),
                    },
                ),
                attributed_at: None,
                now_ms: 5_000,
            })
            .expect("re-seed browser stamps");
        b.record_prespawn_claude_binding(SID, "t-rest-2", "claude", Some("/w"), Some("req-10"));
        let row = ledger.load_binding("claude", SID).expect("row");
        assert_eq!(row.client_instance_id, None);
        assert_eq!(row.device_id, None);
        assert_eq!(row.tab_key, None);
        assert_eq!(row.created_at, 1_000, "created_at survives every re-bind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retire_pane_identity_retires_row_and_clears_pending() {
        use freshell_terminal::registry::PaneIdentityBinder as _;
        // Ledger A2: exit-side hygiene — retired rows must stop looking live.
        // Sync test on purpose: retire MUST be callable with no runtime,
        // because production calls it from the PTY reader thread's exit hook.
        let (b, ledger, identity, dir) = binder("retire");
        b.register_create_identity("t-rest-4", "claude", Some(SID), Some("/tmp"), None);
        b.retire_pane_identity("t-rest-4");
        // Retired == invisible to live lookups, exactly what the WS pane
        // EXIT hook produces: the live find_by_session no longer returns the
        // terminal, while the retired-inclusive get() still does.
        assert!(
            identity.find_by_session("claude", SID).is_none(),
            "retired row is not a live owner"
        );
        let row = identity.get("t-rest-4").expect("identity survives retire");
        assert!(row.retired, "exit hook flips the retired flag");
        // NATURAL-EXIT contract pin: the durable ledger binding must STAY
        // Bound — retire_closed is the explicit-kill trigger
        // (terminal.rs handle_kill), never the exit hook's. A still-Bound row
        // after natural exit is load-bearing for
        // auto_resume::pre_respawn_guard and the recovery inventory's
        // RetiredReason::Closed keying.
        let binding = ledger
            .load_binding("claude", SID)
            .expect("natural exit must NOT retire the ledger binding");
        assert_eq!(binding.state, RowState::Bound);
        assert!(binding.retired_reason.is_none());
        // And the pending-marker delete arm: register a marker-mode pane,
        // retire it, assert its pending marker is gone.
        b.register_create_identity("t-codex-r", "codex", None, Some("/tmp"), None);
        assert!(
            ledger.pending_for_terminal("t-codex-r").is_some(),
            "marker present before retire"
        );
        b.retire_pane_identity("t-codex-r");
        assert!(
            ledger.pending_for_terminal("t-codex-r").is_none(),
            "exit hook deletes the pending marker"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
