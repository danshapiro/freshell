//! Table-driven shell-mode `buildSpawnSpec` matrix (`platform-glue.md §2.2`, P7),
//! transcribed from `terminal-registry.ts:1059-1266`. Covers `{system, cmd,
//! powershell, wsl}` × `{Linux, WSL, Windows}` × `{linux cwd, win cwd, none}`.
//! Byte-exact quoting/paths cross-checked against Node.

use std::collections::BTreeMap;

use freshell_platform::spawn::{build_spawn_spec, SpawnSpec};
use freshell_platform::{Env, HostOs, MapEnv, MapFileProbe, ShellType};

/// The forced env-override layer for an env with no TERM/COLORTERM set.
fn default_overrides() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("LANG".to_string(), "en_US.UTF-8".to_string()),
        ("LC_ALL".to_string(), "en_US.UTF-8".to_string()),
        ("TERM".to_string(), "xterm-256color".to_string()),
    ])
}

fn spec(program: &str, args: &[&str], cwd: Option<&str>) -> SpawnSpec {
    SpawnSpec {
        program: program.to_string(),
        args: args.iter().map(|s| s.to_string()).collect(),
        env_overrides: default_overrides(),
        cwd: cwd.map(str::to_string),
        cols: 120,
        rows: 30,
    }
}

/// A probe where `/bin/bash` exists (typical Linux/WSL).
fn bash_probe() -> MapFileProbe {
    MapFileProbe::new().with("/bin/bash").with("/bin/sh")
}

/// Run build_spawn_spec with empty user overrides + default 120x30.
fn build(
    shell: ShellType,
    host: HostOs,
    is_wsl_env: bool,
    cwd: Option<&str>,
    env: &dyn Env,
    probe: &MapFileProbe,
) -> SpawnSpec {
    build_spawn_spec(
        shell,
        host,
        is_wsl_env,
        cwd,
        env,
        probe,
        &BTreeMap::new(),
        None,
        None,
    )
}

// ===========================================================================
// Linux / macOS (non-WSL): everything -> system shell, args ['-l']
// ===========================================================================

#[test]
fn linux_non_wsl_system_shell() {
    let env = MapEnv::new();
    let probe = bash_probe();
    // system/cmd/powershell/wsl all normalize to the system shell on plain Linux.
    for shell in [
        ShellType::System,
        ShellType::Cmd,
        ShellType::Powershell,
        ShellType::Wsl,
    ] {
        let got = build(shell, HostOs::Linux, false, Some("/home/dan"), &env, &probe);
        assert_eq!(
            got,
            spec("/bin/bash", &["-l"], Some("/home/dan")),
            "{shell:?}"
        );
    }
}

#[test]
fn linux_system_shell_fallbacks() {
    // No /bin/bash -> /bin/sh.
    let empty_probe = MapFileProbe::new();
    let got = build(
        ShellType::System,
        HostOs::Linux,
        false,
        None,
        &MapEnv::new(),
        &empty_probe,
    );
    assert_eq!(got, spec("/bin/sh", &["-l"], None));

    // $SHELL set and existing wins.
    let env = MapEnv::new().with("SHELL", "/usr/bin/fish");
    let probe = MapFileProbe::new().with("/usr/bin/fish").with("/bin/bash");
    let got = build(ShellType::System, HostOs::Linux, false, None, &env, &probe);
    assert_eq!(got.program, "/usr/bin/fish");

    // $SHELL set but missing -> falls back to /bin/bash.
    let env = MapEnv::new().with("SHELL", "/nonexistent");
    let got = build(
        ShellType::System,
        HostOs::Linux,
        false,
        None,
        &env,
        &bash_probe(),
    );
    assert_eq!(got.program, "/bin/bash");
}

#[test]
fn linux_cwd_resolution() {
    let env = MapEnv::new();
    let probe = bash_probe();
    // None cwd stays None; a relative cwd resolves to None (launch-cwd linux-process).
    assert_eq!(
        build(ShellType::System, HostOs::Linux, false, None, &env, &probe).cwd,
        None
    );
    assert_eq!(
        build(
            ShellType::System,
            HostOs::Linux,
            false,
            Some("relative/dir"),
            &env,
            &probe
        )
        .cwd,
        None
    );
}

#[test]
fn macos_non_wsl_prefers_zsh() {
    let env = MapEnv::new();
    let probe = MapFileProbe::new().with("/bin/zsh").with("/bin/bash");
    for shell in [ShellType::System, ShellType::Powershell] {
        let got = build(shell, HostOs::Macos, false, None, &env, &probe);
        assert_eq!(got, spec("/bin/zsh", &["-l"], None), "{shell:?}");
    }
}

// ===========================================================================
// WSL: system/wsl -> Linux shell; cmd/powershell -> Windows interop
// ===========================================================================

#[test]
fn wsl_system_and_wsl_use_linux_shell() {
    let env = MapEnv::new();
    let probe = bash_probe();
    for shell in [ShellType::System, ShellType::Wsl] {
        let got = build(shell, HostOs::Linux, true, Some("/home/dan"), &env, &probe);
        assert_eq!(
            got,
            spec("/bin/bash", &["-l"], Some("/home/dan")),
            "{shell:?}"
        );
    }
}

#[test]
fn wsl_cmd_uses_windows_cmd_with_cd_in_command() {
    let env = MapEnv::new(); // default mount -> /mnt
    let got = build(
        ShellType::Cmd,
        HostOs::Linux,
        true,
        Some("/mnt/c/proj"),
        &env,
        &bash_probe(),
    );
    assert_eq!(
        got,
        spec(
            "/mnt/c/Windows/System32/cmd.exe",
            &["/K", r#"cd /d "C:\proj""#],
            None, // proc cwd is undefined on WSL; cd happens in-command
        )
    );
}

#[test]
fn wsl_cmd_with_no_cwd_uses_windows_default_cwd() {
    // No cwd -> resolveWindowsShellCwd(undefined)=None -> getWindowsDefaultCwd()=C:\ (SYSTEMDRIVE root).
    let env = MapEnv::new();
    let got = build(
        ShellType::Cmd,
        HostOs::Linux,
        true,
        None,
        &env,
        &bash_probe(),
    );
    assert_eq!(
        got,
        spec(
            "/mnt/c/Windows/System32/cmd.exe",
            &["/K", r#"cd /d "C:\\""#],
            None
        )
    );
}

#[test]
fn wsl_powershell_uses_windows_powershell_with_set_location() {
    let env = MapEnv::new();
    let got = build(
        ShellType::Powershell,
        HostOs::Linux,
        true,
        Some("/mnt/c/proj"),
        &env,
        &bash_probe(),
    );
    assert_eq!(
        got,
        spec(
            "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
            &[
                "-NoLogo",
                "-NoExit",
                "-Command",
                r"Set-Location -LiteralPath 'C:\proj'"
            ],
            None,
        )
    );
}

// --- PORT FIX: WSL Windows-shell cwd is INHERITED via the /mnt mount when it exists,
// so cmd/powershell start in the resolved Windows dir instead of failing the interop-
// fragile in-command `cd`/`Set-Location` and stranding in C:\Windows. Probe-gated: the
// goldens above (bash_probe, no /mnt entries) keep the faithful in-command fallback.

#[test]
fn wsl_cmd_inherits_mount_cwd_when_present() {
    let env = MapEnv::new();
    // The /mnt/c/proj mount exists per the probe -> cmd inherits it, no in-command cd.
    let probe = bash_probe().with("/mnt/c/proj");
    let got = build(
        ShellType::Cmd,
        HostOs::Linux,
        true,
        Some("/mnt/c/proj"),
        &env,
        &probe,
    );
    assert_eq!(
        got,
        spec(
            "/mnt/c/Windows/System32/cmd.exe",
            &["/K"],
            Some("/mnt/c/proj")
        )
    );
}

#[test]
fn wsl_powershell_inherits_mount_cwd_when_present() {
    let env = MapEnv::new();
    let probe = bash_probe().with("/mnt/c/proj");
    let got = build(
        ShellType::Powershell,
        HostOs::Linux,
        true,
        Some("/mnt/c/proj"),
        &env,
        &probe,
    );
    assert_eq!(
        got,
        spec(
            "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
            &["-NoLogo"],
            Some("/mnt/c/proj"),
        )
    );
}

#[test]
fn wsl_cmd_no_cwd_inherits_mnt_c_root_when_present() {
    // No cwd -> winCwd = C:\ (default) -> inherit /mnt/c when it exists.
    let env = MapEnv::new();
    let probe = bash_probe().with("/mnt/c");
    let got = build(ShellType::Cmd, HostOs::Linux, true, None, &env, &probe);
    assert_eq!(
        got,
        spec("/mnt/c/Windows/System32/cmd.exe", &["/K"], Some("/mnt/c"))
    );
}

#[test]
fn wsl_cmd_falls_back_to_in_command_cd_when_mount_absent() {
    // Mount not present per the probe -> keep the faithful `cd /d` + proc cwd None
    // (never risk a chdir spawn failure on a missing mount).
    let env = MapEnv::new();
    let got = build(
        ShellType::Cmd,
        HostOs::Linux,
        true,
        Some("/mnt/c/proj"),
        &env,
        &bash_probe(),
    );
    assert_eq!(
        got,
        spec(
            "/mnt/c/Windows/System32/cmd.exe",
            &["/K", r#"cd /d "C:\proj""#],
            None
        )
    );
}

#[test]
fn wsl_cmd_falls_back_when_mount_exists_as_a_file() {
    // DEV-0005 condition 3 (adjudicated 2026-07-11): a resolved mount path that
    // exists as a plain FILE must never become the child's process cwd (a chdir
    // spawn failure the original could never produce) -> keep the faithful
    // in-command `cd /d` fallback.
    let env = MapEnv::new();
    let probe = bash_probe().with_file("/mnt/c/proj");
    let got = build(
        ShellType::Cmd,
        HostOs::Linux,
        true,
        Some("/mnt/c/proj"),
        &env,
        &probe,
    );
    assert_eq!(
        got,
        spec(
            "/mnt/c/Windows/System32/cmd.exe",
            &["/K", r#"cd /d "C:\proj""#],
            None
        )
    );
}

#[test]
fn wsl_powershell_falls_back_when_mount_exists_as_a_file() {
    let env = MapEnv::new();
    let probe = bash_probe().with_file("/mnt/c/proj");
    let got = build(
        ShellType::Powershell,
        HostOs::Linux,
        true,
        Some("/mnt/c/proj"),
        &env,
        &probe,
    );
    assert_eq!(
        got,
        spec(
            "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
            &[
                "-NoLogo",
                "-NoExit",
                "-Command",
                r"Set-Location -LiteralPath 'C:\proj'"
            ],
            None,
        )
    );
}

#[test]
fn wsl_honors_env_overrides_for_exe_paths_and_custom_mount() {
    // WSL_WINDOWS_SYS32 changes both the exe path AND the mount prefix used for cwd conversion.
    let env = MapEnv::new().with("WSL_WINDOWS_SYS32", "/custom/c/Windows/System32");
    let got = build(
        ShellType::Cmd,
        HostOs::Linux,
        true,
        Some("/custom/c/proj"),
        &env,
        &bash_probe(),
    );
    assert_eq!(
        got,
        spec(
            "/custom/c/Windows/System32/cmd.exe",
            &["/K", r#"cd /d "C:\proj""#],
            None
        )
    );

    // POWERSHELL_EXE override wins for the powershell exe.
    let env = MapEnv::new().with("POWERSHELL_EXE", "/opt/pwsh");
    let got = build(
        ShellType::Powershell,
        HostOs::Linux,
        true,
        None,
        &env,
        &bash_probe(),
    );
    assert_eq!(got.program, "/opt/pwsh");
}

// ===========================================================================
// native Windows: system->cmd, powershell, and forceWsl on a Linux cwd
// ===========================================================================

#[test]
fn native_windows_system_maps_to_cmd() {
    let env = MapEnv::new();
    let probe = bash_probe();
    let got = build(
        ShellType::System,
        HostOs::Windows,
        false,
        Some(r"C:\Users\dan"),
        &env,
        &probe,
    );
    // proc cwd IS passed on native Windows (isLinuxPath false -> cwd).
    assert_eq!(got, spec("cmd.exe", &["/K"], Some(r"C:\Users\dan")));

    // No cwd -> proc cwd None.
    let got = build(
        ShellType::System,
        HostOs::Windows,
        false,
        None,
        &env,
        &probe,
    );
    assert_eq!(got, spec("cmd.exe", &["/K"], None));
}

#[test]
fn native_windows_powershell() {
    let env = MapEnv::new();
    let got = build(
        ShellType::Powershell,
        HostOs::Windows,
        false,
        Some(r"C:\proj"),
        &env,
        &bash_probe(),
    );
    assert_eq!(got, spec("powershell.exe", &["-NoLogo"], Some(r"C:\proj")));

    // POWERSHELL_EXE override.
    let env = MapEnv::new().with("POWERSHELL_EXE", "pwsh.exe");
    let got = build(
        ShellType::Powershell,
        HostOs::Windows,
        false,
        None,
        &env,
        &bash_probe(),
    );
    assert_eq!(got, spec("pwsh.exe", &["-NoLogo"], None));
}

#[test]
fn native_windows_wsl_mode() {
    let env = MapEnv::new();
    // Explicit 'wsl' with a Windows cwd -> converts cwd to a WSL mount path.
    let got = build(
        ShellType::Wsl,
        HostOs::Windows,
        false,
        Some(r"C:\proj"),
        &env,
        &bash_probe(),
    );
    assert_eq!(
        got,
        spec(
            "wsl.exe",
            &["--cd", "/mnt/c/proj", "--exec", "bash", "-l"],
            None
        )
    );

    // WSL_DISTRO + WSL_EXE overrides -> `-d <distro>` prepended, custom wsl.exe.
    let env = MapEnv::new()
        .with("WSL_DISTRO", "Ubuntu")
        .with("WSL_EXE", "/opt/wsl.exe");
    let got = build(
        ShellType::Wsl,
        HostOs::Windows,
        false,
        Some(r"C:\proj"),
        &env,
        &bash_probe(),
    );
    assert_eq!(
        got,
        spec(
            "/opt/wsl.exe",
            &[
                "-d",
                "Ubuntu",
                "--cd",
                "/mnt/c/proj",
                "--exec",
                "bash",
                "-l"
            ],
            None
        )
    );
}

#[test]
fn native_windows_force_wsl_on_linux_cwd_overrides_requested_shell() {
    let env = MapEnv::new();
    // A Linux cwd on native Windows forces 'wsl' mode even when 'cmd' was requested
    // (forceWsl, terminal-registry.ts:1130-1133).
    for requested in [ShellType::System, ShellType::Cmd, ShellType::Powershell] {
        let got = build(
            requested,
            HostOs::Windows,
            false,
            Some("/home/dan"),
            &env,
            &bash_probe(),
        );
        assert_eq!(
            got,
            spec(
                "wsl.exe",
                &["--cd", "/home/dan", "--exec", "bash", "-l"],
                None
            ),
            "requested {requested:?} + linux cwd -> forced wsl"
        );
    }
}

// ===========================================================================
// env_overrides + cols/rows
// ===========================================================================

#[test]
fn env_overrides_layering_and_ptysize() {
    // TERM/COLORTERM fall back to env values; LANG/LC_ALL are forced; user overrides win.
    let env = MapEnv::new()
        .with("TERM", "screen-256color")
        .with("COLORTERM", "24bit");
    let mut user = BTreeMap::new();
    user.insert("LANG".to_string(), "C".to_string()); // user overrides the forced LANG
    user.insert("FOO".to_string(), "bar".to_string());

    let got = build_spawn_spec(
        ShellType::System,
        HostOs::Linux,
        false,
        Some("/home/dan"),
        &env,
        &bash_probe(),
        &user,
        Some(80),
        Some(24),
    );

    let expected: BTreeMap<String, String> = BTreeMap::from([
        ("COLORTERM".to_string(), "24bit".to_string()),
        ("FOO".to_string(), "bar".to_string()),
        ("LANG".to_string(), "C".to_string()), // user override wins over en_US.UTF-8
        ("LC_ALL".to_string(), "en_US.UTF-8".to_string()),
        ("TERM".to_string(), "screen-256color".to_string()),
    ]);
    assert_eq!(got.env_overrides, expected);
    assert_eq!((got.cols, got.rows), (80, 24));
}

#[test]
fn default_pty_size_is_120x30() {
    let got = build(
        ShellType::System,
        HostOs::Linux,
        false,
        None,
        &MapEnv::new(),
        &bash_probe(),
    );
    assert_eq!((got.cols, got.rows), (120, 30));
}
