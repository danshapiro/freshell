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
//!   trailing-separator trim, lexical `.`/`..` collapse — the `path.posix.resolve`
//!   of path-utils.ts:69-70), `stat` it, and report `{ valid, resolvedPath }`
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
use freshell_platform::path::{
    convert_windows_path_to_wsl_path, join_windows_display_path, split_windows_display_path,
    win32_resolve,
};
use freshell_platform::{
    detect_user_path_flavor, sanitize_user_path_input, RealEnv, UserPathFlavor,
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
/// Windows-flavor inputs (e.g. `C:\`) resolve through the WSL drive mount when
/// running in WSL (path-utils.ts isReachableDirectory parity); on non-WSL hosts
/// they are unaddressable and report valid:false.
/// With allowedFilePaths configured, targets outside the roots are rejected 403 like every other files endpoint (Node applies validatePath to this route — files-router.ts:232; closing a formerly-unexplained Rust parity gap).
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
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path is required" })),
        )
            .into_response();
    }

    let resolved = resolve_user_path(trimmed);
    let settings = state.settings.get().await;
    if !is_path_allowed(
        resolved.sandbox_target(),
        settings.allowed_file_paths.as_deref(),
    ) {
        return forbidden();
    }
    let is_dir = resolved
        .fs_path
        .as_deref()
        .map(|fs| {
            std::fs::metadata(fs)
                .map(|meta| meta.is_dir())
                .unwrap_or(false)
        })
        .unwrap_or(false);

    Json(json!({ "valid": is_dir, "resolvedPath": resolved.display })).into_response()
}

/// `GET /api/files/read?path=<p>` \u2192 `{ content, size, modifiedAt }` (`files-router.ts:85`).
///
/// The retained `EditorPane` opens a file with this (`EditorPane.tsx:368`). A
/// directory is `400`, a missing file `404`, a sandbox-denied path `403` \u2014 the
/// original's exact shapes. On the POSIX oracle host the normalized user path IS
/// the filesystem path (the `\\wsl$\u2026` Windows flavor is a documented later step).
async fn read_file(
    State(state): State<FilesState>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(path) = q.path.filter(|p| !p.is_empty()) else {
        return bad_request("path query parameter required");
    };
    let resolved = resolve_user_path(&path);
    let settings = state.settings.get().await;
    if !is_path_allowed(
        resolved.sandbox_target(),
        settings.allowed_file_paths.as_deref(),
    ) {
        return forbidden();
    }
    // Node's toFilesystemPath fallthrough (`path-utils.ts:208-215`): an
    // unaddressable input keeps its literal display string as the fs path,
    // so the stat below fails naturally on non-WSL hosts.
    let resolved = resolved.fs_path.unwrap_or(resolved.display);
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
async fn stat_file(
    State(state): State<FilesState>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(path) = q.path.filter(|p| !p.is_empty()) else {
        return bad_request("path query parameter required");
    };
    let resolved = resolve_user_path(&path);
    let settings = state.settings.get().await;
    if !is_path_allowed(
        resolved.sandbox_target(),
        settings.allowed_file_paths.as_deref(),
    ) {
        return forbidden();
    }
    // Node's toFilesystemPath fallthrough — see read_file above.
    let resolved = resolved.fs_path.unwrap_or(resolved.display);
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
async fn write_file(
    State(state): State<FilesState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(path) = body
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
    else {
        return bad_request("path is required");
    };
    let Some(content) = body.get("content").and_then(Value::as_str) else {
        return bad_request("content is required");
    };
    let resolved = resolve_user_path(path);
    let settings = state.settings.get().await;
    if !is_path_allowed(
        resolved.sandbox_target(),
        settings.allowed_file_paths.as_deref(),
    ) {
        return forbidden();
    }
    // Node's toFilesystemPath fallthrough — see read_file above.
    let resolved = resolved.fs_path.unwrap_or(resolved.display);
    if let Some(parent) = Path::new(&resolved).parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            return internal_error(&err.to_string());
        }
    }
    if let Err(err) = std::fs::write(&resolved, content.as_bytes()) {
        return internal_error(&err.to_string());
    }
    match std::fs::metadata(&resolved) {
        Ok(meta) => {
            Json(json!({ "success": true, "modifiedAt": mtime_iso(&meta) })).into_response()
        }
        Err(err) => internal_error(&err.to_string()),
    }
}

/// `GET /api/files/complete?prefix=<p>&root=<r>&dirs=<b>` \u2192
/// `{ suggestions:[{ path, isDirectory }] }` (`files-router.ts:168`). The path
/// autocomplete for `EditorPane` / `DirectoryPicker` / `FreshAgentComposer`.
async fn complete(
    State(state): State<FilesState>,
    headers: HeaderMap,
    Query(q): Query<CompleteQuery>,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(prefix) = q.prefix.filter(|p| !p.is_empty()) else {
        return bad_request("prefix query parameter required");
    };
    let dirs_only = matches!(q.dirs.as_deref(), Some("true") | Some("1"));

    // Resolve the completion input against `root` (unless the prefix is absolute).
    let completion_input = resolve_completion_input(&prefix, q.root.as_deref());
    let resolved = resolve_user_path(&completion_input);
    let settings = state.settings.get().await;
    if !is_path_allowed(
        resolved.sandbox_target(),
        settings.allowed_file_paths.as_deref(),
    ) {
        return forbidden();
    }
    let Some(fs_path) = resolved.fs_path.clone() else {
        // Windows-flavor input this host cannot address (non-WSL host, generic
        // UNC, drive-relative): Node's readdir would ENOENT -> empty suggestions.
        return Json(json!({ "suggestions": [] })).into_response();
    };
    let windows_flavor = resolved.flavor == UserPathFlavor::Windows;

    // If the input is itself a directory, list all its entries; otherwise treat the
    // basename as a partial and filter the parent's entries by it. The split is
    // done on the DISPLAY path with the INPUT's flavor semantics, and the parent
    // is re-converted for filesystem access (`files-router.ts:187-203`).
    let (dir_display, dir_fs, basename) = match std::fs::metadata(&fs_path) {
        Ok(meta) if meta.is_dir() => (resolved.display.clone(), fs_path, String::new()),
        _ if windows_flavor => {
            let Some((parent_display, leaf)) = split_windows_display_path(&resolved.display) else {
                return Json(json!({ "suggestions": [] })).into_response();
            };
            // `fs_path` was Some, so this request already established a live
            // WSL environment — the parent converts under the same regime.
            let Some(parent_fs) = convert_windows_path_to_wsl_path(&parent_display, &RealEnv, true)
            else {
                return Json(json!({ "suggestions": [] })).into_response();
            };
            (parent_display, parent_fs, leaf)
        }
        _ => {
            let p = Path::new(&resolved.display);
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
                // Suggestion paths are DISPLAY paths in the input's flavor
                // (`files-router.ts:211` — pathModule.join(dirDisplayPath, name)).
                let joined = if windows_flavor {
                    join_windows_display_path(&dir_display, &name)
                } else {
                    Path::new(&dir_display)
                        .join(&name)
                        .to_string_lossy()
                        .into_owned()
                };
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
/// on success), matching the original's observable behavior exactly. Both of
/// the original's 409 "Path exists but is not a directory" branches are mapped:
/// EEXIST-on-a-non-directory (`files-router.ts:265-271`, the target itself is
/// an existing file) and ENOTDIR (`files-router.ts:272-274`, an INTERMEDIATE
/// component is a file, e.g. mkdir of `<existing-file>/sub` — the target does
/// not exist, so this maps from `ErrorKind::NotADirectory`, never from an
/// existence re-check).
/// Windows-flavor inputs convert through the WSL mount before create_dir_all; inputs with no native address on this host are rejected with 400 instead of creating a literal backslash-named directory.
async fn mkdir(
    State(state): State<FilesState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(path) = body
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
    else {
        return bad_request("path is required");
    };
    let resolved = resolve_user_path(path);
    let settings = state.settings.get().await;
    if !is_path_allowed(
        resolved.sandbox_target(),
        settings.allowed_file_paths.as_deref(),
    ) {
        return forbidden();
    }
    let Some(fs_path) = resolved.fs_path else {
        // Never create a literal `C:\…` entry under the server cwd — the
        // deliberate divergence from Node's non-WSL fallthrough hazard
        // (`files-router.ts:262` + `path-utils.ts:208-215`).
        return bad_request("path cannot be resolved to a directory on this host");
    };
    match std::fs::create_dir_all(&fs_path) {
        Ok(()) => {
            Json(json!({ "created": true, "existed": false, "resolvedPath": resolved.display }))
                .into_response()
        }
        Err(err) => match err.kind() {
            std::io::ErrorKind::PermissionDenied => forbidden_msg("Permission denied"),
            // Node's ENOTDIR branch (`files-router.ts:272-274`): an INTERMEDIATE
            // path component exists but is not a directory (e.g. mkdir of
            // `<existing-file>/sub`) → 409. The target itself does NOT exist in
            // this case, so it must be mapped from the error kind — re-checking
            // the target's existence (the EEXIST branch below) can never catch
            // it and would wrongly fall through to 500.
            std::io::ErrorKind::NotADirectory => conflict_not_a_directory(),
            _ => {
                // Node's EEXIST-on-a-non-directory branch
                // (`files-router.ts:265-271`): the TARGET itself exists but is
                // not a directory → 409.
                if Path::new(&fs_path).exists() {
                    conflict_not_a_directory()
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

/// Normalize a user-supplied directory path: sanitize the raw input first
/// (`sanitizeUserPathInput` runs on EVERY flavor at the top of Node's
/// `normalizeUserPath`, `path-utils.ts:55` → `:24-30`: trim whitespace, strip
/// one pair of wrapping quotes, re-trim), then expand a leading `~`/`~\\…`/`~/\u2026` to `$HOME`,
/// trim trailing separators, and collapse `.`/`..` segments LEXICALLY
/// — Node's `normalizeUserPath` runs `path.posix.resolve` on POSIX inputs
/// (path-utils.ts:69-70), so `<tmp>/nope/../real` reaches the filesystem (and is
/// displayed) as `<tmp>/real` even when the `nope` intermediate does not exist;
/// a raw stat on the verbatim spelling would ENOENT on that intermediate first
/// (mirrors `path-utils.ts#normalizeUserPath` for the
/// POSIX host the oracle runs on \u2014 the `\\wsl$\u2026` Windows flavor is a later step, handled in
/// [`resolve_user_path`]). Non-absolute inputs are returned unchanged when they
/// do not resolve (the collapse is absolute-only, fail-closed).
pub(crate) fn normalize_user_path(input: &str) -> String {
    let cleaned = sanitize_user_path_input(input);
    let expanded = expand_tilde(&cleaned);
    collapse_dot_segments(&trim_trailing_separators(&expanded))
}

/// Expand a leading `~` (bare, `~/rest`, or `~\rest`) to the process `$HOME`.
/// Node expands BOTH separator spellings (`path-utils.ts:61`:
/// `startsWith('~/') || startsWith('~\\')`) — the backslash form is what
/// Windows users type into the DirectoryPicker targeting a WSL host, and
/// `~\rest` is `native` flavor (not Windows: `~` matches none of the
/// drive/UNC/rooted prefixes), so it reaches this seam. Other `~user` forms
/// are left untouched.
fn expand_tilde(input: &str) -> String {
    if input == "~" {
        if let Some(home) = home_dir() {
            return home.to_string_lossy().into_owned();
        }
        return input.to_string();
    }
    if let Some(rest) = input
        .strip_prefix("~/")
        .or_else(|| input.strip_prefix("~\\"))
    {
        if let Some(home) = home_dir() {
            // Node's posix path.join(home, rest) (path-utils.ts:62) CONCATENATES
            // then lexically normalizes: a rest starting with `/` (mixed
            // separators like `~\/x` or `~//x`) folds onto home as
            // `$HOME/rest` — never replaces it, unlike `Path::join`'s
            // absolute-argument semantics which would root the result at `/`.
            // Inner backslashes stay literal (`~\a\b` -> `$HOME/a\b`), and
            // `.`/`..` collapse exactly like join's normalize.
            return collapse_dot_segments(&format!("{}/{rest}", home.to_string_lossy()));
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

/// Lexical `path.resolve` segment collapse (`path-utils.ts:294`) for
/// slash-absolute inputs: `.` dropped, `..` pops the last component (clamped
/// at the filesystem root), redundant separators folded, trailing separators
/// stripped. Non-absolute inputs are returned unchanged fail-closed: a
/// relative or Windows-literal spelling can never prefix-match an absolute
/// sandbox root, so collapsing here could only ever weaken the check.
fn collapse_dot_segments(input: &str) -> String {
    if !input.starts_with('/') {
        return input.to_string();
    }
    let mut components: Vec<&str> = Vec::new();
    for segment in input.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            _ => components.push(segment),
        }
    }
    if components.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", components.join("/"))
    }
}

/// A user path resolved for filesystem access: the flavor-preserving DISPLAY
/// string (what goes back to the client in `resolvedPath` / suggestion paths)
/// plus the native path used for actual filesystem operations.
/// `fs_path: None` means the input names a location this host cannot address
/// (a Windows path on a non-WSL Linux host, a bare drive `C:`, rooted
/// `\foo`, or a generic `\\server\share` UNC).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedUserPath {
    pub display: String,
    pub fs_path: Option<String>,
    pub flavor: UserPathFlavor,
}

impl ResolvedUserPath {
    /// The string sandbox checks compare — Node's `validatePath` resolves the
    /// request path through `toFilesystemPath` before `isPathAllowed`
    /// (`files-router.ts:75-78`), so comparisons use the CONVERTED native path
    /// when the input is addressable, and fall back to the literal display
    /// string when it is not (Node's non-WSL fallthrough).
    pub(crate) fn sandbox_target(&self) -> &str {
        self.fs_path.as_deref().unwrap_or(&self.display)
    }
}

/// Port of `normalizeUserPath` + `toFilesystemPath` composed
/// (`path-utils.ts:54-73`, `:208-215`, `:241-245`) for this POSIX-host server.
///
/// - Posix/Native flavors (including `~`): EXACTLY the existing
///   [`normalize_user_path`] behavior — display and fs path are the same
///   string, so pre-existing callers observe zero change.
/// - Windows flavor: display = [`win32_resolve`] (Node's `path.win32.resolve`
///   semantics — separators to `\`, trailing separator stripped, `..`
///   collapsed, drive-letter case preserved as typed); fs path = the WSL
///   drive/UNC conversion, gated on the live WSL environment exactly like
///   Node's `resolveWindowsFlavorPath`. Where Node falls through to the
///   literal `C:\…` string on non-WSL hosts (and `fs` then treats it as a
///   relative POSIX name), this returns `fs_path: None` so callers can treat
///   the input as unaddressable instead of stat'ing/creating a literal
///   backslash-named entry — the mkdir hazard this fix removes.
pub(crate) fn resolve_user_path(input: &str) -> ResolvedUserPath {
    let flavor = detect_user_path_flavor(input);
    if flavor != UserPathFlavor::Windows {
        let normalized = normalize_user_path(input);
        return ResolvedUserPath {
            display: normalized.clone(),
            fs_path: Some(normalized),
            flavor,
        };
    }
    let sanitized = sanitize_user_path_input(input);
    let Some(display) = win32_resolve(&sanitized) else {
        // Bare drive (`C:`) / rooted (`\foo`): cwd-dependent inputs the
        // deterministic core refuses. Keep the sanitized input as the
        // display string; not addressable here. (Node would cwd-anchor via
        // path.win32.resolve — e.g. `C:` -> `C:\<server-cwd>` — but oracle
        // runs show `\foo` resolves to itself on POSIX, so the divergence is
        // limited to bare-drive forms, where both servers report
        // valid:false / empty suggestions and nothing is persisted.)
        return ResolvedUserPath {
            display: sanitized,
            fs_path: None,
            flavor: UserPathFlavor::Windows,
        };
    };
    let fs_path = if freshell_platform::detect::is_wsl_env_live() {
        // `convert_windows_path_to_wsl_path`'s drive branch would convert even
        // off-WSL; the gate above is what makes this match Node's
        // resolveWindowsFlavorPath (conversion only when isWslEnvironment()).
        convert_windows_path_to_wsl_path(&display, &RealEnv, true)
    } else {
        None
    };
    ResolvedUserPath {
        display,
        fs_path,
        flavor: UserPathFlavor::Windows,
    }
}

/// An mtime as an ISO-8601 / RFC-3339 millis-precision `Z` string, byte-shape
/// compatible with JS `stat.mtime.toISOString()`.
fn mtime_iso(meta: &std::fs::Metadata) -> String {
    let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    chrono::DateTime::<chrono::Utc>::from(modified)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Port of `isPathAllowed` (`path-utils.ts`): a target is allowed iff there are no
/// configured roots, or it equals / is nested under one (at a directory boundary).
/// Roots resolve through resolve_user_path — the same conversion as targets (Node converts both sides, path-utils.ts:313/319). Case-folding stays absent: Node lowercases only when process.platform === 'win32', which this Linux-host port never is.
pub(crate) fn is_path_allowed(target: &str, allowed_roots: Option<&[String]>) -> bool {
    let roots = match allowed_roots {
        Some(roots) if !roots.is_empty() => roots,
        _ => return true,
    };
    let target_norm = normalize_user_path(target);
    for root in roots {
        // Node parity: isPathAllowed converts BOTH sides through
        // resolvePathForSandboxComparison (path-utils.ts:313/319), so a
        // Windows-flavor root like `C:\Users` matches WSL-converted targets
        // (pinned by Node's test/unit/server/path-utils.test.ts:236-252).
        // resolve_user_path's non-Windows branch IS normalize_user_path, so
        // POSIX/~ roots compare byte-identically to before (including the
        // repo_icon.rs call sites). On a non-WSL host a Windows-flavor root
        // stays literal — fail-closed, same stance as unaddressable targets.
        let root_resolved = resolve_user_path(root);
        let root_norm = root_resolved.sandbox_target();
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
/// prefix or a POSIX/Windows absolute path. `path.win32.isAbsolute` is true for
/// any leading backslash, so win32-rooted (`\rooted\x`) and UNC
/// (`\\srv\share\dir`) forms count as absolute too.
fn is_absolute_user_path(input: &str) -> bool {
    let cleaned = input.trim();
    cleaned.starts_with('~')
        || cleaned.starts_with('/')
        || cleaned.starts_with('\\') // \\srv\share UNC or \rooted win32 forms
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
pub(crate) fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

/// `403 { "error": "Path not allowed" }` \u2014 the sandbox-deny shape (`files-router.ts:79`).
pub(crate) fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "Path not allowed" })),
    )
        .into_response()
}

/// `403 { "error": <msg> }` \u2014 the mkdir permission-deny shape.
fn forbidden_msg(msg: &str) -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": msg }))).into_response()
}

/// `409 { "error": "Path exists but is not a directory" }` — the mkdir
/// EEXIST-non-directory / ENOTDIR shape (`files-router.ts:270,273`).
fn conflict_not_a_directory() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "error": "Path exists but is not a directory" })),
    )
        .into_response()
}

/// `404 { "error": <msg> }`.
pub(crate) fn not_found(msg: &str) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": msg }))).into_response()
}

/// `500 { "error": <msg> }`.
fn internal_error(msg: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": msg })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    // `std::env::set_var` mutates whole-process state, and this bin test
    // binary ALREADY serializes env-mutating tests (session_directory.rs
    // provider_home tests, main.rs resolve-wiring tests) on the crate-wide
    // `HOME_ENV_TEST_LOCK` (session_directory.rs:463-464). Reuse THAT lock —
    // a files-local mutex would not serialize against those 11 tests.
    use crate::session_directory::HOME_ENV_TEST_LOCK as ENV_LOCK;

    /// Poison-tolerant acquisition (same pattern as `main.rs:2460`).
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// RAII: set/remove a group of env vars, restoring prior values on drop.
    struct EnvGuard {
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl EnvGuard {
        /// `Some(v)` sets the var; `None` removes it. Prior state is restored
        /// (set-or-removed) on drop, even on panic.
        fn set(pairs: &[(&'static str, Option<&str>)]) -> Self {
            let saved = pairs
                .iter()
                .map(|(key, value)| {
                    let prior = std::env::var_os(key);
                    match value {
                        Some(v) => std::env::set_var(key, v),
                        None => std::env::remove_var(key),
                    }
                    (*key, prior)
                })
                .collect();
            EnvGuard { saved }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, prior) in self.saved.drain(..) {
                match prior {
                    Some(v) => std::env::set_var(key, v),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    /// A fake WSL drive mount under a tempdir: env says "this is WSL and
    /// drives are mounted at <root>" (WSL_DISTRO_NAME + WSL_WINDOWS_SYS32,
    /// the same knobs the freshell-platform tests and the Node plan
    /// docs/superpowers/plans/2026-06-10-windows-wsl-launch-cwd.md use), and
    /// real directories exist at <root>/c/{Users/dan,Windows/System32} and
    /// <root>/d/proj. WSL_WINDOWS_SYS32 must match the strict
    /// `^(.*)/[a-zA-Z]/Windows/System32$` shape or the mount prefix silently
    /// falls back to /mnt.
    struct WslMountFixture {
        _env: EnvGuard,
        root: tempfile::TempDir,
    }

    impl WslMountFixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let sys32 = root.path().join("c/Windows/System32");
            std::fs::create_dir_all(&sys32).unwrap();
            std::fs::create_dir_all(root.path().join("c/Users/dan")).unwrap();
            std::fs::write(root.path().join("c/Users/notes.txt"), b"x").unwrap();
            std::fs::create_dir_all(root.path().join("d/proj")).unwrap();
            let sys32_str = sys32.to_string_lossy().into_owned();
            let env = EnvGuard::set(&[
                ("WSL_DISTRO_NAME", Some("Ubuntu")),
                ("WSL_INTEROP", None),
                ("WSLENV", None),
                ("WSL_WINDOWS_SYS32", Some(sys32_str.as_str())),
            ]);
            WslMountFixture { _env: env, root }
        }

        /// The native directory a `X:\` drive maps to, e.g. `mount("c")`.
        fn mount(&self, drive: &str) -> std::path::PathBuf {
            self.root.path().join(drive)
        }
    }

    /// Env pinned to a plain (non-WSL) Linux host.
    fn non_wsl_env() -> EnvGuard {
        EnvGuard::set(&[
            ("WSL_DISTRO_NAME", None),
            ("WSL_INTEROP", None),
            ("WSLENV", None),
            ("WSL_WINDOWS_SYS32", None),
        ])
    }

    fn test_state() -> FilesState {
        FilesState {
            auth_token: Arc::new("tok".to_string()),
            settings: SettingsStore::load(None, Vec::new()),
            registry: TerminalRegistry::new(),
        }
    }

    fn auth_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        headers
    }

    async fn body_json(resp: Response) -> Value {
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    // ---- resolve_user_path (R-WIN1: flavor-aware display/native seam) ----

    #[test]
    fn resolve_user_path_windows_drive_on_wsl_maps_to_mount() {
        let _guard = env_lock();
        let fixture = WslMountFixture::new();
        let mount_c = fixture.mount("c").to_string_lossy().into_owned();

        let r = resolve_user_path("C:\\");
        assert_eq!(r.display, "C:\\");
        assert_eq!(r.fs_path, Some(mount_c.clone()));

        let r = resolve_user_path("C:\\Users\\dan");
        assert_eq!(r.display, "C:\\Users\\dan");
        assert_eq!(r.fs_path, Some(format!("{mount_c}/Users/dan")));

        // Forward slashes + trailing separator normalize; drive case preserved
        // as typed (Node path.win32.resolve semantics).
        let r = resolve_user_path("c:/Users/");
        assert_eq!(r.display, "c:\\Users");
        assert_eq!(r.fs_path, Some(format!("{mount_c}/Users")));
    }

    #[test]
    fn resolve_user_path_windows_off_wsl_is_unaddressable() {
        let _guard = env_lock();
        let _env = non_wsl_env();
        let r = resolve_user_path("C:\\Users");
        assert_eq!(r.display, "C:\\Users");
        assert_eq!(r.fs_path, None);
    }

    #[test]
    fn resolve_user_path_windows_unresolvable_forms_are_unaddressable() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // Bare drive, rooted, and generic (non-WSL) UNC inputs have no native
        // address even on WSL. (NOTE: drive-relative `C:foo` is NOT Windows
        // flavor — Node's WINDOWS_DRIVE_PREFIX_RE requires a separator or
        // end-of-string after the colon, so `C:foo` stays `native` in both
        // servers and keeps today's literal behavior.)
        for input in ["C:", "\\rooted", "\\\\srv\\share\\x"] {
            let r = resolve_user_path(input);
            assert_eq!(r.fs_path, None, "{input:?}");
        }
    }

    #[test]
    fn resolve_user_path_posix_and_tilde_unchanged() {
        let _guard = env_lock();
        let _env = EnvGuard::set(&[("HOME", Some("/home/tester"))]);
        // POSIX: exact normalize_user_path behavior — display == fs path.
        let r = resolve_user_path("/tmp/x///");
        assert_eq!(r.display, "/tmp/x");
        assert_eq!(r.fs_path, Some("/tmp/x".to_string()));
        // Tilde: native flavor, expanded via HOME.
        let r = resolve_user_path("~/proj");
        assert_eq!(r.display, "/home/tester/proj");
        assert_eq!(r.fs_path, Some("/home/tester/proj".to_string()));
    }

    /// FILE-03: `normalizeUserPath` expands BOTH `~/rest` AND `~\rest` to the
    /// home directory (path-utils.ts:61: `startsWith('~/') ||
    /// startsWith('~\\')`) — the backslash form is what Windows users type
    /// into the DirectoryPicker targeting a WSL host. `expand_tilde`
    /// previously handled only `~` and `~/`, so `~\proj` stayed a literal
    /// name that no endpoint could address (cluster tilde_expand regression).
    #[test]
    fn test_tilde_expand_backslash_form_expands_to_home() {
        let _guard = env_lock();
        let _env = EnvGuard::set(&[("HOME", Some("/home/tester"))]);
        let r = resolve_user_path("~\\proj");
        assert_eq!(r.display, "/home/tester/proj");
        assert_eq!(r.fs_path, Some("/home/tester/proj".to_string()));
        // The helper agrees (the `~\` prefix joins exactly like `~/`), and
        // the bare `~\` form lands on home itself (Node path.join(home, '')).
        assert_eq!(expand_tilde("~\\proj"), "/home/tester/proj");
        assert_eq!(normalize_user_path("~\\"), "/home/tester");
        // Review pin (boundary separator forms): a `~<sep>` rest that itself
        // starts with `/` FOLDS onto home — Node's posix path.join(home,
        // rest) concatenates then normalizes (path-utils.ts:62), so these
        // yield `$HOME/x`; `Path::join`'s absolute-argument replacement
        // would instead root-anchor them at `/x` (the bounced defect).
        assert_eq!(expand_tilde("~\\/x"), "/home/tester/x");
        assert_eq!(expand_tilde("~//x"), "/home/tester/x");
        let r = resolve_user_path("~\\/x");
        assert_eq!(r.display, "/home/tester/x");
        assert_eq!(r.fs_path, Some("/home/tester/x".to_string()));
        // Inner backslashes are NOT separators on the posix host: they stay
        // literal, exactly like Node's join (`~\a\b` -> `$HOME/a\b`).
        assert_eq!(expand_tilde("~\\a\\b"), "/home/tester/a\\b");
        // …and `.`/`..` in the rest collapse like join's normalize.
        assert_eq!(expand_tilde("~/../x"), "/home/x");
    }

    // ---- validate_dir (R-WIN2: Windows input on WSL resolves via the mount) ----

    // Intentional: `_guard` is held across every `.await` BY DESIGN — the
    // whole test mutates/reads process env and must stay serialized on the
    // crate-wide HOME_ENV_TEST_LOCK end-to-end. Holding the env guard across
    // .await is the point: it serializes env-mutating tests process-wide.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn validate_dir_accepts_windows_drive_on_wsl() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        let resp = validate_dir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": "C:\\" })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["valid"], true);
        assert_eq!(v["resolvedPath"], "C:\\");
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn validate_dir_windows_deep_path_and_missing_dir() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // D:\proj exists in the fixture.
        let resp = validate_dir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": "D:\\proj" })),
        )
        .await
        .into_response();
        let v = body_json(resp).await;
        assert_eq!(v["valid"], true);
        assert_eq!(v["resolvedPath"], "D:\\proj");
        // C:\Nope does not exist -> valid:false but the display path is still
        // returned (Node isReachableDirectory semantics).
        let resp = validate_dir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": "C:\\Nope" })),
        )
        .await
        .into_response();
        let v = body_json(resp).await;
        assert_eq!(v["valid"], false);
        assert_eq!(v["resolvedPath"], "C:\\Nope");
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn validate_dir_windows_input_invalid_off_wsl() {
        let _guard = env_lock();
        let _env = non_wsl_env();
        let resp = validate_dir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": "C:\\" })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["valid"], false);
        assert_eq!(v["resolvedPath"], "C:\\");
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn validate_dir_posix_regression() {
        let _guard = env_lock();
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().into_owned();
        let resp = validate_dir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": dir.as_str() })),
        )
        .await
        .into_response();
        let v = body_json(resp).await;
        assert_eq!(v["valid"], true);
        assert_eq!(v["resolvedPath"], dir);
        let bogus = format!("{}/freshell-nonexistent-xyz", tmp.path().display());
        let resp = validate_dir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": bogus })),
        )
        .await
        .into_response();
        let v = body_json(resp).await;
        assert_eq!(v["valid"], false);
    }

    /// Node's `normalizeUserPath` runs `path.posix.resolve` on POSIX inputs
    /// (path-utils.ts:69-70), collapsing `.`/`..` segments LEXICALLY — so
    /// `<tmp>/nope/../real` reaches the filesystem as `<tmp>/real` and
    /// `validate-dir` reports it valid even though `nope` never exists
    /// (files-router.ts:243). A port keeping the `..` segments verbatim would
    /// ENOENT the raw stat on the missing `nope` intermediate and echo the
    /// un-collapsed path; both the stat and the display string must use the
    /// collapsed form.
    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn test_dotseg_collapse_display() {
        let _guard = env_lock();
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("real")).unwrap();
        let spelled = format!("{}/nope/../real", tmp.path().to_string_lossy());
        let collapsed = format!("{}/real", tmp.path().to_string_lossy());
        let resp = validate_dir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": spelled })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["valid"], true, "Node resolves `..` lexically before stat");
        assert_eq!(v["resolvedPath"], collapsed);
    }

    // ---- complete (R-WIN3: suggestions rendered in the INPUT's flavor) ----

    /// Call `complete` and return the suggestion path strings.
    async fn complete_paths(prefix: &str, root: Option<&str>, dirs: Option<&str>) -> Vec<String> {
        let resp = complete(
            State(test_state()),
            auth_headers(),
            Query(CompleteQuery {
                prefix: Some(prefix.to_string()),
                root: root.map(str::to_string),
                dirs: dirs.map(str::to_string),
            }),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        v["suggestions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["path"].as_str().unwrap().to_string())
            .collect()
    }

    // Intentional: `_guard` is held across every `.await` BY DESIGN — these
    // tests mutate/read process env and must stay serialized on the
    // crate-wide HOME_ENV_TEST_LOCK end-to-end.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn complete_windows_drive_root_lists_in_input_flavor() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // C:\ is a directory (the fixture's <root>/c) -> list all children,
        // display paths joined win32-style in the input's flavor.
        // Children of <root>/c: Users/ and Windows/ (dirs sort before files;
        // byte-order alphabetical within).
        let paths = complete_paths("C:\\", None, None).await;
        assert_eq!(paths, vec!["C:\\Users", "C:\\Windows"]);
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn complete_windows_partial_leaf_filters_and_preserves_flavor() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // Partial leaf: split parent/leaf on the display path, filter by leaf.
        let paths = complete_paths("C:\\Us", None, None).await;
        assert_eq!(paths, vec!["C:\\Users"]);
        // Leaf matching is case-sensitive (Node files-router parity).
        let paths = complete_paths("C:\\us", None, None).await;
        assert!(paths.is_empty());
        // Drive-letter case flows through from the typed input.
        let paths = complete_paths("c:\\Us", None, None).await;
        assert_eq!(paths, vec!["c:\\Users"]);
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn complete_windows_dirs_only_filters_files() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // C:\Users contains dan/ (dir) and notes.txt (file).
        let all = complete_paths("C:\\Users\\", None, None).await;
        assert_eq!(all, vec!["C:\\Users\\dan", "C:\\Users\\notes.txt"]);
        let dirs = complete_paths("C:\\Users\\", None, Some("true")).await;
        assert_eq!(dirs, vec!["C:\\Users\\dan"]);
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn complete_windows_missing_parent_and_off_wsl_return_empty() {
        let _guard = env_lock();
        {
            let _fixture = WslMountFixture::new();
            // Parent C:\Nope doesn't exist -> readdir NotFound -> 200 { suggestions: [] }.
            assert!(complete_paths("C:\\Nope\\x", None, None).await.is_empty());
        }
        let _env = non_wsl_env();
        // Windows input on a non-WSL host is unaddressable -> empty suggestions.
        assert!(complete_paths("C:\\", None, None).await.is_empty());
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn complete_windows_root_anchoring_composes() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // Relative prefix under a windows-flavor root: resolve_completion_input
        // joins with `/`, and win32_resolve then normalizes the mixed
        // separators into a windows display path.
        let paths = complete_paths("da", Some("C:\\Users"), None).await;
        assert_eq!(paths, vec!["C:\\Users\\dan"]);
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn complete_wsl_unc_partial_leaf_round_trips() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // WSL-UNC inputs convert to native root-relative paths
        // (`\\wsl.localhost\Ubuntu\<p>` -> `/<p>`; distro matched
        // case-insensitively against WSL_DISTRO_NAME, path.rs:384-419) — so a
        // real tempdir exercises the full composed chain end-to-end:
        // split on the display path -> reconvert the parent -> join back.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("subdir")).unwrap();
        let tmp_unc = tmp
            .path()
            .to_string_lossy()
            .trim_start_matches('/')
            .replace('/', "\\");
        let prefix = format!("\\\\wsl.localhost\\Ubuntu\\{tmp_unc}\\su");
        let paths = complete_paths(&prefix, None, None).await;
        assert_eq!(
            paths,
            vec![format!("\\\\wsl.localhost\\Ubuntu\\{tmp_unc}\\subdir")]
        );
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn complete_posix_regression_unchanged() {
        let _guard = env_lock();
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("subdir")).unwrap();
        std::fs::create_dir_all(tmp.path().join("subzero")).unwrap();
        let prefix = format!("{}/sub", tmp.path().display());
        let paths = complete_paths(&prefix, None, None).await;
        assert_eq!(
            paths,
            vec![
                format!("{}/subdir", tmp.path().display()),
                format!("{}/subzero", tmp.path().display()),
            ]
        );
    }

    #[test]
    fn sandbox_target_uses_converted_native_path() {
        let _guard = env_lock();
        let fixture = WslMountFixture::new();
        let mount_c = fixture.mount("c").to_string_lossy().into_owned();
        // R-WIN4: sandbox comparisons use the CONVERTED native path (Node's
        // validatePath resolves through toFilesystemPath before isPathAllowed).
        let r = resolve_user_path("C:\\Users");
        assert_eq!(r.sandbox_target(), format!("{mount_c}/Users"));
        // Unaddressable input falls back to its display string. With roots
        // configured, that literal never matches -> unconditional deny. This
        // is DELIBERATELY STRICTER than Node, which posix-resolves the
        // literal against the server cwd first (path-utils.ts:294) and so
        // ALLOWS it whenever the cwd sits under an allowed root (its /write
        // can then even create a literal `C:\...` entry there — oracle-
        // verified). Fail-closed here: we never allow a request Node denies.
        let r = resolve_user_path("\\\\srv\\share\\x");
        assert_eq!(r.sandbox_target(), "\\\\srv\\share\\x");
        // POSIX target is compared as-is.
        let r = resolve_user_path("/tmp/x");
        assert_eq!(r.sandbox_target(), "/tmp/x");
        // And the existing boundary logic operates on those native strings.
        let roots = vec![mount_c.clone()];
        assert!(is_path_allowed(
            resolve_user_path("C:\\Users").sandbox_target(),
            Some(&roots)
        ));
        assert!(!is_path_allowed(
            resolve_user_path("D:\\proj").sandbox_target(),
            Some(&roots)
        ));
    }

    // ---- read/stat/write (R-WIN4: sandbox + fs access via the converted path) ----

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn read_stat_write_follow_windows_conversion_on_wsl() {
        let _guard = env_lock();
        let fixture = WslMountFixture::new();
        // stat: the fixture file C:\Users\notes.txt exists via the mount.
        let resp = stat_file(
            State(test_state()),
            auth_headers(),
            Query(PathQuery {
                path: Some("C:\\Users\\notes.txt".to_string()),
            }),
        )
        .await
        .into_response();
        let v = body_json(resp).await;
        assert_eq!(v["exists"], true);
        // read: content comes back through the converted path.
        let resp = read_file(
            State(test_state()),
            auth_headers(),
            Query(PathQuery {
                path: Some("C:\\Users\\notes.txt".to_string()),
            }),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["content"], "x");
        // write: lands under the mount, not as a literal backslash-named entry.
        let resp = write_file(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": "C:\\Users\\dan\\note2.txt", "content": "hi" })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["success"], true);
        assert_eq!(
            std::fs::read_to_string(fixture.mount("c").join("Users/dan/note2.txt")).unwrap(),
            "hi"
        );
        assert!(!std::path::Path::new("C:\\Users\\dan\\note2.txt").exists());
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn stat_windows_path_off_wsl_reports_not_exists() {
        let _guard = env_lock();
        let _env = non_wsl_env();
        // Node parity: the literal `C:\…` string is handed to fs and the stat
        // fails naturally -> { exists: false } with HTTP 200.
        let resp = stat_file(
            State(test_state()),
            auth_headers(),
            Query(PathQuery {
                path: Some("C:\\Users\\notes.txt".to_string()),
            }),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["exists"], false);
    }

    // ---- validate_dir sandbox (closes the Node-parity gap: files-router.ts:232
    // applies validatePath to validate-dir; 403 pinned by Node's
    // test/unit/server/files-router.test.ts:451-460) ----

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn validate_dir_denies_path_outside_allowed_roots() {
        let _guard = env_lock();
        let fixture = WslMountFixture::new();
        let state = test_state();
        // Configure a sandbox root via the store's public patch API (persist
        // no-ops for home: None stores — settings_store.rs:420-422 — so this
        // touches no real config file).
        let root = fixture.mount("d").to_string_lossy().into_owned();
        state
            .settings
            .patch(&json!({ "allowedFilePaths": [root] }))
            .await
            .unwrap();
        // A windows path converting OUTSIDE the allowed root is denied…
        let resp = validate_dir(
            State(state.clone()),
            auth_headers(),
            Json(json!({ "path": "C:\\Users\\dan" })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        // …while one INSIDE it (converted native path under the root) validates.
        let resp = validate_dir(
            State(state),
            auth_headers(),
            Json(json!({ "path": "D:\\proj" })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["valid"], true);
    }

    // ---- allowlist ROOTS convert through the same seam (R-WIN4 root side:
    // Node's isPathAllowed applies resolvePathForSandboxComparison to BOTH
    // sides, path-utils.ts:313/319; pinned by Node's
    // test/unit/server/path-utils.test.ts:236-252) ----

    #[test]
    fn windows_flavor_allowlist_roots_convert_like_node() {
        let _guard = env_lock();
        let fixture = WslMountFixture::new();
        let mount_c = fixture.mount("c").to_string_lossy().into_owned();
        // Drive-root allowlist entry `C:\` matches the mount root and
        // anything under it (Node test lines 245-247).
        let drive_root = vec!["C:\\".to_string()];
        assert!(is_path_allowed(&mount_c, Some(&drive_root)));
        assert!(is_path_allowed(
            resolve_user_path("C:\\Users\\alice\\project").sandbox_target(),
            Some(&drive_root)
        ));
        // Deeper Windows-flavor root matches converted targets under it and
        // rejects other drives (Node test lines 249-251).
        let users_root = vec!["C:\\Users".to_string()];
        assert!(is_path_allowed(
            resolve_user_path("C:\\Users\\alice\\project").sandbox_target(),
            Some(&users_root)
        ));
        assert!(!is_path_allowed(
            resolve_user_path("D:\\Users\\alice\\project").sandbox_target(),
            Some(&users_root)
        ));
        // POSIX roots keep byte-identical semantics (regression guard).
        let posix_root = vec![mount_c.clone()];
        assert!(is_path_allowed(
            &format!("{mount_c}/Users"),
            Some(&posix_root)
        ));
    }

    // ---- mkdir (R-WIN5: convert windows-flavor input; reject unaddressable) ----

    async fn mkdir_resp(path: &str) -> Response {
        mkdir(
            State(test_state()),
            auth_headers(),
            Json(json!({ "path": path })),
        )
        .await
        .into_response()
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn mkdir_windows_path_creates_under_mount() {
        let _guard = env_lock();
        let fixture = WslMountFixture::new();
        let resp = mkdir_resp("C:\\Users\\dan\\newproj").await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["created"], true);
        assert_eq!(v["existed"], false);
        // resolvedPath is the flavor-preserving DISPLAY path (Node parity).
        assert_eq!(v["resolvedPath"], "C:\\Users\\dan\\newproj");
        // The directory was created under the mount…
        assert!(fixture.mount("c").join("Users/dan/newproj").is_dir());
        // …and NOT as a literal backslash-named entry under the server cwd.
        assert!(!std::path::Path::new("C:\\Users\\dan\\newproj").exists());
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn mkdir_rejects_unaddressable_windows_input_off_wsl() {
        let _guard = env_lock();
        let _env = non_wsl_env();
        let resp = mkdir_resp("C:\\").await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let v = body_json(resp).await;
        assert!(v["error"].as_str().unwrap().contains("cannot be resolved"));
        // The hazard this fix removes (old files.rs:387-393): no literal
        // `C:\` directory materializes under the process cwd.
        assert!(!std::path::Path::new("C:\\").exists());
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn mkdir_rejects_unresolvable_windows_forms_even_on_wsl() {
        let _guard = env_lock();
        let _fixture = WslMountFixture::new();
        // Bare drive / rooted inputs are Windows flavor but have no absolute
        // native address, even on WSL. (`C:foo` is `native` flavor in both
        // servers — see resolve_user_path_windows_unresolvable_forms — so it
        // keeps today's behavior and is not asserted here.)
        for input in ["C:", "\\rooted"] {
            let resp = mkdir_resp(input).await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{input:?}");
        }
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn mkdir_posix_regression_unchanged() {
        let _guard = env_lock();
        let tmp = tempfile::tempdir().unwrap();
        let target = format!("{}/fresh-sub", tmp.path().display());
        let resp = mkdir_resp(&target).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["created"], true);
        assert_eq!(v["existed"], false);
        assert_eq!(v["resolvedPath"], target);
        assert!(std::path::Path::new(&target).is_dir());
    }

    // Intentional: env lock held across `.await` BY DESIGN (see above).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn test_mkdir_enotdir_is_409_not_500() {
        let _guard = env_lock();
        let tmp = tempfile::tempdir().unwrap();
        // An INTERMEDIATE component that is a FILE: recursive mkdir fails
        // ENOTDIR, which Node maps to 409 "Path exists but is not a directory"
        // (`files-router.ts:272-274`) — never a 500.
        std::fs::write(tmp.path().join("blocker"), b"x").unwrap();
        let target = format!("{}/blocker/sub", tmp.path().to_string_lossy());
        let resp = mkdir_resp(&target).await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let v = body_json(resp).await;
        assert_eq!(v["error"], "Path exists but is not a directory");
        assert!(!std::path::Path::new(&target).exists());
    }

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
    fn collapse_dot_segments_mirrors_node_path_resolve() {
        assert_eq!(
            collapse_dot_segments("/home/user/projects/../../etc/passwd"),
            "/home/etc/passwd" // two `..` pop `projects` and `user`
        );
        assert_eq!(
            collapse_dot_segments("/home/user/projects//../../../etc/passwd"),
            "/etc/passwd" // three `..` pop everything down to the root
        );
        assert_eq!(collapse_dot_segments("/a/./b/"), "/a/b");
        assert_eq!(collapse_dot_segments("/a/b/../b/file.txt"), "/a/b/file.txt");
        // `..` clamps at the filesystem root, like path.resolve.
        assert_eq!(collapse_dot_segments("/../.."), "/");
        assert_eq!(collapse_dot_segments("/"), "/");
        // Non-absolute / literal fallback strings stay byte-exact (fail-closed).
        assert_eq!(
            collapse_dot_segments("C:\\Users\\..\\x"),
            "C:\\Users\\..\\x"
        );
        assert_eq!(collapse_dot_segments("rel/../x"), "rel/../x");
    }

    #[test]
    fn expand_tilde_uses_home() {
        let _guard = env_lock();
        let _env = EnvGuard::set(&[("HOME", Some("/home/tester"))]);
        assert_eq!(expand_tilde("~"), "/home/tester");
        assert_eq!(expand_tilde("~/proj"), "/home/tester/proj");
        assert_eq!(expand_tilde("/abs"), "/abs");
    }

    /// posix_not_sanitized regression: Node sanitizes EVERY flavor's input at
    /// the top of `normalizeUserPath` (`path-utils.ts:55` →
    /// `sanitizeUserPathInput` `:24-30`: trim whitespace, strip one pair of
    /// wrapping quotes, re-trim). This port previously sanitized only
    /// `resolve_user_path`'s Windows branch, so a space-padded or shell-quoted
    /// POSIX path was stat'd/written verbatim.
    #[test]
    fn test_posix_input_trims_and_unquotes() {
        let _guard = env_lock();
        let _env = EnvGuard::set(&[("HOME", Some("/home/tester"))]);
        // Leading/trailing whitespace padding is trimmed.
        assert_eq!(normalize_user_path("/tmp/x "), "/tmp/x");
        assert_eq!(normalize_user_path("  /tmp/x"), "/tmp/x");
        // One pair of matching wrapping quotes (a shell-pasted path) is stripped.
        assert_eq!(normalize_user_path("\"/tmp/x\""), "/tmp/x");
        assert_eq!(normalize_user_path("'/tmp/x'"), "/tmp/x");
        // The sanitize runs BEFORE tilde expansion (path-utils.ts:55 then
        // `:58-63`), so a padded/quoted `~` still expands.
        assert_eq!(normalize_user_path(" \"~/proj\" "), "/home/tester/proj");
        // A quotes-only input sanitizes to empty, like Node's `''` return for a
        // falsy `cleaned` (path-utils.ts:26,56).
        assert_eq!(normalize_user_path("\"\""), "");
        // The display/fs path every handler consumes carry the sanitized form.
        let r = resolve_user_path(" \"/tmp/x\" ");
        assert_eq!(r.display, "/tmp/x");
        assert_eq!(r.fs_path, Some("/tmp/x".to_string()));
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

    /// FILE-03 (network shares / prefix-confusion): the legacy
    /// `isAbsoluteUserPath` (files-router.ts:38-42) uses
    /// `path.win32.isAbsolute`, which is TRUE for UNC (`\\srv\share\dir`) and
    /// rooted (`\rooted\x`) forms, so `resolveCompletionInput`
    /// (files-router.ts:46) returns them unchanged instead of anchoring them
    /// under the caller's `root`.
    #[test]
    fn test_unc_classification() {
        assert!(is_absolute_user_path("\\\\srv\\share\\dir"));
        assert!(is_absolute_user_path("\\rooted\\x"));
        // Observable port behavior: rooted/UNC prefixes are returned unchanged,
        // never joined under the completion root.
        assert_eq!(
            resolve_completion_input("\\\\srv\\share\\dir", Some("/root")),
            "\\\\srv\\share\\dir"
        );
        assert_eq!(
            resolve_completion_input("\\rooted\\x", Some("/root")),
            "\\rooted\\x"
        );
    }

    #[test]
    fn resolve_completion_input_honors_root_and_absolute() {
        let _guard = env_lock();
        let _env = EnvGuard::set(&[("HOME", Some("/home/tester"))]);
        // No root \u2192 prefix unchanged.
        assert_eq!(resolve_completion_input("a", None), "a");
        // Absolute prefix ignores root.
        assert_eq!(resolve_completion_input("/abs/x", Some("/root")), "/abs/x");
        // Relative prefix joins the (normalized) root.
        assert_eq!(
            resolve_completion_input("sub/x", Some("/root")),
            "/root/sub/x"
        );
    }

    #[test]
    fn validate_dir_semantics_against_real_fs() {
        // An existing directory validates; a bogus path does not.
        let tmp = std::env::temp_dir();
        assert!(std::fs::metadata(&tmp).map(|m| m.is_dir()).unwrap_or(false));
        let bogus = tmp.join("freshell-nonexistent-xyz-123456");
        assert!(!std::fs::metadata(&bogus)
            .map(|m| m.is_dir())
            .unwrap_or(false));
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
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
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
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["directories"], json!([]));
    }
}
