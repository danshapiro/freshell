//! The server binary's `__unit-exec` dispatch (black-box): `freshell-server
//! __unit-exec -- <cmd...>` is the production per-member exec shim of
//! agent-pane containment. It must run before the server builds its async
//! runtime: a shim lives as long as its pane, so a runtime's worker threads
//! (one per CPU) in every pane's shim are a cost (plan review R2-F1), and the
//! Linux reaper installs signal handlers and reaps with `waitpid(-1)`. It
//! also runs before the server strips an inherited unit tag, so the tag the
//! placement set reaches the command.
//!
//! Harness conventions are intentionally duplicated from
//! `diag01_lifecycle_logging.rs` (this repo's black-box test files each carry
//! their own small copy). No process here is signalled.
#![cfg(target_os = "linux")]

use std::path::PathBuf;
use std::process::Command;

fn discover_server_binary() -> PathBuf {
    if let Some(explicit) = std::env::var_os("FRESHELL_SERVER_BIN") {
        return PathBuf::from(explicit);
    }
    let suffix = std::env::consts::EXE_SUFFIX;
    if let Some(found) = find_sibling(suffix) {
        return found;
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let status = Command::new(env!("CARGO"))
        .args(["build", "--bin", "freshell-server"])
        .current_dir(&manifest_dir)
        .status()
        .expect("spawn `cargo build --bin freshell-server`");
    assert!(status.success(), "cargo build --bin freshell-server failed");
    find_sibling(suffix).expect("freshell-server binary not found even after building it")
}

fn find_sibling(suffix: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    for dir in exe.ancestors().skip(1).take(3) {
        let candidate = dir.join(format!("freshell-server{suffix}"));
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// `freshell-server __unit-exec -- sh -c <script>`, with no inherited unit
/// tag (a test runner started inside a Freshell pane must not change the
/// outcome).
fn unit_exec(script: &str) -> Command {
    let mut cmd = Command::new(discover_server_binary());
    cmd.args(["__unit-exec", "--", "sh", "-c", script])
        .env_remove("FRESHELL_UNIT_ID");
    cmd
}

#[test]
fn the_shim_runs_its_command_and_exits_with_the_commands_code() {
    let status = unit_exec("exit 7").status().expect("run the shim");
    assert_eq!(status.code(), Some(7), "{status:?}");
}

#[test]
fn the_unit_tag_set_by_the_placement_reaches_the_command() {
    let out = unit_exec("printf %s \"$FRESHELL_UNIT_ID\"")
        .env("FRESHELL_UNIT_ID", "u0123456789abcdef0123456789abcdef")
        .output()
        .expect("run the shim");
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "u0123456789abcdef0123456789abcdef"
    );
}

/// The shim is the command's parent (`$PPID`) while it waits for it: with
/// no runtime built, its only thread is the main one.
#[test]
fn the_shim_runs_before_any_async_runtime_starts() {
    let out = unit_exec("ls /proc/$PPID/task | wc -l")
        .output()
        .expect("run the shim");
    assert!(out.status.success(), "{out:?}");
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "1",
        "the shim runs with more than its main thread (an async runtime's workers?)"
    );
}
