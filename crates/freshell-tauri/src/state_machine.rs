//! The explicit window state-machine — the Rust redesign of Electron's
//! **re-entrant `main()`** (`electron/entry.ts:686`, re-invoked after the wizard
//! `entry.ts:571-577` and chooser `entry.ts:543-554`, held together by the
//! module-level `wizardPhase` guard on `window-all-closed`/`will-quit`).
//!
//! Tauri has no re-entrant main. Per `architecture-spec.md:332-342` (Decision 6.2)
//! this is redesigned as an **explicit state machine over long-lived windows**:
//! `Boot → (Wizard | Chooser | Main)`, transitioning on window-close / launch-choice
//! — transitions are DATA returned by [`transition`], never a recursive call. This
//! removes the deadlock / re-entrancy hazard flagged as Risk 3.
//!
//! **Phase 3.13 scope:** only `Boot → Main` is CONSTRUCTED (the app-bound happy
//! path). `Wizard`/`Chooser` are modeled as real phases so the machine is honest &
//! total, but their windows are **deferred to Phase 3.14** — [`runnable_phase`]
//! maps them to `Main` for now (documented), so a not-yet-implemented phase can
//! never wedge the app.

/// A desktop shell phase. Long-lived; the run loop is in exactly one at a time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellPhase {
    /// Startup: read config, decide the initial phase. No window yet.
    Boot,
    /// The main window (retained SPA over the app-bound server). Implemented.
    Main,
    /// Setup wizard window (`!setupCompleted`, `startup.ts:303-305`). **Deferred to 3.14.**
    Wizard,
    /// Launch-chooser window (`show-chooser`, `launch-policy.ts`). **Deferred to 3.14.**
    Chooser,
    /// Terminal state: the app is quitting (server reaped, event loop ending).
    Exiting,
}

impl ShellPhase {
    /// Whether this phase's window is deferred to Phase 3.14 (wizard/chooser).
    pub fn is_deferred(self) -> bool {
        matches!(self, ShellPhase::Wizard | ShellPhase::Chooser)
    }
}

/// Minimal desktop config inputs the initial-phase decision reads. Mirrors the
/// fields `runStartup` branches on (`startup.ts:300-370`); the full launch-policy
/// (discovery/remote/candidates) is a 3.14 concern.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BootInputs {
    /// `desktop.json.setupCompleted` (`desktop-config.ts:26`, default false).
    pub setup_completed: bool,
    /// The configured server mode.
    pub server_mode: ServerMode,
}

/// The three server modes (`DesktopConfig.serverMode`, `types.ts:10`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerMode {
    /// Server lives & dies with the app (the mode this step implements).
    AppBound,
    /// Server is an OS service. Deferred (daemon managers → 3.14, CD-5).
    Daemon,
    /// Connect to a remote server. Deferred → 3.14.
    Remote,
}

/// Events that drive phase transitions (window lifecycle + launch choice), the
/// explicit replacement for Electron's re-entrant `main()` re-invocations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellEvent {
    /// Boot resolved the initial phase.
    Resolved(ShellPhase),
    /// The current auxiliary window (wizard/chooser) closed → re-derive from Boot
    /// (the analog of Electron re-running `main()` after wizard/chooser close, but
    /// as an explicit return-to-Boot, not recursion).
    AuxWindowClosed,
    /// A launch choice was made in the chooser → advance to Main.
    LaunchChosen,
    /// Quit requested (tray/menu/`app.quit()`).
    Quit,
}

/// The pure transition function. Total over (phase, event); returns the NEXT phase.
/// No recursion, no re-entrancy — this is the whole point of Decision 6.2.
pub fn transition(current: ShellPhase, event: ShellEvent) -> ShellPhase {
    match (current, event) {
        // Quit from anywhere → Exiting (before-quit / will-quit, main.ts:50-53).
        (_, ShellEvent::Quit) => ShellPhase::Exiting,
        // Boot resolves to whatever phase the decision produced.
        (ShellPhase::Boot, ShellEvent::Resolved(next)) => next,
        // An auxiliary window closing returns to Boot to re-derive (Electron
        // re-runs main(); we return to Boot explicitly).
        (ShellPhase::Wizard, ShellEvent::AuxWindowClosed) => ShellPhase::Boot,
        (ShellPhase::Chooser, ShellEvent::AuxWindowClosed) => ShellPhase::Boot,
        // A chooser selection advances straight to Main (forced-launch,
        // startup.ts:307-309).
        (ShellPhase::Chooser, ShellEvent::LaunchChosen) => ShellPhase::Main,
        // Otherwise the phase is unchanged (e.g. Main ignores AuxWindowClosed).
        (phase, _) => phase,
    }
}

/// Decide the initial phase from boot inputs. Mirrors `runStartup`'s ordering
/// (`startup.ts:303-370`): `!setupCompleted` → Wizard; otherwise the mode selects
/// the path (app-bound/daemon/remote all land on the Main window once a server URL
/// is obtained — the difference is only HOW the server is obtained, §3.1).
pub fn decide_initial_phase(inputs: BootInputs) -> ShellPhase {
    if !inputs.setup_completed {
        return ShellPhase::Wizard;
    }
    match inputs.server_mode {
        // All three modes ultimately show the Main window; app-bound is the only
        // one whose server this step spawns. Daemon/remote resolution is 3.14.
        ServerMode::AppBound | ServerMode::Daemon | ServerMode::Remote => ShellPhase::Main,
    }
}

/// Map a decided phase onto what this step can actually CONSTRUCT. Wizard/Chooser
/// windows are deferred to Phase 3.14, so they degrade to `Main` here (documented,
/// so a deferred phase never wedges the app). `Main`/`Boot`/`Exiting` pass through.
pub fn runnable_phase(decided: ShellPhase) -> ShellPhase {
    if decided.is_deferred() {
        ShellPhase::Main
    } else {
        decided
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unconfigured_app_decides_wizard() {
        let inputs = BootInputs {
            setup_completed: false,
            server_mode: ServerMode::AppBound,
        };
        assert_eq!(decide_initial_phase(inputs), ShellPhase::Wizard);
    }

    #[test]
    fn configured_app_bound_decides_main() {
        let inputs = BootInputs {
            setup_completed: true,
            server_mode: ServerMode::AppBound,
        };
        assert_eq!(decide_initial_phase(inputs), ShellPhase::Main);
    }

    #[test]
    fn configured_daemon_and_remote_also_reach_main() {
        for mode in [ServerMode::Daemon, ServerMode::Remote] {
            let inputs = BootInputs {
                setup_completed: true,
                server_mode: mode,
            };
            assert_eq!(decide_initial_phase(inputs), ShellPhase::Main);
        }
    }

    #[test]
    fn deferred_phases_degrade_to_main_this_step() {
        assert_eq!(runnable_phase(ShellPhase::Wizard), ShellPhase::Main);
        assert_eq!(runnable_phase(ShellPhase::Chooser), ShellPhase::Main);
        // Non-deferred phases pass through untouched.
        assert_eq!(runnable_phase(ShellPhase::Main), ShellPhase::Main);
        assert_eq!(runnable_phase(ShellPhase::Boot), ShellPhase::Boot);
        assert_eq!(runnable_phase(ShellPhase::Exiting), ShellPhase::Exiting);
    }

    #[test]
    fn boot_resolves_to_decided_phase() {
        assert_eq!(
            transition(ShellPhase::Boot, ShellEvent::Resolved(ShellPhase::Main)),
            ShellPhase::Main
        );
    }

    #[test]
    fn aux_windows_return_to_boot_not_recursion() {
        // The explicit replacement for Electron re-invoking main().
        assert_eq!(
            transition(ShellPhase::Wizard, ShellEvent::AuxWindowClosed),
            ShellPhase::Boot
        );
        assert_eq!(
            transition(ShellPhase::Chooser, ShellEvent::AuxWindowClosed),
            ShellPhase::Boot
        );
    }

    #[test]
    fn chooser_selection_advances_to_main() {
        assert_eq!(
            transition(ShellPhase::Chooser, ShellEvent::LaunchChosen),
            ShellPhase::Main
        );
    }

    #[test]
    fn quit_from_any_phase_exits() {
        for phase in [
            ShellPhase::Boot,
            ShellPhase::Main,
            ShellPhase::Wizard,
            ShellPhase::Chooser,
        ] {
            assert_eq!(transition(phase, ShellEvent::Quit), ShellPhase::Exiting);
        }
    }

    #[test]
    fn main_ignores_aux_close() {
        assert_eq!(
            transition(ShellPhase::Main, ShellEvent::AuxWindowClosed),
            ShellPhase::Main
        );
    }
}
