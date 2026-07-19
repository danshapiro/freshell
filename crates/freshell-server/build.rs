//! Compile-time provenance stamp for `freshell-server`: bakes the git commit
//! SHA + a "was the tree dirty at build time" flag into two `rustc-env`
//! variables (`FRESHELL_BUILD_COMMIT` / `FRESHELL_BUILD_DIRTY`) that
//! `src/diag.rs` reads via `option_env!` and surfaces additively on
//! `GET /api/server-info` (`commit` / `buildDirty`). Prevention lane for the
//! incident this closes: a production investigation was slowed because the
//! running binary's source commit was unknowable (built mid-WIP from a
//! dirty tree, with no way to confirm that after the fact).
//!
//! Never fails the build over a missing/unavailable `git`: every git
//! invocation here degrades to a documented fallback (`"unknown"` for the
//! commit; `"unknown"` -> treated as dirty, fail-closed, for `buildDirty`)
//! rather than panicking or returning a non-zero exit from `main()` -- a
//! build script that could abort `cargo build` over a diagnostics nicety
//! would be strictly worse than the problem it solves.
//!
//! `cargo:rerun-if-changed` is pointed at the exact files that change when
//! HEAD moves in THIS checkout so a cached build restamps correctly:
//!   * the resolved `HEAD` file (`git rev-parse --git-path HEAD`) -- this is
//!     WORKTREE-AWARE: a git worktree's `HEAD` lives under
//!     `<common-git-dir>/worktrees/<name>/HEAD`, not the common dir's own
//!     `HEAD`, and `--git-path` resolves the correct one for wherever this
//!     build actually runs.
//!   * when HEAD is a symbolic ref (the normal on-a-branch case), the
//!     RESOLVED ref file too (e.g. `refs/heads/feat/rust-tauri-port`). A
//!     plain `git commit` on the same already-checked-out branch changes
//!     that ref file's bytes, never `HEAD`'s own bytes (HEAD's content, the
//!     `ref: refs/heads/...` line, is unchanged by a same-branch commit) --
//!     without also watching the ref file, the stamp would silently go
//!     stale across a cached rebuild after a same-branch commit.
//!   * the common dir's `packed-refs`, in case that ref is (or becomes)
//!     packed rather than loose (e.g. after `git gc`/`git pack-refs`).
//!
//! Any step that can't resolve a path (git missing, detached HEAD with no
//! symbolic ref, a path that doesn't exist) is simply skipped -- this
//! degrades to cargo's normal source-file-based rerun heuristics, never a
//! build failure.

use std::path::PathBuf;
use std::process::Command;

fn main() {
    let commit = git_head_commit().unwrap_or_else(|| "unknown".to_string());
    let dirty = git_tree_dirty();

    println!("cargo:rustc-env=FRESHELL_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=FRESHELL_BUILD_DIRTY={dirty}");

    for path in rerun_paths() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}

/// `git rev-parse HEAD`, trimmed. `None` on any failure (git not on `PATH`,
/// not inside a git checkout, ...) -- the caller falls back to `"unknown"`.
fn git_head_commit() -> Option<String> {
    run_git(&["rev-parse", "HEAD"])
}

/// `git status --porcelain` non-empty => `"true"`; empty => `"false"`; any
/// git failure => `"unknown"`. `diag.rs::build_dirty()` treats `"unknown"`
/// as dirty -- fail-closed, so an unverifiable build is never silently
/// reported clean.
fn git_tree_dirty() -> String {
    match run_git_raw(&["status", "--porcelain"]) {
        Some(output) => {
            if output.trim().is_empty() {
                "false".to_string()
            } else {
                "true".to_string()
            }
        }
        None => "unknown".to_string(),
    }
}

/// Runs `git <args>` and returns stdout trimmed, or `None` on any failure
/// (missing binary, non-zero exit, invalid UTF-8).
fn run_git(args: &[&str]) -> Option<String> {
    run_git_raw(args).map(|s| s.trim().to_string())
}

/// As [`run_git`], but returns raw (untrimmed) stdout -- `git_tree_dirty`
/// needs to distinguish "empty" from "whitespace-only" for its own
/// `.trim().is_empty()` check rather than have that decision made twice.
fn run_git_raw(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

/// Every file whose modification should trigger a restamp. Best-effort --
/// see the module doc comment above for the worktree-aware HEAD/ref
/// resolution rationale.
fn rerun_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(head_path) = run_git(&["rev-parse", "--git-path", "HEAD"]) {
        paths.push(PathBuf::from(head_path));
    }

    if let Some(ref_name) = run_git(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(ref_path) = run_git(&["rev-parse", "--git-path", &ref_name]) {
            let path = PathBuf::from(ref_path);
            if path.exists() {
                paths.push(path);
            }
        }
    }

    if let Some(packed) = run_git(&["rev-parse", "--git-path", "packed-refs"]) {
        let path = PathBuf::from(packed);
        if path.exists() {
            paths.push(path);
        }
    }

    paths
}
