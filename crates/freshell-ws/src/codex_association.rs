//! Codex terminal-pane association controller (Lane B2): arm the
//! CodexLocator at create, feed Enter submits, and on resolution adopt the
//! identity through the shared `codex_identity::adopt_codex_identity` tail.
//! Structure mirrors `opencode_association.rs` — deliberately (spec §5-shape
//! duplication over a premature provider-generic controller). One deliberate
//! deviation: the locator's windows are ENTER-ANCHORED ONLY (no spawn
//! window) — real codex materializes its rollout only at the first user
//! prompt, so `maybe_arm` only takes the snapshot and `note_possible_submit`
//! is what opens a correlation window (async: the FIRST submit re-snapshots
//! `known_files` on the blocking pool and MUST complete before the Enter is
//! written to the PTY — see the terminal.rs seam).

use freshell_protocol::TerminalRunStatus;

use crate::terminal::now_ms;
use crate::WsState;

/// Deliberate one-line duplicate of `opencode_association::is_submit_input`
/// (itself a duplicate of the deleted `amplifier_association`'s — spec §5: "a one-liner,
/// duplication acceptable"): the input is ONLY a run of CR/LF bytes — an
/// Enter keypress, possibly repeated.
pub(crate) fn is_submit_input(data: &str) -> bool {
    !data.is_empty() && data.chars().all(|c| c == '\r' || c == '\n')
}

/// S5.b / D-03 (recorded rule): managed panes bind identity from the proxy
/// Candidate stream; the disk locator must not race it for the first bind.
/// Suppression happens HERE at arm time — never via `locator.disarm`, which
/// would also kill the fork watch (`codex_locator.rs:263-267`).
pub(crate) fn should_arm_codex_locator(mode: &str, managed_codex: bool) -> bool {
    mode == "codex" && !managed_codex
}

/// Arm the locator for a freshly-created terminal, iff it's a fresh
/// (non-resuming) `codex` pane with a resolved cwd. No-ops when the locator
/// is unavailable (`WsState::codex_locator` is `None`) or the mode isn't
/// `codex`. Arming only takes the known-files snapshot — windows are
/// Enter-anchored and open in `note_possible_submit` (see module doc). The
/// snapshot walks the sessions tree, so the caller runs this on the
/// blocking pool (see the terminal.rs arm-at-create seam).
pub(crate) fn maybe_arm(
    state: &WsState,
    terminal_id: &str,
    mode: &str,
    cwd: Option<&str>,
    resume_session_id: Option<&str>,
    managed_codex: bool,
) {
    if !should_arm_codex_locator(mode, managed_codex) {
        return;
    }
    let Some(locator) = &state.codex_locator else {
        return;
    };
    locator.arm(terminal_id, mode, true, resume_session_id, cwd);
}

/// Feed a `terminal.input` write to the locator iff it's submit-shaped
/// (Enter). Async, unlike the opencode sibling: the FIRST `note_submit`
/// re-snapshots `known_files` (a bounded sessions-tree walk), so it runs on
/// the blocking pool, and the CALLER MUST AWAIT this BEFORE writing the
/// Enter to the PTY — codex materializes the rollout in response to that
/// very Enter, and a re-snapshot racing after the write could capture
/// (permanently exclude) the pane's own file. Non-submit data returns
/// immediately; later submits are a cheap mutex hop.
pub(crate) async fn note_possible_submit(state: &WsState, terminal_id: &str, data: &str) {
    if !is_submit_input(data) {
        return;
    }
    let Some(locator) = &state.codex_locator else {
        return;
    };
    let locator = std::sync::Arc::clone(locator);
    let terminal_id = terminal_id.to_string();
    let at_ms = now_ms();
    if let Err(join_error) = tokio::task::spawn_blocking(move || {
        locator.note_submit(&terminal_id, at_ms);
        // Fork lane (validated A5, load-bearing): EVERY Enter opens the
        // fork-scan window -- NOT gated on the arm state or on
        // `note_submit`'s outcome, because Enters from already-BOUND
        // (watched, not armed) codex panes MUST reach it. Fork-then-idle
        // children are real (2/12 real user forks: the child's session_meta
        // is fully written ~0.1s after fork-confirm and the file is never
        // touched again), so the confirm Enter itself must open the window
        // -- there is no later Enter to catch. `note_fork_submit` no-ops
        // when no watch exists, so the unconditional call is cheap.
        locator.note_fork_submit(&terminal_id, at_ms);
    })
    .await
    {
        tracing::warn!(
            error = %join_error,
            "codex_note_submit_panicked: blocking submit task panicked"
        );
    }
}

/// Drive one locator polling cycle and adopt every association it resolved
/// this tick through the shared `codex_identity::adopt_codex_identity` tail.
/// The tick does bounded filesystem walks + first-line reads — never on an
/// async worker (same `spawn_blocking` discipline as the opencode sweep).
pub(crate) async fn drain_and_associate(state: &WsState) {
    let Some(locator) = &state.codex_locator else {
        return;
    };
    let tick_locator = std::sync::Arc::clone(locator);
    let now = now_ms();
    let located = match tokio::task::spawn_blocking(move || tick_locator.tick(now)).await {
        Ok(located) => located,
        Err(join_error) => {
            tracing::warn!(
                error = %join_error,
                "codex_locator_tick_panicked: sweep tick task panicked, skipping this cycle"
            );
            return;
        }
    };
    for hit in located {
        // Defense-in-depth rejects against registry truth (mirrors
        // opencode_association.rs's drain checks): a terminal could
        // legitimately be killed between `Located` and this draining tick.
        let Some(entry) = state
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == hit.terminal_id)
        else {
            tracing::warn!(
                terminal_id = %hit.terminal_id,
                thread_id = %hit.thread_id,
                "codex_association_rejected: terminal_missing"
            );
            continue;
        };
        if entry.mode != "codex" || entry.status != TerminalRunStatus::Running {
            tracing::warn!(
                terminal_id = %hit.terminal_id,
                mode = %entry.mode,
                "codex_association_rejected: terminal_not_codex_or_not_running"
            );
            continue;
        }
        if entry.resume_session_id.is_some() {
            tracing::warn!(
                terminal_id = %hit.terminal_id,
                "codex_association_rejected: terminal_already_bound"
            );
            continue;
        }
        // Fork watch BEFORE the adoption tail (ordering is load-bearing):
        // `adopt_codex_identity` broadcasts `terminal.session.associated`,
        // and that frame is the client's cue that the pane is bound -- an
        // in-TUI /resume fork driven immediately after it must find the
        // watch already registered with its known-files snapshot already
        // taken. Registered after the broadcast (the old order), the watch
        // raced the client's next Enter two ways under load: (1) the Enter's
        // `note_fork_submit` found no watch, so no fork window ever opened;
        // (2) the snapshot ran after the fork child's rollout appeared and
        // swallowed it into `known_files` (permanently excluded). Observed
        // as the intermittent `codex_fork_rebind.rs::after_rebind_*` phase-2
        // rebind timeout. `watch_fork` snapshots the sessions tree (bounded
        // fs walk), so it runs on the blocking pool like the adoption tick
        // above.
        {
            let watch_locator = std::sync::Arc::clone(locator);
            let terminal_id = hit.terminal_id.clone();
            let thread_id = hit.thread_id.clone();
            if let Err(join_error) = tokio::task::spawn_blocking(move || {
                watch_locator.watch_fork(&terminal_id, &thread_id);
            })
            .await
            {
                tracing::warn!(
                    error = %join_error,
                    "codex_watch_fork_panicked: blocking watch_fork task panicked"
                );
            }
        }
        // The shared adoption tail (codex_identity.rs): binds both identity
        // homes, awaits the durable ledger row, broadcasts the pinned
        // associated/meta pair, and feeds the activity hub (including the
        // rollout attach for the reconcile lane).
        let adopted = crate::codex_identity::adopt_codex_identity(
            state,
            crate::codex_identity::CodexAdoption {
                terminal_id: &hit.terminal_id,
                thread_id: &hit.thread_id,
                rollout_path: Some(hit.rollout_path.as_path()),
                cwd: entry.cwd.as_deref(),
            },
        )
        .await;
        if !adopted {
            // Adoption refused by the tail's guards: an unbound pane must
            // carry no fork watch, so drop the eagerly-registered one.
            // `disarm` clears both locator homes; the armed entry was
            // already consumed by this tick's resolution, so this removes
            // exactly the watch -- restoring the refused pane to the same
            // end state the old (watch-after-adopt) order produced.
            locator.disarm(&hit.terminal_id);
        }
    }

    // Fork lane: lineage-proven mid-session rebinds. Runs on the same sweep.
    // The adoption loop's `terminal_already_bound` gate does NOT apply here
    // -- being bound is the fork lane's precondition.
    // `tick_forks` diffs the sessions tree (bounded fs walk), so it runs on
    // the blocking pool like the adoption tick above.
    let fork_locator = std::sync::Arc::clone(locator);
    let forks = match tokio::task::spawn_blocking(move || fork_locator.tick_forks(now)).await {
        Ok(forks) => forks,
        Err(join_error) => {
            tracing::warn!(
                error = %join_error,
                "codex_fork_tick_panicked: fork sweep tick task panicked, skipping this cycle"
            );
            return;
        }
    };
    for f in forks {
        let ok = crate::codex_identity::rebind_codex_identity(
            state,
            crate::codex_identity::CodexRebind {
                terminal_id: &f.terminal_id,
                old_session_id: &f.old_session_id,
                new_session_id: &f.new_session_id,
                rollout_path: &f.rollout_path,
                cwd: f.cwd.as_deref(),
            },
        )
        .await;
        if !ok {
            tracing::warn!(terminal_id = %f.terminal_id, "codex_fork_rebind_refused");
            // `tick_forks` eagerly advanced the watch to the (now refused)
            // child id BEFORE these guards ran. Re-register with the OLD id
            // so a later GENUINE fork of the pane's real session is still
            // detected; `watch_fork` also re-snapshots known_files, so the
            // refused child's rollout can never re-fire. Blocking pool, same
            // as the adoption-lane watch_fork above (bounded fs walk).
            let watch_locator = std::sync::Arc::clone(locator);
            let terminal_id = f.terminal_id.clone();
            let old_session_id = f.old_session_id.clone();
            if let Err(join_error) = tokio::task::spawn_blocking(move || {
                watch_locator.watch_fork(&terminal_id, &old_session_id);
            })
            .await
            {
                tracing::warn!(
                    error = %join_error,
                    "codex_watch_fork_panicked: blocking watch_fork task panicked"
                );
            }
        }
    }
}

/// The sweep-timer wiring (mirrors `spawn_opencode_locator_sweep`):
/// periodically drive the locator's polling cycle and process any resolved
/// associations, off the per-connection select loops.
pub fn spawn_codex_locator_sweep(state: WsState, interval: std::time::Duration) {
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
    use crate::terminal::now_ms;
    use crate::WsState;
    use freshell_sessions::codex_locator::CodexLocator;
    use std::sync::Arc as StdArc;

    fn state_with_locator(
        data_home: std::path::PathBuf,
    ) -> (WsState, tokio::sync::broadcast::Receiver<String>) {
        let auth_token = StdArc::new("s3cr3t-token-abcdef".to_string());
        let broadcast_tx = StdArc::new(tokio::sync::broadcast::channel::<String>(16).0);
        let rx = broadcast_tx.subscribe();
        let state = WsState {
            pane_ledger: std::sync::Arc::new(crate::pane_ledger::PaneLedger::disabled()),
            layout: Default::default(),
            terminal_meta: Default::default(),
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
            opencode_locator: None,
            codex_locator: Some(StdArc::new(CodexLocator::new(data_home))),
            activity: None,
            session_existence: std::sync::Arc::new(crate::existence::NoIndexProbe::default()),
            reconcile_deferral_budget_ms: crate::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
            fresh_agent_respawn_counts: Default::default(),
        };
        (state, rx)
    }

    /// Sibling of `state_with_locator` with a REAL (enabled) pane ledger
    /// rooted at `ledger_dir` — copied from `opencode_association.rs`'s
    /// harness rather than churning every existing caller of the
    /// disabled-ledger fixture.
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
            "freshell-codex-association-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Write a rollout file whose FIRST line is the session_meta identity
    /// record, exactly the shape the real codex CLI writes (payload.id =
    /// identity; payload.cwd = the session's working dir). Reused inline
    /// from `codex_locator.rs`'s test helper.
    fn write_rollout(
        root: &std::path::Path,
        rel_dir: &str,
        thread_id: &str,
        cwd: Option<&str>,
    ) -> std::path::PathBuf {
        let dir = root.join(rel_dir);
        std::fs::create_dir_all(&dir).expect("create rollout dir");
        let file = dir.join(format!("rollout-2026-07-26T08-00-00-{thread_id}.jsonl"));
        let payload = match cwd {
            Some(c) => format!(r#"{{"id":"{thread_id}","cwd":"{c}"}}"#),
            None => format!(r#"{{"id":"{thread_id}"}}"#),
        };
        let line = format!(
            r#"{{"timestamp":"2026-07-26T08:00:00.000Z","type":"session_meta","payload":{payload}}}"#
        );
        std::fs::write(&file, format!("{line}\n")).expect("write rollout");
        file
    }

    #[test]
    fn is_submit_input_matches_enter_only_sequences() {
        for yes in ["\r", "\n", "\r\n", "\r\r\n\n"] {
            assert!(is_submit_input(yes), "{yes:?} should be a submit");
        }
        for no in ["", "hello", "hello\r\n", "\u{1b}[A"] {
            assert!(!is_submit_input(no), "{no:?} should not be a submit");
        }
    }

    #[test]
    fn managed_panes_never_arm_the_locator_d03() {
        assert!(should_arm_codex_locator("codex", false));
        assert!(!should_arm_codex_locator("codex", true)); // D-03: proxy candidate is authoritative
        assert!(!should_arm_codex_locator("shell", false));
        assert!(!should_arm_codex_locator("claude", false));
    }

    #[test]
    fn maybe_arm_arms_a_fresh_codex_terminal_and_ignores_others() {
        let dir = unique_temp_dir("assoc-arm");
        let (state, _rx) = state_with_locator(dir.clone());
        let locator = state.codex_locator.as_ref().unwrap().clone();
        maybe_arm(&state, "t1", "opencode", Some("/tmp"), None, false); // wrong mode
        assert_eq!(locator.armed_count(), 0);
        maybe_arm(
            &state,
            "t1",
            "codex",
            Some("/tmp"),
            Some("resume-id"),
            false,
        ); // resuming
        assert_eq!(locator.armed_count(), 0);
        maybe_arm(&state, "t1", "codex", Some("/tmp"), None, true); // managed (D-03)
        assert_eq!(locator.armed_count(), 0);
        maybe_arm(&state, "t1", "codex", Some("/tmp"), None, false); // fresh
        assert_eq!(locator.armed_count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn note_possible_submit_feeds_only_enter_sequences() {
        let dir = unique_temp_dir("assoc-submit");
        let (state, _rx) = state_with_locator(dir.clone());
        let locator = state.codex_locator.as_ref().unwrap().clone();
        maybe_arm(&state, "t1", "codex", Some("/tmp"), None, false);
        note_possible_submit(&state, "t1", "hello").await;
        // Observable proof via the locator's own seam: "hello" must not have
        // consumed the window — a direct note_submit still returns true.
        assert!(locator.note_submit("t1", now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Fresh codex pane: rollout appears after arm → sweep binds identity,
    /// writes the durable binding row, and broadcasts both frames in the
    /// pinned order.
    #[tokio::test]
    async fn drain_and_associate_binds_identity_ledger_and_broadcasts() {
        const TID: &str = "11111111-2222-3333-4444-555555555555";
        let home = unique_temp_dir("drain-associate");
        let ledger_dir = unique_temp_dir("drain-associate-ledger");
        let (state, mut rx) = state_with_locator_and_ledger(home.clone(), &ledger_dir);

        // A running codex terminal the association controller can validate
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
                "codex",
                None,
                None,
                None,
                None,
            )
            .expect("spawn a real shell for the test PTY");
        state
            .registry
            .set_meta("t1", None, None, Some("codex".to_string()), None);

        maybe_arm(&state, "t1", "codex", Some("/tmp"), None, false);

        // OPEN THE WINDOW FIRST: windows are Enter-anchored (no spawn
        // window), so resolution requires a submit, and the FIRST submit
        // re-snapshots known_files — the rollout MUST be seeded AFTER this
        // call (a pre-seeded file would be captured by the re-snapshot and
        // never bind; that exclusion is the Task 1/2 hardening, not a bug).
        note_possible_submit(&state, "t1", "\r").await;

        // THEN write the rollout the locator must find (lands well inside
        // the 2 s Enter-anchored window).
        write_rollout(&home, "2026/07/26", TID, Some("/tmp"));

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

        assert_eq!(
            state.identity.session_ref_for("t1"),
            Some(freshell_protocol::SessionLocator {
                provider: "codex".to_string(),
                session_id: TID.to_string(),
            })
        );

        let dir_entry = state
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == "t1")
            .unwrap();
        assert_eq!(dir_entry.resume_session_id.as_deref(), Some(TID));

        let hit = state
            .pane_ledger
            .lookup_by_session("codex", TID)
            .expect("binding row written at resolution");
        assert_eq!(hit.row.live_terminal_id.as_deref(), Some("t1"));
        assert!(state.pane_ledger.pending_for_terminal("t1").is_none());

        // Broadcasts, in the pinned order: `terminal.session.associated`
        // FIRST, then `terminal.meta.updated` (frame type assertions exactly
        // as the opencode sibling does them, plus the order pin).
        let mut frames = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            frames.push(frame);
        }
        let associated_at = frames
            .iter()
            .position(|f| f.contains("terminal.session.associated") && f.contains(TID))
            .expect("expected a terminal.session.associated broadcast");
        let meta_at = frames
            .iter()
            .position(|f| f.contains("terminal.meta.updated") && f.contains(TID))
            .expect("expected a terminal.meta.updated broadcast");
        assert!(
            associated_at < meta_at,
            "pinned order: associated THEN meta.updated"
        );

        state.registry.kill("t1");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ledger_dir);
    }

    /// Wave-A re-arm contract (the codex mirror of P1.10): a restore-created
    /// pane WITHOUT identity (resume None) arms like a fresh pane, records a
    /// pending marker, and resolves into the ledger — binding row first,
    /// marker gone after.
    #[tokio::test]
    async fn restore_created_pane_without_identity_arms_and_resolves_into_the_ledger() {
        const TID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let home = unique_temp_dir("p110-restore-rearm");
        let ledger_dir = unique_temp_dir("p110-ledger");
        let (state, _rx) = state_with_locator_and_ledger(home.clone(), &ledger_dir);

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
                "codex",
                None,
                None,
                None,
                None,
            )
            .expect("spawn a real shell for the test PTY");
        state
            .registry
            .set_meta("t1", None, None, Some("codex".to_string()), None);

        // The restore-shaped arm: identity absent, so resume is None — the
        // exact argument shape terminal.rs's handle_create produces for a
        // restore:true create that carried no sessionRef.
        maybe_arm(&state, "t1", "codex", Some("/tmp"), None, false);
        assert_eq!(state.codex_locator.as_ref().unwrap().armed_count(), 1);

        // The spawn-time pending marker (written by handle_create in
        // production — written directly here because this test drives the
        // module, not the WS handler).
        state
            .pane_ledger
            .record_pending("t1", "codex", Some("/tmp"), now_ms())
            .unwrap();

        // Enter-anchored window needs the submit; the first-submit
        // re-snapshot would exclude a pre-seeded file, so the rollout is
        // written only AFTER this await completes.
        note_possible_submit(&state, "t1", "\r").await;

        write_rollout(&home, "2026/07/26", TID, Some("/tmp"));

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
            .lookup_by_session("codex", TID)
            .expect("binding row written at resolution");
        assert_eq!(hit.row.live_terminal_id.as_deref(), Some("t1"));
        assert!(state.pane_ledger.pending_for_terminal("t1").is_none());
        assert!(state.pane_ledger.list_pending_raw().is_empty());

        state.registry.kill("t1");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ledger_dir);
    }

    /// One-writer defense survives the channel swap: a session already bound
    /// to ANOTHER terminal (including a retired binding) is never re-adopted.
    #[tokio::test]
    async fn located_session_bound_elsewhere_is_rejected() {
        const TID: &str = "99999999-8888-7777-6666-555555555555";
        let home = unique_temp_dir("bound-elsewhere");
        let (state, _rx) = state_with_locator(home.clone());

        // The victim's binding, RETIRED — exactly the state the exit path
        // leaves behind (terminal.rs's exit hook calls
        // `identity.retire(&tid)`). Retired-INCLUSIVE is the point: a dead
        // pane's identity must still repel adoption by a fresh terminal.
        state
            .identity
            .upsert("victim", Some("codex"), Some(TID), Some("/tmp"), now_ms());
        assert!(state.identity.retire("victim"));

        // A real PTY "t1" (codex mode), armed, with a locator handle kept
        // for the positive resolution signal below.
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
                "codex",
                None,
                None,
                None,
                None,
            )
            .expect("spawn a real shell for the test PTY");
        state
            .registry
            .set_meta("t1", None, None, Some("codex".to_string()), None);

        maybe_arm(&state, "t1", "codex", Some("/tmp"), None, false);
        let locator = state.codex_locator.as_ref().unwrap().clone();
        assert_eq!(locator.armed_count(), 1);

        // Open the Enter-anchored window, THEN seed the rollout (after the
        // submit — the first-submit re-snapshot would exclude a pre-seeded
        // file) with payload.cwd set to THE PANE'S OWN cwd: the rollout must
        // be a fully resolvable candidate, or this test proves nothing.
        note_possible_submit(&state, "t1", "\r").await;
        write_rollout(&home, "2026/07/26", TID, Some("/tmp"));

        // Poll drain_and_associate past the window.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        for _ in 0..40 {
            drain_and_associate(&state).await;
            if locator.armed_count() == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        // POSITIVE resolution signal FIRST, so the negative assertions
        // cannot pass vacuously: tick emitted Located and disarmed —
        // resolution HAPPENED, so whatever follows is the adoption-tail
        // guard's doing (a locator that never resolved would also leave
        // identity None, and identity-only assertions cannot tell those
        // worlds apart).
        assert_eq!(locator.armed_count(), 0);
        // Guard refused: nothing adopted.
        assert!(state.identity.session_ref_for("t1").is_none());
        let dir_entry = state
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == "t1")
            .unwrap();
        assert!(dir_entry.resume_session_id.is_none());

        state.registry.kill("t1");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// B2xB4 misbind hardening (B2 plan item 10, fix assigned to B4's
    /// territory): a freshagent codex sidecar writes rollouts into the SAME
    /// `$HOME/.codex/sessions` root, so a later bare Enter on a codex
    /// TERMINAL pane could adopt the fresh-agent thread as a sole candidate.
    /// B4's kind:fresh-agent ledger rows (written durable-before-answer at
    /// thread start) are the exclusion signal: the adoption tail must refuse
    /// a freshagent-known thread id.
    #[tokio::test]
    async fn located_freshagent_known_thread_is_rejected() {
        const TID: &str = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
        let home = unique_temp_dir("freshagent-known");
        let ledger_dir = unique_temp_dir("freshagent-known-ledger");
        let (state, _rx) = state_with_locator_and_ledger(home.clone(), &ledger_dir);

        // The fresh-agent thread's ledger row, exactly what B4's
        // record_codex_binding persists at thread/start (durable BEFORE the
        // create reply goes out).
        state
            .pane_ledger
            .record_fresh_agent_binding(&crate::pane_ledger::FreshAgentBindingWrite {
                provider: "codex",
                session_id: TID,
                mode: "freshcodex",
                cwd: Some("/tmp"),
                create_request_id: None,
                model: Some("gpt-5"),
                sandbox: None,
                permission_mode: None,
                effort: None,
                supersedes: None,
                now_ms: now_ms(),
            })
            .expect("seed fresh-agent ledger row");

        // A real PTY "t1" (codex mode), armed.
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
                "codex",
                None,
                None,
                None,
                None,
            )
            .expect("spawn a real shell for the test PTY");
        state
            .registry
            .set_meta("t1", None, None, Some("codex".to_string()), None);

        maybe_arm(&state, "t1", "codex", Some("/tmp"), None, false);
        let locator = state.codex_locator.as_ref().unwrap().clone();
        assert_eq!(locator.armed_count(), 1);

        // Bare Enter opens the window, THEN the freshagent sidecar's rollout
        // appears in the shared sessions root with the pane's own cwd -- the
        // exact misbind shape from B2 plan item 10.
        note_possible_submit(&state, "t1", "\r").await;
        write_rollout(&home, "2026/07/26", TID, Some("/tmp"));

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        for _ in 0..40 {
            drain_and_associate(&state).await;
            if locator.armed_count() == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        // Resolution HAPPENED (locator disarmed) -- so the refusal below is
        // the adoption-tail guard's doing, not a locator no-op.
        assert_eq!(locator.armed_count(), 0);
        // Guard refused: the fresh-agent thread never binds to the terminal.
        assert!(state.identity.session_ref_for("t1").is_none());
        let dir_entry = state
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == "t1")
            .unwrap();
        assert!(dir_entry.resume_session_id.is_none());

        state.registry.kill("t1");
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ledger_dir);
    }
}
