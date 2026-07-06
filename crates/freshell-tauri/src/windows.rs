//! Auxiliary window specs + the phase→window mapping — the Rust analog of
//! `electron/setup-wizard/wizard-window.ts` (640×500, `resizable:false`, centered,
//! `autoHideMenuBar`) and the launch-chooser `BrowserWindow` (760×720, shown once
//! loaded, `entry.ts:588-608`). The re-entrant Electron `main()` becomes the
//! explicit [`crate::state_machine`]; this module says WHICH window each phase
//! constructs and enforces the **per-window trust boundary** (`electron-tauri.md
//! §9 Risk 3`): a privileged command is honored only from its owning window.
//!
//! The window specs + phase→window decision + the window-label gate are pure and
//! unit-tested; the actual `WebviewWindowBuilder` construction (in `lib.rs`) is a
//! display-gated seam (`electron-tauri.md §8` items 16/17 — logic live, render
//! under Xvfb).

use crate::state_machine::ShellPhase;

/// Stable window labels (the Tauri analog of Electron `webContents.id`, used both
/// as the window handle and the trust key for per-window command gating).
pub const MAIN_WINDOW: &str = "main";
pub const WIZARD_WINDOW: &str = "wizard";
pub const CHOOSER_WINDOW: &str = "chooser";

/// A window to construct: its label, initial inner size, and chrome flags. URLs are
/// resolved by the shell (main loads the `?token=` server URL; wizard/chooser load
/// their own bundles), so they are not part of the spec.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowSpec {
    pub label: &'static str,
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub resizable: bool,
    pub center: bool,
    /// Show immediately (main/wizard) vs after load (chooser, `show:false` until
    /// `.show()` post-load — `entry.ts:588,607`).
    pub visible_on_create: bool,
}

/// The setup-wizard window spec (`wizard-window.ts:14-40`): 640×500, not resizable,
/// centered.
pub fn wizard_spec() -> WindowSpec {
    WindowSpec {
        label: WIZARD_WINDOW,
        title: "Freshell Setup".to_string(),
        width: 640.0,
        height: 500.0,
        resizable: false,
        center: true,
        visible_on_create: true,
    }
}

/// The launch-chooser window spec (`entry.ts:588-608`): 760×720, shown after its
/// bundle loads.
pub fn chooser_spec() -> WindowSpec {
    WindowSpec {
        label: CHOOSER_WINDOW,
        title: "Freshell — Choose a Server".to_string(),
        width: 760.0,
        height: 720.0,
        resizable: true,
        center: true,
        visible_on_create: false,
    }
}

/// The main window spec (`startup.ts:139-160`; default 1200×800). The bounds are
/// normally overridden by persisted [`crate::window_state`], clamped on-screen.
pub fn main_spec() -> WindowSpec {
    WindowSpec {
        label: MAIN_WINDOW,
        title: "Freshell".to_string(),
        width: crate::window_state::DEFAULT_WIDTH as f64,
        height: crate::window_state::DEFAULT_HEIGHT as f64,
        resizable: true,
        center: false,
        visible_on_create: true,
    }
}

/// The window a phase constructs. `Boot`/`Exiting` build no window (`None`); the
/// three live phases each map to their spec. This is the explicit, total
/// replacement for Electron branching inside a re-entrant `main()`.
pub fn window_for_phase(phase: ShellPhase) -> Option<WindowSpec> {
    match phase {
        ShellPhase::Main => Some(main_spec()),
        ShellPhase::Wizard => Some(wizard_spec()),
        ShellPhase::Chooser => Some(chooser_spec()),
        ShellPhase::Boot | ShellPhase::Exiting => None,
    }
}

/// The window label allowed to invoke a privileged command — the trust boundary of
/// `electron-tauri.md §2` "Security scoping":
///   * `complete-setup` → the wizard window (`entry.ts:513`),
///   * `get-launch-options` / `choose-launch-option` → the chooser window
///     (`entry.ts:538-541` `isAllowedSender === chooserWebContentsId`),
///   * `open-external-url` → the main window (`entry.ts:490-509`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivilegedCommand {
    CompleteSetup,
    GetLaunchOptions,
    ChooseLaunchOption,
    OpenExternalUrl,
}

/// The single window label permitted to invoke `command`.
pub fn owner_window(command: PrivilegedCommand) -> &'static str {
    match command {
        PrivilegedCommand::CompleteSetup => WIZARD_WINDOW,
        PrivilegedCommand::GetLaunchOptions | PrivilegedCommand::ChooseLaunchOption => {
            CHOOSER_WINDOW
        }
        PrivilegedCommand::OpenExternalUrl => MAIN_WINDOW,
    }
}

/// Whether `actual_label` may invoke `command` — the Rust analog of `isAllowedSender`
/// (a window-label check replaces the `webContents.id` check; per-window capability
/// files grant the invoke permission, this enforces which window per command).
pub fn is_allowed_window(command: PrivilegedCommand, actual_label: &str) -> bool {
    actual_label == owner_window(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_maps_to_expected_window() {
        assert_eq!(
            window_for_phase(ShellPhase::Main).unwrap().label,
            MAIN_WINDOW
        );
        assert_eq!(
            window_for_phase(ShellPhase::Wizard).unwrap().label,
            WIZARD_WINDOW
        );
        assert_eq!(
            window_for_phase(ShellPhase::Chooser).unwrap().label,
            CHOOSER_WINDOW
        );
        assert!(window_for_phase(ShellPhase::Boot).is_none());
        assert!(window_for_phase(ShellPhase::Exiting).is_none());
    }

    #[test]
    fn wizard_window_is_fixed_640x500() {
        let s = wizard_spec();
        assert_eq!((s.width, s.height), (640.0, 500.0));
        assert!(
            !s.resizable,
            "wizard is resizable:false (wizard-window.ts:16)"
        );
        assert!(s.center);
        assert!(s.visible_on_create);
    }

    #[test]
    fn chooser_window_is_760x720_shown_after_load() {
        let s = chooser_spec();
        assert_eq!((s.width, s.height), (760.0, 720.0));
        assert!(
            !s.visible_on_create,
            "chooser is show:false until its bundle loads (entry.ts:588,607)"
        );
    }

    #[test]
    fn main_window_defaults_1200x800() {
        let s = main_spec();
        assert_eq!((s.width, s.height), (1200.0, 800.0));
    }

    #[test]
    fn per_window_command_gate() {
        // Each privileged command is honored ONLY from its owning window.
        assert!(is_allowed_window(
            PrivilegedCommand::CompleteSetup,
            WIZARD_WINDOW
        ));
        assert!(!is_allowed_window(
            PrivilegedCommand::CompleteSetup,
            MAIN_WINDOW
        ));
        assert!(!is_allowed_window(
            PrivilegedCommand::CompleteSetup,
            CHOOSER_WINDOW
        ));

        assert!(is_allowed_window(
            PrivilegedCommand::ChooseLaunchOption,
            CHOOSER_WINDOW
        ));
        assert!(!is_allowed_window(
            PrivilegedCommand::ChooseLaunchOption,
            WIZARD_WINDOW
        ));

        assert!(is_allowed_window(
            PrivilegedCommand::GetLaunchOptions,
            CHOOSER_WINDOW
        ));
        assert!(is_allowed_window(
            PrivilegedCommand::OpenExternalUrl,
            MAIN_WINDOW
        ));
        assert!(!is_allowed_window(
            PrivilegedCommand::OpenExternalUrl,
            CHOOSER_WINDOW
        ));
    }
}
