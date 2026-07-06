//! The `files` REST surface the RETAINED SPA's DirectoryPicker needs (Phase 3.15).
//!
//! When a browser user opens a Fresh Agent pane (Freshclaude / Freshcodex /
//! Freshopencode) the pane first renders a `DirectoryPicker`
//! (`src/components/panes/DirectoryPicker.tsx`) to choose the session cwd. That
//! picker paints its selectable rows (`role="option"`) from
//! `GET /api/files/candidate-dirs`, and confirms a pick through
//! `POST /api/files/validate-dir`. Without those two endpoints the picker has no
//! options and the whole Fresh Agent create flow stalls (the T3 e2e specs time out
//! on `getByRole('option')`).
//!
//! This module ports the minimal read-only slice of `server/files-router.ts` the
//! picker exercises, faithfully:
//!
//! * `GET  /api/files/candidate-dirs` — mirrors `files-router.ts:319` +
//!   `server/candidate-dirs.ts#collectCandidateDirectories`. Sources, in the
//!   original's order: coding-cli projects, running-terminal cwds,
//!   `recentDirectories`, provider cwds, then `settings.defaultCwd`, de-duplicated
//!   preserving first-seen order. In the oracle's isolated runtime the projects
//!   index / recentDirectories / provider cwds are empty, so the effective set is
//!   the live terminal cwds (from the shared [`TerminalRegistry`]) plus
//!   `settings.defaultCwd` — exactly what the original returns on a clean boot.
//! * `POST /api/files/validate-dir` — mirrors `files-router.ts:232` +
//!   `path-utils.ts#isReachableDirectory`: normalize the user path (`~` expansion,
//!   trailing-separator trim), `stat` it, and report `{ valid, resolvedPath }`
//!   (`valid` iff it resolves to an existing directory).
//!
//! Both routes are gated by the shared auth token (via [`crate::boot::is_authed`],
//! the port of `server/auth.ts#httpAuthMiddleware`). Everything here is ADDITIVE
//! and read-only; no `server/` or `shared/` source is touched.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use freshell_protocol::ServerSettings;
use freshell_terminal::TerminalRegistry;
use serde_json::{json, Value};

/// Shared, cheaply-cloneable state for the files REST surface.
#[derive(Clone)]
pub struct FilesState {
    /// The required auth token (`AUTH_TOKEN`) — the gate for every route here.
    pub auth_token: Arc<String>,
    /// The server-settings tree; `settings.defaultCwd` is the final candidate-dir.
    pub settings: Arc<ServerSettings>,
    /// The shared, connection-independent terminal registry — its running
    /// terminals' cwds are the primary candidate directories on a clean boot.
    pub registry: TerminalRegistry,
}

/// The files REST sub-router, pre-bound to its state (mergeable into the app).
pub fn router(state: FilesState) -> Router {
    Router::new()
        .route("/api/files/candidate-dirs", get(candidate_dirs))
        .route("/api/files/validate-dir", post(validate_dir))
        .with_state(state)
}

// ── Handlers ────────────────────────────────────────────────────────────────

/// `GET /api/files/candidate-dirs` → `{ directories: string[] }`.
///
/// Ports `collectCandidateDirectories` for the isolated-runtime sources: the live
/// terminal cwds (registry) then `settings.defaultCwd`, de-duped preserving order.
async fn candidate_dirs(State(state): State<FilesState>, headers: HeaderMap) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    let mut directories: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Terminals: the running PTYs' cwds (the original's `registry.list()` source).
    for terminal in state.registry.inventory() {
        add_unique_directory(&mut directories, &mut seen, terminal.cwd.as_deref());
    }

    // Then `settings.defaultCwd` (the original appends it last). Empty on a clean
    // isolated boot, present once a user has configured one.
    add_unique_directory(
        &mut directories,
        &mut seen,
        state.settings.default_cwd.as_deref(),
    );

    // Fallback: the original resolves EVERY default terminal's cwd to
    // `getDefaultCwd(settings) || os.homedir()` at create time
    // (`terminal-registry.ts:1565`), so its terminal records — and therefore this
    // list — always carry the home directory. The port faithfully records a default
    // terminal's cwd as `None` (the reference passes `undefined`), so when nothing
    // above contributed a directory we apply the SAME `defaultCwd || $HOME`
    // resolution here, yielding the identical observable candidate list (the
    // DirectoryPicker needs at least one option to render). This touches only the
    // endpoint — never the PTY spawn or `terminal.created` — so T0/T1 are unaffected.
    if directories.is_empty() {
        let fallback = state
            .settings
            .default_cwd
            .clone()
            .or_else(|| home_dir().map(|h| h.to_string_lossy().into_owned()));
        add_unique_directory(&mut directories, &mut seen, fallback.as_deref());
    }

    Json(json!({ "directories": directories })).into_response()
}

/// `POST /api/files/validate-dir` `{ path }` → `{ valid, resolvedPath }`.
///
/// Ports `isReachableDirectory`: normalize the user path, `stat` it, and report
/// whether it resolves to an existing directory. A missing/blank `path` is `400`,
/// exactly like the original.
async fn validate_dir(
    State(state): State<FilesState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    let raw = body.get("path").and_then(Value::as_str).unwrap_or("");
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "path is required" }))).into_response();
    }

    let normalized_path = normalize_user_path(trimmed);
    let is_dir = std::fs::metadata(&normalized_path)
        .map(|meta| meta.is_dir())
        .unwrap_or(false);

    Json(json!({ "valid": is_dir, "resolvedPath": normalized_path })).into_response()
}

// ── Helpers ───────────────────────────────────────────────────────────────

/// `addUniqueDirectory` (`candidate-dirs.ts:11`): push a trimmed, non-empty,
/// not-yet-seen directory, preserving first-seen order.
fn add_unique_directory(
    directories: &mut Vec<String>,
    seen: &mut std::collections::HashSet<String>,
    value: Option<&str>,
) {
    let Some(value) = value else { return };
    let trimmed = value.trim();
    if trimmed.is_empty() || seen.contains(trimmed) {
        return;
    }
    seen.insert(trimmed.to_string());
    directories.push(trimmed.to_string());
}

/// Normalize a user-supplied directory path: expand a leading `~`/`~/…` to `$HOME`
/// and trim trailing separators (mirrors `path-utils.ts#normalizeUserPath` for the
/// POSIX host the oracle runs on — the `\\wsl$\…` Windows flavor is a later step,
/// not exercised by the Linux-host e2e). Returns the path unchanged when it does
/// not resolve.
fn normalize_user_path(input: &str) -> String {
    let expanded = expand_tilde(input);
    trim_trailing_separators(&expanded)
}

/// Expand a leading `~` (bare or `~/rest`) to the process `$HOME`. Other `~user`
/// forms are left untouched (the DirectoryPicker only ever sends `~` or absolute
/// paths).
fn expand_tilde(input: &str) -> String {
    if input == "~" {
        if let Some(home) = home_dir() {
            return home.to_string_lossy().into_owned();
        }
        return input.to_string();
    }
    if let Some(rest) = input.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    input.to_string()
}

/// `$HOME` (or `FRESHELL_HOME`, matching the server's own home resolution).
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("FRESHELL_HOME"))
        .map(PathBuf::from)
}

/// Trim trailing `/` separators, but never below the filesystem root.
fn trim_trailing_separators(input: &str) -> String {
    let path = Path::new(input);
    // Leave the root (`/`) as-is.
    if path.parent().is_none() {
        return input.to_string();
    }
    let trimmed = input.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

/// `401 { "error": "Unauthorized" }` — byte-shape-equal to the original's reject.
fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_unique_dedupes_and_trims() {
        let mut dirs = Vec::new();
        let mut seen = std::collections::HashSet::new();
        add_unique_directory(&mut dirs, &mut seen, Some("/a"));
        add_unique_directory(&mut dirs, &mut seen, Some("  /a  ")); // dup after trim
        add_unique_directory(&mut dirs, &mut seen, Some("   ")); // blank
        add_unique_directory(&mut dirs, &mut seen, None);
        add_unique_directory(&mut dirs, &mut seen, Some("/b"));
        assert_eq!(dirs, vec!["/a".to_string(), "/b".to_string()]);
    }

    #[test]
    fn trim_trailing_separators_keeps_root() {
        assert_eq!(trim_trailing_separators("/"), "/");
        assert_eq!(trim_trailing_separators("/tmp/x/"), "/tmp/x");
        assert_eq!(trim_trailing_separators("/tmp/x///"), "/tmp/x");
        assert_eq!(trim_trailing_separators("/tmp/x"), "/tmp/x");
    }

    #[test]
    fn expand_tilde_uses_home() {
        std::env::set_var("HOME", "/home/tester");
        assert_eq!(expand_tilde("~"), "/home/tester");
        assert_eq!(expand_tilde("~/proj"), "/home/tester/proj");
        assert_eq!(expand_tilde("/abs"), "/abs");
    }

    #[test]
    fn validate_dir_semantics_against_real_fs() {
        // An existing directory validates; a bogus path does not.
        let tmp = std::env::temp_dir();
        assert!(std::fs::metadata(&tmp).map(|m| m.is_dir()).unwrap_or(false));
        let bogus = tmp.join("freshell-nonexistent-xyz-123456");
        assert!(!std::fs::metadata(&bogus).map(|m| m.is_dir()).unwrap_or(false));
    }
}
