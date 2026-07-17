//! OS / WSL detection — **both regimes, kept deliberately separate (CD-1)**.
//!
//! freshell has **two independent WSL-detection regimes** used by different
//! subsystems (`platform-glue.md §0`). A faithful port must preserve *both
//! behaviors* because they can legitimately disagree:
//!
//! - **Regime A — env-var** ([`is_wsl_env`]). Mirrors `isWsl()`
//!   (`terminal-registry.ts:870-876`) and `isWslEnvironment()`
//!   (`path-utils.ts:75-81`). **Drives terminal shell-spawn routing.**
//! - **Regime B — `/proc/version`** ([`is_wsl2_proc`] / [`is_wsl_proc`]).
//!   Mirrors `isWSL2()` / `isWSL()` (`platform.ts:12-32`). **Drives network
//!   bind (0.0.0.0), firewall, WSL port-forward.**
//!
//! > ### CANDIDATE DEVIATION CD-1 — do NOT self-unify
//! > A scrubbed-env WSL2 process (systemd unit, `env -i`, some service managers)
//! > has Regime A = `false` (env vars stripped) but Regime B = `true`
//! > (`/proc/version` still says WSL2). The reference tolerates this because the
//! > two subsystems are independent. **Naively collapsing both into one predicate
//! > changes behavior in that case** (`platform-glue.md §0.2 [BUG?]`). This crate
//! > therefore keeps `is_wsl_env` and `is_wsl2_proc` as **separate** functions and
//! > [`build_spawn_spec`](crate::spawn::build_spawn_spec) takes Regime A
//! > explicitly. Unifying is a `DELIBERATE_FIX` requiring antagonist adjudication
//! > and is intentionally **not** done here.

use crate::Env;

/// The three `process.platform` values freshell branches on.
///
/// (Node's `process.platform` has more values, but every platform check in the
/// ported code compares against `'win32'`, `'darwin'`, or `'linux'`; anything
/// else is treated as the generic non-Windows/non-macOS path.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOs {
    /// `process.platform === 'linux'` (includes WSL, which *is* Linux).
    Linux,
    /// `process.platform === 'darwin'`.
    Macos,
    /// `process.platform === 'win32'`.
    Windows,
}

/// The single unified platform view suggested by the frozen ADR
/// (Decision 4.1: "compute one `Platform` enum once").
///
/// **This is a convenience view derived from Regime B (`/proc/version`), used for
/// the *network* semantics that need the WSL1/WSL2 distinction. It does NOT
/// replace the two predicates (CD-1).** In particular,
/// [`build_spawn_spec`](crate::spawn::build_spawn_spec) must consult
/// [`is_wsl_env`] (Regime A) directly, **never** this enum — otherwise a
/// scrubbed-env WSL2 process would be mis-routed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Macos,
    Windows,
    Wsl1,
    Wsl2,
}

// ---------------------------------------------------------------------------
// Regime A — env-var based (drives the terminal-spawn stack)
// ---------------------------------------------------------------------------

/// **Regime A.** `process.platform === 'linux' && (!!WSL_DISTRO_NAME ||
/// !!WSL_INTEROP || !!WSLENV)` — verbatim from `terminal-registry.ts:870-876`
/// (byte-identical copy `isWslEnvironment` at `path-utils.ts:75-81`).
///
/// Used by the terminal shell-spawn stack. See the module-level CD-1 note: this
/// is intentionally distinct from [`is_wsl2_proc`] and the two must not be merged.
pub fn is_wsl_env(host_os: HostOs, env: &dyn Env) -> bool {
    host_os == HostOs::Linux
        && (env.truthy("WSL_DISTRO_NAME") || env.truthy("WSL_INTEROP") || env.truthy("WSLENV"))
}

/// `process.platform === 'win32'` (`terminal-registry.ts:862-864`).
pub fn is_windows(host_os: HostOs) -> bool {
    host_os == HostOs::Windows
}

/// `isWindows() || isWsl()` (`terminal-registry.ts:882-884`) — true where Windows
/// shells (cmd/powershell) are reachable (native Windows or WSL interop).
///
/// Takes Regime A (`is_wsl_env`) explicitly, per CD-1.
pub fn is_windows_like(host_os: HostOs, is_wsl_env: bool) -> bool {
    is_windows(host_os) || is_wsl_env
}

// ---------------------------------------------------------------------------
// Regime B — /proc/version based (drives network / firewall / port-forward)
// ---------------------------------------------------------------------------

/// **Regime B.** `isWSL2()` (`platform.ts:12-19`): `/proc/version` (lowercased)
/// `.includes('wsl2') || .includes('microsoft-standard')`.
///
/// `proc_version` is the raw contents of `/proc/version`, or `None` if unreadable
/// (the reference's `try/catch` returns `false` on read failure).
///
/// See the module-level CD-1 note: distinct from [`is_wsl_env`] on purpose.
pub fn is_wsl2_proc(proc_version: Option<&str>) -> bool {
    match proc_version {
        Some(v) => {
            let lower = v.to_lowercase();
            lower.contains("wsl2") || lower.contains("microsoft-standard")
        }
        None => false,
    }
}

/// **Regime B.** `isWSL()` (`platform.ts:25-32`): `/proc/version` (lowercased)
/// `.includes('microsoft')` — matches WSL1 **and** WSL2. `None` -> `false`.
pub fn is_wsl_proc(proc_version: Option<&str>) -> bool {
    match proc_version {
        Some(v) => v.to_lowercase().contains("microsoft"),
        None => false,
    }
}

/// **Regime B.** `detectPlatform()` (`platform.ts:39-55`): non-linux ->
/// `process.platform`; linux + `/proc/version` contains `microsoft|wsl` ->
/// `"wsl"`; else `"linux"`. Returns the same string set the reference does
/// (`"win32" | "darwin" | "linux" | "wsl"`), used by firewall/network detection.
pub fn detect_platform_proc(host_os: HostOs, proc_version: Option<&str>) -> &'static str {
    match host_os {
        HostOs::Windows => "win32",
        HostOs::Macos => "darwin",
        HostOs::Linux => match proc_version {
            Some(v) => {
                let lower = v.to_lowercase();
                if lower.contains("microsoft") || lower.contains("wsl") {
                    "wsl"
                } else {
                    "linux"
                }
            }
            None => "linux",
        },
    }
}

/// Compute the single unified [`Platform`] enum once (ADR Decision 4.1).
///
/// **Derived from Regime B** for the WSL1/WSL2 split (network semantics).
/// Does **not** replace [`is_wsl_env`] (Regime A) for shell-spawn routing — see
/// the module-level CD-1 note and [`Platform`]. `env` is currently unused for the
/// derivation (Regime B keys off `/proc/version` only); it is threaded so the
/// signature stays stable if a future ledgered CD-1 fix needs Regime A here.
pub fn resolve_platform(host_os: HostOs, _env: &dyn Env, proc_version: Option<&str>) -> Platform {
    match host_os {
        HostOs::Windows => Platform::Windows,
        HostOs::Macos => Platform::Macos,
        HostOs::Linux => {
            if is_wsl2_proc(proc_version) {
                Platform::Wsl2
            } else if is_wsl_proc(proc_version) {
                // 'microsoft' present but not a WSL2 marker -> WSL1.
                Platform::Wsl1
            } else {
                Platform::Linux
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Live edges — thin wrappers that perform the real reads, then delegate.
// (Kept out of the pure logic paths above; used by the eventual server wiring.)
// ---------------------------------------------------------------------------

/// The real host OS at compile time (mirrors `process.platform` for the target).
pub fn host_os_live() -> HostOs {
    if cfg!(target_os = "windows") {
        HostOs::Windows
    } else if cfg!(target_os = "macos") {
        HostOs::Macos
    } else {
        HostOs::Linux
    }
}

/// Read `/proc/version` (Regime B source). `None` on any error, matching the
/// reference's `try/catch`.
pub fn read_proc_version() -> Option<String> {
    std::fs::read_to_string("/proc/version").ok()
}

/// Live Regime A: real `process.platform` + real env.
pub fn is_wsl_env_live() -> bool {
    is_wsl_env(host_os_live(), &crate::RealEnv)
}

/// Live Regime B (WSL2): real `/proc/version`.
pub fn is_wsl2_proc_live() -> bool {
    is_wsl2_proc(read_proc_version().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MapEnv;

    // ---- Regime A (env-var) ------------------------------------------------

    #[test]
    fn regime_a_true_on_linux_with_any_wsl_var() {
        for var in ["WSL_DISTRO_NAME", "WSL_INTEROP", "WSLENV"] {
            let env = MapEnv::new().with(var, "x");
            assert!(is_wsl_env(HostOs::Linux, &env), "{var} should trigger A");
        }
    }

    #[test]
    fn regime_a_false_on_linux_with_no_vars() {
        assert!(!is_wsl_env(HostOs::Linux, &MapEnv::new()));
    }

    #[test]
    fn regime_a_false_on_linux_with_empty_vars() {
        // JS `!!process.env.X`: empty string is falsy.
        let env = MapEnv::new()
            .with("WSL_DISTRO_NAME", "")
            .with("WSL_INTEROP", "")
            .with("WSLENV", "");
        assert!(!is_wsl_env(HostOs::Linux, &env));
    }

    #[test]
    fn regime_a_false_off_linux_even_with_vars() {
        // `process.platform === 'linux'` gate: Windows/macOS never A-detect.
        let env = MapEnv::new().with("WSL_DISTRO_NAME", "Ubuntu");
        assert!(!is_wsl_env(HostOs::Windows, &env));
        assert!(!is_wsl_env(HostOs::Macos, &env));
    }

    // ---- Regime B (/proc/version) -----------------------------------------

    #[test]
    fn regime_b_wsl2_markers() {
        // Live host marker + the two documented substrings, case-insensitive.
        assert!(is_wsl2_proc(Some(
            "Linux version 6.6.87.2-microsoft-standard-WSL2 ..."
        )));
        assert!(is_wsl2_proc(Some("... wsl2 ...")));
        assert!(is_wsl2_proc(Some("... MICROSOFT-STANDARD ...")));
    }

    #[test]
    fn regime_b_wsl2_false_for_wsl1_and_native_and_unreadable() {
        // WSL1: 'Microsoft' present but not a WSL2 marker.
        assert!(!is_wsl2_proc(Some("Linux version 4.4.0-Microsoft ...")));
        assert!(!is_wsl2_proc(Some("Linux version 6.0.0-generic ...")));
        assert!(!is_wsl2_proc(None)); // read failure -> false
    }

    #[test]
    fn regime_b_broad_wsl_matches_wsl1_and_wsl2() {
        assert!(is_wsl_proc(Some("... Microsoft ...")));
        assert!(is_wsl_proc(Some("...-microsoft-standard-WSL2 ...")));
        assert!(!is_wsl_proc(Some("Linux version 6.0.0-generic ...")));
        assert!(!is_wsl_proc(None));
    }

    // ---- CD-1: the two regimes CAN disagree (must, faithfully) ------------

    #[test]
    fn cd1_scrubbed_env_wsl2_disagrees_between_regimes() {
        // The scrubbed-env WSL2 case that makes unification a behavior change:
        // Regime A = false (env stripped), Regime B = true (/proc still WSL2).
        let scrubbed = MapEnv::new(); // no WSL_* vars
        let proc = Some("Linux version 6.6-microsoft-standard-WSL2 ...");
        assert!(
            !is_wsl_env(HostOs::Linux, &scrubbed),
            "Regime A must be false"
        );
        assert!(is_wsl2_proc(proc), "Regime B must be true");
    }

    // ---- detect_platform_proc ---------------------------------------------

    #[test]
    fn detect_platform_proc_matrix() {
        let wsl2 = Some("...microsoft-standard-WSL2...");
        assert_eq!(detect_platform_proc(HostOs::Windows, None), "win32");
        assert_eq!(detect_platform_proc(HostOs::Macos, None), "darwin");
        assert_eq!(detect_platform_proc(HostOs::Linux, wsl2), "wsl");
        assert_eq!(
            detect_platform_proc(HostOs::Linux, Some("... plain generic ...")),
            "linux"
        );
        assert_eq!(detect_platform_proc(HostOs::Linux, None), "linux");
    }

    // ---- resolve_platform (unified view) ----------------------------------

    #[test]
    fn resolve_platform_view() {
        let env = MapEnv::new();
        assert_eq!(
            resolve_platform(HostOs::Linux, &env, Some("...-WSL2...")),
            Platform::Wsl2
        );
        assert_eq!(
            resolve_platform(HostOs::Linux, &env, Some("...Microsoft (WSL1)...")),
            Platform::Wsl1
        );
        assert_eq!(
            resolve_platform(HostOs::Linux, &env, Some("generic")),
            Platform::Linux
        );
        assert_eq!(
            resolve_platform(HostOs::Windows, &env, None),
            Platform::Windows
        );
        assert_eq!(resolve_platform(HostOs::Macos, &env, None), Platform::Macos);
    }

    #[test]
    fn windows_like_helpers() {
        assert!(is_windows(HostOs::Windows));
        assert!(!is_windows(HostOs::Linux));
        assert!(is_windows_like(HostOs::Windows, false)); // native Windows
        assert!(is_windows_like(HostOs::Linux, true)); // WSL (Regime A)
        assert!(!is_windows_like(HostOs::Linux, false)); // plain Linux
    }
}
