//! App-bound server spawn + reap — the Rust analog of `electron/server-spawner.ts`
//! and the app-bound branch of `electron/startup.ts` (`startAppBoundServer`,
//! `startup.ts:247-279`).
//!
//! In Electron, app-bound mode spawns the **bundled Node** running
//! `server/index.js` with a `NODE_PATH` that puts the recompiled native `node-pty`
//! ahead of the pruned production deps (`server-spawner.ts:100-108`,
//! `startup.ts:266-277`). In the Tauri port this collapses to spawning ONE Rust
//! `freshell-server` binary (`architecture-spec.md:17-19,187-190`): **no bundled
//! Node, no `NODE_PATH`, no native-modules dir**. The health-poll and
//! SIGTERM→SIGKILL lifecycle are preserved 1:1 (see `health.rs` + [`reap_child`]).
//!
//! This module is pure/plumbing and unit-tested headlessly: the spawn PLAN
//! (program/args/env/port/token) is a pure function; the reap ESCALATION is a
//! pure decision; only [`spawn_server`]/[`reap_child`] touch a real process.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Everything needed to construct the app-bound `freshell-server` spawn.
///
/// Mirrors the inputs `server-spawner.ts` derives from `ServerSpawnerOptions`
/// (`server-spawner.ts:16-22`) — but for the single Rust binary, so the fields are
/// the binary path + the server's env contract (see `crates/freshell-server/src/main.rs`
/// docs: `PORT`, `AUTH_TOKEN`, `FRESHELL_BIND_HOST`, `HOME`/`FRESHELL_HOME`,
/// `FRESHELL_CLIENT_DIR`).
#[derive(Debug, Clone)]
pub struct SpawnConfig {
    /// Absolute path to the cargo-built `freshell-server` binary to spawn.
    pub server_binary: PathBuf,
    /// The ephemeral loopback port the server binds (`PORT`). App-bound always
    /// uses a fresh ephemeral port (see [`allocate_ephemeral_port`]).
    pub port: u16,
    /// The generated auth token (`AUTH_TOKEN`) the server requires and the SPA
    /// reads back from the `?token=` query (`startup.ts:155`).
    pub auth_token: String,
    /// The bind host (`FRESHELL_BIND_HOST`) — always `127.0.0.1` for app-bound
    /// (the server dies with the app; LAN exposure is the daemon/headless mode).
    pub bind_host: String,
    /// The home whose `.freshell/config.json` supplies the persisted overlay.
    /// `None` = inherit the real desktop `HOME` (production app-bound). `Some(_)`
    /// = an isolated home (tests / provisioning), passed as BOTH `FRESHELL_HOME`
    /// and `HOME` (matching the server's resolution order).
    pub home: Option<PathBuf>,
    /// Explicit `dist/client` dir (`FRESHELL_CLIENT_DIR`). `None` = let the server
    /// resolve it (its compile-time `../../dist/client` fallback).
    pub client_dir: Option<PathBuf>,
    /// An ownership tag written into the child's env (`FRESHELL_OWNER`) so an
    /// external `/proc`-ownership reaper can attribute the process to this shell —
    /// defense-in-depth on top of owning the `Child` handle directly.
    pub owner_tag: String,
}

/// A resolved, side-effect-free description of the process to spawn. Extracted so
/// the exact program/args/env can be asserted in a headless unit test (the
/// analog of asserting `spawn(cmd, args, {env})` in the TS suite).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Env vars to SET on top of the inherited environment (insertion-ordered,
    /// deterministic for tests). These OVERRIDE inherited values of the same key.
    pub env: Vec<(String, String)>,
}

impl SpawnPlan {
    /// Look up an env value by key (test helper).
    pub fn env_get(&self, key: &str) -> Option<&str> {
        self.env
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
}

/// Build the app-bound spawn plan. Pure — no process is created.
///
/// The env contract is exactly what `freshell-server` reads (`main.rs` header):
/// `PORT`, `AUTH_TOKEN`, `FRESHELL_BIND_HOST`, optionally `HOME`+`FRESHELL_HOME`
/// and `FRESHELL_CLIENT_DIR`, plus the `FRESHELL_OWNER` ownership tag. Crucially it
/// sets **no `NODE_PATH` and no `NODE_ENV`** — the single Rust binary replaces the
/// bundled-Node model (`architecture-spec.md:189-190`).
pub fn build_spawn_plan(cfg: &SpawnConfig) -> SpawnPlan {
    let mut env: Vec<(String, String)> = Vec::new();
    env.push(("PORT".to_string(), cfg.port.to_string()));
    env.push(("AUTH_TOKEN".to_string(), cfg.auth_token.clone()));
    env.push(("FRESHELL_BIND_HOST".to_string(), cfg.bind_host.clone()));
    if let Some(home) = &cfg.home {
        // Pass both keys: the server prefers FRESHELL_HOME, then HOME.
        env.push((
            "FRESHELL_HOME".to_string(),
            home.to_string_lossy().into_owned(),
        ));
        env.push(("HOME".to_string(), home.to_string_lossy().into_owned()));
    }
    if let Some(dir) = &cfg.client_dir {
        env.push((
            "FRESHELL_CLIENT_DIR".to_string(),
            dir.to_string_lossy().into_owned(),
        ));
    }
    env.push(("FRESHELL_OWNER".to_string(), cfg.owner_tag.clone()));

    SpawnPlan {
        program: cfg.server_binary.clone(),
        args: Vec::new(),
        env,
    }
}

/// Spawn the server from a plan. Inherits the parent environment and OVERRIDES the
/// plan's keys on top (the analog of `{...process.env, PORT}` in
/// `server-spawner.ts:95-98`). stderr is inherited so the server's single startup
/// line is visible; stdout is discarded.
pub fn spawn_server(plan: &SpawnPlan) -> std::io::Result<Child> {
    let mut command = Command::new(&plan.program);
    command.args(&plan.args);
    for (key, value) in &plan.env {
        command.env(key, value);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::null());
    command.stderr(Stdio::inherit());
    command.spawn()
}

/// Resolve the `freshell-server` binary to spawn:
/// 1. `FRESHELL_SERVER_BIN` (explicit override — used by the headless smoke/tests).
/// 2. A sibling of the current executable (`<exe_dir>/freshell-server[.exe]`) — in a
///    cargo workspace `freshell-tauri` and `freshell-server` land in the same
///    `target/<profile>/` dir, so the shell finds its server next to itself.
pub fn resolve_server_binary() -> std::io::Result<PathBuf> {
    if let Some(explicit) = std::env::var_os("FRESHELL_SERVER_BIN") {
        return Ok(PathBuf::from(explicit));
    }
    let exe = std::env::current_exe()?;
    let dir = exe.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "current exe has no parent directory",
        )
    })?;
    Ok(sibling_server_binary(dir, std::env::consts::EXE_SUFFIX))
}

/// The sibling `freshell-server` path in `dir` for the given exe suffix
/// (`""` on unix, `".exe"` on Windows). Pure — unit-tested for both suffixes.
pub fn sibling_server_binary(dir: &Path, exe_suffix: &str) -> PathBuf {
    dir.join(format!("freshell-server{exe_suffix}"))
}

/// Allocate a free ephemeral loopback port by binding `127.0.0.1:0` and reading
/// the assigned port back. The listener is dropped immediately; the server rebinds
/// it (the same brief-TOCTOU pattern the oracle's `test-server.ts` uses — fine for
/// loopback app-bound). "ephemeral 127.0.0.1 port" per the Phase-3.13 spec.
pub fn allocate_ephemeral_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Mint a generated `AUTH_TOKEN` for the app-bound spawn (128 bits of hex, two v4
/// UUIDs). The original resolves the token from `~/.freshell/.env`; app-bound in
/// the port generates one per boot and hands it to both the server (env) and the
/// SPA (the `?token=` URL) — `architecture-spec.md:187-190`, task spec.
pub fn generate_auth_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// The outcome of a reap (for logging + tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReapOutcome {
    /// The child had already exited before we signaled it.
    AlreadyExited,
    /// The child exited within the grace window after SIGTERM.
    Graceful,
    /// The child had to be SIGKILLed after the grace window elapsed.
    Forced,
}

/// One step of the reap escalation state machine — a pure decision, unit-tested.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReapStep {
    /// Child still alive, still within grace → keep waiting.
    WaitMore,
    /// Grace elapsed and child still alive → escalate to SIGKILL.
    Escalate,
    /// Child has exited → done.
    Done,
}

/// Decide the next reap step. Mirrors the `SIGTERM` → wait `grace` → `SIGKILL`
/// escalation of `server-spawner.ts:168-188` (5 s grace).
pub fn reap_step(child_alive: bool, elapsed: Duration, grace: Duration) -> ReapStep {
    if !child_alive {
        ReapStep::Done
    } else if elapsed >= grace {
        ReapStep::Escalate
    } else {
        ReapStep::WaitMore
    }
}

/// Gracefully reap the spawned server: request termination (SIGTERM on unix), wait
/// up to `grace` polling `poll`, then SIGKILL if still alive. 1:1 with
/// `server-spawner.ts` `stop()` (`:154-189`). Owning the `Child` means no `pkill`
/// (a divergence + safety risk, forbidden by `architecture-spec.md:220-221`).
pub fn reap_child(child: &mut Child, grace: Duration, poll: Duration) -> ReapOutcome {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return ReapOutcome::AlreadyExited;
    }

    // request_terminate returns whether a graceful signal was actually delivered
    // (true on unix). If not (Windows: no SIGTERM), skip straight to the hard kill.
    if request_terminate(child) {
        let deadline = Instant::now() + grace;
        loop {
            match reap_step(!has_exited(child), deadline.saturating_duration_since(Instant::now()), grace) {
                ReapStep::Done => return ReapOutcome::Graceful,
                ReapStep::Escalate => break,
                ReapStep::WaitMore => std::thread::sleep(poll),
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    ReapOutcome::Forced
}

/// Non-consuming "has the child exited?" probe.
fn has_exited(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(Some(_)))
}

/// Request graceful termination. Returns true if a graceful signal was delivered
/// (so the caller should wait for it), false if the platform has no graceful path
/// (escalate immediately).
#[cfg(unix)]
fn request_terminate(child: &Child) -> bool {
    // SAFETY: `kill(2)` with the child's pid + SIGTERM. A stale pid yields ESRCH,
    // which we ignore (the subsequent try_wait/kill handle the already-dead case).
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    true
}

#[cfg(not(unix))]
fn request_terminate(_child: &Child) -> bool {
    // No POSIX SIGTERM on Windows; the owned Child.kill() (TerminateProcess) is the
    // stop path. Return false so reap_child escalates without waiting the grace.
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn base_cfg() -> SpawnConfig {
        SpawnConfig {
            server_binary: PathBuf::from("/opt/freshell/freshell-server"),
            port: 51234,
            auth_token: "tok-abc123".to_string(),
            bind_host: "127.0.0.1".to_string(),
            home: None,
            client_dir: None,
            owner_tag: "freshell-tauri-4242".to_string(),
        }
    }

    #[test]
    fn plan_sets_program_and_core_env() {
        let plan = build_spawn_plan(&base_cfg());
        assert_eq!(plan.program, PathBuf::from("/opt/freshell/freshell-server"));
        assert!(plan.args.is_empty(), "the Rust server takes no positional args");
        assert_eq!(plan.env_get("PORT"), Some("51234"));
        assert_eq!(plan.env_get("AUTH_TOKEN"), Some("tok-abc123"));
        assert_eq!(plan.env_get("FRESHELL_BIND_HOST"), Some("127.0.0.1"));
        assert_eq!(plan.env_get("FRESHELL_OWNER"), Some("freshell-tauri-4242"));
    }

    #[test]
    fn plan_omits_bundled_node_vars() {
        // The single Rust binary replaces bundled-Node: NO NODE_PATH / NODE_ENV
        // (architecture-spec.md:189-190). Their presence would be a port defect.
        let plan = build_spawn_plan(&base_cfg());
        assert_eq!(plan.env_get("NODE_PATH"), None);
        assert_eq!(plan.env_get("NODE_ENV"), None);
    }

    #[test]
    fn plan_without_home_or_client_dir_omits_them() {
        let plan = build_spawn_plan(&base_cfg());
        assert_eq!(plan.env_get("HOME"), None, "inherit the real HOME when unset");
        assert_eq!(plan.env_get("FRESHELL_HOME"), None);
        assert_eq!(plan.env_get("FRESHELL_CLIENT_DIR"), None);
    }

    #[test]
    fn plan_with_isolated_home_sets_both_home_keys() {
        let mut cfg = base_cfg();
        cfg.home = Some(PathBuf::from("/tmp/isolated-home"));
        cfg.client_dir = Some(PathBuf::from("/tmp/dist/client"));
        let plan = build_spawn_plan(&cfg);
        assert_eq!(plan.env_get("FRESHELL_HOME"), Some("/tmp/isolated-home"));
        assert_eq!(plan.env_get("HOME"), Some("/tmp/isolated-home"));
        assert_eq!(plan.env_get("FRESHELL_CLIENT_DIR"), Some("/tmp/dist/client"));
    }

    #[test]
    fn plan_env_keys_are_unique() {
        let mut cfg = base_cfg();
        cfg.home = Some(PathBuf::from("/h"));
        cfg.client_dir = Some(PathBuf::from("/c"));
        let plan = build_spawn_plan(&cfg);
        let mut seen: HashMap<&str, u32> = HashMap::new();
        for (k, _) in &plan.env {
            *seen.entry(k.as_str()).or_default() += 1;
        }
        assert!(seen.values().all(|&n| n == 1), "duplicate env key in plan: {seen:?}");
    }

    #[test]
    fn sibling_binary_uses_exe_suffix() {
        let dir = Path::new("/work/target/debug");
        assert_eq!(
            sibling_server_binary(dir, ""),
            PathBuf::from("/work/target/debug/freshell-server")
        );
        assert_eq!(
            sibling_server_binary(dir, ".exe"),
            PathBuf::from("/work/target/debug/freshell-server.exe")
        );
    }

    #[test]
    fn generated_token_is_nonempty_and_url_safe_hex() {
        let token = generate_auth_token();
        assert_eq!(token.len(), 64, "two v4 uuids simple-formatted = 64 hex chars");
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(generate_auth_token(), token, "tokens are per-call random");
    }

    #[test]
    fn ephemeral_port_is_nonzero_and_bindable() {
        let port = allocate_ephemeral_port().expect("allocate ephemeral port");
        assert_ne!(port, 0);
        // Re-bindable after release (the listener was dropped).
        let again = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(again.is_ok(), "ephemeral port should be free after release");
    }

    #[test]
    fn reap_step_transitions() {
        let grace = Duration::from_secs(5);
        // Alive, still within grace → wait.
        assert_eq!(reap_step(true, Duration::from_secs(1), grace), ReapStep::WaitMore);
        // Alive, grace elapsed → escalate.
        assert_eq!(reap_step(true, Duration::from_secs(5), grace), ReapStep::Escalate);
        assert_eq!(reap_step(true, Duration::from_secs(9), grace), ReapStep::Escalate);
        // Exited → done, regardless of elapsed.
        assert_eq!(reap_step(false, Duration::from_secs(0), grace), ReapStep::Done);
        assert_eq!(reap_step(false, Duration::from_secs(9), grace), ReapStep::Done);
    }

    #[test]
    fn reap_already_exited_short_process() {
        // A process that exits on its own is reaped as AlreadyExited (or Graceful
        // if the race lands mid-signal) — never Forced.
        let mut child = Command::new("true")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn `true`");
        // Give it a moment to exit on its own.
        std::thread::sleep(Duration::from_millis(50));
        let outcome = reap_child(&mut child, Duration::from_secs(5), Duration::from_millis(10));
        assert!(
            matches!(outcome, ReapOutcome::AlreadyExited | ReapOutcome::Graceful),
            "a self-exited process must not be Forced, got {outcome:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn reap_terminates_a_long_sleeper_gracefully() {
        // `sleep 600` ignores nothing and dies on SIGTERM → Graceful within grace.
        let mut child = Command::new("sleep")
            .arg("600")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn `sleep 600`");
        let outcome = reap_child(&mut child, Duration::from_secs(5), Duration::from_millis(20));
        assert_eq!(outcome, ReapOutcome::Graceful);
        assert!(has_exited(&mut child), "child must be reaped, no orphan");
    }
}
