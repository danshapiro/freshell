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
//! ## Scope of THIS step (Phase 3.2, step 1): the DETERMINISTIC CORE only
//!
//! - [`detect`] — OS / WSL detection (BOTH regimes, kept separate — see CD-1 below).
//! - [`path`]   — WSL <-> Windows path conversion + flavor detection + launch-cwd.
//! - [`spawn`]  — the shell [`SpawnSpec`](spawn::SpawnSpec) builder.
//!
//! The live-process pieces (firewall/netsh, elevated PowerShell, WSL port-forward,
//! network bind/LAN) are **deferred** to a later sub-step; their module surface is
//! scaffolded as clearly-marked stubs with no behavior: [`firewall`], [`network`],
//! [`port_forward`], [`elevated`].
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

pub mod detect;
pub mod path;
pub mod spawn;

// ---- Deferred live-process module surface (stubs, no behavior — later sub-step) ----
pub mod elevated;
pub mod firewall;
pub mod network;
pub mod port_forward;

pub use detect::{HostOs, Platform};
pub use path::{
    convert_windows_path_to_wsl_path, convert_wsl_drive_path_to_windows_path,
    detect_user_path_flavor, sanitize_user_path_input, UserPathFlavor,
};
pub use spawn::{build_spawn_spec, ShellType, SpawnSpec};

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
}

/// The real filesystem (the live edge).
#[derive(Debug, Default, Clone, Copy)]
pub struct RealFileProbe;

impl FileProbe for RealFileProbe {
    fn exists(&self, path: &str) -> bool {
        std::path::Path::new(path).exists()
    }
}

/// A set-backed [`FileProbe`] for deterministic unit tests.
#[derive(Debug, Default, Clone)]
pub struct MapFileProbe {
    present: std::collections::BTreeSet<String>,
}

impl MapFileProbe {
    pub fn new() -> Self {
        Self::default()
    }

    /// Builder-style: register `path` as existing.
    pub fn with(mut self, path: &str) -> Self {
        self.present.insert(path.to_string());
        self
    }
}

impl FileProbe for MapFileProbe {
    fn exists(&self, path: &str) -> bool {
        self.present.contains(path)
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
