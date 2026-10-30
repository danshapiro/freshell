//! Compile-time build-provenance stamp for `freshell-ws`: bakes the git
//! validated `FRESHELL_BUILD_COMMIT` input (or the checkout SHA) into
//! `FRESHELL_WS_BUILD_COMMIT` so the WS handshake's `ready` can stamp
//! `ready.buildId` (client-side stale-bundle auto-reload).
//! Build provenance is BUILD-scoped, not boot-scoped, so it deliberately
//! does NOT ride on `WsState` (whose contents are boot-scoped ids/state
//! injected by `freshell-server`). The full worktree-aware rationale for
//! the `rerun-if-changed` set lives in `crates/freshell-server/build.rs` —
//! this copy performs the SAME resolved-HEAD/ref/packed-refs watching so a
//! cached rebuild re-stamps when HEAD moves; both crates compile in the
//! same workspace build, so their baked commits agree. Never fails the
//! build over a missing/unavailable `git` (falls back to `"unknown"` unless
//! the validated build input is present).

use std::path::PathBuf;
use std::process::Command;

fn main() {
    let commit = build_commit_override()
        .or_else(git_head_commit)
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=FRESHELL_WS_BUILD_COMMIT={commit}");
    println!("cargo:rerun-if-env-changed=FRESHELL_BUILD_COMMIT");
    // Match the server's cache trigger: copied incremental artifacts can still
    // watch another worktree's Git paths until this script runs here again.
    // The trigger only invalidates the cache; provenance still comes from git
    // or the separately validated FRESHELL_BUILD_COMMIT input above.
    println!("cargo:rerun-if-env-changed=FRESHELL_BUILD_SOURCE_STATE");
    for path in rerun_paths() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}

/// The Cloud Build provenance input is intentionally stricter than a generic
/// string: only a full lowercase Git object id may replace checkout discovery.
/// Invalid values preserve the ordinary git -> `"unknown"` fallback.
fn build_commit_override() -> Option<String> {
    std::env::var("FRESHELL_BUILD_COMMIT")
        .ok()
        .filter(|value| is_lowercase_commit(value))
}

fn is_lowercase_commit(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `git rev-parse HEAD`, trimmed. `None` on any failure (git not on `PATH`,
/// not inside a git checkout, ...) -- the caller falls back to `"unknown"`.
fn git_head_commit() -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// The exact paths that change when HEAD moves in THIS checkout, resolved
/// worktree-aware via `git rev-parse --git-path` (see the module doc and
/// `crates/freshell-server/build.rs`'s richer version for why each entry is
/// watched). Skipped resolutions degrade to cargo's default heuristics.
fn rerun_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let git_path = |arg: &str| {
        Command::new("git")
            .args(["rev-parse", "--git-path", arg])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
            .filter(|p| !p.as_os_str().is_empty())
    };
    if let Some(head) = git_path("HEAD") {
        paths.push(head);
    }
    if let Some(head) = git_path("HEAD") {
        if let Ok(contents) = std::fs::read_to_string(&head) {
            if let Some(ref_name) = contents.strip_prefix("ref: ") {
                if let Some(resolved) = git_path(ref_name.trim()) {
                    paths.push(resolved);
                }
            }
        }
    }
    if let Some(packed) = git_path("packed-refs") {
        if packed.exists() {
            paths.push(packed);
        }
    }
    paths
}
