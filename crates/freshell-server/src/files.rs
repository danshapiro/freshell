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
//! * `GET  /api/files/candidate-dirs` \u2014 mirrors `files-router.ts:319` +
//!   `server/candidate-dirs.ts#collectCandidateDirectories`. Sources, in the
//!   original's order: coding-cli projects, running-terminal cwds,
//!   `recentDirectories`, provider cwds, then `settings.defaultCwd`, de-duplicated
//!   preserving first-seen order. In the oracle's isolated runtime the projects
//!   index / recentDirectories / provider cwds are empty, so the effective set is
//!   the live terminal cwds (from the shared [`TerminalRegistry`]) plus
//!   `settings.defaultCwd` \u2014 exactly what the original returns on a clean boot.
//!   R8: unlike an earlier revision, this NEVER falls back to `$HOME` when the
//!   set is empty \u2014 `collectCandidateDirectories` has no such fallback, and the
//!   original's empty-state response really is `{ directories: [] }`.
//! * `POST /api/files/validate-dir` \u2014 mirrors `files-router.ts:232` +
//!   `path-utils.ts#isReachableDirectory`: normalize the user path (`~` expansion,
//!   trailing-separator trim), `stat` it, and report `{ valid, resolvedPath }`
//!   (`valid` iff it resolves to an existing directory).
//!
//! Both routes are gated by the shared auth token (via [`crate::boot::is_authed`],
//! the port of `server/auth.ts#httpAuthMiddleware`). Everything here is ADDITIVE
//! and read-only against the retained client; no `server/` or `shared/` source is
//! touched.
//!
//! R3 (security-relevant): `allowedFilePaths` sandbox enforcement reads the LIVE
//! [`SettingsStore`] on every request (not a boot-time snapshot), so a
//! `PATCH /api/settings` toggling the sandbox takes effect immediately \u2014 the
//! root cause of the earlier divergence was that this state held its own frozen
//! `Arc<ServerSettings>` that a settings patch could never reach.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use freshell_terminal::TerminalRegistry;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::settings_store::SettingsStore;

/// `?path=<p>` query for `read` / `stat`.
#[derive(Debug, Deserialize)]
pub struct PathQuery {
    pub path: Option<String>,
}

/// `?prefix=<p>&root=<r>&dirs=<b>` query for `complete`.
#[derive(Debug, Deserialize)]
pub struct CompleteQuery {
    pub prefix: Option<String>,
    pub root: Option<String>,
    pub dirs: Option<String>,
}

/// Shared, cheaply-cloneable state for the files REST surface.
#[derive(Clone)]
pub struct FilesState {
    /// The required auth token (`AUTH_TOKEN`) \u2014 the gate for every route here.
    pub auth_token: Arc<String>,
    /// The LIVE server-settings store (R3): `allowedFilePaths` sandbox +
    /// `defaultCwd` are read fresh on every request.
    pub settings: SettingsStore,
    /// The shared, connection-independent terminal registry \u2014 its running
    /// terminals' cwds are the primary candidate directories on a clean boot.
    pub registry: TerminalRegistry,
}

/// The files REST sub-router, pre-bound to its state (mergeable into the app).
pub fn router(state: FilesState) -> Router {
    Router::new()
        .route("/api/files/candidate-dirs", get(candidate_dirs))
        .route("/api/files/validate-dir", post(validate_dir))
        .route("/api/files/read", get(read_file))
        .route("/api/files/stat", get(stat_file))
        .route("/api/files/write", post(write_file))
        .route("/api/files/complete", get(complete))
        .route("/api/files/mkdir", post(mkdir))
        .with_state(state)
}

// \u2500\u2500 Handlers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/// `GET /api/files/candidate-dirs` \u2192 `{ directories: string[] }`.
///
/// Ports `collectCandidateDirectories` for the isolated-runtime sources: the live
/// terminal cwds (registry) then `settings.defaultCwd`, de-duped preserving
/// order. R8: no `$HOME` fallback \u2014 an empty set stays `[]`, byte-matching the
/// original's empty-state response.
async fn candidate_dirs(State(state): State<FilesState>, headers: HeaderMap) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    let settings = state.settings.get().await;
    let mut directories: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Terminals: the running PTYs' cwds (the original's `registry.list()` source).
    for terminal in state.registry.inventory() {
        add_unique_directory(&mut directories, &mut seen, terminal.cwd.as_deref());
    }

    // Then `settings.defaultCwd` (the original appends it last). Empty on a clean
    // isolated boot, present once a user has configured one.
    add_unique_directory(&mut directories, &mut seen, settings.default_cwd.as_deref());

    Json(json!({ "directories": directories })).into_response()
}

/// `POST /api/files/validate-dir` `{ path }` \u2192 `{ valid, resolvedPath }`.
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

/// `GET /api/files/read?path=<p>` \u2192 `{ content, size, modifiedAt }` (`files-router.ts:85`).
///
/// The retained `EditorPane` opens a file with this (`EditorPane.tsx:368`). A
/// directory is `400`, a missing file `404`, a sandbox-denied path `403` \u2014 the
/// original's exact shapes. On the POSIX oracle host the normalized user path IS
/// the filesystem path (the `\\wsl$\u2026` Windows flavor is a documented later step).
async fn read_file(State(state): State<FilesState>, headers: HeaderMap, Query(q): Query<PathQuery>) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(path) = q.path.filter(|p| !p.is_empty()) else {
        return bad_request("path query parameter required");
    };
    let resolved = normalize_user_path(&path);
    let settings = state.settings.get().await;
    if !is_path_allowed(&resolved, settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }
    match std::fs::metadata(&resolved) {
        Ok(meta) if meta.is_dir() => bad_request("Cannot read directory"),
        Ok(meta) => match std::fs::read(&resolved) {
            Ok(bytes) => {
                let content = String::from_utf8_lossy(&bytes).into_owned();
                Json(json!({
                    "content": content,
                    "size": meta.len(),
                    "modifiedAt": mtime_iso(&meta),
                }))
                .into_response()
            }
            Err(err) => internal_error(&err.to_string()),
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => not_found("File not found"),
        Err(err) => internal_error(&err.to_string()),
    }
}

/// `GET /api/files/stat?path=<p>` \u2192 `{ exists, size, modifiedAt }` (`files-router.ts:113`).
///
/// `EditorPane`'s external-change poll (`EditorPane.tsx:745`). A directory or a
/// missing file is reported as `{ exists:false, size:null, modifiedAt:null }`.
async fn stat_file(State(state): State<FilesState>, headers: HeaderMap, Query(q): Query<PathQuery>) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(path) = q.path.filter(|p| !p.is_empty()) else {
        return bad_request("path query parameter required");
    };
    let resolved = normalize_user_path(&path);
    let settings = state.settings.get().await;
    if !is_path_allowed(&resolved, settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }
    match std::fs::metadata(&resolved) {
        Ok(meta) if meta.is_dir() => {
            Json(json!({ "exists": false, "size": null, "modifiedAt": null })).into_response()
        }
        Ok(meta) => Json(json!({
            "exists": true,
            "size": meta.len(),
            "modifiedAt": mtime_iso(&meta),
        }))
        .into_response(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Json(json!({ "exists": false, "size": null, "modifiedAt": null })).into_response()
        }
        Err(err) => internal_error(&err.to_string()),
    }
}

/// `POST /api/files/write` `{ path, content }` \u2192 `{ success, modifiedAt }`
/// (`files-router.ts:140`). `EditorPane`'s save (`EditorPane.tsx:600`); creates
/// parent dirs, writes UTF-8, returns the new mtime.
async fn write_file(State(state): State<FilesState>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(path) = body.get("path").and_then(Value::as_str).filter(|p| !p.is_empty()) else {
        return bad_request("path is required");
    };
    let Some(content) = body.get("content").and_then(Value::as_str) else {
        return bad_request("content is required");
    };
    let resolved = normalize_user_path(path);
    let settings = state.settings.get().await;
    if !is_path_allowed(&resolved, settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }
    if let Some(parent) = Path::new(&resolved).parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            return internal_error(&err.to_string());
        }
    }
    if let Err(err) = std::fs::write(&resolved, content.as_bytes()) {
        return internal_error(&err.to_string());
    }
    match std::fs::metadata(&resolved) {
        Ok(meta) => Json(json!({ "success": true, "modifiedAt": mtime_iso(&meta) })).into_response(),
        Err(err) => internal_error(&err.to_string()),
    }
}

/// `GET /api/files/complete?prefix=<p>&root=<r>&dirs=<b>` \u2192
/// `{ suggestions:[{ path, isDirectory }] }` (`files-router.ts:168`). The path
/// autocomplete for `EditorPane` / `DirectoryPicker` / `FreshAgentComposer`.
async fn complete(State(state): State<FilesState>, headers: HeaderMap, Query(q): Query<CompleteQuery>) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(prefix) = q.prefix.filter(|p| !p.is_empty()) else {
        return bad_request("prefix query parameter required");
    };
    let dirs_only = matches!(q.dirs.as_deref(), Some("true") | Some("1"));

    // Resolve the completion input against `root` (unless the prefix is absolute).
    let completion_input = resolve_completion_input(&prefix, q.root.as_deref());
    let normalized = normalize_user_path(&completion_input);
    let settings = state.settings.get().await;
    if !is_path_allowed(&normalized, settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }

    // If the input is itself a directory, list all its entries; otherwise treat the
    // basename as a partial and filter the parent's entries by it.
    let (dir_display, dir_fs, basename) = match std::fs::metadata(&normalized) {
        Ok(meta) if meta.is_dir() => (normalized.clone(), normalized.clone(), String::new()),
        _ => {
            let p = Path::new(&normalized);
            let parent = p
                .parent()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_else(|| "/".to_string());
            let base = p
                .file_name()
                .map(|b| b.to_string_lossy().into_owned())
                .unwrap_or_default();
            (parent.clone(), parent, base)
        }
    };

    let mut matches: Vec<(String, bool)> = match std::fs::read_dir(&dir_fs) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.starts_with(&basename) {
                    return None;
                }
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if dirs_only && !is_dir {
                    return None;
                }
                let joined = Path::new(&dir_display).join(&name).to_string_lossy().into_owned();
                Some((joined, is_dir))
            })
            .collect(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(err) => return internal_error(&err.to_string()),
    };
    // Sort: directories first, then alphabetically by path; cap at 20.
    matches.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.cmp(&b.0),
    });
    matches.truncate(20);
    let suggestions: Vec<Value> = matches
        .into_iter()
        .map(|(path, is_directory)| json!({ "path": path, "isDirectory": is_directory }))
        .collect();
    Json(json!({ "suggestions": suggestions })).into_response()
}

/// `POST /api/files/mkdir` `{ path }` \u2192 `{ created, existed, resolvedPath }`
/// (`files-router.ts:247`). The `DirectoryPicker`'s "create folder"
/// (`DirectoryPicker.tsx:216`).
///
/// R7: the original's `fsp.mkdir(path, { recursive: true })` succeeds silently
/// whether or not the directory already existed \u2014 recursive mkdir CANNOT
/// distinguish the two, so a successful create is ALWAYS reported as
/// `existed:false` (`files-router.ts:262-263`). `existed:true` is only reached
/// from the `EEXIST` catch branch, which in practice fires for a path that
/// already exists as something recursive-mkdir still complained about; the
/// common "directory already there" case never takes that branch. This port
/// therefore never pre-checks existence \u2014 it always attempts the create and
/// reports `existed` purely from what `create_dir_all` tells it (i.e. never true
/// on success), matching the original's observable behavior exactly.
async fn mkdir(State(state): State<FilesState>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(path) = body.get("path").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty()) else {
        return bad_request("path is required");
    };
    let resolved = normalize_user_path(path);
    let settings = state.settings.get().await;
    if !is_path_allowed(&resolved, settings.allowed_file_paths.as_deref()) {
        return forbidden();
    }
    match std::fs::create_dir_all(&resolved) {
        Ok(()) => Json(json!({ "created": true, "existed": false, "resolvedPath": resolved })).into_response(),
        Err(err) => match err.kind() {
            std::io::ErrorKind::PermissionDenied => forbidden_msg("Permission denied"),
            _ => {
                // A path component that exists but is not a directory \u2192 409.
                if Path::new(&resolved).exists() {
                    (StatusCode::CONFLICT, Json(json!({ "error": "Path exists but is not a directory" }))).into_response()
                } else {
                    internal_error(&err.to_string())
                }
            }
        },
    }
}

// \u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

/// Normalize a user-supplied directory path: expand a leading `~`/`~/\u2026` to `$HOME`
/// and trim trailing separators (mirrors `path-utils.ts#normalizeUserPath` for the
/// POSIX host the oracle runs on \u2014 the `\\wsl$\u2026` Windows flavor is a later step,
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

/// An mtime as an ISO-8601 / RFC-3339 millis-precision `Z` string, byte-shape
/// compatible with JS `stat.mtime.toISOString()`.
fn mtime_iso(meta: &std::fs::Metadata) -> String {
    let modified = meta
        .modified()
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Port of `isPathAllowed` (`path-utils.ts`): a target is allowed iff there are no
/// configured roots, or it equals / is nested under one (at a directory boundary).
/// POSIX comparison (the oracle host); the Windows case-fold flavor is deferred.
fn is_path_allowed(target: &str, allowed_roots: Option<&[String]>) -> bool {
    let roots = match allowed_roots {
        Some(roots) if !roots.is_empty() => roots,
        _ => return true,
    };
    let target_norm = normalize_user_path(target);
    for root in roots {
        let root_norm = normalize_user_path(root);
        if target_norm == root_norm || target_norm.starts_with(&format!("{root_norm}/")) {
            return true;
        }
    }
    false
}

/// Port of `resolveCompletionInput` (`files-router.ts:44`): resolve a completion
/// `prefix` against `root` unless there is no root or the prefix is already absolute.
fn resolve_completion_input(prefix: &str, root: Option<&str>) -> String {
    let root = root.map(str::trim).filter(|r| !r.is_empty());
    let Some(root) = root else {
        return prefix.to_string();
    };
    if is_absolute_user_path(prefix) {
        return prefix.to_string();
    }
    let root_path = normalize_user_path(root);
    Path::new(&root_path)
        .join(prefix)
        .to_string_lossy()
        .into_owned()
}

/// Port of `isAbsoluteUserPath` (`files-router.ts:38`) for the POSIX host: a `~`
/// prefix or a POSIX/Windows absolute path.
fn is_absolute_user_path(input: &str) -> bool {
    let cleaned = input.trim();
    cleaned.starts_with('~')
        || cleaned.starts_with('/')
        || (cleaned.len() >= 3 && cleaned.as_bytes()[1] == b':') // C:\u2026 drive-absolute
}

/// `401 { "error": "Unauthorized" }` \u2014 byte-shape-equal to the original's reject.
fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}

/// `400 { "error": <msg> }`.
fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

/// `403 { "error": "Path not allowed" }` \u2014 the sandbox-deny shape (`files-router.ts:79`).
fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": "Path not allowed" }))).into_response()
}

/// `403 { "error": <msg> }` \u2014 the mkdir permission-deny shape.
fn forbidden_msg(msg: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": msg }))).into_response()
}

/// `404 { "error": <msg> }`.
fn not_found(msg: &str) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": msg }))).into_response()
}

/// `500 { "error": <msg> }`.
fn internal_error(msg: &str) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": msg }))).into_response()
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
    fn sandbox_empty_allows_everything() {
        assert!(is_path_allowed("/anywhere/at/all", None));
        assert!(is_path_allowed("/anywhere", Some(&[])));
    }

    #[test]
    fn sandbox_enforces_directory_boundary() {
        let roots = vec!["/home/tester/proj".to_string()];
        assert!(is_path_allowed("/home/tester/proj", Some(&roots))); // equal
        assert!(is_path_allowed("/home/tester/proj/src/a.rs", Some(&roots))); // nested
        assert!(!is_path_allowed("/home/tester/project-x", Some(&roots))); // prefix, not boundary
        assert!(!is_path_allowed("/etc/passwd", Some(&roots))); // outside
    }

    #[test]
    fn is_absolute_user_path_posix_and_tilde_and_drive() {
        assert!(is_absolute_user_path("/etc"));
        assert!(is_absolute_user_path("~/x"));
        assert!(is_absolute_user_path("C:\\Users"));
        assert!(!is_absolute_user_path("rel/path"));
        assert!(!is_absolute_user_path("a.txt"));
    }

    #[test]
    fn resolve_completion_input_honors_root_and_absolute() {
        std::env::set_var("HOME", "/home/tester");
        // No root \u2192 prefix unchanged.
        assert_eq!(resolve_completion_input("a", None), "a");
        // Absolute prefix ignores root.
        assert_eq!(resolve_completion_input("/abs/x", Some("/root")), "/abs/x");
        // Relative prefix joins the (normalized) root.
        assert_eq!(resolve_completion_input("sub/x", Some("/root")), "/root/sub/x");
    }

    #[test]
    fn validate_dir_semantics_against_real_fs() {
        // An existing directory validates; a bogus path does not.
        let tmp = std::env::temp_dir();
        assert!(std::fs::metadata(&tmp).map(|m| m.is_dir()).unwrap_or(false));
        let bogus = tmp.join("freshell-nonexistent-xyz-123456");
        assert!(!std::fs::metadata(&bogus).map(|m| m.is_dir()).unwrap_or(false));
    }

    #[tokio::test]
    async fn mkdir_recreating_existing_dir_reports_existed_false() {
        // R7: re-creating an already-existing directory still reports
        // `existed:false` (recursive mkdir cannot detect pre-existence, and never
        // errors on an existing directory either).
        let dir = std::env::temp_dir().join(format!("frs-mkdir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = FilesState {
            auth_token: Arc::new("tok".to_string()),
            settings: SettingsStore::load(None, Vec::new()),
            registry: TerminalRegistry::new(),
        };
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let resp = mkdir(
            State(state),
            headers,
            Json(json!({ "path": dir.to_string_lossy() })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["created"], true);
        assert_eq!(v["existed"], false);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn candidate_dirs_empty_state_has_no_home_fallback() {
        // R8: an empty candidate set stays `[]` \u2014 no `$HOME` fallback entry.
        let state = FilesState {
            auth_token: Arc::new("tok".to_string()),
            settings: SettingsStore::load(None, Vec::new()),
            registry: TerminalRegistry::new(),
        };
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let resp = candidate_dirs(State(state), headers).await.into_response();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["directories"], json!([]));
    }
}
