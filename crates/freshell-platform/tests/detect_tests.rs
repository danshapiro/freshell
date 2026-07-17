//! Table-driven OS/WSL detection matrix (`platform-glue.md §0`, P1). Pins BOTH
//! regimes as **separate** predicates and their **CD-1** disagreement.

use freshell_platform::detect::{
    detect_platform_proc, is_wsl2_proc, is_wsl_env, is_wsl_proc, resolve_platform, HostOs, Platform,
};
use freshell_platform::MapEnv;

/// Build a MapEnv from the three WSL env vars (None = unset).
fn env(distro: Option<&str>, interop: Option<&str>, wslenv: Option<&str>) -> MapEnv {
    let mut e = MapEnv::new();
    if let Some(v) = distro {
        e.set("WSL_DISTRO_NAME", v);
    }
    if let Some(v) = interop {
        e.set("WSL_INTEROP", v);
    }
    if let Some(v) = wslenv {
        e.set("WSLENV", v);
    }
    e
}

// ===========================================================================
// Regime A (env-var) — `terminal-registry.ts:870`, `path-utils.ts:75`
// ===========================================================================

/// (host, WSL_DISTRO_NAME, WSL_INTEROP, WSLENV, expected is_wsl_env)
type RegimeARow = (
    HostOs,
    Option<&'static str>,
    Option<&'static str>,
    Option<&'static str>,
    bool,
);

#[test]
fn regime_a_env_matrix() {
    let rows: &[RegimeARow] = &[
        // Linux + any single WSL var (non-empty) -> true.
        (HostOs::Linux, Some("Ubuntu"), None, None, true),
        (HostOs::Linux, None, Some("/run/WSL/1_interop"), None, true),
        (HostOs::Linux, None, None, Some("WT_SESSION::"), true),
        (
            HostOs::Linux,
            Some("Ubuntu"),
            Some("/run/WSL/x"),
            Some("y"),
            true,
        ),
        // Linux + no vars / empty vars -> false (JS `!!` treats "" as falsy).
        (HostOs::Linux, None, None, None, false),
        (HostOs::Linux, Some(""), Some(""), Some(""), false),
        // Non-linux platforms never A-detect, even with the vars set.
        (HostOs::Windows, Some("Ubuntu"), Some("x"), Some("y"), false),
        (HostOs::Macos, Some("Ubuntu"), None, None, false),
    ];
    for (host, d, i, w, expected) in rows {
        assert_eq!(
            is_wsl_env(*host, &env(*d, *i, *w)),
            *expected,
            "is_wsl_env({host:?}, distro={d:?}, interop={i:?}, wslenv={w:?})"
        );
    }
}

// ===========================================================================
// Regime B (/proc/version) — `platform.ts:12-32`
// ===========================================================================

#[test]
fn regime_b_proc_matrix() {
    // (proc_version, is_wsl2, is_wsl)
    let rows: &[(Option<&str>, bool, bool)] = &[
        // The live host's marker.
        (
            Some("Linux version 6.6.87.2-microsoft-standard-WSL2 (...)"),
            true,
            true,
        ),
        // 'wsl2' present but NOT 'microsoft': the two Regime-B predicates are
        // independent, so isWSL2()=true while isWSL()=false (`platform.ts:12-32`).
        (Some("... contains wsl2 ..."), true, false),
        (Some("... MICROSOFT-STANDARD ..."), true, true), // case-insensitive
        // WSL1: 'Microsoft' present, but not a WSL2 marker.
        (Some("Linux version 4.4.0-43-Microsoft (...)"), false, true),
        // Native Linux.
        (Some("Linux version 6.8.0-generic (...)"), false, false),
        // Unreadable /proc/version -> both false.
        (None, false, false),
    ];
    for (proc, wsl2, wsl) in rows {
        assert_eq!(is_wsl2_proc(*proc), *wsl2, "is_wsl2_proc({proc:?})");
        assert_eq!(is_wsl_proc(*proc), *wsl, "is_wsl_proc({proc:?})");
    }
}

#[test]
fn detect_platform_proc_and_resolved_platform() {
    let e = MapEnv::new();
    let wsl2 = Some("...microsoft-standard-WSL2...");
    let wsl1 = Some("...Microsoft...");
    let linux = Some("...generic...");

    assert_eq!(detect_platform_proc(HostOs::Windows, None), "win32");
    assert_eq!(detect_platform_proc(HostOs::Macos, None), "darwin");
    assert_eq!(detect_platform_proc(HostOs::Linux, wsl2), "wsl");
    assert_eq!(detect_platform_proc(HostOs::Linux, wsl1), "wsl");
    assert_eq!(detect_platform_proc(HostOs::Linux, linux), "linux");
    assert_eq!(detect_platform_proc(HostOs::Linux, None), "linux");

    assert_eq!(resolve_platform(HostOs::Linux, &e, wsl2), Platform::Wsl2);
    assert_eq!(resolve_platform(HostOs::Linux, &e, wsl1), Platform::Wsl1);
    assert_eq!(resolve_platform(HostOs::Linux, &e, linux), Platform::Linux);
    assert_eq!(
        resolve_platform(HostOs::Windows, &e, None),
        Platform::Windows
    );
    assert_eq!(resolve_platform(HostOs::Macos, &e, None), Platform::Macos);
}

// ===========================================================================
// CD-1: the two regimes must be able to disagree, faithfully.
// ===========================================================================

#[test]
fn cd1_regimes_can_disagree_both_directions() {
    // Scrubbed-env WSL2: Regime A false (no env vars) but Regime B true (/proc).
    let scrubbed = MapEnv::new();
    let wsl2_proc = Some("...microsoft-standard-WSL2...");
    assert!(!is_wsl_env(HostOs::Linux, &scrubbed));
    assert!(is_wsl2_proc(wsl2_proc));

    // Conversely, a container that sets WSL_DISTRO_NAME but has a non-WSL
    // /proc/version: Regime A true, Regime B false. (Both preserved, not merged.)
    let spoofed = MapEnv::new().with("WSL_DISTRO_NAME", "Ubuntu");
    let generic_proc = Some("Linux version 6.8.0-generic");
    assert!(is_wsl_env(HostOs::Linux, &spoofed));
    assert!(!is_wsl2_proc(generic_proc));
}
