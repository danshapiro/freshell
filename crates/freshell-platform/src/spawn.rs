//! Shell `SpawnSpec` builder — the deterministic **shell-mode** slice of
//! `buildSpawnSpec` (`terminal-registry.ts:1059-1266`, `platform-glue.md §2`).
//!
//! This constructs the `program` / `args` / `env` / `cwd` a future
//! `freshell-terminal` (portable-pty) will consume for a **`mode: 'shell'`**
//! terminal, across `{system, cmd, powershell, wsl}` × `{Linux, WSL, Windows}`.
//! It performs **no spawning** — pure spec construction.
//!
//! **Scope note:** the coding-CLI modes (`resolveCodingCliCommand`, and the
//! `escapeCmdExe`/`buildCmdCommand`/`buildPowerShellCommand` launch-line builders)
//! are deferred to `freshell-harness`; only the two quoters shell-mode needs
//! (`quote_cmd_arg`, `quote_powershell_literal`) are ported here.
//!
//! **CD-2:** shell resolution + `getWindowsDefaultCwd`/`getWindowsExe`/
//! `getSystemShell` are ported from the **live** `terminal-registry.ts`, never the
//! dead `platform-utils.ts` (whose `getWindowsDefaultCwd` differs materially).

use std::collections::BTreeMap;

use crate::detect::{is_windows, is_windows_like, HostOs};
use crate::path::{
    convert_windows_path_to_wsl_path, is_linux_path, resolve_launch_cwd, LaunchCwdTargetRuntime,
};
use crate::{Env, FileProbe};

/// `ShellType` (`terminal-registry.ts:74`, wire values `'system'|'cmd'|'powershell'|'wsl'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellType {
    System,
    Cmd,
    Powershell,
    Wsl,
}

impl ShellType {
    /// The wire/string form (`'system'|'cmd'|'powershell'|'wsl'`).
    pub fn as_str(self) -> &'static str {
        match self {
            ShellType::System => "system",
            ShellType::Cmd => "cmd",
            ShellType::Powershell => "powershell",
            ShellType::Wsl => "wsl",
        }
    }

    /// Parse the wire value; unknown -> `None`.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "system" => Some(ShellType::System),
            "cmd" => Some(ShellType::Cmd),
            "powershell" => Some(ShellType::Powershell),
            "wsl" => Some(ShellType::Wsl),
            _ => None,
        }
    }
}

/// Which Windows executable to resolve (`getWindowsExe` arg, `terminal-registry.ts:891`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsExe {
    Cmd,
    Powershell,
}

// ===========================================================================
// Coding-CLI launch (mode != 'shell') — the deterministic base-command slice of
// `resolveCodingCliCommand`/`buildSpawnSpec` (`terminal-registry.ts:274-320,
// 1256-1266`).
// ===========================================================================

/// A registered coding-CLI's command resolution inputs (the subset of
/// `CodingCliCommandSpec` this port consumes: `terminal-registry.ts:77-90`).
/// Populated from the extension registry's `cli` block (`freshell.json`) or the
/// `FALLBACK_CODING_CLI_COMMAND_SPECS` seed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliCommandSpec {
    /// The terminal mode / provider name (`claude` | `codex` | `opencode` | ...).
    pub name: String,
    /// The env var that overrides the command (`spec.envVar`); `None` = no override.
    pub env_var: Option<String>,
    /// `spec.defaultCommand` — the executable to run when no override is set.
    pub default_cmd: String,
}

/// A resolved coding-CLI launch (`resolveCodingCliCommand` return, reduced).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliLaunch {
    /// `cli.command` — `(env[spec.envVar] || spec.defaultCommand)`.
    pub command: String,
    /// `cli.args` — the base launch args (empty for a fresh, non-resume launch).
    pub args: Vec<String>,
    /// `cli.env` — CLI-specific env overrides (empty in the reduced port).
    pub env: BTreeMap<String, String>,
}

/// `resolveCodingCliCommand(mode, ...)` base-command slice
/// (`terminal-registry.ts:283-286`): look up the spec for `mode`, then resolve
/// `command = (env[spec.envVar] || spec.defaultCommand)`. Returns `None` for
/// `mode == 'shell'` or an unregistered mode (the caller then uses the shell path,
/// mirroring `buildSpawnSpec`'s `mode === 'shell'` branch; the reference *throws*
/// `UnknownTerminalModeError` for a truly-unknown mode — see the caller).
///
/// **REDUCED FIDELITY (deferred, tracked as a candidate deviation):** this resolves
/// only the base `command` + (empty) base `args` + (empty) `env`. The reference also
/// injects, per provider: MCP config (`generateMcpInjection` — writes a config file
/// / `-c mcp_servers.*`), turn-complete notification args
/// (`providerNotificationArgs` — codex `-c tui.*`, claude `--settings <hook json>`),
/// the OpenCode loopback control endpoint (`--hostname/--port`, server-allocated),
/// and resume/model/sandbox/permission args from provider settings. Those layers are
/// NOT ported here; a fresh CLI still launches and renders its interactive UI, which
/// is what this matrix validates (it does not drive a live model turn).
pub fn resolve_cli_launch(
    specs: &[CliCommandSpec],
    mode: &str,
    env: &dyn Env,
) -> Option<CliLaunch> {
    if mode == "shell" {
        return None;
    }
    let spec = specs.iter().find(|s| s.name == mode)?;
    let command = spec
        .env_var
        .as_deref()
        .and_then(|var| env.get(var))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| spec.default_cmd.clone());
    Some(CliLaunch {
        command,
        args: Vec::new(),
        env: BTreeMap::new(),
    })
}

/// The resolved shell spawn specification (shell mode).
///
/// `env_overrides` is the **deterministic override layer** the reference applies
/// on top of the (stripped) parent environment. The terminal layer computes the
/// final child env as: `(real parent env − STRIP_ENV) + env_overrides`. See
/// [`STRIP_ENV`] and `build_spawn_spec`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    /// The `file` to exec (`terminal-registry.ts` `buildSpawnSpec` return `.file`).
    pub program: String,
    /// The argument vector (`.args`).
    pub args: Vec<String>,
    /// Forced env overrides + user overrides (see struct docs); sorted, deterministic.
    pub env_overrides: BTreeMap<String, String>,
    /// The process cwd (`.cwd`) — `None` where the reference passes `undefined`
    /// (WSL Windows-shell cases use in-command `cd`/`Set-Location` instead).
    pub cwd: Option<String>,
    /// PTY columns (`opts.cols || 120`, `terminal-registry.ts:1562`).
    pub cols: u16,
    /// PTY rows (`opts.rows || 30`, `terminal-registry.ts:1563`).
    pub rows: u16,
}

/// Default PTY size (`terminal-registry.ts:1562-1563`).
pub const DEFAULT_COLS: u16 = 120;
pub const DEFAULT_ROWS: u16 = 30;

/// Env vars stripped from the inherited parent before spawn
/// (`buildSpawnSpec`, `terminal-registry.ts:1083-1097`). The terminal layer must
/// remove these from the real parent env; the deterministic core can't (it holds
/// no parent env), so it exposes the list.
pub const STRIP_ENV: &[&str] = &[
    "CLAUDECODE",
    "CI",
    "NO_COLOR",
    "FORCE_COLOR",
    "COLOR",
    "PORT",
    "AUTH_TOKEN",
    "ALLOWED_ORIGINS",
    "NODE_ENV",
    "npm_lifecycle_script",
    "OPENCODE_SERVER_USERNAME",
    "OPENCODE_SERVER_PASSWORD",
];

// ===========================================================================
// §2.1 resolveShell (`terminal-registry.ts:949-965`)
// ===========================================================================

/// `resolveShell` (`terminal-registry.ts:949-965`). `is_wsl_env` is Regime A.
pub fn resolve_shell(requested: ShellType, host_os: HostOs, is_wsl_env: bool) -> ShellType {
    if is_windows(host_os) {
        // native Windows: 'system' -> cmd, others pass through.
        return if requested == ShellType::System {
            ShellType::Cmd
        } else {
            requested
        };
    }
    if is_wsl_env {
        // WSL: 'system' and 'wsl' -> Linux shell ('system'); cmd/powershell pass through.
        return match requested {
            ShellType::System | ShellType::Wsl => ShellType::System,
            other => other,
        };
    }
    // macOS/Linux (non-WSL): everything -> 'system'.
    ShellType::System
}

// ===========================================================================
// §2.3/2.4/2.5 exe + default-cwd + system-shell resolution
// ===========================================================================

/// `getWindowsExe` (`terminal-registry.ts:891-901`).
pub fn get_windows_exe(exe: WindowsExe, host_os: HostOs, env: &dyn Env) -> String {
    if is_windows(host_os) {
        return match exe {
            WindowsExe::Cmd => "cmd.exe".to_string(),
            WindowsExe::Powershell => env.or_default("POWERSHELL_EXE", "powershell.exe"),
        };
    }
    // WSL: explicit paths (Windows PATH may be unavailable).
    let system_root = env.or_default("WSL_WINDOWS_SYS32", "/mnt/c/Windows/System32");
    match exe {
        WindowsExe::Cmd => format!("{system_root}/cmd.exe"),
        WindowsExe::Powershell => match env.get("POWERSHELL_EXE") {
            Some(p) if !p.is_empty() => p,
            _ => format!("{system_root}/WindowsPowerShell/v1.0/powershell.exe"),
        },
    }
}

/// `getWindowsDefaultCwd` (**live** `terminal-registry.ts:923-942`) — the WSL
/// branch (the only reachable one from `build_spawn_spec`, which calls this solely
/// on the `is_wsl_env` path, where `isWindows()` is false).
///
/// CD-2: this mirrors the LIVE copy (USERPROFILE via launch-cwd -> HOMEDRIVE+HOMEPATH
/// -> SYSTEMDRIVE root), NOT the dead `platform-utils.ts` (`/mnt/<d>/..` regex).
///
/// NOTE: the `isWindows() -> os.homedir()` branch (`:924-926`) is unreachable here
/// and intentionally omitted (native Windows never calls `getWindowsDefaultCwd` in
/// `buildSpawnSpec`).
pub fn get_windows_default_cwd(env: &dyn Env, is_wsl_env: bool) -> String {
    if let Some(user_profile) = env.get("USERPROFILE") {
        if !user_profile.trim().is_empty() {
            // resolveWindowsShellCwd(USERPROFILE)
            if let Some(resolved) = resolve_windows_shell_cwd(Some(&user_profile), env, is_wsl_env) {
                return resolved;
            }
        }
    }
    let home_drive = env.get("HOMEDRIVE").unwrap_or_default();
    let home_path = env.get("HOMEPATH").unwrap_or_default();
    if !home_drive.is_empty() && !home_path.is_empty() {
        // path.win32.resolve(`${HOMEDRIVE}${HOMEPATH}`)
        if let Some(resolved) = crate::path::win32_resolve(&format!("{home_drive}{home_path}")) {
            return resolved;
        }
    }
    let system_drive = env.or_default("SYSTEMDRIVE", "C:");
    // path.win32.resolve(`${SYSTEMDRIVE}\\`)
    crate::path::win32_resolve(&format!("{system_drive}\\")).unwrap_or_else(|| format!("{system_drive}\\"))
}

/// `getSystemShell` (`terminal-registry.ts:971-989`). `fs.existsSync` is injected
/// via [`FileProbe`]. `platform-glue.md §2.5 [PORT RISK]`: the probe ORDER is
/// T1-determinism-load-bearing.
pub fn get_system_shell(host_os: HostOs, env: &dyn Env, probe: &dyn FileProbe) -> String {
    if let Some(shell) = env.get("SHELL") {
        // set, non-empty, non-whitespace, and exists.
        if !shell.trim().is_empty() && probe.exists(&shell) {
            return shell;
        }
    }
    if host_os == HostOs::Macos {
        if probe.exists("/bin/zsh") {
            return "/bin/zsh".to_string();
        }
        if probe.exists("/bin/bash") {
            return "/bin/bash".to_string();
        }
    } else {
        // Linux (and any non-darwin): prefer bash, then sh.
        if probe.exists("/bin/bash") {
            return "/bin/bash".to_string();
        }
    }
    "/bin/sh".to_string()
}

fn resolve_windows_shell_cwd(cwd: Option<&str>, env: &dyn Env, is_wsl_env: bool) -> Option<String> {
    resolve_launch_cwd(cwd, LaunchCwdTargetRuntime::WindowsProcess, env, is_wsl_env).launch_cwd
}

fn resolve_unix_shell_cwd(cwd: Option<&str>, env: &dyn Env, is_wsl_env: bool) -> Option<String> {
    resolve_launch_cwd(cwd, LaunchCwdTargetRuntime::LinuxProcess, env, is_wsl_env).launch_cwd
}

// ===========================================================================
// §2.6 Arg quoting (Windows) — byte-exact, verified against Node goldens
// ===========================================================================

/// `quoteCmdArg` (`terminal-registry.ts:1014-1044`): MS backslash-before-quote
/// doubling rule + `%`->`%%`. `platform-glue.md §2.6 [PORT RISK]` byte-exact.
pub fn quote_cmd_arg(arg: &str) -> String {
    let escaped = arg.replace('%', "%%");
    let mut quoted = String::from("\"");
    let mut backslash_count = 0usize;
    for ch in escaped.chars() {
        if ch == '\\' {
            backslash_count += 1;
            continue;
        }
        if ch == '"' {
            quoted.push_str(&"\\".repeat(backslash_count * 2 + 1));
            quoted.push('"');
            backslash_count = 0;
            continue;
        }
        if backslash_count > 0 {
            quoted.push_str(&"\\".repeat(backslash_count));
            backslash_count = 0;
        }
        quoted.push(ch);
    }
    if backslash_count > 0 {
        quoted.push_str(&"\\".repeat(backslash_count * 2));
    }
    quoted.push('"');
    quoted
}

/// `quotePowerShellLiteral` (`terminal-registry.ts:1050-1052`): wrap in `'...'`, `'`->`''`.
pub fn quote_powershell_literal(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "''"))
}

// ===========================================================================
// buildSpawnSpec (shell mode) — `terminal-registry.ts:1059-1266`
// ===========================================================================

/// Build the shell-mode [`SpawnSpec`] (`buildSpawnSpec` with `mode: 'shell'`).
///
/// - `host_os` mirrors `process.platform`.
/// - `is_wsl_env` is Regime A (`detect::is_wsl_env`), passed explicitly per CD-1.
/// - `user_env_overrides` mirrors `envOverrides` (wins over the forced defaults).
/// - `cols`/`rows` default to 120x30 when `None`.
#[allow(clippy::too_many_arguments)]
pub fn build_spawn_spec(
    shell: ShellType,
    host_os: HostOs,
    is_wsl_env: bool,
    cwd: Option<&str>,
    env: &dyn Env,
    probe: &dyn FileProbe,
    user_env_overrides: &BTreeMap<String, String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> SpawnSpec {
    let env_overrides = build_env_overrides(env, user_env_overrides);
    let cols = cols.unwrap_or(DEFAULT_COLS);
    let rows = rows.unwrap_or(DEFAULT_ROWS);
    let spec = |program: String, args: Vec<String>, cwd: Option<String>| SpawnSpec {
        program,
        args,
        env_overrides: env_overrides.clone(),
        cwd,
        cols,
        rows,
    };

    let effective_shell = resolve_shell(shell, host_os, is_wsl_env);
    let in_wsl_with_linux_shell = is_wsl_env && effective_shell == ShellType::System;

    if is_windows_like(host_os, is_wsl_env) && !in_wsl_with_linux_shell {
        // Force WSL only on native Windows with a Linux cwd (not when already in WSL).
        let force_wsl = is_windows(host_os) && cwd.is_some_and(is_linux_path);

        // windowsMode: forceWsl -> 'wsl'; else effectiveShell (never 'system' here, so the
        // WINDOWS_SHELL default is unreachable) -> otherwise (WINDOWS_SHELL||'wsl').
        // CD/DEV candidate: resolveShell never yields 'system' in this branch (native
        // Windows maps system->cmd; WSL 'system' is handled by in_wsl_with_linux_shell),
        // so the `(WINDOWS_SHELL||'wsl')` fallback (`terminal-registry.ts:1137`) is dead
        // code. Ported verbatim (do NOT remove); reported as a fidelity observation.
        let windows_mode = if force_wsl {
            "wsl".to_string()
        } else if effective_shell != ShellType::System {
            effective_shell.as_str().to_string()
        } else {
            env.or_default("WINDOWS_SHELL", "wsl").to_lowercase()
        };

        if windows_mode == "wsl" {
            // Option A: WSL from native Windows (skipped when already inside WSL).
            let wsl = env.or_default("WSL_EXE", "wsl.exe");
            let mut args: Vec<String> = Vec::new();
            if let Some(distro) = env.get("WSL_DISTRO") {
                if !distro.is_empty() {
                    args.push("-d".to_string());
                    args.push(distro);
                }
            }
            // The WSL child needs a Linux cwd for `wsl.exe --cd`.
            let wsl_child_cwd = cwd.map(|c| {
                if is_linux_path(c) {
                    c.to_string()
                } else {
                    convert_windows_path_to_wsl_path(c, env, is_wsl_env).unwrap_or_else(|| c.to_string())
                }
            });
            if let Some(child_cwd) = wsl_child_cwd {
                args.push("--cd".to_string());
                args.push(child_cwd);
            }
            // mode === 'shell'
            args.push("--exec".to_string());
            args.push("bash".to_string());
            args.push("-l".to_string());
            return spec(wsl, args, None);
        }

        if windows_mode == "cmd" {
            let file = get_windows_exe(WindowsExe::Cmd, host_os, env);
            let in_wsl = is_wsl_env;
            let win_cwd = compute_win_cwd(cwd, in_wsl, env, is_wsl_env);
            let proc_cwd = if in_wsl { None } else { win_cwd.clone() };
            // mode === 'shell'
            if in_wsl {
                if let Some(wc) = win_cwd.as_deref() {
                    // PORT FIX (see wsl_windows_shell_inherit_cwd): let cmd.exe INHERIT
                    // a valid /mnt mount cwd instead of the original's in-command
                    // `cd /d "<win>"`, which WSL argv->cmdline interop breaks (embedded
                    // `"` -> `\"`, which cmd's builtin `cd` rejects -> "syntax is
                    // incorrect"; and with no proc cwd the child inherits the server's
                    // non-mount cwd as a \\wsl.localhost UNC path -> C:\Windows).
                    if let Some(inherit) = wsl_windows_shell_inherit_cwd(wc, env, is_wsl_env, probe) {
                        return spec(file, vec!["/K".to_string()], Some(inherit));
                    }
                    return spec(
                        file,
                        vec!["/K".to_string(), format!("cd /d {}", quote_cmd_arg(wc))],
                        proc_cwd,
                    );
                }
            }
            return spec(file, vec!["/K".to_string()], proc_cwd);
        }

        // default: PowerShell
        let file = get_windows_exe(WindowsExe::Powershell, host_os, env);
        let in_wsl = is_wsl_env;
        let win_cwd = compute_win_cwd(cwd, in_wsl, env, is_wsl_env);
        let proc_cwd = if in_wsl { None } else { win_cwd.clone() };
        // mode === 'shell'
        if in_wsl {
            if let Some(wc) = win_cwd.as_deref() {
                // PORT FIX (see wsl_windows_shell_inherit_cwd): inherit a valid /mnt
                // mount cwd instead of relying on the in-command `Set-Location`, so the
                // shell never inherits the server's non-mount cwd as a \\wsl.localhost
                // UNC path. (Set-Location's single-quoted literal survives interop, so
                // this is belt-and-suspenders for powershell but essential for cmd; kept
                // symmetric so both Windows shells resolve cwd identically.)
                if let Some(inherit) = wsl_windows_shell_inherit_cwd(wc, env, is_wsl_env, probe) {
                    return spec(file, vec!["-NoLogo".to_string()], Some(inherit));
                }
                return spec(
                    file,
                    vec![
                        "-NoLogo".to_string(),
                        "-NoExit".to_string(),
                        "-Command".to_string(),
                        format!("Set-Location -LiteralPath {}", quote_powershell_literal(wc)),
                    ],
                    proc_cwd,
                );
            }
        }
        return spec(file, vec!["-NoLogo".to_string()], proc_cwd);
    }

    // Non-Windows: native spawn using the system shell (Linux/macOS non-WSL, or
    // WSL with the Linux 'system' shell).
    let system_shell = get_system_shell(host_os, env, probe);
    let unix_cwd = resolve_unix_shell_cwd(cwd, env, is_wsl_env);
    // mode === 'shell'
    spec(system_shell, vec!["-l".to_string()], unix_cwd)
}

/// Build the **coding-CLI** launch [`SpawnSpec`] (mode != 'shell') on the
/// non-Windows / WSL-Linux-shell path — the tail of `buildSpawnSpec`
/// (`terminal-registry.ts:1256-1266`):
///
/// ```js
/// const cli = resolveCodingCliCommand(mode, ...)
/// return { file: cli.command, args: cli.args, cwd: unixCwd, env: { ...env, ...cli.env } }
/// ```
///
/// The env layer matches shell mode (parent − STRIP_ENV + TERM/COLORTERM/LANG/LC_ALL
/// + user overrides, then `...cli.env` on top) and the cwd is resolved through the
/// same `resolveUnixShellCwd`, so a claude/codex/opencode terminal lands in the
/// requested directory with `CLAUDECODE` stripped (which the reference notes is
/// required or child Claude refuses to start).
///
/// Scope: CLI panes are always created with `shell:'system'` (`PaneContainer`
/// `createContentForType`), which resolves to the Linux system shell on WSL/Linux/
/// macOS — i.e. this tail. Native-Windows CLI launch (the `cmd`/`powershell`
/// windows-shell CLI branches, `terminal-registry.ts:1204/1237`) is **deferred**;
/// the caller falls back to the shell path there.
#[allow(clippy::too_many_arguments)]
pub fn build_cli_spawn_spec(
    launch: &CliLaunch,
    is_wsl_env: bool,
    cwd: Option<&str>,
    env: &dyn Env,
    user_env_overrides: &BTreeMap<String, String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> SpawnSpec {
    let mut env_overrides = build_env_overrides(env, user_env_overrides);
    for (k, v) in &launch.env {
        env_overrides.insert(k.clone(), v.clone()); // ...cli.env wins
    }
    let unix_cwd = resolve_unix_shell_cwd(cwd, env, is_wsl_env);
    SpawnSpec {
        program: launch.command.clone(),
        args: launch.args.clone(),
        env_overrides,
        cwd: unix_cwd,
        cols: cols.unwrap_or(DEFAULT_COLS),
        rows: rows.unwrap_or(DEFAULT_ROWS),
    }
}

/// PORT FIX (deliberate, reported divergence from `buildSpawnSpec`
/// `terminal-registry.ts:1177-1248`): the Linux **mount** cwd a WSL-spawned Windows
/// shell (`cmd.exe`/`powershell.exe`) should INHERIT so it starts in `win_cwd`.
///
/// The reference passes `cwd: undefined` to node-pty on WSL and changes directory
/// *inside* the launched shell (`cd /d "<win>"` / `Set-Location -LiteralPath '<win>'`).
/// That mechanism is broken for `cmd` when the shell is launched from WSL: a Linux
/// process `exec`s the `.exe` through WSL interop, whose argv->Windows-cmdline
/// conversion escapes every embedded `"` as `\"` (verified via `%CMDCMDLINE%`), and
/// cmd's builtin `cd` rejects `\"…\"` with *"The filename, directory name, or volume
/// label syntax is incorrect."* — leaving cmd stranded in `C:\Windows` (the child also
/// inherits the server's non-mount cwd as a `\\wsl.localhost\…` UNC path, which cmd
/// refuses: *"UNC paths are not supported. Defaulting to the Windows directory."*).
/// Both are shared with the original but leave cmd in the wrong directory.
///
/// The robust fix: hand the child a valid **Linux** cwd (`/mnt/<d>/…`) that WSL maps
/// to the intended Windows directory, so the shell inherits it with no UNC and no
/// in-command `cd`. Gated on the mount actually existing (via [`FileProbe`]) so a
/// missing/unmounted target never induces a `chdir` spawn failure — the caller then
/// keeps the faithful in-command fallback. Because the unit-test probes carry no
/// `/mnt` entries, every transcribed `buildSpawnSpec` golden is preserved; the fix
/// only engages against the real filesystem at runtime.
fn wsl_windows_shell_inherit_cwd(
    win_cwd: &str,
    env: &dyn Env,
    is_wsl_env: bool,
    probe: &dyn FileProbe,
) -> Option<String> {
    let mount = convert_windows_path_to_wsl_path(win_cwd, env, is_wsl_env)?;
    probe.exists(&mount).then_some(mount)
}

/// `winCwd = inWsl ? (resolveWindowsShellCwd(cwd) || getWindowsDefaultCwd()) :
///                   (isLinuxPath(cwd) ? undefined : cwd)`.
fn compute_win_cwd(cwd: Option<&str>, in_wsl: bool, env: &dyn Env, is_wsl_env: bool) -> Option<String> {
    if in_wsl {
        match resolve_windows_shell_cwd(cwd, env, is_wsl_env) {
            Some(s) if !s.is_empty() => Some(s),
            _ => Some(get_windows_default_cwd(env, is_wsl_env)),
        }
    } else {
        match cwd {
            Some(c) if is_linux_path(c) => None,
            other => other.map(str::to_string),
        }
    }
}

/// The forced env-override layer: `{TERM, COLORTERM, LANG, LC_ALL}` (with the
/// documented fallbacks) then the user overrides on top (`buildSpawnSpec:1098-1105`).
fn build_env_overrides(env: &dyn Env, user: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    out.insert("TERM".to_string(), env.or_default("TERM", "xterm-256color"));
    out.insert("COLORTERM".to_string(), env.or_default("COLORTERM", "truecolor"));
    out.insert("LANG".to_string(), "en_US.UTF-8".to_string());
    out.insert("LC_ALL".to_string(), "en_US.UTF-8".to_string());
    for (k, v) in user {
        out.insert(k.clone(), v.clone()); // ...envOverrides wins
    }
    out
}

#[cfg(test)]
mod helper_tests {
    use super::*;

    #[test]
    fn resolve_shell_matrix() {
        use HostOs::*;
        use ShellType::*;
        // native Windows: system->cmd, others pass through.
        assert_eq!(resolve_shell(System, Windows, false), Cmd);
        assert_eq!(resolve_shell(Powershell, Windows, false), Powershell);
        assert_eq!(resolve_shell(Wsl, Windows, false), Wsl);
        // WSL: system/wsl -> system; cmd/powershell pass through.
        assert_eq!(resolve_shell(System, Linux, true), System);
        assert_eq!(resolve_shell(Wsl, Linux, true), System);
        assert_eq!(resolve_shell(Cmd, Linux, true), Cmd);
        assert_eq!(resolve_shell(Powershell, Linux, true), Powershell);
        // plain Linux/macOS: everything -> system.
        for s in [System, Cmd, Powershell, Wsl] {
            assert_eq!(resolve_shell(s, Linux, false), System);
            assert_eq!(resolve_shell(s, Macos, false), System);
        }
    }

    #[test]
    fn quote_cmd_arg_goldens() {
        // Verified against terminal-registry.ts quoteCmdArg via Node.
        assert_eq!(quote_cmd_arg("C:\\proj"), "\"C:\\proj\"");
        assert_eq!(quote_cmd_arg("C:\\"), "\"C:\\\\\""); // trailing backslash doubled
        assert_eq!(quote_cmd_arg("plain"), "\"plain\"");
        assert_eq!(quote_cmd_arg("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_cmd_arg("a\\b"), "\"a\\b\"");
        assert_eq!(quote_cmd_arg("end\\"), "\"end\\\\\"");
        assert_eq!(quote_cmd_arg("end\\\\"), "\"end\\\\\\\\\"");
        assert_eq!(quote_cmd_arg("50%rate"), "\"50%%rate\"");
        assert_eq!(quote_cmd_arg("a%PATH%b"), "\"a%%PATH%%b\"");
        assert_eq!(quote_cmd_arg("a\\\"b"), "\"a\\\\\\\"b\"");
        assert_eq!(quote_cmd_arg(""), "\"\"");
    }

    #[test]
    fn quote_powershell_literal_goldens() {
        assert_eq!(quote_powershell_literal("C:\\proj"), "'C:\\proj'");
        assert_eq!(quote_powershell_literal("O'Brien"), "'O''Brien'");
        assert_eq!(quote_powershell_literal("a'b'c"), "'a''b''c'");
        assert_eq!(quote_powershell_literal("''"), "''''''");
        assert_eq!(quote_powershell_literal(""), "''");
    }
}
