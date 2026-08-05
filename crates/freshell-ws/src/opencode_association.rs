//! OpenCode terminal-pane session association (Slice B + the input-submit
//! seam) — sibling of the deleted amplifier association (kata qmpk), bringing opencode
//! TERMINAL panes (the raw `opencode` CLI in a PTY) to durable-restore parity
//! with codex/amplifier (`docs/plans/2026-07-18-opencode-terminal-restore-spec.md`).
//!
//! [`crate::identity`] + `terminal.rs`'s existing `terminal.meta.updated`
//! broadcast already close the client → persist → restart → resume chain for
//! every provider whose sessionRef arrives at `terminal.create` time. opencode
//! terminal panes are different: nothing gives them a `resumeSessionId` at
//! create time (legacy has NO opencode terminal locator at all — spec §2).
//! [`freshell_sessions::opencode_locator::OpencodeLocator`] closes that gap by
//! correlating a fresh opencode PTY with the new `session` row opencode
//! writes into its SQLite `opencode.db`; this module is the thin controller
//! around it — arm/disarm the locator at the right terminal lifecycle points,
//! feed it submit-shaped input, and (once it resolves) bind + broadcast the
//! identity exactly like every other provider's create-time path does.
//!
//! Mirrors the deleted `amplifier_association.rs`'s reject checks (terminal missing/not
//! running, wrong mode, already bound) as defense-in-depth — the locator's
//! own single-bind-per-terminal design already makes these redundant in
//! practice, but a terminal could legitimately be killed between `Located`
//! and this draining tick.

use freshell_protocol::{
    ServerMessage, SessionLocator, TerminalMetaRecord, TerminalMetaUpdated, TerminalRunStatus,
    TerminalSessionAssociated,
};

use crate::terminal::now_ms;
use crate::WsState;

/// `isSubmitInput` (`shared/turn-complete-signal.ts:125-127`): the input is
/// ONLY a run of CR/LF bytes -- an Enter keypress, possibly repeated. Anything
/// else (real text, control sequences, partial lines) is not a submit.
/// Identical rule to the deleted `amplifier_association::is_submit_input` — duplicated
/// rather than shared (spec §5, Slice B: "a one-liner, duplication
/// acceptable").
pub(crate) fn is_submit_input(data: &str) -> bool {
    !data.is_empty() && data.chars().all(|c| c == '\r' || c == '\n')
}

/// Arm the locator for a freshly-created terminal, iff it's a fresh
/// (non-resuming) `opencode` pane with a resolved cwd. No-ops when the
/// locator is unavailable (`WsState::opencode_locator` is `None`) or the mode
/// isn't `opencode` — cheap enough to call unconditionally from
/// `handle_create`.
pub(crate) fn maybe_arm(
    state: &WsState,
    terminal_id: &str,
    mode: &str,
    cwd: Option<&str>,
    resume_session_id: Option<&str>,
) {
    if mode != "opencode" {
        return;
    }
    let Some(locator) = &state.opencode_locator else {
        return;
    };
    locator.arm(terminal_id, mode, true, resume_session_id, cwd, now_ms());
}

/// Feed a `terminal.input` write to the locator iff it's submit-shaped
/// (Enter). No-ops for every other terminal (armed only for opencode panes)
/// and when the locator is unavailable.
pub(crate) fn note_possible_submit(state: &WsState, terminal_id: &str, data: &str) {
    if !is_submit_input(data) {
        return;
    }
    let Some(locator) = &state.opencode_locator else {
        return;
    };
    locator.note_submit(terminal_id, now_ms());
}

/// Drive one locator polling cycle and bind + broadcast every association it
/// resolved this tick. Intended to be called periodically (the sweep-timer
/// pattern the deleted `spawn_amplifier_locator_sweep` also used).
///
/// `OpencodeLocator::tick` is a synchronous, bounded SQLite read whenever at
/// least one terminal is armed (see its module doc for the idle
/// short-circuit that makes it a zero-I/O no-op otherwise). Either way, this
/// runs the tick inside `tokio::task::spawn_blocking` rather than directly on
/// this async task's worker thread — mirroring
/// the deleted `amplifier_association::drain_and_associate`'s identical wrapping.
pub(crate) async fn drain_and_associate(state: &WsState) {
    let Some(locator) = &state.opencode_locator else {
        return;
    };
    let locator = std::sync::Arc::clone(locator);
    let now = now_ms();
    let located = match tokio::task::spawn_blocking(move || locator.tick(now)).await {
        Ok(located) => located,
        Err(join_error) => {
            // The blocking closure only calls `OpencodeLocator::tick`, which
            // does not itself panic in normal operation; a panic here would
            // be a genuine bug, not a routine condition to silently swallow.
            tracing::warn!(
                error = %join_error,
                "opencode_locator_tick_panicked: sweep tick task panicked, skipping this cycle"
            );
            return;
        }
    };
    for located in located {
        let Some(entry) = state
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == located.terminal_id)
        else {
            tracing::warn!(
                terminal_id = %located.terminal_id,
                session_id = %located.session_id,
                "opencode_association_rejected: terminal_missing"
            );
            continue;
        };
        if entry.mode != "opencode" || entry.status != TerminalRunStatus::Running {
            tracing::warn!(
                terminal_id = %located.terminal_id,
                mode = %entry.mode,
                "opencode_association_rejected: terminal_not_opencode_or_not_running"
            );
            continue;
        }
        if entry.resume_session_id.is_some() {
            tracing::warn!(
                terminal_id = %located.terminal_id,
                "opencode_association_rejected: terminal_already_bound"
            );
            continue;
        }

        state.identity.upsert(
            &located.terminal_id,
            Some("opencode"),
            Some(&located.session_id),
            entry.cwd.as_deref(),
            now_ms(),
        );
        state.registry.set_meta(
            &located.terminal_id,
            None,
            None,
            Some("opencode".to_string()),
            Some(located.session_id.clone()),
        );
        // P1.8 (trigger c) + P1.10: locator resolution is an identity event —
        // durable binding row first, then the spawn-time pending marker is
        // deleted. Registry-truth cwd, same as the in-memory binds above.
        // Awaited (drain_and_associate is async; the helper spawn_blockings
        // the fsync off this sweep task — V1.md).
        crate::pane_ledger::ledger_resolve_identity(
            state,
            &located.terminal_id,
            "opencode",
            &located.session_id,
            entry.cwd.as_deref(),
        )
        .await;
        broadcast_terminal_session_associated(
            state,
            &located.terminal_id,
            &located.session_id,
            entry.cwd.clone(),
        );
        // Task 10: feed the identity proof into the activity hub — the
        // opencode tracker's deferred (awaitingAssociation) completions
        // release on this bind (channel-deferred, safe off the sweep task;
        // codex_identity.rs:221 precedent).
        if let Some(hub) = &state.activity {
            hub.bind_opencode_session(&located.terminal_id, &located.session_id);
        }
    }
}

/// Fan `terminal.session.associated` (the sessionRef the client's
/// `reconcileTerminalSessionAssociation` persists) AND a `terminal.meta.updated`
/// upsert (the same shape `terminal.rs`'s `broadcast_terminal_meta_created`
/// emits at create time for every other provider) to every connection.
/// Mirrors the deleted `amplifier_association`'s identical broadcast (kata qmpk).
fn broadcast_terminal_session_associated(
    state: &WsState,
    terminal_id: &str,
    session_id: &str,
    cwd: Option<String>,
) {
    let associated = ServerMessage::TerminalSessionAssociated(TerminalSessionAssociated {
        terminal_id: terminal_id.to_string(),
        session_ref: SessionLocator {
            provider: "opencode".to_string(),
            session_id: session_id.to_string(),
        },
        previous_session_id: None,
    });
    if let Ok(frame) = serde_json::to_string(&associated) {
        let _ = state.broadcast_tx.send(frame);
    }

    let meta = ServerMessage::TerminalMetaUpdated(TerminalMetaUpdated {
        remove: Vec::new(),
        upsert: vec![TerminalMetaRecord {
            terminal_id: terminal_id.to_string(),
            updated_at: now_ms(),
            branch: None,
            checkout_root: None,
            cwd,
            display_subdir: None,
            is_dirty: None,
            provider: Some("opencode".to_string()),
            repo_root: None,
            session_id: Some(session_id.to_string()),
            token_usage: None,
        }],
    });
    if let Ok(frame) = serde_json::to_string(&meta) {
        let _ = state.broadcast_tx.send(frame);
    }
}

/// The sweep-timer wiring (mirrors `freshell-server`'s `spawn_sessions_sweep`):
/// periodically drive the locator's polling cycle and process any resolved
/// associations, off the per-connection select loops.
pub fn spawn_opencode_locator_sweep(state: WsState, interval: std::time::Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        loop {
            ticker.tick().await;
            drain_and_associate(&state).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_sessions::opencode_locator::OpencodeLocator;
    use std::sync::Arc as StdArc;

    fn state_with_locator(
        data_home: std::path::PathBuf,
    ) -> (WsState, tokio::sync::broadcast::Receiver<String>) {
        let auth_token = StdArc::new("s3cr3t-token-abcdef".to_string());
        let broadcast_tx = StdArc::new(tokio::sync::broadcast::channel::<String>(16).0);
        let rx = broadcast_tx.subscribe();
        let state = WsState {
            pane_ledger: std::sync::Arc::new(crate::pane_ledger::PaneLedger::disabled()),
            identity: crate::identity::TerminalIdentityRegistry::new(),
            auth_token: StdArc::clone(&auth_token),
            server_instance_id: StdArc::new("srv-1111".to_string()),
            boot_id: StdArc::new("boot-2222".to_string()),
            settings: StdArc::new(
                serde_json::from_value(serde_json::json!({
                    "ai": {},
                    "codingCli": { "enabledProviders": [], "mcpServer": true, "providers": {} },
                    "editor": { "externalEditor": "auto" },
                    "extensions": { "disabled": [] },
                    "freshAgent": { "defaultPlugins": [], "enabled": false, "providers": {} },
                    "logging": { "debug": false },
                    "network": { "configured": true, "host": "127.0.0.1" },
                    "panes": { "defaultNewPane": "ask" },
                    "safety": { "autoKillIdleMinutes": 15 },
                    "sidebar": {
                        "autoGenerateTitles": true,
                        "excludeFirstChatMustStart": false,
                        "excludeFirstChatSubstrings": []
                    },
                    "terminal": { "scrollback": 10000 }
                }))
                .unwrap(),
            ),
            broadcast_tx: StdArc::clone(&broadcast_tx),
            auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
            auto_resume_cancels: Default::default(),
            fresh_codex: freshell_freshagent::FreshCodexState::new(
                StdArc::clone(&auth_token),
                StdArc::clone(&broadcast_tx),
                serde_json::json!({ "freshAgent": { "enabled": false } }),
            ),
            fresh_claude: freshell_freshagent::FreshClaudeState::new(StdArc::clone(&broadcast_tx)),
            fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
                freshell_freshagent::FreshAgentState::new(auth_token, StdArc::clone(&broadcast_tx)),
            ),
            registry: freshell_terminal::TerminalRegistry::new(),
            shutdown: StdArc::new(tokio::sync::Notify::new()),
            tabs: crate::tabs::TabsRegistry::new(),
            screenshots: crate::screenshot::ScreenshotBroker::new(broadcast_tx),
            terminals_revision: StdArc::new(std::sync::atomic::AtomicI64::new(0)),
            sessions_revision: StdArc::new(std::sync::atomic::AtomicI64::new(0)),
            cli_commands: StdArc::new(Vec::new()),
            ping_interval_ms: 30_000,
            hello_timeout_ms: 5_000,
            allowed_origins: StdArc::new(crate::origin::default_allowed_origins()),
            ws_max_payload_bytes: 16 * 1024 * 1024,
            term09: crate::backpressure::Term09Config::default(),
            create_protect: crate::create_limit::CreateProtectConfig::default(),
            spawn_gate: std::sync::Arc::new(crate::spawn_gate::SpawnGate::new(4, 64)),
            shutdown_started: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            create_dedupe: std::sync::Arc::new(crate::create_dedupe::CreateDedupe::default()),
            config_fallback: None,
            opencode_locator: Some(StdArc::new(OpencodeLocator::new(data_home))),
            codex_locator: None,
            activity: None,
            session_existence: std::sync::Arc::new(crate::existence::NoIndexProbe::default()),
            reconcile_deferral_budget_ms: crate::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
            fresh_agent_respawn_counts: Default::default(),
        };
        (state, rx)
    }

    /// Sibling of `state_with_locator` with a REAL (enabled) pane ledger
    /// rooted at `ledger_dir` — added rather than churning every existing
    /// caller of the disabled-ledger fixture.
    fn state_with_locator_and_ledger(
        data_home: std::path::PathBuf,
        ledger_dir: &std::path::Path,
    ) -> (WsState, tokio::sync::broadcast::Receiver<String>) {
        let (mut state, rx) = state_with_locator(data_home);
        state.pane_ledger = std::sync::Arc::new(crate::pane_ledger::PaneLedger::new(Some(
            ledger_dir.to_path_buf(),
        )));
        (state, rx)
    }

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-opencode-association-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn open_seed_db(data_home: &std::path::Path) -> rusqlite::Connection {
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

    fn insert_session(conn: &rusqlite::Connection, id: &str, cwd: &str, time_created: i64) {
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

    #[test]
    fn is_submit_input_matches_enter_only_sequences() {
        assert!(is_submit_input("\r"));
        assert!(is_submit_input("\n"));
        assert!(is_submit_input("\r\n"));
        assert!(is_submit_input("\r\r\n\n"));
        assert!(!is_submit_input(""));
        assert!(!is_submit_input("hello"));
        assert!(!is_submit_input("hello\r\n"));
        assert!(!is_submit_input("\x1b[A"));
    }

    #[test]
    fn maybe_arm_ignores_non_opencode_modes() {
        let home = unique_temp_dir("maybe-arm-wrong-mode");
        let (state, _rx) = state_with_locator(home.clone());
        maybe_arm(&state, "t1", "codex", Some("/proj"), None);
        assert_eq!(state.opencode_locator.as_ref().unwrap().armed_count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn maybe_arm_arms_a_fresh_opencode_terminal() {
        let home = unique_temp_dir("maybe-arm-fresh");
        let (state, _rx) = state_with_locator(home.clone());
        maybe_arm(&state, "t1", "opencode", Some("/proj"), None);
        assert_eq!(state.opencode_locator.as_ref().unwrap().armed_count(), 1);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn maybe_arm_skips_a_resuming_opencode_terminal() {
        let home = unique_temp_dir("maybe-arm-resume");
        let (state, _rx) = state_with_locator(home.clone());
        maybe_arm(&state, "t1", "opencode", Some("/proj"), Some("existing-id"));
        assert_eq!(state.opencode_locator.as_ref().unwrap().armed_count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn note_possible_submit_ignores_non_enter_input() {
        let home = unique_temp_dir("note-submit-ignore");
        let (state, _rx) = state_with_locator(home.clone());
        maybe_arm(&state, "t1", "opencode", Some("/proj"), None);

        // "hello" is not submit-shaped (`is_submit_input` rejects it) and
        // must never reach `OpencodeLocator::note_submit` -- if it wrongly
        // did, the locator's per-terminal evaluation window (`enter_ms`)
        // would already be open and unresolved.
        note_possible_submit(&state, "t1", "hello");

        // Observable proof, via the locator's own seam:
        // `OpencodeLocator::note_submit` returns `true` only when it (re)opens
        // an evaluation window, and `false` when one is already open and
        // unresolved (see its doc comment). Calling it directly here, right
        // after "hello", proves whether "hello" already consumed the window:
        // if it wrongly had, this call would observe `enter_ms.is_some()` and
        // return `false`, failing the assertion below.
        let opened_by_first_real_submit = state
            .opencode_locator
            .as_ref()
            .unwrap()
            .note_submit("t1", now_ms());
        assert!(
            opened_by_first_real_submit,
            "\"hello\" must not have opened/consumed the locator's evaluation \
             window; a genuine Enter must still be able to open a fresh one"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn drain_and_associate_binds_identity_and_broadcasts_on_location() {
        let home = unique_temp_dir("drain-associate");
        let (state, mut rx) = state_with_locator(home.clone());
        let db = open_seed_db(&home);

        // A running opencode terminal the association controller can validate
        // against (mode/status/resume_session_id all read from
        // `state.registry`, mirroring the controller's own reject checks).
        let spec = freshell_platform::build_spawn_spec(
            freshell_platform::ShellType::System,
            freshell_platform::detect::HostOs::Linux,
            false,
            Some("/tmp"),
            &freshell_platform::RealEnv,
            &freshell_platform::RealFileProbe,
            &std::collections::BTreeMap::new(),
            None,
            None,
        );
        state
            .registry
            .create(
                &spec,
                &std::collections::BTreeMap::new(),
                "t1".to_string(),
                "stream-1".to_string(),
                "opencode",
                None,
                None,
                None,
                None,
            )
            .expect("spawn a real shell for the test PTY");
        state
            .registry
            .set_meta("t1", None, None, Some("opencode".to_string()), None);

        maybe_arm(&state, "t1", "opencode", Some("/tmp"), None);
        note_possible_submit(&state, "t1", "\r");

        insert_session(&db, "ses_drain", "/tmp", crate::terminal::now_ms());

        // Drain repeatedly until the locator's correlation window has
        // definitely closed relative to wall-clock `now_ms()`.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        for _ in 0..40 {
            drain_and_associate(&state).await;
            if state
                .identity
                .get("t1")
                .and_then(|i| i.session_id)
                .is_some()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        let identity = state.identity.get("t1").expect("identity seeded");
        assert_eq!(identity.provider.as_deref(), Some("opencode"));
        assert_eq!(identity.session_id.as_deref(), Some("ses_drain"));

        let dir_entry = state
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == "t1")
            .unwrap();
        assert_eq!(dir_entry.resume_session_id.as_deref(), Some("ses_drain"));

        let mut saw_associated = false;
        let mut saw_meta = false;
        while let Ok(frame) = rx.try_recv() {
            if frame.contains("terminal.session.associated") && frame.contains("ses_drain") {
                saw_associated = true;
            }
            if frame.contains("terminal.meta.updated") && frame.contains("ses_drain") {
                saw_meta = true;
            }
        }
        assert!(
            saw_associated,
            "expected a terminal.session.associated broadcast"
        );
        assert!(saw_meta, "expected a terminal.meta.updated broadcast");

        state.registry.kill("t1");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// P1.10: a RESTORE-created opencode pane that lacks identity must
    /// still arm (restore:true suppresses arming ONLY via an implied
    /// resume_session_id — `OpencodeLocator::arm` checks the resume id,
    /// never a restore flag), and its identity-in-flight window must be
    /// covered by a durable pending marker until resolution deletes it.
    #[tokio::test]
    async fn restore_created_pane_without_identity_arms_and_resolves_into_the_ledger() {
        let home = unique_temp_dir("p110-restore-rearm");
        let ledger_dir = unique_temp_dir("p110-ledger");
        let (state, _rx) = state_with_locator_and_ledger(home.clone(), &ledger_dir);
        let db = open_seed_db(&home);

        // A real PTY registry row, exactly as the sibling resolve-path test
        // spawns it (the controller's reject checks read mode/status/resume
        // from `state.registry`).
        let spec = freshell_platform::build_spawn_spec(
            freshell_platform::ShellType::System,
            freshell_platform::detect::HostOs::Linux,
            false,
            Some("/tmp"),
            &freshell_platform::RealEnv,
            &freshell_platform::RealFileProbe,
            &std::collections::BTreeMap::new(),
            None,
            None,
        );
        state
            .registry
            .create(
                &spec,
                &std::collections::BTreeMap::new(),
                "t1".to_string(),
                "stream-1".to_string(),
                "opencode",
                None,
                None,
                None,
                None,
            )
            .expect("spawn a real shell for the test PTY");
        state
            .registry
            .set_meta("t1", None, None, Some("opencode".to_string()), None);

        // The restore-shaped arm: identity absent, so resume is None — the
        // exact argument shape terminal.rs's handle_create produces for a
        // restore:true create that carried no sessionRef.
        maybe_arm(&state, "t1", "opencode", Some("/tmp"), None);
        assert_eq!(state.opencode_locator.as_ref().unwrap().armed_count(), 1);

        // The spawn-time pending marker (written by handle_create in
        // production — Task 6; written directly here because this test
        // drives the module, not the WS handler).
        state
            .pane_ledger
            .record_pending("t1", "opencode", Some("/tmp"), crate::terminal::now_ms())
            .unwrap();

        note_possible_submit(&state, "t1", "\r");

        insert_session(&db, "ses_restore", "/tmp", crate::terminal::now_ms());

        // Drain repeatedly until the locator's correlation window has
        // definitely closed relative to wall-clock `now_ms()`.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        for _ in 0..40 {
            drain_and_associate(&state).await;
            if state
                .identity
                .get("t1")
                .and_then(|i| i.session_id)
                .is_some()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        // Resolution wrote the binding and deleted the marker (pinned order).
        let hit = state
            .pane_ledger
            .lookup_by_session("opencode", "ses_restore")
            .expect("binding row written at resolution");
        assert_eq!(hit.row.live_terminal_id.as_deref(), Some("t1"));
        assert!(state.pane_ledger.pending_for_terminal("t1").is_none());
        assert!(state.pane_ledger.list_pending_raw().is_empty());

        state.registry.kill("t1");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ledger_dir);
    }

    /// D1.2's LOCATOR half (the signal half lives in
    /// `tests/opencode_switch_rebind.rs` Phase 8, which cannot reach the
    /// `pub(crate)` `drain_and_associate`): once a TUI-plugin signal
    /// first-bind has set the pane's registry `resume_session_id`, a later
    /// `Located` event for the same pane must be REJECTED by the
    /// `terminal_already_bound` check — the signal is user-facing route
    /// truth and outranks the locator's DB heuristic. The reject emits only
    /// a `tracing::warn!` (no frame, no event), so REJECTION IS ASSERTED BY
    /// ABSENCE OF EFFECT: no identity row, registry meta unchanged, no
    /// ledger binding for the located candidate.
    #[tokio::test]
    async fn signal_bound_terminal_rejects_a_later_located_event() {
        let home = unique_temp_dir("d12-locator-arbitration");
        let ledger_dir = unique_temp_dir("d12-locator-arbitration-ledger");
        let (state, _rx) = state_with_locator_and_ledger(home.clone(), &ledger_dir);
        let db = open_seed_db(&home);

        let spec = freshell_platform::build_spawn_spec(
            freshell_platform::ShellType::System,
            freshell_platform::detect::HostOs::Linux,
            false,
            Some("/tmp"),
            &freshell_platform::RealEnv,
            &freshell_platform::RealFileProbe,
            &std::collections::BTreeMap::new(),
            None,
            None,
        );
        state
            .registry
            .create(
                &spec,
                &std::collections::BTreeMap::new(),
                "t1".to_string(),
                "stream-1".to_string(),
                "opencode",
                None,
                None,
                None,
                None,
            )
            .expect("spawn a real shell for the test PTY");
        state
            .registry
            .set_meta("t1", None, None, Some("opencode".to_string()), None);

        // The fresh create armed the locator (resume id still None) and the
        // user submitted — the locator's evaluation window is open.
        maybe_arm(&state, "t1", "opencode", Some("/tmp"), None);
        note_possible_submit(&state, "t1", "\r");

        // A TUI-plugin signal first-bind lands mid-flight: the registry meta
        // now carries the signal-bound session id (exactly the footprint the
        // signal bind leaves behind, opencode_signal.rs).
        state.registry.set_meta(
            "t1",
            None,
            None,
            Some("opencode".to_string()),
            Some("ses_hhhhhhhhhhhhhhhhhhhhhhhhhh".to_string()),
        );

        // Seed a DIFFERENT session row that would otherwise associate.
        insert_session(&db, "ses_dbcandidate", "/tmp", crate::terminal::now_ms());

        // Drive drains until the locator EMITS its Located event — `tick`
        // disarms the terminal on emission, so armed_count reaching 0 is the
        // positive proof that a Located event reached the reject check (not
        // merely that the locator never resolved).
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let mut emitted = false;
        for _ in 0..40 {
            drain_and_associate(&state).await;
            if state.opencode_locator.as_ref().unwrap().armed_count() == 0 {
                emitted = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(
            emitted,
            "the locator must emit a Located event for the seeded session"
        );

        // Rejection by absence of effect.
        assert!(
            state.identity.get("t1").is_none(),
            "the rejected Located event must not seed an identity row"
        );
        let entry = state
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == "t1")
            .expect("registry must list t1");
        assert_eq!(
            entry.resume_session_id.as_deref(),
            Some("ses_hhhhhhhhhhhhhhhhhhhhhhhhhh"),
            "the signal-bound session id must be untouched"
        );
        assert!(
            state
                .pane_ledger
                .lookup_by_session("opencode", "ses_dbcandidate")
                .is_none(),
            "no ledger binding may be written for the rejected candidate"
        );

        state.registry.kill("t1");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ledger_dir);
    }
}
