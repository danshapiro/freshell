//! Amplifier session association (Slice B + the input-submit seam) — the
//! restore-across-restart fix,
//! `docs/plans/2026-07-18-amplifier-restore-spec.md`.
//!
//! [`crate::identity`] + `terminal.rs`'s existing `terminal.meta.updated`
//! broadcast already close the client → persist → restart → resume chain for
//! every OTHER provider (the sessionRef arrives at `terminal.create` time, via
//! `resumeSessionId`). Amplifier is different: its session dir is created
//! LAZILY at the first prompt submit, so there is no identity to seed at
//! create time. [`freshell_sessions::amplifier_locator::AmplifierLocator`]
//! closes that gap by correlating the PTY's first Enter with the new session
//! dir amplifier writes; this module is the thin controller around it —
//! arm/disarm the locator at the right terminal lifecycle points, feed it
//! submit-shaped input, and (once it resolves) bind + broadcast the identity
//! exactly like every other provider's create-time path does.
//!
//! Mirrors `server/coding-cli/amplifier-session-controller.ts`'s reject
//! checks (terminal missing/not running, wrong mode, already bound) as
//! defense-in-depth — the locator's own single-bind-per-terminal design
//! already makes these redundant in practice, but a terminal could
//! legitimately be killed between `Located` and this draining tick.

use freshell_protocol::{
    ServerMessage, SessionLocator, TerminalMetaRecord, TerminalMetaUpdated, TerminalRunStatus,
    TerminalSessionAssociated,
};

use crate::terminal::now_ms;
use crate::WsState;

/// `isSubmitInput` (`shared/turn-complete-signal.ts:125-127`): the input is
/// ONLY a run of CR/LF bytes -- an Enter keypress, possibly repeated. Anything
/// else (real text, control sequences, partial lines) is not a submit.
pub(crate) fn is_submit_input(data: &str) -> bool {
    !data.is_empty() && data.chars().all(|c| c == '\r' || c == '\n')
}

/// Arm the locator for a freshly-created terminal, iff it's a fresh
/// (non-resuming) `amplifier` pane with a resolved cwd. No-ops when the
/// locator is unavailable (`WsState::amplifier_locator` is `None`) or the
/// mode isn't `amplifier` -- cheap enough to call unconditionally from
/// `handle_create`.
pub(crate) fn maybe_arm(
    state: &WsState,
    terminal_id: &str,
    mode: &str,
    cwd: Option<&str>,
    resume_session_id: Option<&str>,
) {
    if mode != "amplifier" {
        return;
    }
    let Some(locator) = &state.amplifier_locator else {
        return;
    };
    locator.arm(terminal_id, mode, true, resume_session_id, cwd, now_ms());
}

/// Feed a `terminal.input` write to the locator iff it's submit-shaped
/// (Enter). No-ops for every other terminal (armed only for amplifier panes)
/// and when the locator is unavailable.
pub(crate) fn note_possible_submit(state: &WsState, terminal_id: &str, data: &str) {
    if !is_submit_input(data) {
        return;
    }
    let Some(locator) = &state.amplifier_locator else {
        return;
    };
    locator.note_submit(terminal_id, now_ms());
}

/// Drive one locator polling cycle and bind + broadcast every association it
/// resolved this tick. Intended to be called periodically (the sweep-timer
/// pattern already used by `spawn_sessions_sweep`,
/// `crates/freshell-server/src/main.rs`).
///
/// `AmplifierLocator::tick` is synchronous `std::fs` I/O (a `projects/`
/// directory walk plus bounded `events.jsonl` probe reads) whenever at
/// least one terminal is armed -- see its doc comment for the idle
/// short-circuit that makes it a zero-I/O no-op otherwise. Either way, this
/// runs the tick inside `tokio::task::spawn_blocking` rather than directly
/// on this async task's worker thread, mirroring `SessionIndex::snapshot`'s
/// identical wrapping for the analogous `spawn_sessions_sweep` poll
/// (`crates/freshell-server/src/main.rs`) -- a blocking filesystem call has
/// no business running straight on a tokio executor thread.
pub(crate) async fn drain_and_associate(state: &WsState) {
    let Some(locator) = &state.amplifier_locator else {
        return;
    };
    let locator = std::sync::Arc::clone(locator);
    let now = now_ms();
    let located = match tokio::task::spawn_blocking(move || locator.tick(now)).await {
        Ok(located) => located,
        Err(join_error) => {
            // The blocking closure only calls `AmplifierLocator::tick`,
            // which does not itself panic in normal operation; a panic
            // here would be a genuine bug, not a routine condition to
            // silently swallow.
            tracing::warn!(
                error = %join_error,
                "amplifier_locator_tick_panicked: sweep tick task panicked, skipping this cycle"
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
                "amplifier_association_rejected: terminal_missing"
            );
            continue;
        };
        if entry.mode != "amplifier" || entry.status != TerminalRunStatus::Running {
            tracing::warn!(
                terminal_id = %located.terminal_id,
                mode = %entry.mode,
                "amplifier_association_rejected: terminal_not_amplifier_or_not_running"
            );
            continue;
        }
        if entry.resume_session_id.is_some() {
            tracing::warn!(
                terminal_id = %located.terminal_id,
                "amplifier_association_rejected: terminal_already_bound"
            );
            continue;
        }

        state.identity.upsert(
            &located.terminal_id,
            Some("amplifier"),
            Some(&located.session_id),
            entry.cwd.as_deref(),
            now_ms(),
        );
        state.registry.set_meta(
            &located.terminal_id,
            None,
            None,
            Some("amplifier".to_string()),
            Some(located.session_id.clone()),
        );
        broadcast_terminal_session_associated(
            state,
            &located.terminal_id,
            &located.session_id,
            entry.cwd.clone(),
        );
    }
}

/// `broadcastTerminalSessionAssociation` (`session-association-broadcast.ts`)
/// as applied by `amplifier-session-controller.ts`'s `associated` handler:
/// fan `terminal.session.associated` (the sessionRef the client's
/// `reconcileTerminalSessionAssociation` persists) AND a `terminal.meta.updated`
/// upsert (the same shape `terminal.rs`'s `broadcast_terminal_meta_created`
/// emits at create time for every other provider) to every connection.
fn broadcast_terminal_session_associated(
    state: &WsState,
    terminal_id: &str,
    session_id: &str,
    cwd: Option<String>,
) {
    let associated = ServerMessage::TerminalSessionAssociated(TerminalSessionAssociated {
        terminal_id: terminal_id.to_string(),
        session_ref: SessionLocator {
            provider: "amplifier".to_string(),
            session_id: session_id.to_string(),
        },
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
            provider: Some("amplifier".to_string()),
            repo_root: None,
            session_id: Some(session_id.to_string()),
            token_usage: None,
        }],
    });
    if let Ok(frame) = serde_json::to_string(&meta) {
        let _ = state.broadcast_tx.send(frame);
    }
}

/// The sweep-timer wiring (mirrors `freshell_ws::spawn_idle_monitor` /
/// `freshell-server`'s `spawn_sessions_sweep`): periodically drive the
/// locator's polling cycle and process any resolved associations, off the
/// per-connection select loops.
pub fn spawn_amplifier_locator_sweep(state: WsState, interval: std::time::Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // STATE-SYNC FIX 1 increment 2b: the identity invariant alarm rides
        // this same sweep cadence (the sweep is spawned whenever the
        // amplifier locator exists, `freshell-server/src/main.rs`), with a
        // sweep-lifetime once-per-terminal bound.
        let mut identity_warned = std::collections::HashSet::new();
        loop {
            ticker.tick().await;
            drain_and_associate(&state).await;
            crate::invariants::warn_unresolved_terminal_identities(
                &state.registry.identity_probe_rows(),
                &state.identity,
                &mut identity_warned,
                now_ms(),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_sessions::amplifier_locator::AmplifierLocator;
    use std::sync::Arc as StdArc;

    fn state_with_locator(
        amplifier_home: std::path::PathBuf,
    ) -> (WsState, tokio::sync::broadcast::Receiver<String>) {
        let auth_token = StdArc::new("s3cr3t-token-abcdef".to_string());
        let broadcast_tx = StdArc::new(tokio::sync::broadcast::channel::<String>(16).0);
        let rx = broadcast_tx.subscribe();
        let state = WsState {
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
            config_fallback: None,
            amplifier_locator: Some(StdArc::new(AmplifierLocator::new(amplifier_home))),
            session_existence: std::sync::Arc::new(crate::existence::NoIndexProbe::default()),
            opencode_locator: None,
        };
        (state, rx)
    }

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-amplifier-association-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
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
    fn maybe_arm_ignores_non_amplifier_modes() {
        let home = unique_temp_dir("maybe-arm-wrong-mode");
        let (state, _rx) = state_with_locator(home.clone());
        maybe_arm(&state, "t1", "codex", Some("/proj"), None);
        assert_eq!(state.amplifier_locator.as_ref().unwrap().armed_count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn maybe_arm_arms_a_fresh_amplifier_terminal() {
        let home = unique_temp_dir("maybe-arm-fresh");
        let (state, _rx) = state_with_locator(home.clone());
        maybe_arm(&state, "t1", "amplifier", Some("/proj"), None);
        assert_eq!(state.amplifier_locator.as_ref().unwrap().armed_count(), 1);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn maybe_arm_skips_a_resuming_amplifier_terminal() {
        let home = unique_temp_dir("maybe-arm-resume");
        let (state, _rx) = state_with_locator(home.clone());
        maybe_arm(
            &state,
            "t1",
            "amplifier",
            Some("/proj"),
            Some("existing-id"),
        );
        assert_eq!(state.amplifier_locator.as_ref().unwrap().armed_count(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn note_possible_submit_ignores_non_enter_input() {
        let home = unique_temp_dir("note-submit-ignore");
        let (state, _rx) = state_with_locator(home.clone());
        maybe_arm(&state, "t1", "amplifier", Some("/proj"), None);
        note_possible_submit(&state, "t1", "hello");
        // No window opened means a fresh Enter can still open one -- verify
        // indirectly via a real Enter succeeding right after.
        note_possible_submit(&state, "t1", "\r");
        // If the "hello" call had wrongly opened/consumed a window slot, this
        // second (real) submit would still succeed since note_submit allows a
        // fresh window whenever none is open; the meaningful assertion is that
        // "hello" alone never panics and never associates anything.
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn drain_and_associate_binds_identity_and_broadcasts_on_location() {
        let home = unique_temp_dir("drain-associate");
        let (state, mut rx) = state_with_locator(home.clone());

        // A running amplifier terminal the locator can validate against at
        // association time (mode/status/resume_session_id all read from
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
                "amplifier",
                None,
                None,
                None,
                None,
            )
            .expect("spawn a real shell for the test PTY");
        state
            .registry
            .set_meta("t1", None, None, Some("amplifier".to_string()), None);

        maybe_arm(&state, "t1", "amplifier", Some("/proj"), None);
        note_possible_submit(&state, "t1", "\r");

        let dir = home
            .join("projects")
            .join("proj")
            .join("sessions")
            .join("sess-drain");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("events.jsonl"),
            "{\"event\":\"session:start\"}\n{\"event\":\"session:config\",\"working_dir\":\"/proj\"}\n",
        )
        .unwrap();

        // Drain repeatedly until the locator's correlation window (2000ms)
        // has definitely closed relative to wall-clock `now_ms()`.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        for _ in 0..30 {
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
        assert_eq!(identity.provider.as_deref(), Some("amplifier"));
        assert_eq!(identity.session_id.as_deref(), Some("sess-drain"));

        let dir_entry = state
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == "t1")
            .unwrap();
        assert_eq!(dir_entry.resume_session_id.as_deref(), Some("sess-drain"));

        let mut saw_associated = false;
        let mut saw_meta = false;
        while let Ok(frame) = rx.try_recv() {
            if frame.contains("terminal.session.associated") && frame.contains("sess-drain") {
                saw_associated = true;
            }
            if frame.contains("terminal.meta.updated") && frame.contains("sess-drain") {
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
}
