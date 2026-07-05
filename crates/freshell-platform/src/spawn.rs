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
