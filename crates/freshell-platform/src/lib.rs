//! # freshell-platform
//!
//! OS / path / shell glue for the freshell Rust port. This crate is an **identical**
//! port (behavior-equivalent) of the platform layer documented in
//! `port/machine/specs/platform-glue.md`, sourced from:
//!
//! - `server/path-utils.ts`      — WSL <-> Windows path conversion.
//! - `server/platform.ts`        — `/proc/version`-based WSL detection (Regime B).
//! - `server/terminal-registry.ts` — **live** shell resolution + `buildSpawnSpec`
//!   (lines 862-1266) and the env-var WSL detector (Regime A, line 870).
//!
//! ## Deterministic core
//!
//! - [`detect`] — OS / WSL detection (BOTH regimes, kept separate — see CD-1 below).
//! - [`path`]   — WSL <-> Windows path conversion + flavor detection + launch-cwd.
//! - [`spawn`]  — the shell [`SpawnSpec`](spawn::SpawnSpec) builder.
//!
//! ## Live-process layer (Phase 3, step 14)
//!
//! The OS-integration command *builders* — firewall detection + rule commands
//! ([`firewall`]), WSL `netsh portproxy` + firewall companion + plan/idempotency
//! ([`port_forward`]), elevated-PowerShell arg building + the two-phase
//! confirmation-token gate ([`elevated`]), and network bind/LAN/CORS
//! ([`network`]) — are implemented here. Every one is a pure builder tested
//! against **golden strings** transcribed from `server/*.ts`.
//!
//! **All subprocess execution is injected** through [`CommandRunner`]. The real
//! edge ([`StdCommandRunner`]) is used **only for READ-ONLY verification**
//! (`netsh … show`, `ip … show`, `powershell -Command $PSVersionTable`). Every
//! **mutating** path (`netsh … add/delete`, elevated `Start-Process -Verb RunAs`)
//! is only ever *constructed* as a command string and, in tests, driven through a
//! [`FakeCommandRunner`] — it is never executed against a live host.
//!
//! ## Fidelity constraints baked in
//!
//! - **CD-1 — two WSL detectors preserved SEPARATELY.** freshell uses an env-var
//!   detector (Regime A, drives terminal shell-spawn) *and* a `/proc/version`
//!   detector (Regime B, drives network/firewall). They can disagree in a
//!   scrubbed-env WSL2 process. Unifying them is a `DELIBERATE_FIX` requiring
//!   antagonist adjudication and is **NOT** done here. See
//!   [`detect::is_wsl_env`] (A) vs [`detect::is_wsl2_proc`] (B).
//! - **CD-2 — ported from the LIVE `terminal-registry.ts`, not the dead
//!   `platform-utils.ts`.** The dead duplicate's `getWindowsDefaultCwd` /
//!   `getWslMountPrefix` differ materially; porting them is a latent Windows/WSL
//!   cwd defect. This crate mirrors the live copies only.
//!
//! ## Injected IO (no real env/proc/fs reads inside the logic paths)
//!
//! Every function that the reference feeds from `process.env`, `/proc/version`,
//! `fs.existsSync`, `os.homedir`, or `wsl.exe`/`reg.exe` takes its input through an
//! injected source ([`Env`], [`FileProbe`], [`path::WslPathResolver`]). Thin `*_live`
//! wrappers at the edges perform the real reads and delegate to the pure core.

pub mod cli_launch;
pub mod detect;
pub mod mcp_inject;
pub mod path;
pub mod spawn;

// ---- Live-process modules (Phase 3, step 14) — builders + injected CommandRunner ----
pub mod elevated;
pub mod firewall;
pub mod network;
pub mod port_forward;

pub use detect::{HostOs, Platform};
pub use elevated::{
    build_elevated_powershell_args, ConfirmationAction, ConfirmationGate, ELEVATED_POWERSHELL_TIMEOUT_MS,
};
pub use firewall::{detect_firewall, firewall_commands, FirewallInfo, FirewallPlatform};
pub use network::{
    build_allowed_origins, is_remote_access_enabled, resolve_bind_host, BindHostConfig,
};
pub use path::{
    convert_windows_path_to_wsl_path, convert_wsl_drive_path_to_windows_path,
    detect_user_path_flavor, sanitize_user_path_input, UserPathFlavor,
};
pub use port_forward::{
    build_port_forwarding_script, build_wsl_port_forwarding_plan, WslPortForwardingPlan,
};
pub use spawn::{
    build_cli_spawn_spec, build_spawn_spec, build_windows_cli_spawn_spec, resolve_cli_launch,
    CliCommandSpec, CliLaunch, ShellType, SpawnSpec,
};

// ---------------------------------------------------------------------------
// Injection infrastructure
// ---------------------------------------------------------------------------

/// An injected view of `process.env`.
///
/// Mirrors JavaScript's `process.env.X`: an unset variable is `None`; an
/// explicitly-empty variable is `Some("")`. Callers that need JS truthiness
/// (`!!process.env.X`) use [`Env::truthy`], which treats empty as falsy.
pub trait Env {
    /// Return the value of `key`, or `None` if unset. May return `Some("")`.
    fn get(&self, key: &str) -> Option<String>;

    /// JS-truthy check for `!!process.env[key]` — present **and** non-empty.
    fn truthy(&self, key: &str) -> bool {
        self.get(key).is_some_and(|v| !v.is_empty())
    }

    /// `process.env[key] || fallback` (JS `||`: empty string falls through).
    fn or_default(&self, key: &str, fallback: &str) -> String {
        match self.get(key) {
            Some(v) if !v.is_empty() => v,
            _ => fallback.to_string(),
        }
    }
}

/// A `HashMap`-backed [`Env`] for deterministic unit tests.
#[derive(Debug, Default, Clone)]
pub struct MapEnv {
    vars: std::collections::BTreeMap<String, String>,
}

impl MapEnv {
    pub fn new() -> Self {
        Self::default()
    }

    /// Builder-style setter (chainable).
    pub fn with(mut self, key: &str, value: &str) -> Self {
        self.vars.insert(key.to_string(), value.to_string());
        self
    }

    pub fn set(&mut self, key: &str, value: &str) {
        self.vars.insert(key.to_string(), value.to_string());
    }
}

impl Env for MapEnv {
    fn get(&self, key: &str) -> Option<String> {
        self.vars.get(key).cloned()
    }
}

/// The real process environment (the live edge).
#[derive(Debug, Default, Clone, Copy)]
pub struct RealEnv;

impl Env for RealEnv {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

/// An injected view of `fs.existsSync(path)` (used by `getSystemShell`).
pub trait FileProbe {
    fn exists(&self, path: &str) -> bool;

    /// Directory-aware probe (DEV-0005 condition 3): `wsl_windows_shell_inherit_cwd`
    /// must never hand the child PTY a cwd that exists as a *file* (a chdir failure
    /// mode the original could never produce). Defaults to `exists` for probes that
    /// cannot distinguish (legacy behavior).
    fn is_dir(&self, path: &str) -> bool {
        self.exists(path)
    }
}

/// The real filesystem (the live edge).
#[derive(Debug, Default, Clone, Copy)]
pub struct RealFileProbe;

impl FileProbe for RealFileProbe {
    fn exists(&self, path: &str) -> bool {
        std::path::Path::new(path).exists()
    }

    fn is_dir(&self, path: &str) -> bool {
        std::path::Path::new(path).is_dir()
    }
}

/// A set-backed [`FileProbe`] for deterministic unit tests.
#[derive(Debug, Default, Clone)]
pub struct MapFileProbe {
    present: std::collections::BTreeSet<String>,
    files: std::collections::BTreeSet<String>,
}

impl MapFileProbe {
    pub fn new() -> Self {
        Self::default()
    }

    /// Builder-style: register `path` as existing (as a directory-like entry).
    pub fn with(mut self, path: &str) -> Self {
        self.present.insert(path.to_string());
        self
    }

    /// Builder-style: register `path` as existing **as a plain file** (DEV-0005
    /// condition 3: `is_dir` returns false for these).
    pub fn with_file(mut self, path: &str) -> Self {
        self.present.insert(path.to_string());
        self.files.insert(path.to_string());
        self
    }
}

impl FileProbe for MapFileProbe {
    fn exists(&self, path: &str) -> bool {
        self.present.contains(path)
    }

    fn is_dir(&self, path: &str) -> bool {
        self.present.contains(path) && !self.files.contains(path)
    }
}

// ---------------------------------------------------------------------------
// Injected process layer (`execFile`) — the ONLY way this crate runs subprocesses
// ---------------------------------------------------------------------------

/// The "settled" result of running an external command (mirrors Node's
/// `execFile` callback `{ error, stdout, stderr }`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    /// Process exit code, or `None` when the process failed to spawn (missing
    /// binary), was killed by a signal, or timed out. This mirrors
    /// `getExecExitCode` (`wsl-port-forward.ts:90-104`), which returns `null`
    /// for a non-numeric `error.code` (e.g. the `'ENOENT'` string).
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl CommandOutput {
    /// A successful (exit-0) run with the given stdout and empty stderr.
    pub fn success(stdout: impl Into<String>) -> Self {
        Self { exit_code: Some(0), stdout: stdout.into(), stderr: String::new() }
    }

    /// A failed run (non-zero exit) with the given exit code / streams.
    pub fn failure(exit_code: i32, stdout: impl Into<String>, stderr: impl Into<String>) -> Self {
        Self { exit_code: Some(exit_code), stdout: stdout.into(), stderr: stderr.into() }
    }

    /// A spawn failure (binary absent / killed): `error.code` is not numeric, so
    /// [`CommandOutput::exit_code`] is `None` (matches `getExecExitCode` → null).
    pub fn spawn_failure(stderr: impl Into<String>) -> Self {
        Self { exit_code: None, stdout: String::new(), stderr: stderr.into() }
    }

    /// `true` iff the process ran and exited 0 — Node's `error === null`.
    pub fn ok(&self) -> bool {
        self.exit_code == Some(0)
    }

    /// `tryExec` semantics (`firewall.ts:27-34`): `stdout` on success, else `None`
    /// (`execFileAsync` rejects on any non-zero exit / spawn failure).
    pub fn stdout_on_success(&self) -> Option<&str> {
        if self.ok() {
            Some(&self.stdout)
        } else {
            None
        }
    }
}

/// The injected process layer. Every subprocess this crate would run (`netsh`,
/// `ip`, `hostname`, `ipconfig.exe`, `powershell.exe`, `ufw`, …) goes through a
/// `CommandRunner`, so tests drive a [`FakeCommandRunner`] and **no mutating
/// command is ever executed against a real host**.
///
/// `args` is an argument vector (no shell), matching `execFile(cmd, args)`.
pub trait CommandRunner {
    fn run(&self, command: &str, args: &[&str]) -> CommandOutput;
}

/// The real edge: `std::process::Command` with a wall-clock timeout and
/// kill-on-timeout (so an unattended run can never leak an orphan). Pipes are
/// drained on threads to avoid buffer-fill deadlocks.
///
/// **Used only for READ-ONLY verification in this crate.**
#[derive(Debug, Clone, Copy)]
pub struct StdCommandRunner {
    pub timeout: std::time::Duration,
}

impl Default for StdCommandRunner {
    fn default() -> Self {
        // Matches the reference's 5s `tryExec` timeout (`firewall.ts:29`).
        Self { timeout: std::time::Duration::from_secs(5) }
    }
}

impl StdCommandRunner {
    pub fn with_timeout(timeout: std::time::Duration) -> Self {
        Self { timeout }
    }
}

impl CommandRunner for StdCommandRunner {
    fn run(&self, command: &str, args: &[&str]) -> CommandOutput {
        use std::io::Read;
        use std::process::{Command, Stdio};

        let mut child = match Command::new(command)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => return CommandOutput::spawn_failure(e.to_string()),
        };

        // Drain both pipes on their own threads (prevents deadlock on large output).
        let mut stdout_pipe = child.stdout.take();
        let mut stderr_pipe = child.stderr.take();
        let out_handle = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(p) = stdout_pipe.as_mut() {
                let _ = p.read_to_string(&mut s);
            }
            s
        });
        let err_handle = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(p) = stderr_pipe.as_mut() {
                let _ = p.read_to_string(&mut s);
            }
            s
        });

        let deadline = std::time::Instant::now() + self.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        break None;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(15));
                }
                Err(_) => break None,
            }
        };

        let stdout = out_handle.join().unwrap_or_default();
        let stderr = err_handle.join().unwrap_or_default();
        match status {
            Some(s) => CommandOutput { exit_code: s.code(), stdout, stderr },
            None => CommandOutput { exit_code: None, stdout, stderr },
        }
    }
}

/// A scripted [`CommandRunner`] for deterministic tests. Matches by exact
/// `command` plus a set of argument substrings that must all be present, and
/// records every invocation so tests can assert *what* would have been run
/// (crucial for proving a mutating command is only ever *constructed*).
#[derive(Default)]
pub struct FakeCommandRunner {
    rules: Vec<FakeRule>,
    default: Option<CommandOutput>,
    calls: std::cell::RefCell<Vec<(String, Vec<String>)>>,
}

struct FakeRule {
    command: String,
    needles: Vec<String>,
    output: CommandOutput,
}

impl FakeCommandRunner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a scripted response: when `command` matches exactly and every string
    /// in `arg_needles` appears among the args, return `output`.
    pub fn on(mut self, command: &str, arg_needles: &[&str], output: CommandOutput) -> Self {
        self.rules.push(FakeRule {
            command: command.to_string(),
            needles: arg_needles.iter().map(|s| s.to_string()).collect(),
            output,
        });
        self
    }

    /// Fallback response for unmatched commands (default: a spawn failure, i.e.
    /// "binary absent").
    pub fn with_default(mut self, output: CommandOutput) -> Self {
        self.default = Some(output);
        self
    }

    /// Every `(command, args)` this runner was asked to run, in order.
    pub fn calls(&self) -> Vec<(String, Vec<String>)> {
        self.calls.borrow().clone()
    }

    /// How many commands were run (== number of mutating invocations when the
    /// fake is wired behind an elevation path).
    pub fn call_count(&self) -> usize {
        self.calls.borrow().len()
    }
}

impl CommandRunner for FakeCommandRunner {
    fn run(&self, command: &str, args: &[&str]) -> CommandOutput {
        self.calls
            .borrow_mut()
            .push((command.to_string(), args.iter().map(|s| s.to_string()).collect()));
        for rule in &self.rules {
            if rule.command == command && rule.needles.iter().all(|n| args.iter().any(|a| a.contains(n.as_str()))) {
                return rule.output.clone();
            }
        }
        self.default
            .clone()
            .unwrap_or_else(|| CommandOutput::spawn_failure(format!("no fake rule for {command}")))
    }
}

#[cfg(test)]
mod inject_tests {
    use super::*;

    #[test]
    fn env_truthy_matches_js_double_bang() {
        // `!!process.env.X`: unset -> false, empty -> false, non-empty -> true.
        let env = MapEnv::new().with("SET", "v").with("EMPTY", "");
        assert!(env.truthy("SET"));
        assert!(!env.truthy("EMPTY"));
        assert!(!env.truthy("MISSING"));
    }

    #[test]
    fn env_or_default_matches_js_or() {
        // `process.env.X || 'd'`: empty string is falsy -> falls through.
        let env = MapEnv::new().with("SET", "v").with("EMPTY", "");
        assert_eq!(env.or_default("SET", "d"), "v");
        assert_eq!(env.or_default("EMPTY", "d"), "d");
        assert_eq!(env.or_default("MISSING", "d"), "d");
    }

    #[test]
    fn file_probe_map() {
        let probe = MapFileProbe::new().with("/bin/bash");
        assert!(probe.exists("/bin/bash"));
        assert!(!probe.exists("/bin/zsh"));
    }
}
