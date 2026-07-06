//! Elevated PowerShell + the two-phase confirmation-token gate.
//!
//! Identical port of `server/elevated-powershell.ts` (arg building, P25) and the
//! confirmation-token state machine in `server/network-router.ts:150-758` (P26),
//! per `platform-glue.md` §6.
//!
//! ## Elevation is only ever CONSTRUCTED here
//!
//! `Start-Process -Verb RunAs` triggers an interactive Windows UAC prompt and is
//! not CI-automatable. This module *builds* the elevated command and *gates* it
//! behind a fresh confirmation token; the actual spawn goes through the injected
//! [`CommandRunner`], which in tests is always a [`crate::FakeCommandRunner`].
//! **No elevated command is ever run against a live host.**

use crate::CommandRunner;

/// `ELEVATED_POWERSHELL_TIMEOUT_MS` (`elevated-powershell.ts:3`).
pub const ELEVATED_POWERSHELL_TIMEOUT_MS: u64 = 120_000;

/// `buildElevatedPowerShellArgs` (`elevated-powershell.ts:11-17`).
///
/// Byte-exact: escape every `'` as `''`, then wrap in the fixed
/// `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '<script>'`.
pub fn build_elevated_powershell_args(script: &str) -> Vec<String> {
    let escaped = script.replace('\'', "''");
    vec![
        "-Command".to_string(),
        format!("Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '{escaped}'"),
    ]
}

/// `spawnElevatedPowerShell` (`elevated-powershell.ts:19-30`) — build the args and
/// run them through the injected layer. In production `command` is
/// `powershell.exe` (native) or the WSL `powershell.exe` path (chosen per
/// [`ConfirmationAction::powershell_command`]); in tests the runner is a fake, so
/// **this never elevates for real**.
pub fn spawn_elevated_powershell(
    runner: &dyn CommandRunner,
    command: &str,
    script: &str,
) -> crate::CommandOutput {
    let args = build_elevated_powershell_args(script);
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    runner.run(command, &arg_refs)
}

/// `ConfirmationAction` (`network-router.ts:50`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmationAction {
    WindowsRepair,
    WindowsDisable,
    Wsl2Repair,
    Wsl2Disable,
}

impl ConfirmationAction {
    pub fn as_str(self) -> &'static str {
        match self {
            ConfirmationAction::WindowsRepair => "windows-repair",
            ConfirmationAction::WindowsDisable => "windows-disable",
            ConfirmationAction::Wsl2Repair => "wsl2-repair",
            ConfirmationAction::Wsl2Disable => "wsl2-disable",
        }
    }

    /// Which PowerShell to elevate through (`network-router.ts:561-562,704-706`):
    /// the WSL path for the `wsl2-*` actions, bare `powershell.exe` otherwise.
    pub fn powershell_command(self) -> &'static str {
        match self {
            ConfirmationAction::Wsl2Repair | ConfirmationAction::Wsl2Disable => {
                "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
            }
            ConfirmationAction::WindowsRepair | ConfirmationAction::WindowsDisable => {
                "powershell.exe"
            }
        }
    }

    /// `responseMethod` (`network-router.ts:56`): `windows-elevated` for the
    /// Windows actions, `wsl2` for the WSL actions.
    pub fn response_method(self) -> &'static str {
        match self {
            ConfirmationAction::WindowsRepair | ConfirmationAction::WindowsDisable => {
                "windows-elevated"
            }
            ConfirmationAction::Wsl2Repair | ConfirmationAction::Wsl2Disable => "wsl2",
        }
    }
}

/// `WINDOWS_ELEVATION_CONFIRMATION` + the issued token (`network-router.ts:28-33,218-228`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmationResponse {
    pub method: &'static str,
    pub title: &'static str,
    pub body: &'static str,
    pub confirm_label: &'static str,
    pub confirmation_token: String,
}

impl ConfirmationResponse {
    fn new(token: impl Into<String>) -> Self {
        Self {
            method: "confirmation-required",
            title: "Administrator approval required",
            body: "To complete this, you will need to accept the Windows administrator \
prompt on the next screen.",
            confirm_label: "Continue",
            confirmation_token: token.into(),
        }
    }
}

/// The outcome of a `/network/configure-firewall`-style elevation request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElevationDecision {
    /// Phase 1 — a fresh token was issued; the client must re-POST to confirm.
    /// **No elevation happened.**
    Issued(ConfirmationResponse),
    /// Confirm arrived with a stale/missing token — a new token was re-issued.
    /// **No elevation happened.**
    Reissued(ConfirmationResponse),
    /// A confirmed repair is already in flight (HTTP 409).
    Locked,
    /// The confirmed token matched under the lock — the elevated command was
    /// constructed and dispatched through the injected runner (a fake in tests).
    Started { method: &'static str },
}

/// The confirmation-token / in-flight-lock state machine
/// (`network-router.ts:90-262`): `currentConfirmation` + `confirmedRepairInFlight`.
///
/// The `randomUUID` token generation is kept at the edge — callers pass the fresh
/// token into [`ConfirmationGate::request_elevation`], so this gate is fully
/// deterministic for tests (the oracle normalizes the UUID anyway).
#[derive(Debug, Default)]
pub struct ConfirmationGate {
    current: Option<Confirmation>,
    repair_in_flight: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Confirmation {
    token: String,
    action: ConfirmationAction,
}

impl ConfirmationGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// `issueConfirmation` (`network-router.ts:218-228`): store `{token, action}`
    /// and return the UX copy + token.
    pub fn issue_confirmation(
        &mut self,
        action: ConfirmationAction,
        token: &str,
    ) -> ConfirmationResponse {
        self.current = Some(Confirmation { token: token.to_string(), action });
        ConfirmationResponse::new(token)
    }

    /// `matchesConfirmation` (`network-router.ts:230-235`).
    pub fn matches_confirmation(&self, token: Option<&str>, action: ConfirmationAction) -> bool {
        match (&self.current, token) {
            (Some(c), Some(t)) => c.token == t && c.action == action,
            _ => false,
        }
    }

    /// `consumeConfirmation` (`network-router.ts:237-244`): if it matches, clear
    /// and return `true`.
    pub fn consume_confirmation(&mut self, token: Option<&str>, action: ConfirmationAction) -> bool {
        if self.matches_confirmation(token, action) {
            self.current = None;
            true
        } else {
            false
        }
    }

    /// `consumeCurrentConfirmation` (`network-router.ts:95-103`): clear if the
    /// token matches the current confirmation (regardless of action).
    pub fn consume_current_confirmation(&mut self, token: Option<&str>) -> bool {
        match (&self.current, token) {
            (Some(c), Some(t)) if c.token == t => {
                self.current = None;
                true
            }
            _ => false,
        }
    }

    pub fn is_repair_in_flight(&self) -> bool {
        self.repair_in_flight
    }

    /// `acquireConfirmedRepairLock` (`network-router.ts:246-262`): `false` if a
    /// repair is already in flight, else take the lock.
    pub fn try_acquire_repair_lock(&mut self) -> bool {
        if self.repair_in_flight {
            return false;
        }
        self.repair_in_flight = true;
        true
    }

    /// The idempotent lock release (the returned closure in the reference).
    pub fn release_repair_lock(&mut self) {
        self.repair_in_flight = false;
    }

    /// The confirmable branch of `/network/configure-firewall` &
    /// `/network/disable-remote-access` (`network-router.ts:653-733`), reduced to
    /// the gate essentials: issue → confirm → lock → (fresh re-check ==) → spawn.
    ///
    /// `runner` is the injected process layer; with a fake it proves elevation is
    /// only ever *constructed*, never really run.
    pub fn request_elevation(
        &mut self,
        action: ConfirmationAction,
        script: &str,
        confirm_elevation: bool,
        provided_token: Option<&str>,
        new_token: &str,
        runner: &dyn CommandRunner,
    ) -> ElevationDecision {
        // Pre-check: a confirmed repair already running -> 409.
        if self.repair_in_flight {
            return ElevationDecision::Locked;
        }

        // Phase 1: no confirmation yet (or token mismatch) -> issue a fresh token.
        if !confirm_elevation || !self.matches_confirmation(provided_token, action) {
            return ElevationDecision::Issued(self.issue_confirmation(action, new_token));
        }

        // Phase 2: take the lock (409 if lost the race).
        if !self.try_acquire_repair_lock() {
            return ElevationDecision::Locked;
        }

        // Re-derive & consume the token under the lock; stale token -> re-issue.
        if !self.consume_confirmation(provided_token, action) {
            self.release_repair_lock();
            return ElevationDecision::Reissued(self.issue_confirmation(action, new_token));
        }

        // Construct & dispatch the elevated command through the injected layer.
        // (In the reference, verify/persist/release happen in the spawn callback;
        // the fake completes synchronously, so we release right after.)
        let _out = spawn_elevated_powershell(runner, action.powershell_command(), script);
        self.release_repair_lock();
        ElevationDecision::Started { method: action.response_method() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommandOutput, FakeCommandRunner};

    // ---- P25: elevated arg building (byte-exact golden) -------------------

    #[test]
    fn elevated_args_golden_no_quotes() {
        let script = "netsh advfirewall firewall add rule name=FreshellLANAccess \
dir=in action=allow protocol=tcp localport=3001 profile=private";
        let args = build_elevated_powershell_args(script);
        assert_eq!(args[0], "-Command");
        assert_eq!(
            args[1],
            "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', \
'netsh advfirewall firewall add rule name=FreshellLANAccess dir=in action=allow \
protocol=tcp localport=3001 profile=private'"
        );
    }

    #[test]
    fn elevated_args_double_single_quotes() {
        // Every `'` -> `''`.
        let args = build_elevated_powershell_args("Write-Host 'hi'");
        assert_eq!(
            args[1],
            "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', \
'Write-Host ''hi'''"
        );
    }

    #[test]
    fn timeout_constant() {
        assert_eq!(ELEVATED_POWERSHELL_TIMEOUT_MS, 120_000);
    }

    // ---- action metadata ---------------------------------------------------

    #[test]
    fn action_strings_and_powershell_and_method() {
        assert_eq!(ConfirmationAction::WindowsRepair.as_str(), "windows-repair");
        assert_eq!(ConfirmationAction::WindowsDisable.as_str(), "windows-disable");
        assert_eq!(ConfirmationAction::Wsl2Repair.as_str(), "wsl2-repair");
        assert_eq!(ConfirmationAction::Wsl2Disable.as_str(), "wsl2-disable");

        assert_eq!(ConfirmationAction::WindowsRepair.powershell_command(), "powershell.exe");
        assert_eq!(
            ConfirmationAction::Wsl2Repair.powershell_command(),
            "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
        );
        assert_eq!(
            ConfirmationAction::Wsl2Disable.powershell_command(),
            "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
        );

        assert_eq!(ConfirmationAction::WindowsRepair.response_method(), "windows-elevated");
        assert_eq!(ConfirmationAction::Wsl2Repair.response_method(), "wsl2");
    }

    // ---- P26: two-phase flow (never spawns without a matching token) -------

    #[test]
    fn phase1_issues_token_and_never_spawns() {
        let mut gate = ConfirmationGate::new();
        let runner = FakeCommandRunner::new().with_default(CommandOutput::success(""));

        let decision = gate.request_elevation(
            ConfirmationAction::Wsl2Repair,
            "netsh ... ",
            /* confirm */ false,
            /* token */ None,
            "TOKEN-1",
            &runner,
        );
        match decision {
            ElevationDecision::Issued(resp) => {
                assert_eq!(resp.method, "confirmation-required");
                assert_eq!(resp.confirmation_token, "TOKEN-1");
                assert_eq!(resp.confirm_label, "Continue");
            }
            other => panic!("expected Issued, got {other:?}"),
        }
        // Crucial: elevation was NOT constructed/run.
        assert_eq!(runner.call_count(), 0, "phase 1 must not spawn");
    }

    #[test]
    fn phase2_matching_token_spawns_via_injected_fake() {
        let mut gate = ConfirmationGate::new();
        let runner = FakeCommandRunner::new().with_default(CommandOutput::success(""));

        // Phase 1
        let issued = gate.request_elevation(
            ConfirmationAction::Wsl2Repair,
            "SCRIPT",
            false,
            None,
            "TOKEN-1",
            &runner,
        );
        let token = match issued {
            ElevationDecision::Issued(r) => r.confirmation_token,
            other => panic!("expected Issued, got {other:?}"),
        };

        // Phase 2 with the matching token
        let started = gate.request_elevation(
            ConfirmationAction::Wsl2Repair,
            "SCRIPT",
            true,
            Some(&token),
            "TOKEN-2",
            &runner,
        );
        assert_eq!(started, ElevationDecision::Started { method: "wsl2" });

        // Exactly one elevated spawn, through the WSL powershell path, with the
        // byte-exact elevated args.
        assert_eq!(runner.call_count(), 1);
        let (cmd, args) = runner.calls().into_iter().next().unwrap();
        assert_eq!(cmd, "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
        assert_eq!(args[0], "-Command");
        assert_eq!(
            args[1],
            "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', 'SCRIPT'"
        );
        // Token consumed — a replay re-issues instead of spawning again.
        assert!(gate.current.is_none());
    }

    #[test]
    fn confirm_with_wrong_token_reissues_and_does_not_spawn() {
        let mut gate = ConfirmationGate::new();
        let runner = FakeCommandRunner::new().with_default(CommandOutput::success(""));
        gate.issue_confirmation(ConfirmationAction::WindowsRepair, "REAL");

        let decision = gate.request_elevation(
            ConfirmationAction::WindowsRepair,
            "SCRIPT",
            true,
            Some("WRONG"),
            "TOKEN-NEW",
            &runner,
        );
        // Mismatch -> phase-1 issue path (a fresh token), no spawn.
        match decision {
            ElevationDecision::Issued(r) => assert_eq!(r.confirmation_token, "TOKEN-NEW"),
            other => panic!("expected Issued, got {other:?}"),
        }
        assert_eq!(runner.call_count(), 0);
    }

    #[test]
    fn in_flight_repair_returns_locked_409() {
        let mut gate = ConfirmationGate::new();
        let runner = FakeCommandRunner::new().with_default(CommandOutput::success(""));

        // Simulate a confirmed repair already running.
        assert!(gate.try_acquire_repair_lock());
        let decision = gate.request_elevation(
            ConfirmationAction::WindowsRepair,
            "SCRIPT",
            true,
            Some("whatever"),
            "TOKEN",
            &runner,
        );
        assert_eq!(decision, ElevationDecision::Locked);
        assert_eq!(runner.call_count(), 0);

        gate.release_repair_lock();
        assert!(!gate.is_repair_in_flight());
    }

    #[test]
    fn second_lock_acquire_fails_until_released() {
        let mut gate = ConfirmationGate::new();
        assert!(gate.try_acquire_repair_lock());
        assert!(!gate.try_acquire_repair_lock()); // already held
        gate.release_repair_lock();
        assert!(gate.try_acquire_repair_lock()); // released -> re-acquirable
    }

    #[test]
    fn consume_current_confirmation_matches_any_action() {
        let mut gate = ConfirmationGate::new();
        gate.issue_confirmation(ConfirmationAction::Wsl2Disable, "T");
        assert!(!gate.consume_current_confirmation(Some("nope")));
        assert!(gate.consume_current_confirmation(Some("T")));
        assert!(!gate.consume_current_confirmation(Some("T"))); // already cleared
    }
}
