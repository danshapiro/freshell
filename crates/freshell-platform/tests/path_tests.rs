//! Table-driven path-conversion tests, transcribed from the spec (`platform-glue.md §1`)
//! and cross-checked against **Node ground truth** (`path.win32.resolve` + a verbatim
//! inline transcription of `path-utils.ts`, captured on the live WSL2 host and against
//! `wslpath -w/-u`). Every row cites the documented rule it pins.

use freshell_platform::path::{
    convert_windows_path_to_wsl_path, convert_wsl_drive_path_to_windows_path,
    detect_user_path_flavor, is_linux_path, resolve_launch_cwd, sanitize_user_path_input,
    win32_resolve, LaunchCwdConversion, LaunchCwdTargetRuntime, UserPathFlavor,
};
use freshell_platform::MapEnv;

/// Default WSL2/Ubuntu env (mount prefix `/mnt`), matching the live host.
fn wsl_ubuntu_env() -> MapEnv {
    MapEnv::new().with("WSL_DISTRO_NAME", "Ubuntu")
}

// ===========================================================================
// §1.1 sanitize + flavor detection
// ===========================================================================

#[test]
fn sanitize_strips_one_wrapping_quote_pair_and_trims() {
    assert_eq!(sanitize_user_path_input("  /mnt/c/x  "), "/mnt/c/x");
    assert_eq!(sanitize_user_path_input("\"/mnt/c/x\""), "/mnt/c/x");
    assert_eq!(sanitize_user_path_input("'/mnt/c/x'"), "/mnt/c/x");
    assert_eq!(sanitize_user_path_input("\" spaced \""), "spaced"); // inner re-trimmed
    assert_eq!(sanitize_user_path_input("''"), ""); // empty inner
    assert_eq!(sanitize_user_path_input("'mismatch\""), "'mismatch\""); // not a matching pair
    assert_eq!(sanitize_user_path_input("   "), "");
}

#[test]
fn flavor_detection_matrix() {
    use UserPathFlavor::*;
    // WINDOWS: drive (with sep or end), UNC, single-rooted.
    for w in [
        "C:",
        "C:\\",
        "c:/",
        "D:\\a",
        "\\\\server\\share\\x",
        "\\foo",
    ] {
        assert_eq!(detect_user_path_flavor(w), Windows, "{w:?} -> windows");
    }
    // POSIX: leading slash (that is not classified windows).
    for p in ["/home/x", "/mnt/c", "//wsl.localhost/Ubuntu"] {
        assert_eq!(detect_user_path_flavor(p), Posix, "{p:?} -> posix");
    }
    // NATIVE: relative, drive-relative, empty.
    for n in ["relative/path", "C:foo", "", "  "] {
        assert_eq!(detect_user_path_flavor(n), Native, "{n:?} -> native");
    }
}

#[test]
fn is_linux_path_excludes_double_slash() {
    assert!(is_linux_path("/home/dan"));
    assert!(!is_linux_path("//server/share")); // UNC-ish, not a Linux path
    assert!(!is_linux_path("C:\\x"));
    assert!(!is_linux_path("relative"));
}

// ===========================================================================
// win32.resolve goldens (Node path.win32.resolve, single absolute arg)
// ===========================================================================

#[test]
fn win32_resolve_goldens_from_node() {
    let rows: &[(&str, Option<&str>)] = &[
        ("C:\\", Some("C:\\")),
        ("C:\\foo", Some("C:\\foo")),
        ("c:/foo", Some("c:\\foo")), // drive-letter case preserved
        ("D:\\a\\b", Some("D:\\a\\b")),
        ("C:\\a\\..\\b", Some("C:\\b")),
        ("C:\\a\\.\\b", Some("C:\\a\\b")),
        ("C:\\foo\\", Some("C:\\foo")),
        ("C:\\foo\\\\bar", Some("C:\\foo\\bar")),
        ("D:/a/b", Some("D:\\a\\b")),
        ("C:\\Program Files\\x", Some("C:\\Program Files\\x")),
        ("\\\\server\\share\\x", Some("\\\\server\\share\\x")),
        (
            "\\\\wsl.localhost\\Ubuntu",
            Some("\\\\wsl.localhost\\Ubuntu\\"),
        ), // UNC root -> trailing sep
        (
            "//wsl.localhost/Ubuntu/x",
            Some("\\\\wsl.localhost\\Ubuntu\\x"),
        ),
        // cwd-dependent inputs -> None (deterministic-core boundary).
        ("C:", None),
        ("C:foo", None),
        ("\\foo", None),
        ("relative", None),
    ];
    for (input, expected) in rows {
        assert_eq!(
            win32_resolve(input).as_deref(),
            *expected,
            "win32_resolve({input:?})"
        );
    }
}

// ===========================================================================
// §1.3 convertWslDrivePathToWindowsPath  (/mnt/c -> C:\)
// ===========================================================================

#[test]
fn wsl_drive_to_windows_default_mount() {
    let env = wsl_ubuntu_env();
    let rows: &[(&str, Option<&str>)] = &[
        ("/mnt/d/foo/bar", Some("D:\\foo\\bar")),
        ("/mnt/c", Some("C:\\")),
        ("/mnt/c/", Some("C:\\")),
        ("/mnt/D/x", Some("D:\\x")), // drive letter upper-cased
        ("/mnt/c/a b/c", Some("C:\\a b\\c")),
        ("/mnt/c/Users/dan", Some("C:\\Users\\dan")),
        ("\"/mnt/c/x\"", Some("C:\\x")), // quotes stripped by sanitize
        ("\\mnt\\c\\x", Some("C:\\x")),  // backslashes normalized to slashes first
        ("/mnt/", None),                 // no drive letter
        ("/mnt/1", None),                // digit is not [a-zA-Z]
        ("/mnt/cc/x", None),             // two-char segment is not a single drive letter
        ("/home/dan", None),             // not under the mount prefix
        ("", None),
    ];
    for (input, expected) in rows {
        assert_eq!(
            convert_wsl_drive_path_to_windows_path(input, &env).as_deref(),
            *expected,
            "convert_wsl_drive_path_to_windows_path({input:?})"
        );
    }
}

#[test]
fn wsl_drive_to_windows_root_mount_empty_prefix() {
    // WSL_WINDOWS_SYS32=/c/Windows/System32 -> mount prefix "" (drives at root).
    let env = MapEnv::new()
        .with("WSL_DISTRO_NAME", "Ubuntu")
        .with("WSL_WINDOWS_SYS32", "/c/Windows/System32");
    let rows: &[(&str, Option<&str>)] = &[
        ("/d/foo", Some("D:\\foo")),
        ("/c", Some("C:\\")),
        ("/c/", Some("C:\\")),
        ("/z/a/b", Some("Z:\\a\\b")),
        ("/mnt/c/x", None), // /mnt is no longer the prefix
    ];
    for (input, expected) in rows {
        assert_eq!(
            convert_wsl_drive_path_to_windows_path(input, &env).as_deref(),
            *expected,
            "root-mount convert_wsl_drive_path_to_windows_path({input:?})"
        );
    }
}

#[test]
fn wsl_drive_to_windows_custom_mount_prefix() {
    // WSL_WINDOWS_SYS32=/custom/c/Windows/System32 -> mount prefix "/custom".
    let env = MapEnv::new()
        .with("WSL_DISTRO_NAME", "Ubuntu")
        .with("WSL_WINDOWS_SYS32", "/custom/c/Windows/System32");
    assert_eq!(
        convert_wsl_drive_path_to_windows_path("/custom/c/proj", &env).as_deref(),
        Some("C:\\proj")
    );
    // Default /mnt no longer matches under a custom prefix.
    assert_eq!(
        convert_wsl_drive_path_to_windows_path("/mnt/c/x", &env),
        None
    );
}

// ===========================================================================
// §1.4 convertWindowsPathToWslPath  (C:\ -> /mnt/c, UNC, POSIX-guard)
// ===========================================================================

#[test]
fn windows_to_wsl_default_mount_wsl_env() {
    let env = wsl_ubuntu_env();
    let rows: &[(&str, Option<&str>)] = &[
        ("D:\\a\\b", Some("/mnt/d/a/b")),
        ("C:\\Users\\dan", Some("/mnt/c/Users/dan")),
        ("C:\\", Some("/mnt/c")), // note: NO trailing slash (rest is empty)
        ("c:\\foo", Some("/mnt/c/foo")),
        ("C:\\a b\\c", Some("/mnt/c/a b/c")),
        ("/home/x", None), // POSIX-guard (`:124`)
        ("\\foo", None),   // rooted -> not resolvable/absolute
        ("\\\\wsl.localhost\\Ubuntu\\home\\dan", Some("/home/dan")),
        ("\\\\wsl.localhost\\Ubuntu", Some("/")), // UNC root -> "/"
        ("\\\\wsl.localhost\\ubuntu\\x", Some("/x")), // distro match is case-insensitive
        ("\\\\WSL.LOCALHOST\\Ubuntu\\x", Some("/x")), // prefix match is case-insensitive
        ("\\\\wsl$\\Ubuntu\\x", None),            // `\\wsl$\` share form NOT handled
        ("\\\\wsl.localhost\\Debian\\x", None),   // distro mismatch (current=Ubuntu)
        ("\\\\server\\share", None),              // non-wsl UNC
        ("", None),
    ];
    for (input, expected) in rows {
        assert_eq!(
            convert_windows_path_to_wsl_path(input, &env, true).as_deref(),
            *expected,
            "convert_windows_path_to_wsl_path({input:?}, wsl=true)"
        );
    }
}

#[test]
fn windows_to_wsl_drive_branch_works_even_off_wsl() {
    // The DRIVE branch has no WSL-env gate (only the UNC branch does).
    let env = MapEnv::new(); // not WSL, no distro
    assert_eq!(
        convert_windows_path_to_wsl_path("D:\\a\\b", &env, false).as_deref(),
        Some("/mnt/d/a/b")
    );
    // ...but the UNC branch is skipped when not in WSL env.
    assert_eq!(
        convert_windows_path_to_wsl_path("\\\\wsl.localhost\\Ubuntu\\home\\dan", &env, false),
        None
    );
}

#[test]
fn windows_to_wsl_unc_accepts_any_distro_when_current_is_empty() {
    // WSL via WSL_INTEROP with an empty WSL_DISTRO_NAME: the mismatch check is
    // skipped (`if (currentDistro && ...)`), so any distro in the UNC is accepted.
    let env = MapEnv::new().with("WSL_DISTRO_NAME", ""); // present but empty
    assert_eq!(
        convert_windows_path_to_wsl_path("\\\\wsl.localhost\\Anything\\x", &env, true).as_deref(),
        Some("/x")
    );
}

#[test]
fn windows_to_wsl_custom_and_root_mount() {
    // Custom mount prefix flows through the drive branch.
    let custom = MapEnv::new()
        .with("WSL_DISTRO_NAME", "Ubuntu")
        .with("WSL_WINDOWS_SYS32", "/custom/c/Windows/System32");
    assert_eq!(
        convert_windows_path_to_wsl_path("D:\\a\\b", &custom, true).as_deref(),
        Some("/custom/d/a/b")
    );
    assert_eq!(
        convert_windows_path_to_wsl_path("C:\\", &custom, true).as_deref(),
        Some("/custom/c")
    );

    // Empty-prefix (root) mount: `C:\ -> /c`, `D:\a\b -> /d/a/b`.
    let root = MapEnv::new()
        .with("WSL_DISTRO_NAME", "Ubuntu")
        .with("WSL_WINDOWS_SYS32", "/c/Windows/System32");
    assert_eq!(
        convert_windows_path_to_wsl_path("C:\\", &root, true).as_deref(),
        Some("/c")
    );
    assert_eq!(
        convert_windows_path_to_wsl_path("D:\\a\\b", &root, true).as_deref(),
        Some("/d/a/b")
    );
}

// ===========================================================================
// launch-cwd (resolveLaunchCwd) — the cwd juggling buildSpawnSpec relies on
// ===========================================================================

#[test]
fn launch_cwd_linux_process_matrix() {
    let env = wsl_ubuntu_env();
    let lp = LaunchCwdTargetRuntime::LinuxProcess;

    // Linux path passes through unchanged.
    let r = resolve_launch_cwd(Some("/home/dan"), lp, &env, true);
    assert_eq!(r.launch_cwd.as_deref(), Some("/home/dan"));
    assert_eq!(r.conversion, LaunchCwdConversion::None);

    // Windows drive path converts to a WSL mount path (WSL env only).
    let r = resolve_launch_cwd(Some("D:\\proj"), lp, &env, true);
    assert_eq!(r.launch_cwd.as_deref(), Some("/mnt/d/proj"));
    assert_eq!(r.conversion, LaunchCwdConversion::WindowsDriveToWslMount);

    // Windows drive path but NOT in WSL env -> no conversion.
    let r = resolve_launch_cwd(Some("D:\\proj"), lp, &MapEnv::new(), false);
    assert_eq!(r.launch_cwd, None);

    // Drive-relative / UNC / rooted / slash-wsl-unc / empty -> None.
    for c in [
        "C:proj",
        "\\\\srv\\share",
        "\\rooted",
        "//wsl.localhost/Ubuntu/x",
    ] {
        assert_eq!(
            resolve_launch_cwd(Some(c), lp, &env, true).launch_cwd,
            None,
            "{c:?}"
        );
    }
    assert_eq!(resolve_launch_cwd(None, lp, &env, true).launch_cwd, None);
}

#[test]
fn launch_cwd_windows_process_matrix() {
    let env = wsl_ubuntu_env();
    let wp = LaunchCwdTargetRuntime::WindowsProcess;

    // WSL mount path converts to a Windows drive path (WSL env only).
    let r = resolve_launch_cwd(Some("/mnt/c/proj"), wp, &env, true);
    assert_eq!(r.launch_cwd.as_deref(), Some("C:\\proj"));
    assert_eq!(r.conversion, LaunchCwdConversion::WslMountToWindowsDrive);

    // Linux path but NOT in WSL env -> None.
    assert_eq!(
        resolve_launch_cwd(Some("/mnt/c/proj"), wp, &MapEnv::new(), false).launch_cwd,
        None
    );

    // Drive-absolute path -> path.win32.resolve.
    let r = resolve_launch_cwd(Some("C:/a/../b"), wp, &env, true);
    assert_eq!(r.launch_cwd.as_deref(), Some("C:\\b"));
    assert_eq!(r.conversion, LaunchCwdConversion::None);

    // UNC / slash-UNC / rooted / drive-relative -> None. Includes the WSL UNC forms
    // (`\\wsl.localhost\..`, `\\wsl$\..`, `//wsl.localhost/..`) that cmd.exe rejects:
    // the reference returns `undefined` (no cwd) rather than pass an unsupported path
    // (launch-cwd.ts:108-118 windows-process).
    for c in [
        "\\\\srv\\share",
        "//srv/share",
        "\\rooted",
        "C:rel",
        "\\\\wsl.localhost\\Ubuntu\\home\\dan",
        "\\\\wsl$\\Ubuntu\\home\\dan",
        "//wsl.localhost/Ubuntu/home/dan",
    ] {
        assert_eq!(
            resolve_launch_cwd(Some(c), wp, &env, true).launch_cwd,
            None,
            "{c:?}"
        );
    }
}
