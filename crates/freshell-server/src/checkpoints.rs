//! Code rewind checkpoints for FreshAgent panes. The routes here create, list,
//! annotate, and restore snapshots in a shadow bare Git repository under
//! `<home>/.freshell/checkpoints/<sha1-of-workspace-path>.git`; the source
//! repository's index, refs, and permissions are never changed.
//!
//! A pane carries checkpoint workspace intent separately from its launch/routing
//! cwd. Directory-picker selections can name a non-Git directory; an inferred
//! workspace resolves to the enclosing Git root. An account HOME is never an
//! implicit capture scope. Older checkpoint stores remain addressable by their
//! exact legacy cwd locator.
//!
//! Each create uses a request-local index, applies the workspace's Git ignore
//! rules, expands nested repositories and submodules into ordinary files, and
//! verifies that every selected regular file and symlink can be read. Metadata
//! is written before the shadow ref is advanced, and the ref update is the final
//! publication step. Restore and metadata routes accept only commits reachable
//! from the published ref, so failed/orphaned objects never become targets.
//!
//! The create response retains the legacy `{ id, ts, label, requestId? }` fields
//! and adds the resolved `{ path, provenance }` workspace locator. Expected
//! scope/readability failures return a stable code and user-safe details while
//! structured logs retain bounded internal cause and request correlation.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use std::collections::HashMap;

use axum::routing::get as get_method;
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::boot::{is_authed, unauthorized};

/// `CHECKPOINT_LABEL_LIMIT` (`fresh-agent-extras-router.ts:349` inline `.slice(0,
/// 120)` on the label — mirrored here as a named constant for clarity, matching
/// the client's own `CHECKPOINT_LABEL_LIMIT` in `src/lib/fresh-agent-checkpoints.ts:6`).
/// NOTE: truncation here is by Unicode scalar value (Rust `char`), not by UTF-16
/// code unit as JS `String.prototype.slice` counts — astral-plane characters
/// (rare in a checkpoint label, which is derived from the outgoing message text)
/// would truncate one char later here than in JS. Not fixed: a byte-for-byte port
/// of JS's UTF-16 indexing has no ergonomic Rust equivalent and the divergence is
/// unobservable for the overwhelming majority of real labels (ASCII/BMP text).
const CHECKPOINT_LABEL_LIMIT: usize = 120;

/// `CHECKPOINT_IDENTITY` (`fresh-agent-extras-router.ts:73`): the shadow repo's
/// commit author/committer identity, so a checkpoint commit never depends on (or
/// pollutes) the real user's global git config.
const CHECKPOINT_IDENTITY: [&str; 4] = [
    "-c",
    "user.name=freshell",
    "-c",
    "user.email=checkpoints@freshell.local",
];

/// Shared state for the `/api/fresh-agent/checkpoints` route.
#[derive(Clone)]
pub struct CheckpointsApiState {
    pub auth_token: Arc<String>,
    /// The resolved home directory whose `.freshell/checkpoints/` holds every
    /// shadow repo (mirrors `os.homedir()` in `checkpointGitDir`,
    /// `fresh-agent-extras-router.ts:76`). `Arc`-shared, not re-resolved per
    /// request, matching this crate's convention for boot-resolved paths (see
    /// `main.rs`'s `session_metadata_dir`).
    pub home: Arc<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ResolvedCheckpointWorkspace {
    path: PathBuf,
    provenance: String,
}

#[derive(Debug)]
struct CheckpointWorkspaceUnavailable {
    candidate: String,
    reason: String,
}

impl CheckpointWorkspaceUnavailable {
    fn response(&self) -> Response {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "error": self.reason,
                "code": "workspace_unavailable",
                "workspace": self.candidate,
                "details": self.reason,
            })),
        )
            .into_response()
    }
}

#[derive(Debug)]
struct CheckpointFailure {
    stage: &'static str,
    operation: String,
    code: &'static str,
    workspace: String,
    path: Option<String>,
    filesystem_kind: Option<String>,
    errno: Option<i32>,
    git_exit_status: Option<i32>,
    cause: String,
    user_details: &'static str,
}

impl CheckpointFailure {
    fn from_capture_detail(home: &Path, workspace: &Path, detail: &str) -> Self {
        let mut operation = "capture".to_string();
        let mut path = None;
        let mut cause = detail;
        if let Some(after_prefix) = detail.strip_prefix("checkpoint operation ") {
            if let Some((name, after_name)) = after_prefix.split_once(" failed") {
                operation = name.to_string();
                if let Some(after_for) = after_name.strip_prefix(" for ") {
                    if let Some((path_value, cause_value)) = after_for.split_once(": ") {
                        path = Some(path_value.to_string());
                        cause = cause_value;
                    }
                } else if let Some(cause_value) = after_name.strip_prefix(": ") {
                    cause = cause_value;
                }
            }
        }
        if let Some(after_prefix) = detail.strip_prefix("Git operation ") {
            if let Some((name, after_name)) = after_prefix.split_once(" failed") {
                operation = name.to_string();
                cause =
                    after_name.trim_start_matches(|character| character == ' ' || character == ':');
            }
        } else if detail.starts_with("git index update failed") {
            operation = "git-index-update".to_string();
            cause = detail;
        } else if detail.starts_with("failed to read checkpoint metadata") {
            operation = "read-metadata".to_string();
            cause = detail;
        } else if detail.starts_with("failed to persist checkpoint metadata") {
            operation = "write-metadata".to_string();
            cause = detail;
        }

        if path.is_none() && matches!(operation.as_str(), "read-metadata" | "write-metadata") {
            path = Some(
                checkpoint_metadata_path(&checkpoint_git_dir(home, workspace))
                    .to_string_lossy()
                    .into_owned(),
            );
        }

        if path.is_none() {
            path = git_open_failure_path(detail);
        }

        let git_exit_status = cause
            .split_once("exit_status=")
            .and_then(|(_, rest)| {
                rest.strip_prefix("Some(")
                    .unwrap_or(rest)
                    .split(|ch: char| !ch.is_ascii_digit() && ch != '-')
                    .next()
            })
            .and_then(|value| value.parse::<i32>().ok());
        let lowered_cause = cause.to_ascii_lowercase();
        let filesystem_kind = if lowered_cause.contains("permission denied") {
            Some("PermissionDenied".to_string())
        } else if lowered_cause.contains("is a directory") {
            Some("IsADirectory".to_string())
        } else {
            None
        };
        let errno = cause
            .split_once("os error ")
            .and_then(|(_, rest)| {
                rest.split(|ch: char| !ch.is_ascii_digit() && ch != '-')
                    .next()
            })
            .and_then(|value| value.parse::<i32>().ok());
        let permission_denied = cause.to_ascii_lowercase().contains("permission denied");
        let unreadable = operation == "verify-readable"
            || operation == "verify-symlink"
            || (permission_denied && path.is_some());
        Self {
            stage: if unreadable { "readability" } else { "capture" },
            operation,
            code: if unreadable {
                "checkpoint_path_unreadable"
            } else {
                "checkpoint_capture_failed"
            },
            workspace: workspace.to_string_lossy().into_owned(),
            path,
            filesystem_kind,
            errno,
            git_exit_status,
            cause: bounded_log_detail(cause),
            user_details: if unreadable {
                "A selected project file could not be read, so this code checkpoint is unavailable."
            } else {
                "The project code checkpoint could not be saved."
            },
        }
    }

    fn log(&self, send_request_id: Option<&str>) {
        if self.code == "checkpoint_path_unreadable" {
            tracing::warn!(
                target: "freshell_server::checkpoints",
                event = "code_checkpoint.failed",
                send_request_id = %send_request_id.unwrap_or(""),
                stage = self.stage,
                operation = %self.operation,
                failure_code = self.code,
                workspace = %self.workspace,
                path = %self.path.as_deref().unwrap_or(""),
                filesystem_kind = %self.filesystem_kind.as_deref().unwrap_or(""),
                errno = self.errno.unwrap_or_default(),
                git_exit_status = self.git_exit_status.unwrap_or_default(),
                cause = %self.cause,
                "code checkpoint failed"
            );
        } else {
            tracing::error!(
                target: "freshell_server::checkpoints",
                event = "code_checkpoint.failed",
                send_request_id = %send_request_id.unwrap_or(""),
                stage = self.stage,
                operation = %self.operation,
                failure_code = self.code,
                workspace = %self.workspace,
                path = %self.path.as_deref().unwrap_or(""),
                filesystem_kind = %self.filesystem_kind.as_deref().unwrap_or(""),
                errno = self.errno.unwrap_or_default(),
                git_exit_status = self.git_exit_status.unwrap_or_default(),
                cause = %self.cause,
                "code checkpoint failed"
            );
        }
    }

    fn response(&self) -> Response {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": "Code checkpoint unavailable",
                "code": self.code,
                "details": self.user_details,
                "workspace": self.workspace,
            })),
        )
            .into_response()
    }
}

fn git_open_failure_path(detail: &str) -> Option<String> {
    let (start, marker) = ["fatal: open(", "error: open("]
        .iter()
        .find_map(|marker| detail.find(marker).map(|start| (start, *marker)))?;
    let start = start + marker.len();
    let remainder = &detail[start..];
    let (path, suffix) = match remainder.as_bytes().first().copied() {
        Some(b'\'') => {
            let end = remainder[1..].find("'):")? + 1;
            (&remainder[1..end], &remainder[end + 3..])
        }
        Some(b'\"') => {
            let end = remainder[1..].find("\"):")? + 1;
            (&remainder[1..end], &remainder[end + 3..])
        }
        _ => {
            let end = remainder.find("):")?;
            (&remainder[..end], &remainder[end + 2..])
        }
    };
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
        || !suffix.to_ascii_lowercase().contains("permission denied")
    {
        return None;
    }
    Some(path.to_string_lossy().into_owned())
}

fn bounded_log_detail(detail: &str) -> String {
    detail
        .chars()
        .filter(|character| !character.is_control() || *character == ' ')
        .take(240)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn safe_send_request_id(request_id: Option<&str>) -> Option<&str> {
    request_id.filter(|value| {
        !value.is_empty()
            && value.len() <= 128
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
            })
    })
}

fn log_workspace_unavailable(candidate: &str, cause: &str, send_request_id: Option<&str>) {
    tracing::warn!(
        target: "freshell_server::checkpoints",
        event = "code_checkpoint.failed",
        send_request_id = %send_request_id.unwrap_or(""),
        stage = "workspace-resolution",
        operation = "resolve-workspace",
        failure_code = "workspace_unavailable",
        workspace = candidate,
        path = candidate,
        cause = %bounded_log_detail(cause),
        "code checkpoint workspace unavailable"
    );
}

fn recognized_account_homes(server_home: Option<&Path>) -> Vec<PathBuf> {
    let mut homes = Vec::new();
    let mut add_existing = |candidate: &Path| {
        if let Ok(canonical) = std::fs::canonicalize(candidate) {
            if !homes.contains(&canonical) {
                homes.push(canonical);
            }
        }
    };
    if let Some(server_home) = server_home {
        add_existing(server_home);
    }
    for variable in ["HOME", "USERPROFILE"] {
        if let Some(value) = std::env::var_os(variable) {
            add_existing(Path::new(&value));
        }
    }
    #[cfg(unix)]
    if let Ok(passwd) = std::fs::read_to_string("/etc/passwd") {
        for line in passwd.lines() {
            let fields = line.split(':').collect::<Vec<_>>();
            if fields.len() >= 6 && !fields[5].is_empty() {
                add_existing(Path::new(fields[5]));
            }
        }
    }
    #[cfg(windows)]
    if let (Some(drive), Some(path)) = (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH"))
    {
        add_existing(&PathBuf::from(drive).join(path));
    }
    homes
}

pub fn is_os_account_home(candidate: &Path) -> bool {
    let Ok(candidate) = std::fs::canonicalize(candidate) else {
        return false;
    };
    is_recognized_account_home(&candidate, &recognized_account_homes(None))
}

fn is_recognized_account_home(path: &Path, homes: &[PathBuf]) -> bool {
    homes.iter().any(|home| home == path)
}

async fn canonical_workspace(path: &Path) -> Result<PathBuf, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("workspace is not accessible: {error}"))?;
    if !metadata.is_dir() {
        return Err("workspace is not a directory".to_string());
    }
    tokio::fs::canonicalize(path)
        .await
        .map_err(|error| format!("workspace cannot be resolved: {error}"))
}

async fn git_checkout_root(path: &Path) -> Option<PathBuf> {
    let output = run_git(&["rev-parse", "--show-toplevel"], Some(path))
        .await
        .ok()?;
    tokio::fs::canonicalize(output.trim()).await.ok()
}

async fn resolve_checkpoint_workspace(
    server_home: &Path,
    launch_cwd: &Path,
    intent: Option<&Value>,
) -> Result<ResolvedCheckpointWorkspace, CheckpointWorkspaceUnavailable> {
    let candidate = intent
        .and_then(|workspace| workspace.get("path"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| launch_cwd.to_string_lossy().into_owned());
    let homes = recognized_account_homes(Some(server_home));
    if let Some(workspace) = intent {
        let provenance = workspace
            .get("provenance")
            .and_then(Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "directory-picker" | "resolved-project" | "legacy-checkpoint"
                )
            })
            .map(str::to_string)
            .ok_or_else(|| CheckpointWorkspaceUnavailable {
                candidate: candidate.clone(),
                reason: "workspace selection has no recognized provenance".to_string(),
            })?;
        let selected = canonical_workspace(Path::new(&candidate))
            .await
            .map_err(|reason| CheckpointWorkspaceUnavailable {
                candidate: candidate.clone(),
                reason,
            })?;
        if is_recognized_account_home(&selected, &homes) {
            return Err(CheckpointWorkspaceUnavailable {
                candidate,
                reason: "account home cannot be used as a code checkpoint workspace".to_string(),
            });
        }
        let path = if provenance == "legacy-checkpoint" {
            selected
        } else {
            git_checkout_root(&selected).await.unwrap_or(selected)
        };
        if is_recognized_account_home(&path, &homes) {
            return Err(CheckpointWorkspaceUnavailable {
                candidate,
                reason: "account home cannot be used as an inferred code checkpoint workspace"
                    .to_string(),
            });
        }
        return Ok(ResolvedCheckpointWorkspace { path, provenance });
    }

    let launch =
        canonical_workspace(launch_cwd)
            .await
            .map_err(|reason| CheckpointWorkspaceUnavailable {
                candidate: candidate.clone(),
                reason,
            })?;
    if is_recognized_account_home(&launch, &homes) {
        return Err(CheckpointWorkspaceUnavailable {
            candidate,
            reason: "account home has no selected code checkpoint workspace".to_string(),
        });
    }
    let root = git_checkout_root(&launch)
        .await
        .ok_or_else(|| CheckpointWorkspaceUnavailable {
            candidate: candidate.clone(),
            reason: "no explicit workspace or Git project root is available".to_string(),
        })?;
    let path = root;
    if is_recognized_account_home(&path, &homes) {
        return Err(CheckpointWorkspaceUnavailable {
            candidate,
            reason: "account home cannot be used as an inferred code checkpoint workspace"
                .to_string(),
        });
    }
    Ok(ResolvedCheckpointWorkspace {
        path,
        provenance: "resolved-project".to_string(),
    })
}

fn workspace_response_value(workspace: &ResolvedCheckpointWorkspace) -> Value {
    json!({
        "path": workspace.path.to_string_lossy(),
        "provenance": workspace.provenance,
    })
}

/// The `/api/fresh-agent/checkpoints` sub-router. `GET` (list) and `POST`
/// (create) share the one `/checkpoints` path; `restore` and `metadata` are
/// their own POST-only sibling paths (`fresh-agent-extras-router.ts:230-232`).
pub fn router(state: CheckpointsApiState) -> Router {
    Router::new()
        .route(
            "/api/fresh-agent/checkpoints",
            post(post_checkpoint).get(get_method(get_checkpoints)),
        )
        .route(
            "/api/fresh-agent/checkpoints/restore",
            post(post_checkpoint_restore),
        )
        .route(
            "/api/fresh-agent/checkpoints/metadata",
            post(post_checkpoint_metadata),
        )
        .with_state(state)
}

async fn post_checkpoint(
    State(state): State<CheckpointsApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    let cwd = match body
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        Some(cwd) => cwd.to_string(),
        None => return bad_request("cwd is required"),
    };

    let label = body
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(CHECKPOINT_LABEL_LIMIT).collect::<String>())
        .unwrap_or_else(|| "checkpoint".to_string());

    let request_id = body
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let cwd_path = Path::new(&cwd);
    let send_request_id = safe_send_request_id(request_id.as_deref());
    let workspace =
        match resolve_checkpoint_workspace(&state.home, cwd_path, body.get("workspace")).await {
            Ok(workspace) => workspace,
            Err(error) => {
                log_workspace_unavailable(&error.candidate, &error.reason, send_request_id);
                return error.response();
            }
        };

    match create_checkpoint(&state.home, &workspace.path, &label, request_id.as_deref()).await {
        Ok(mut entry) => {
            if let Some(fields) = entry.as_object_mut() {
                fields.insert(
                    "workspace".to_string(),
                    workspace_response_value(&workspace),
                );
            }
            Json(entry).into_response()
        }
        Err(message) => {
            let failure =
                CheckpointFailure::from_capture_detail(&state.home, &workspace.path, &message);
            failure.log(send_request_id);
            failure.response()
        }
    }
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

// ── checkpoint git operations (fresh-agent-extras-router.ts:75-184) ─────────

/// `createCheckpoint` (`fresh-agent-extras-router.ts:174-184`): `git add -A` +
/// `commit --allow-empty` in the shadow repo, then (iff a `requestId` was
/// supplied) persist a `sha -> {requestId}` metadata entry. Returns the exact
/// legacy response shape.
async fn create_checkpoint(
    home: &Path,
    cwd: &Path,
    label: &str,
    request_id: Option<&str>,
) -> Result<Value, String> {
    let git_dir = ensure_checkpoint_repo(home, cwd).await?;
    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let work_tree_arg = format!("--work-tree={}", cwd.display());

    let index_path = git_dir.join("index");
    let request_index = git_dir.join(format!("index.tmp-{}", uuid::Uuid::new_v4()));
    let old_head = run_git(&[&git_dir_arg, "rev-parse", "--verify", "HEAD"], None)
        .await
        .ok()
        .map(|head| head.trim().to_string());

    if old_head.is_some() {
        if tokio::fs::copy(&index_path, &request_index).await.is_err() {
            let tree = run_git(&[&git_dir_arg, "rev-parse", "HEAD^{tree}"], None)
                .await?
                .trim()
                .to_string();
            run_git_with_index(&[&git_dir_arg, "read-tree", &tree], None, &request_index).await?;
        } else {
            let cached_tree =
                run_git_with_index(&[&git_dir_arg, "write-tree"], None, &request_index)
                    .await
                    .ok()
                    .map(|tree| tree.trim().to_string());
            let published_tree = run_git(&[&git_dir_arg, "rev-parse", "HEAD^{tree}"], None)
                .await
                .ok()
                .map(|tree| tree.trim().to_string());
            if cached_tree != published_tree {
                let _ = tokio::fs::remove_file(&request_index).await;
                let tree = published_tree.ok_or_else(|| {
                    "checkpoint operation resolve-published-tree failed: current HEAD is unavailable"
                        .to_string()
                })?;
                run_git_with_index(&[&git_dir_arg, "read-tree", &tree], None, &request_index)
                    .await?;
            }
        }
    } else {
        run_git_with_index(
            &[&git_dir_arg, "read-tree", "--empty"],
            None,
            &request_index,
        )
        .await?;
    }

    let capture = async {
        verify_readable_directories(&git_dir, cwd).await?;
        run_git_with_index(
            &[&git_dir_arg, &work_tree_arg, "add", "-A", "--", "."],
            Some(cwd),
            &request_index,
        )
        .await?;
        expand_nested_repositories(&git_dir, cwd, &request_index).await?;
        verify_checkpoint_index(&git_dir, cwd, &request_index).await?;

        let tree = run_git_with_index(&[&git_dir_arg, "write-tree"], None, &request_index)
            .await?
            .trim()
            .to_string();
        let mut commit_args: Vec<&str> = vec![git_dir_arg.as_str()];
        commit_args.extend(CHECKPOINT_IDENTITY);
        commit_args.extend(["commit-tree", tree.as_str()]);
        if let Some(parent) = old_head.as_deref() {
            commit_args.extend(["-p", parent]);
        }
        commit_args.extend(["-m", label]);
        let sha = run_git(&commit_args, None).await?.trim().to_string();

        if let Some(request_id) = request_id {
            update_checkpoint_metadata(&git_dir, &sha, request_id).await?;
        }

        let head_ref = run_git(&[&git_dir_arg, "symbolic-ref", "HEAD"], None)
            .await?
            .trim()
            .to_string();
        let mut update_ref = vec![&git_dir_arg, "update-ref", head_ref.as_str(), sha.as_str()];
        if let Some(parent) = old_head.as_deref() {
            update_ref.push(parent);
        }
        run_git(&update_ref, None).await?;

        Ok::<String, String>(sha)
    }
    .await;

    let sha = match capture {
        Ok(sha) => sha,
        Err(error) => {
            let _ = tokio::fs::remove_file(&request_index).await;
            return Err(error);
        }
    };

    // The published tree is already complete. Losing this disposable stat cache
    // can make the next request slower, but cannot hide or invalidate a target.
    if let Err(error) = install_checkpoint_index(&request_index, &index_path).await {
        tracing::warn!(
            event = "code_checkpoint.index_cache_install_failed",
            workspace = %cwd.display(),
            cause = %error,
            "checkpoint index cache could not be retained"
        );
        let _ = tokio::fs::remove_file(&request_index).await;
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut entry = Map::new();
    entry.insert("id".to_string(), json!(sha));
    entry.insert("ts".to_string(), json!(ts));
    entry.insert("label".to_string(), json!(label));
    if let Some(request_id) = request_id {
        entry.insert("requestId".to_string(), json!(request_id));
    }
    Ok(Value::Object(entry))
}

/// `ensureCheckpointRepo` (`fresh-agent-extras-router.ts:96-105`): create the
/// bare shadow repo on first use for this `cwd`, otherwise reuse it.
async fn ensure_checkpoint_repo(home: &Path, cwd: &Path) -> Result<PathBuf, String> {
    let git_dir = checkpoint_git_dir(home, cwd);
    match tokio::fs::metadata(git_dir.join("HEAD")).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tokio::fs::create_dir_all(&git_dir)
                .await
                .map_err(|e| format!("failed to create checkpoint dir: {e}"))?;
            run_git(&["init", "--bare", "-q", &git_dir.to_string_lossy()], None).await?;
        }
        Err(error) => return Err(format!("failed to inspect checkpoint repository: {error}")),
    }
    Ok(git_dir)
}

/// `checkpointGitDir` (`fresh-agent-extras-router.ts:75-78`): the shadow repo
/// path is `<home>/.freshell/checkpoints/<first-16-hex-of-sha1(resolved cwd)>.git`
/// — a stable, deterministic per-cwd identity.
fn checkpoint_git_dir(home: &Path, cwd: &Path) -> PathBuf {
    let resolved = resolve_absolute(cwd);
    let mut hasher = Sha1::new();
    hasher.update(resolved.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let hex = hex_encode(&digest);
    let short = &hex[..16.min(hex.len())];
    home.join(".freshell")
        .join("checkpoints")
        .join(format!("{short}.git"))
}

/// Lexical (no symlink-following) equivalent of Node's `path.resolve(cwd)`: an
/// already-absolute path is normalized (`.`/`..` segments collapsed); a relative
/// one is resolved against the process's current directory first. Node's
/// `path.resolve` never touches the filesystem (no symlink resolution) — this
/// mirrors that, unlike `Path::canonicalize` which would.
fn resolve_absolute(input: &Path) -> PathBuf {
    let base = if input.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
    };
    let mut components: Vec<std::ffi::OsString> = Vec::new();
    for comp in base.components().chain(input.components()) {
        match comp {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                components.clear();
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                components.pop();
            }
            std::path::Component::Normal(part) => {
                components.push(part.to_os_string());
            }
        }
    }
    let mut result = PathBuf::from("/");
    for c in components {
        result.push(c);
    }
    result
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Run Git without exposing the shadow-store flags or full argv in diagnostics.
/// Failures retain a safe operation name, exit status, and bounded stderr cause.
async fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let output = invoke_git(args, cwd, None).await?;
    check_git_output(args, output)
}

async fn run_git_with_index(
    args: &[&str],
    cwd: Option<&Path>,
    index: &Path,
) -> Result<String, String> {
    let output = invoke_git(args, cwd, Some(index)).await?;
    check_git_output(args, output)
}

async fn run_git_bytes(args: &[&str], cwd: Option<&Path>) -> Result<Vec<u8>, String> {
    let output = invoke_git(args, cwd, None).await?;
    check_git_output_bytes(args, output)
}

async fn run_git_with_index_bytes(
    args: &[&str],
    cwd: Option<&Path>,
    index: &Path,
) -> Result<Vec<u8>, String> {
    let output = invoke_git(args, cwd, Some(index)).await?;
    check_git_output_bytes(args, output)
}

async fn run_git_with_index_input(
    args: &[&str],
    cwd: Option<&Path>,
    index: &Path,
    input: &[u8],
) -> Result<(), String> {
    let mut cmd = Command::new("git");
    cmd.args(args).stdin(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.env("GIT_INDEX_FILE", index);
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("git update-index failed to start: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(error) = stdin.write_all(input).await {
            let _ = child.kill().await;
            return Err(format!(
                "git update-index failed to write path list: {error}"
            ));
        }
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("git update-index failed to wait: {error}"))?;
    check_git_output_bytes(args, output).map(|_| ())
}

async fn ignored_git_directories(
    git_dir: &Path,
    work_tree: &Path,
    directory_paths: &[Vec<u8>],
) -> Result<std::collections::HashSet<Vec<u8>>, String> {
    if directory_paths.is_empty() {
        return Ok(std::collections::HashSet::new());
    }

    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let work_tree_arg = format!("--work-tree={}", work_tree.display());
    let mut child = Command::new("git")
        .arg(git_dir_arg)
        .arg(work_tree_arg)
        .args(["check-ignore", "--no-index", "--stdin", "-z"])
        .current_dir(work_tree)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("git check-ignore failed to start: {error}"))?;
    let mut input = Vec::new();
    for path in directory_paths {
        input.extend_from_slice(path);
        input.push(0);
    }
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(error) = stdin.write_all(&input).await {
            let _ = child.kill().await;
            return Err(format!("git check-ignore failed to write paths: {error}"));
        }
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("git check-ignore failed to wait: {error}"))?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(format!(
            "Git operation check-ignore failed (exit_status={:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(<[u8]>::to_vec)
        .collect())
}

fn git_path_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    }
    #[cfg(windows)]
    {
        path.to_string_lossy().as_bytes().to_vec()
    }
}

fn display_relative_path(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        ".".to_string()
    } else {
        path.to_string_lossy().into_owned()
    }
}

async fn verify_readable_directories(git_dir: &Path, work_tree: &Path) -> Result<(), String> {
    let mut pending = vec![PathBuf::new()];
    while let Some(relative_parent) = pending.pop() {
        let absolute_parent = work_tree.join(&relative_parent);
        let mut entries = tokio::fs::read_dir(&absolute_parent)
            .await
            .map_err(|error| {
                format!(
                    "checkpoint operation verify-readable failed for {}: {error}",
                    display_relative_path(&relative_parent)
                )
            })?;
        let mut candidates = Vec::new();
        while let Some(entry) = entries.next_entry().await.map_err(|error| {
            format!(
                "checkpoint operation verify-readable failed for {}: {error}",
                display_relative_path(&relative_parent)
            )
        })? {
            if entry.file_name() == ".git" {
                continue;
            }
            let file_type = entry.file_type().await.map_err(|error| {
                let relative = relative_parent.join(entry.file_name());
                format!(
                    "checkpoint operation verify-readable failed for {}: {error}",
                    display_relative_path(&relative)
                )
            })?;
            if !file_type.is_dir() {
                continue;
            }
            let relative = relative_parent.join(entry.file_name());
            let mut ignore_path = git_path_bytes(&relative);
            ignore_path.push(b'/');
            candidates.push((relative, ignore_path));
        }

        let candidate_paths = candidates
            .iter()
            .map(|(_, path)| path.clone())
            .collect::<Vec<_>>();
        let ignored = ignored_git_directories(git_dir, work_tree, &candidate_paths).await?;
        for (relative, ignore_path) in candidates {
            if !ignored.contains(&ignore_path) {
                pending.push(relative);
            }
        }
    }
    Ok(())
}

async fn invoke_git(
    args: &[&str],
    cwd: Option<&Path>,
    index: Option<&Path>,
) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    cmd.output()
        .await
        .map_err(|e| format!("Git process failed to start: {e}"))
}

fn check_git_output(args: &[&str], output: std::process::Output) -> Result<String, String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let operation = git_operation_label(args);
        let message = if stderr.trim().is_empty() {
            format!(
                "Git operation {operation} failed (exit_status={:?})",
                output.status.code()
            )
        } else {
            format!(
                "Git operation {operation} failed (exit_status={:?}): {}",
                output.status.code(),
                stderr.trim()
            )
        };
        return Err(message);
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn check_git_output_bytes(args: &[&str], output: std::process::Output) -> Result<Vec<u8>, String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let operation = git_operation_label(args);
        let message = if stderr.trim().is_empty() {
            format!(
                "Git operation {operation} failed (exit_status={:?})",
                output.status.code()
            )
        } else {
            format!(
                "Git operation {operation} failed (exit_status={:?}): {}",
                output.status.code(),
                stderr.trim()
            )
        };
        return Err(message);
    }
    Ok(output.stdout)
}

fn git_operation_label(args: &[&str]) -> &'static str {
    args.iter()
        .rev()
        .find_map(|argument| match *argument {
            "add" => Some("add"),
            "check-ignore" => Some("check-ignore"),
            "read-tree" => Some("read-tree"),
            "write-tree" => Some("write-tree"),
            "commit-tree" => Some("commit-tree"),
            "update-ref" => Some("update-ref"),
            "ls-files" => Some("ls-files"),
            "rev-parse" => Some("rev-parse"),
            "symbolic-ref" => Some("symbolic-ref"),
            "merge-base" => Some("merge-base"),
            "log" => Some("log"),
            "checkout" => Some("checkout"),
            "init" => Some("init"),
            "config" => Some("config"),
            _ => None,
        })
        .unwrap_or("other")
}

#[derive(Clone, Debug)]
struct GitIndexEntry {
    mode: Vec<u8>,
    path: Vec<u8>,
}

fn parse_git_index_entries(raw: &[u8]) -> Result<Vec<GitIndexEntry>, String> {
    raw.split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .map(|record| {
            let separator = record
                .iter()
                .position(|byte| *byte == b'\t')
                .ok_or_else(|| {
                    "checkpoint operation inspect-index failed: malformed Git index row".to_string()
                })?;
            let mode = record[..separator]
                .split(|byte| byte.is_ascii_whitespace())
                .next()
                .unwrap_or_default()
                .to_vec();
            Ok(GitIndexEntry {
                mode,
                path: record[separator + 1..].to_vec(),
            })
        })
        .collect()
}

async fn checkpoint_index_entries(
    git_dir: &Path,
    index: &Path,
) -> Result<Vec<GitIndexEntry>, String> {
    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let raw =
        run_git_with_index_bytes(&[&git_dir_arg, "ls-files", "--stage", "-z"], None, index).await?;
    parse_git_index_entries(&raw)
}

#[cfg(unix)]
fn git_relative_path(path: &[u8]) -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    PathBuf::from(std::ffi::OsStr::from_bytes(path))
}

#[cfg(windows)]
fn git_relative_path(path: &[u8]) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(path).as_ref())
}

fn git_path_ancestors(path: &[u8]) -> Vec<Vec<u8>> {
    let mut ancestors = Vec::new();
    for (index, byte) in path.iter().enumerate() {
        if *byte == b'/' && index > 0 {
            ancestors.push(path[..index].to_vec());
        }
    }
    ancestors
}

fn join_git_path(prefix: &[u8], relative: &[u8]) -> Vec<u8> {
    let mut joined = Vec::with_capacity(prefix.len() + 1 + relative.len());
    joined.extend_from_slice(prefix);
    joined.push(b'/');
    joined.extend_from_slice(relative);
    joined
}

fn git_path_is_at_or_below(path: &[u8], prefix: &[u8]) -> bool {
    path == prefix || (path.starts_with(prefix) && path.get(prefix.len()) == Some(&b'/'))
}

async fn directory_has_git_marker(work_tree: &Path, relative: &[u8]) -> bool {
    let path = work_tree.join(git_relative_path(relative));
    let metadata = tokio::fs::symlink_metadata(&path).await;
    if !metadata.is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink()) {
        return false;
    }
    tokio::fs::symlink_metadata(path.join(".git")).await.is_ok()
}

async fn nested_git_roots(
    repo_work_tree: &Path,
    staged: &[GitIndexEntry],
    selected_paths: &[Vec<u8>],
) -> Vec<Vec<u8>> {
    let mut candidates = Vec::new();
    for entry in staged {
        if entry.mode == b"160000" {
            candidates.push(entry.path.clone());
        }
        for ancestor in git_path_ancestors(&entry.path) {
            if directory_has_git_marker(repo_work_tree, &ancestor).await {
                candidates.push(ancestor);
            }
        }
    }
    for path in selected_paths {
        for ancestor in git_path_ancestors(path) {
            if directory_has_git_marker(repo_work_tree, &ancestor).await {
                candidates.push(ancestor);
            }
        }
    }
    candidates.sort();
    candidates.dedup();
    candidates
}

async fn collect_nested_snapshot_paths(
    nested_root: &Path,
    index_prefix: &[u8],
    files: &mut Vec<Vec<u8>>,
) -> Result<(), String> {
    let mut pending = vec![(nested_root.to_path_buf(), index_prefix.to_vec(), 0usize)];
    while let Some((repo_root, prefix, depth)) = pending.pop() {
        if depth > 64 {
            return Err(format!(
                "checkpoint operation enumerate-nested-repository failed for {}: nested repository depth exceeds 64",
                String::from_utf8_lossy(&prefix)
            ));
        }
        let root_metadata = tokio::fs::symlink_metadata(&repo_root)
            .await
            .map_err(|error| {
                format!(
                    "checkpoint operation enumerate-nested-repository failed for {}: {error}",
                    String::from_utf8_lossy(&prefix)
                )
            })?;
        if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
            return Err(format!(
                "checkpoint operation enumerate-nested-repository failed for {}: expected a populated repository directory",
                String::from_utf8_lossy(&prefix)
            ));
        }

        let top = run_git(&["rev-parse", "--show-toplevel"], Some(&repo_root))
            .await
            .map_err(|error| {
                format!(
                    "checkpoint operation enumerate-nested-repository failed for {}: {error}",
                    String::from_utf8_lossy(&prefix)
                )
            })?;
        let canonical_root = tokio::fs::canonicalize(&repo_root).await.map_err(|error| {
            format!(
                "checkpoint operation enumerate-nested-repository failed for {}: {error}",
                String::from_utf8_lossy(&prefix)
            )
        })?;
        let canonical_git_root = tokio::fs::canonicalize(top.trim()).await.map_err(|error| {
            format!(
                "checkpoint operation enumerate-nested-repository failed for {}: {error}",
                String::from_utf8_lossy(&prefix)
            )
        })?;
        if canonical_root != canonical_git_root {
            return Err(format!(
                "checkpoint operation enumerate-nested-repository failed for {}: Git resolves this path to a different repository root",
                String::from_utf8_lossy(&prefix)
            ));
        }

        let staged_raw = run_git_bytes(&["ls-files", "--stage", "-z"], Some(&repo_root))
            .await
            .map_err(|error| {
                format!(
                    "checkpoint operation enumerate-nested-repository failed for {}: {error}",
                    String::from_utf8_lossy(&prefix)
                )
            })?;
        let staged = parse_git_index_entries(&staged_raw)?;
        let selected_raw = run_git_bytes(
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
            Some(&repo_root),
        )
        .await
        .map_err(|error| {
            format!(
                "checkpoint operation enumerate-nested-repository failed for {}: {error}",
                String::from_utf8_lossy(&prefix)
            )
        })?;
        let selected = selected_raw
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(<[u8]>::to_vec)
            .collect::<Vec<_>>();
        let child_roots = nested_git_roots(&repo_root, &staged, &selected).await;

        for path in &selected {
            if child_roots
                .iter()
                .any(|child| git_path_is_at_or_below(path, child))
            {
                continue;
            }
            files.push(join_git_path(&prefix, path));
        }

        for child in child_roots.into_iter().rev() {
            let child_prefix = join_git_path(&prefix, &child);
            pending.push((
                repo_root.join(git_relative_path(&child)),
                child_prefix,
                depth + 1,
            ));
        }
    }
    Ok(())
}

async fn expand_nested_repositories(
    git_dir: &Path,
    work_tree: &Path,
    index: &Path,
) -> Result<(), String> {
    let staged = checkpoint_index_entries(git_dir, index).await?;
    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let work_tree_arg = format!("--work-tree={}", work_tree.display());
    let selected_raw = run_git_with_index_bytes(
        &[
            &git_dir_arg,
            &work_tree_arg,
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        Some(work_tree),
        index,
    )
    .await?;
    let selected = selected_raw
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(<[u8]>::to_vec)
        .collect::<Vec<_>>();
    let mut roots = nested_git_roots(work_tree, &staged, &selected).await;
    if let Ok(native_raw) = run_git_bytes(&["ls-files", "--stage", "-z"], Some(work_tree)).await {
        if let Ok(native_entries) = parse_git_index_entries(&native_raw) {
            roots.extend(
                native_entries
                    .into_iter()
                    .filter(|entry| entry.mode == b"160000")
                    .map(|entry| entry.path),
            );
        }
    }
    roots.sort();
    roots.dedup();
    if roots.is_empty() {
        return Ok(());
    }

    let mut files = Vec::new();
    for root in &roots {
        collect_nested_snapshot_paths(&work_tree.join(git_relative_path(root)), root, &mut files)
            .await?;
    }

    let root_index_entries = checkpoint_index_entries(git_dir, index).await?;
    let removals = root_index_entries
        .iter()
        .filter(|entry| {
            roots
                .iter()
                .any(|root| git_path_is_at_or_below(&entry.path, root))
        })
        .map(|entry| entry.path.clone())
        .collect::<std::collections::BTreeSet<_>>();
    if !removals.is_empty() {
        let mut input = Vec::new();
        for path in removals {
            input.extend_from_slice(&path);
            input.push(0);
        }
        let git_dir_arg = format!("--git-dir={}", git_dir.display());
        let work_tree_arg = format!("--work-tree={}", work_tree.display());
        run_git_with_index_input(
            &[
                &git_dir_arg,
                &work_tree_arg,
                "update-index",
                "-z",
                "--force-remove",
                "--stdin",
            ],
            Some(work_tree),
            index,
            &input,
        )
        .await?;
    }

    files.sort();
    files.dedup();
    if !files.is_empty() {
        let mut input = Vec::new();
        for path in files {
            input.extend_from_slice(&path);
            input.push(0);
        }
        let git_dir_arg = format!("--git-dir={}", git_dir.display());
        let work_tree_arg = format!("--work-tree={}", work_tree.display());
        run_git_with_index_input(
            &[
                &git_dir_arg,
                &work_tree_arg,
                "update-index",
                "--add",
                "--remove",
                "-z",
                "--stdin",
            ],
            Some(work_tree),
            index,
            &input,
        )
        .await?;
    }
    Ok(())
}

async fn verify_checkpoint_index(
    git_dir: &Path,
    work_tree: &Path,
    index: &Path,
) -> Result<(), String> {
    let staged = checkpoint_index_entries(git_dir, index).await?;
    for entry in staged {
        let mode = entry.mode.as_slice();
        let path = git_relative_path(&entry.path);
        if path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err(format!(
                "checkpoint operation inspect-index failed: unsafe captured path {}",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        let absolute = work_tree.join(path);
        let metadata = tokio::fs::symlink_metadata(&absolute)
            .await
            .map_err(|error| {
                format!(
                    "checkpoint operation verify-readable failed for {}: {error}",
                    String::from_utf8_lossy(&entry.path)
                )
            })?;
        if mode == b"160000" {
            return Err(format!(
                "checkpoint operation enumerate-nested-repository failed for {}: nested repository content is not captured as ordinary files",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        if mode == b"120000" {
            if !metadata.file_type().is_symlink() {
                return Err(format!(
                    "checkpoint operation verify-symlink failed for {}: indexed symlink is no longer a symlink",
                    String::from_utf8_lossy(&entry.path)
                ));
            }
            tokio::fs::read_link(&absolute).await.map_err(|error| {
                format!(
                    "checkpoint operation verify-symlink failed for {}: {error}",
                    String::from_utf8_lossy(&entry.path)
                )
            })?;
            continue;
        }
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(format!(
                "checkpoint operation verify-readable failed for {}: expected a regular file",
                String::from_utf8_lossy(&entry.path)
            ));
        }
        let mut file = tokio::fs::File::open(&absolute).await.map_err(|error| {
            format!(
                "checkpoint operation verify-readable failed for {}: {error}",
                String::from_utf8_lossy(&entry.path)
            )
        })?;
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let count = file.read(&mut buffer).await.map_err(|error| {
                format!(
                    "checkpoint operation verify-readable failed for {}: {error}",
                    String::from_utf8_lossy(&entry.path)
                )
            })?;
            if count == 0 {
                break;
            }
        }
    }
    Ok(())
}

async fn install_checkpoint_index(
    request_index: &Path,
    published_index: &Path,
) -> Result<(), String> {
    if tokio::fs::try_exists(published_index)
        .await
        .unwrap_or(false)
    {
        tokio::fs::remove_file(published_index)
            .await
            .map_err(|error| format!("failed to remove stale checkpoint index cache: {error}"))?;
    }
    tokio::fs::rename(request_index, published_index)
        .await
        .map_err(|error| format!("failed to install checkpoint index cache: {error}"))
}

// ── checkpoint metadata (fresh-agent-extras-router.ts:107-149) ──────────────

fn checkpoint_metadata_path(git_dir: &Path) -> PathBuf {
    git_dir.join("freshell-checkpoint-metadata.json")
}

/// `readCheckpointMetadata` (`fresh-agent-extras-router.ts:118-137`): a missing
/// file degrades to an empty map (first checkpoint ever taken for this cwd);
/// anything else that isn't a JSON object also degrades to empty (legacy:
/// `Array.isArray(parsed)` or non-object `parsed` -> `{}`). A file that exists
/// but fails to PARSE as JSON at all is a real error in legacy (only the ENOENT
/// case is swallowed) — mirrored here as `Err`, not silently degraded.
async fn read_checkpoint_metadata(git_dir: &Path) -> Result<Map<String, Value>, String> {
    let path = checkpoint_metadata_path(git_dir);
    match tokio::fs::read_to_string(&path).await {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Ok(Map::new()),
            Err(e) => Err(format!("invalid checkpoint metadata: {e}")),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(format!("failed to read checkpoint metadata: {e}")),
    }
}

/// `writeCheckpointMetadata` (`fresh-agent-extras-router.ts:139-149`): write to a
/// uniquely-named temp file, then atomically rename over the real path — a
/// concurrent checkpoint write for a different sha can never observe a
/// half-written file.
async fn write_checkpoint_metadata(
    git_dir: &Path,
    metadata: &Map<String, Value>,
) -> Result<(), String> {
    let path = checkpoint_metadata_path(git_dir);
    let tmp_name = format!(
        "freshell-checkpoint-metadata.json.tmp-{}",
        uuid::Uuid::new_v4()
    );
    let tmp_path = git_dir.join(tmp_name);
    let serialized = serde_json::to_string_pretty(&Value::Object(metadata.clone()))
        .map_err(|e| format!("failed to serialize checkpoint metadata: {e}"))?;
    tokio::fs::write(&tmp_path, format!("{serialized}\n"))
        .await
        .map_err(|e| format!("failed to write checkpoint metadata: {e}"))?;
    match tokio::fs::rename(&tmp_path, &path).await {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            Err(format!("failed to persist checkpoint metadata: {e}"))
        }
    }
}

/// `updateCheckpointMetadata` (`fresh-agent-extras-router.ts:151-172`), narrowed
/// to this port's one call site: merge a `requestId` into the (possibly absent)
/// existing entry for `sha` and persist. The full legacy function also resolves
/// short/ambiguous ids via `git rev-parse --verify` and merges a `turnId` field —
/// unneeded here since `create_checkpoint` always calls this with the exact,
/// just-created full sha (deferred alongside the `/checkpoints/metadata` route
/// that is this function's only OTHER caller in legacy).
async fn update_checkpoint_metadata(
    git_dir: &Path,
    sha: &str,
    request_id: &str,
) -> Result<(), String> {
    let mut metadata = read_checkpoint_metadata(git_dir).await?;
    let mut entry = metadata
        .get(sha)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    entry.insert("requestId".to_string(), json!(request_id));
    metadata.insert(sha.to_string(), Value::Object(entry));
    write_checkpoint_metadata(git_dir, &metadata).await
}

// ── list / restore / metadata routes (fresh-agent-extras-router.ts:114-232,370-428) ──

/// `CHECKPOINT_LIST_LIMIT` (`fresh-agent-extras-router.ts:72`): cap on the
/// number of commits `git log` returns for a listing.
const CHECKPOINT_LIST_LIMIT: u32 = 100;

/// `isValidCheckpointId` (`fresh-agent-extras-router.ts:114-116`):
/// `/^[0-9a-f]{7,40}$/i` — a short (7+) to full (40) hex commit id. Rejects
/// anything that couldn't possibly be a git object id before ever shelling
/// out to git.
fn is_valid_checkpoint_id(id: &str) -> bool {
    let len = id.chars().count();
    (7..=40).contains(&len) && id.chars().all(|c| c.is_ascii_hexdigit())
}

/// `listCheckpoints` (`fresh-agent-extras-router.ts:186-213`): read the shadow
/// repo's commit log (newest-first, `git log`'s default order — no explicit
/// sort needed) and decorate each entry with any persisted `requestId`/
/// `turnId` metadata. A cwd that has never been checkpointed (no shadow repo
/// yet) or whose shadow repo has zero commits both degrade to `[]`, not an
/// error — mirrors the two `try {} catch { return [] }` guards in legacy.
async fn list_checkpoints(home: &Path, cwd: &Path) -> Result<Vec<Value>, String> {
    let git_dir = checkpoint_git_dir(home, cwd);
    if tokio::fs::metadata(git_dir.join("HEAD")).await.is_err() {
        return Ok(Vec::new());
    }
    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let limit = CHECKPOINT_LIST_LIMIT.to_string();
    let raw = match run_git(
        &[
            &git_dir_arg,
            "log",
            "-n",
            &limit,
            "--pretty=format:%H%x09%ct%x09%s",
        ],
        None,
    )
    .await
    {
        Ok(raw) => raw,
        // Empty repo (no commits yet) — `git log` errors on a HEAD-less repo.
        Err(_) => return Ok(Vec::new()),
    };
    let metadata = read_checkpoint_metadata(&git_dir).await?;
    let mut entries = Vec::new();
    for line in raw.split('\n') {
        if line.is_empty() {
            continue;
        }
        // `[id, ts, ...rest] = line.split('\t'); label: rest.join('\t')` —
        // `splitn(3, ...)` reproduces this: the third piece is left intact
        // (re-joined) even if the subject itself contained tab characters.
        let mut parts = line.splitn(3, '\t');
        let id = parts.next().unwrap_or_default().to_string();
        let ts = parts
            .next()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let label = parts.next().unwrap_or_default().to_string();
        let mut entry = Map::new();
        entry.insert("id".to_string(), json!(id));
        entry.insert("ts".to_string(), json!(ts));
        entry.insert("label".to_string(), json!(label));
        if let Some(meta) = metadata.get(&id).and_then(Value::as_object) {
            if let Some(request_id) = meta.get("requestId") {
                entry.insert("requestId".to_string(), request_id.clone());
            }
            if let Some(turn_id) = meta.get("turnId") {
                entry.insert("turnId".to_string(), turn_id.clone());
            }
        }
        entries.push(Value::Object(entry));
    }
    Ok(entries)
}

/// Resolve a (possibly abbreviated) checkpoint id to the full 40-hex commit
/// sha via `git rev-parse --verify <id>^{commit}` — the resolution step
/// `updateCheckpointMetadata` performs (`fresh-agent-extras-router.ts:160`)
/// before it merges a metadata patch, so a short prefix from the client
/// always keys the persisted metadata file by full sha.
async fn resolve_checkpoint_commit(git_dir: &Path, id: &str) -> Result<String, String> {
    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let revision = format!("{id}^{{commit}}");
    let out = run_git(&[&git_dir_arg, "rev-parse", "--verify", &revision], None).await?;
    let resolved = out.trim().to_string();
    let ancestry = invoke_git(
        &[
            &git_dir_arg,
            "merge-base",
            "--is-ancestor",
            &resolved,
            "HEAD",
        ],
        None,
        None,
    )
    .await?;
    if ancestry.status.success() {
        return Ok(resolved);
    }
    if ancestry.status.code() == Some(1) {
        return Err("invalid checkpoint id: target is not published".to_string());
    }
    check_git_output(
        &[
            &git_dir_arg,
            "merge-base",
            "--is-ancestor",
            &resolved,
            "HEAD",
        ],
        ancestry,
    )?;
    unreachable!("failed merge-base command must return an error")
}

/// `updateCheckpointMetadata` (`fresh-agent-extras-router.ts:151-172`), full
/// version backing the `/checkpoints/metadata` route: validate the id's
/// *format*, resolve it to a full sha, merge whichever of `requestId`/
/// `turnId` the caller supplied into that sha's metadata entry, persist, then
/// re-read the entry back out of `list_checkpoints` (matching legacy's own
/// `listCheckpoints(cwd)` + `.find(...)` round-trip) so the response always
/// reflects the merged, persisted state rather than just the patch applied.
async fn apply_checkpoint_metadata_patch(
    home: &Path,
    cwd: &Path,
    id: &str,
    request_id: Option<&str>,
    turn_id: Option<&str>,
) -> Result<Value, String> {
    if !is_valid_checkpoint_id(id) {
        return Err("invalid checkpoint id".to_string());
    }
    let git_dir = ensure_checkpoint_repo(home, cwd).await?;
    let resolved_id = resolve_checkpoint_commit(&git_dir, id).await?;

    let mut metadata = read_checkpoint_metadata(&git_dir).await?;
    let mut entry = metadata
        .get(&resolved_id)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(request_id) = request_id {
        entry.insert("requestId".to_string(), json!(request_id));
    }
    if let Some(turn_id) = turn_id {
        entry.insert("turnId".to_string(), json!(turn_id));
    }
    metadata.insert(resolved_id.clone(), Value::Object(entry));
    write_checkpoint_metadata(&git_dir, &metadata).await?;

    let entries = list_checkpoints(home, cwd).await?;
    entries
        .into_iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(resolved_id.as_str()))
        .ok_or_else(|| "invalid checkpoint id".to_string())
}

/// `restoreCheckpoint` (`fresh-agent-extras-router.ts:215-221`): `git checkout
/// <id> -- .` in the shadow repo, using the real cwd as `--work-tree`. Git's
/// default *overlay* checkout semantics govern the observable behavior (see
/// the module doc comment): tracked paths that exist in the checkpoint's tree
/// are written back (recreating deleted files, reverting modified ones);
/// paths that exist in the working tree but NOT in the checkpoint's tree
/// (i.e. files created after the checkpoint) are left completely alone — this
/// is not a `git reset --hard` / `git clean`, so nothing is ever deleted.
async fn restore_checkpoint(home: &Path, cwd: &Path, id: &str) -> Result<(), String> {
    if !is_valid_checkpoint_id(id) {
        return Err("invalid checkpoint id".to_string());
    }
    let git_dir = ensure_checkpoint_repo(home, cwd).await?;
    let published_id = resolve_checkpoint_commit(&git_dir, id).await?;
    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let work_tree_arg = format!("--work-tree={}", cwd.display());
    run_git(
        &[
            &git_dir_arg,
            &work_tree_arg,
            "checkout",
            "-q",
            &published_id,
            "--",
            ".",
        ],
        Some(cwd),
    )
    .await?;
    Ok(())
}

// ── list / restore / metadata route handlers (fresh-agent-extras-router.ts:370-428) ──

/// `GET /checkpoints?cwd=` (`fresh-agent-extras-router.ts:370-380`). Note:
/// unlike the sibling POST routes in this file, legacy does NOT check that
/// `cwd` exists on disk here — a cwd that's never been checkpointed (or
/// doesn't exist at all) just yields an empty list, not a 400.
async fn get_checkpoints(
    State(state): State<CheckpointsApiState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let cwd = match params
        .get("cwd")
        .map(String::as_str)
        .filter(|s| !s.is_empty())
    {
        Some(cwd) => cwd.to_string(),
        None => return bad_request("cwd query parameter required"),
    };
    let explicit_intent = params
        .get("workspacePath")
        .map(String::as_str)
        .filter(|path| !path.is_empty())
        .map(|path| {
            json!({
                "path": path,
                "provenance": params.get("workspaceProvenance")
                    .map(String::as_str)
                    .unwrap_or("resolved-project"),
            })
        });
    let workspaces = if let Some(intent) = explicit_intent {
        match resolve_checkpoint_workspace(&state.home, Path::new(&cwd), Some(&intent)).await {
            Ok(workspace) => vec![workspace],
            Err(error) => return error.response(),
        }
    } else {
        // Modern panes resolve nested launch directories to the Git project
        // root. Old panes can still have an immutable checkpoint store keyed
        // by their exact launch cwd, so include that store only when it already
        // exists. An unselected non-Git directory or HOME therefore lists as
        // empty and can never become an implicit capture scope.
        let mut workspaces = Vec::new();
        if let Ok(workspace) =
            resolve_checkpoint_workspace(&state.home, Path::new(&cwd), None).await
        {
            workspaces.push(workspace);
        }

        let legacy_path = resolve_absolute(Path::new(&cwd));
        let candidate_for_home_check = tokio::fs::canonicalize(&legacy_path)
            .await
            .unwrap_or_else(|_| legacy_path.clone());
        if !is_recognized_account_home(
            &candidate_for_home_check,
            &recognized_account_homes(Some(&state.home)),
        ) {
            let already_present = workspaces
                .iter()
                .any(|workspace| workspace.path == legacy_path);
            if !already_present
                && tokio::fs::metadata(checkpoint_git_dir(&state.home, &legacy_path).join("HEAD"))
                    .await
                    .is_ok()
            {
                workspaces.push(ResolvedCheckpointWorkspace {
                    path: legacy_path,
                    provenance: "legacy-checkpoint".to_string(),
                });
            }
        }
        workspaces
    };

    let mut entries = Vec::new();
    for workspace in workspaces {
        match list_checkpoints(&state.home, &workspace.path).await {
            Ok(mut scoped_entries) => {
                for entry in &mut scoped_entries {
                    if let Some(fields) = entry.as_object_mut() {
                        fields.insert(
                            "workspace".to_string(),
                            workspace_response_value(&workspace),
                        );
                    }
                }
                entries.extend(scoped_entries);
            }
            Err(message) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": message })),
                )
                    .into_response();
            }
        }
    }
    entries.sort_by(|left, right| {
        right["ts"]
            .as_u64()
            .unwrap_or_default()
            .cmp(&left["ts"].as_u64().unwrap_or_default())
    });
    entries.truncate(CHECKPOINT_LIST_LIMIT as usize);
    Json(json!({ "checkpoints": entries })).into_response()
}

/// `POST /checkpoints/metadata` (`fresh-agent-extras-router.ts:382-408`).
async fn post_checkpoint_metadata(
    State(state): State<CheckpointsApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    let cwd = body.get("cwd").and_then(Value::as_str).unwrap_or("");
    let id = body.get("id").and_then(Value::as_str).unwrap_or("");
    let request_id = body
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let turn_id = body
        .get("turnId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if cwd.is_empty() || id.is_empty() {
        return bad_request("cwd and id are required");
    }
    if request_id.is_none() && turn_id.is_none() {
        return bad_request("requestId or turnId is required");
    }
    let cwd_path = Path::new(cwd);
    let workspace = if let Some(intent) = body.get("workspace") {
        match resolve_checkpoint_workspace(&state.home, cwd_path, Some(intent)).await {
            Ok(workspace) => workspace.path,
            Err(error) => return error.response(),
        }
    } else {
        if tokio::fs::metadata(cwd_path).await.is_err() {
            return bad_request(&format!("cwd does not exist: {cwd}"));
        }
        cwd_path.to_path_buf()
    };

    match apply_checkpoint_metadata_patch(&state.home, &workspace, id, request_id, turn_id).await {
        Ok(entry) => Json(entry).into_response(),
        Err(message) => {
            let status = if message.contains("invalid checkpoint id") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "error": message }))).into_response()
        }
    }
}

/// `POST /checkpoints/restore` (`fresh-agent-extras-router.ts:410-428`).
async fn post_checkpoint_restore(
    State(state): State<CheckpointsApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    let cwd = body.get("cwd").and_then(Value::as_str).unwrap_or("");
    let id = body.get("id").and_then(Value::as_str).unwrap_or("");
    if cwd.is_empty() || id.is_empty() {
        return bad_request("cwd and id are required");
    }
    let cwd_path = Path::new(cwd);
    let workspace = if let Some(intent) = body.get("workspace") {
        match resolve_checkpoint_workspace(&state.home, cwd_path, Some(intent)).await {
            Ok(workspace) => workspace.path,
            Err(error) => return error.response(),
        }
    } else {
        if tokio::fs::metadata(cwd_path).await.is_err() {
            return bad_request(&format!("cwd does not exist: {cwd}"));
        }
        cwd_path.to_path_buf()
    };

    match restore_checkpoint(&state.home, &workspace, id).await {
        Ok(()) => Json(json!({ "restored": true })).into_response(),
        Err(message) => {
            let status = if message.contains("invalid checkpoint id") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "error": message }))).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers_with_token(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", token.parse().unwrap());
        headers
    }

    fn state(home: &Path) -> CheckpointsApiState {
        CheckpointsApiState {
            auth_token: Arc::new("tok".to_string()),
            home: Arc::new(home.to_path_buf()),
        }
    }

    async fn body_json(resp: Response) -> Value {
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn is_full_sha(s: &str) -> bool {
        s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
    }

    // ── pure helper tests ────────────────────────────────────────────────

    #[test]
    fn checkpoint_git_dir_is_deterministic_and_scoped_under_home_freshell_checkpoints() {
        let home = PathBuf::from("/home/tester");
        let a = checkpoint_git_dir(&home, Path::new("/some/project"));
        let b = checkpoint_git_dir(&home, Path::new("/some/project"));
        assert_eq!(a, b, "same cwd must always hash to the same shadow repo");
        assert!(a.starts_with(home.join(".freshell").join("checkpoints")));
        assert!(a.extension().and_then(|e| e.to_str()) == Some("git"));
    }

    #[test]
    fn checkpoint_git_dir_differs_for_different_cwds() {
        let home = PathBuf::from("/home/tester");
        let a = checkpoint_git_dir(&home, Path::new("/project-a"));
        let b = checkpoint_git_dir(&home, Path::new("/project-b"));
        assert_ne!(a, b);
    }

    #[test]
    fn resolve_absolute_collapses_dot_and_dotdot_segments() {
        let resolved = resolve_absolute(Path::new("/a/b/../c/./d"));
        assert_eq!(resolved, PathBuf::from("/a/c/d"));
    }

    #[test]
    fn git_add_permission_failure_has_structured_path_and_cause() {
        let home = tempfile::tempdir().unwrap();
        let failure = CheckpointFailure::from_capture_detail(
            home.path(),
            Path::new("/workspace/project"),
            "Git operation add failed (exit_status=Some(128)): error: open(\"private-file\"): Permission denied\nerror: unable to index file 'private-file'\nfatal: adding files failed",
        );
        assert_eq!(failure.stage, "readability");
        assert_eq!(failure.operation, "add");
        assert_eq!(failure.code, "checkpoint_path_unreadable");
        assert_eq!(failure.path.as_deref(), Some("private-file"));
        assert_eq!(failure.filesystem_kind.as_deref(), Some("PermissionDenied"));
        assert_eq!(failure.git_exit_status, Some(128));
        assert!(failure.cause.contains("Permission denied"));
    }

    #[test]
    fn git_permission_failure_path_parser_rejects_unsafe_and_non_permission_paths() {
        assert_eq!(
            git_open_failure_path(
                "Git operation add failed (exit_status=128): fatal: open('../outside'): Permission denied"
            ),
            None
        );
        assert_eq!(
            git_open_failure_path(
                "Git operation add failed (exit_status=128): fatal: open(\"src/file.rs\"): No such file or directory"
            ),
            None
        );
    }

    #[tokio::test]
    async fn directory_ignore_probe_honors_workspace_gitignore_with_shadow_repo() {
        let work_tree = tempfile::tempdir().unwrap();
        let shadow_parent = tempfile::tempdir().unwrap();
        let git_dir = shadow_parent.path().join("shadow.git");
        tokio::fs::write(
            work_tree.path().join(".gitignore"),
            "private-dir.ignored/\n",
        )
        .await
        .unwrap();
        tokio::fs::create_dir(work_tree.path().join("private-dir.ignored"))
            .await
            .unwrap();
        run_git(
            &["init", "--bare", "--quiet", git_dir.to_str().unwrap()],
            None,
        )
        .await
        .unwrap();

        let ignored = ignored_git_directories(
            &git_dir,
            work_tree.path(),
            &[b"private-dir.ignored/".to_vec()],
        )
        .await
        .unwrap();
        assert!(ignored.contains(b"private-dir.ignored/".as_slice()));
    }

    // ── route-level tests ────────────────────────────────────────────────

    fn valid_body(cwd: &str) -> Value {
        json!({
            "cwd": cwd,
            "workspace": { "path": cwd, "provenance": "directory-picker" },
            "label": "fix the thing"
        })
    }

    #[tokio::test]
    async fn missing_auth_header_is_401() {
        let dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(dir.path())),
            HeaderMap::new(),
            Json(valid_body(dir.path().to_str().unwrap())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn wrong_auth_token_is_401() {
        let dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(dir.path())),
            headers_with_token("wrong"),
            Json(valid_body(dir.path().to_str().unwrap())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn missing_cwd_is_400() {
        let dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(dir.path())),
            headers_with_token("tok"),
            Json(json!({ "label": "no cwd here" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value["error"], json!("cwd is required"));
    }

    #[tokio::test]
    async fn nonexistent_cwd_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let missing = home_dir.path().join("does-not-exist");
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(missing.to_str().unwrap())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let value = body_json(resp).await;
        assert_eq!(value["code"], json!("workspace_unavailable"));
    }

    #[tokio::test]
    async fn valid_post_returns_200_with_id_ts_label() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert!(is_full_sha(value["id"].as_str().unwrap()));
        assert!(value["ts"].as_u64().unwrap() > 0);
        assert_eq!(value["label"], json!("fix the thing"));
        assert!(value.get("requestId").is_none());
    }

    #[tokio::test]
    async fn explicit_non_git_picker_scope_restores() {
        let home_dir = tempfile::tempdir().unwrap();
        let project_dir = tempfile::tempdir().unwrap();
        let source = project_dir.path().join("source.txt");
        tokio::fs::write(&source, "before").await.unwrap();
        let workspace = json!({
            "path": project_dir.path(),
            "provenance": "directory-picker",
        });

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": home_dir.path(),
                "workspace": workspace,
                "label": "before turn",
                "requestId": "scope-request",
            })),
        )
        .await;
        let status = response.status();
        let entry = body_json(response).await;
        assert_eq!(status, StatusCode::OK, "{entry}");
        assert_eq!(entry["workspace"]["path"], json!(project_dir.path()));
        assert_eq!(entry["workspace"]["provenance"], json!("directory-picker"));

        tokio::fs::write(&source, "after").await.unwrap();
        let listed = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Query(HashMap::from([
                (
                    "cwd".to_string(),
                    home_dir.path().to_string_lossy().into_owned(),
                ),
                (
                    "workspacePath".to_string(),
                    project_dir.path().to_string_lossy().into_owned(),
                ),
                (
                    "workspaceProvenance".to_string(),
                    "directory-picker".to_string(),
                ),
            ])),
        )
        .await;
        let listed = body_json(listed).await;
        assert_eq!(listed["checkpoints"][0]["id"], entry["id"]);

        let restored = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": home_dir.path(),
                "workspace": workspace,
                "id": entry["id"],
            })),
        )
        .await;
        assert_eq!(restored.status(), StatusCode::OK);
        assert_eq!(tokio::fs::read_to_string(source).await.unwrap(), "before");
    }

    #[tokio::test]
    async fn home_launch_without_workspace_does_not_publish_checkpoint() {
        let home_dir = tempfile::tempdir().unwrap();
        tokio::fs::write(home_dir.path().join("private.txt"), "private")
            .await
            .unwrap();

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": home_dir.path() })),
        )
        .await;

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let error = body_json(response).await;
        assert_eq!(error["code"], json!("workspace_unavailable"));
        assert_eq!(error["workspace"], json!(home_dir.path()));
        let checkpoints = home_dir.path().join(".freshell/checkpoints");
        assert!(!tokio::fs::try_exists(checkpoints).await.unwrap());
    }

    #[tokio::test]
    async fn picker_home_is_launch_only() {
        let home_dir = tempfile::tempdir().unwrap();
        tokio::fs::write(home_dir.path().join("private.txt"), "private")
            .await
            .unwrap();

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": home_dir.path(),
                "workspace": {
                    "path": home_dir.path(),
                    "provenance": "directory-picker",
                },
            })),
        )
        .await;

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let error = body_json(response).await;
        assert_eq!(error["code"], json!("workspace_unavailable"));
        assert!(
            !tokio::fs::try_exists(home_dir.path().join(".freshell/checkpoints"))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn resolved_project_scope_independent_of_routing_cwd() {
        let home_dir = tempfile::tempdir().unwrap();
        let project_dir = tempfile::tempdir().unwrap();
        let nested = project_dir.path().join("src/nested");
        tokio::fs::create_dir_all(&nested).await.unwrap();
        let source = project_dir.path().join("src/main.rs");
        tokio::fs::write(&source, "before").await.unwrap();
        run_git(&["init", "-q"], Some(project_dir.path()))
            .await
            .unwrap();

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": nested })),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let entry = body_json(response).await;
        assert_eq!(entry["workspace"]["path"], json!(project_dir.path()));
        assert_eq!(entry["workspace"]["provenance"], json!("resolved-project"));

        tokio::fs::write(&source, "after").await.unwrap();
        let restored = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": home_dir.path(),
                "workspace": entry["workspace"],
                "id": entry["id"],
            })),
        )
        .await;
        assert_eq!(restored.status(), StatusCode::OK);
        assert_eq!(tokio::fs::read_to_string(source).await.unwrap(), "before");
    }

    #[tokio::test]
    async fn nested_clone_non_git_scope_complete_restore() {
        let home_dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let nested = workspace.path().join("vendor/project");
        tokio::fs::create_dir_all(&nested).await.unwrap();
        run_git(&["init", "-q"], Some(&nested)).await.unwrap();

        let ignore_file = nested.join(".gitignore");
        let tracked = nested.join("tracked.txt");
        let tracked_ignored = nested.join("tracked-ignored.txt");
        let untracked = nested.join("untracked.txt");
        let ignored_untracked = nested.join("ignored-untracked.txt");
        tokio::fs::write(&ignore_file, "tracked-ignored.txt\nignored-untracked.txt\n")
            .await
            .unwrap();
        tokio::fs::write(&tracked, "tracked before").await.unwrap();
        tokio::fs::write(&tracked_ignored, "ignored but tracked before")
            .await
            .unwrap();
        run_git(&["add", ".gitignore", "tracked.txt"], Some(&nested))
            .await
            .unwrap();
        run_git(&["add", "-f", "tracked-ignored.txt"], Some(&nested))
            .await
            .unwrap();
        run_git(
            &[
                "-c",
                "user.name=Checkpoint Test",
                "-c",
                "user.email=checkpoint@example.invalid",
                "commit",
                "-m",
                "nested fixture",
            ],
            Some(&nested),
        )
        .await
        .unwrap();
        tokio::fs::write(&untracked, "untracked before")
            .await
            .unwrap();
        tokio::fs::write(&ignored_untracked, "ignored untracked before")
            .await
            .unwrap();

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": workspace.path(),
                "workspace": {
                    "path": workspace.path(),
                    "provenance": "directory-picker",
                },
                "label": "nested clone state",
            })),
        )
        .await;
        let status = response.status();
        let entry = body_json(response).await;
        assert_eq!(status, StatusCode::OK, "{entry}");
        let id = entry["id"].as_str().expect("checkpoint id").to_string();

        tokio::fs::write(&tracked, "tracked after").await.unwrap();
        tokio::fs::write(&tracked_ignored, "ignored but tracked after")
            .await
            .unwrap();
        tokio::fs::write(&untracked, "untracked after")
            .await
            .unwrap();
        tokio::fs::write(&ignored_untracked, "ignored untracked after")
            .await
            .unwrap();

        let restored = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": workspace.path(),
                "workspace": {
                    "path": workspace.path(),
                    "provenance": "directory-picker",
                },
                "id": id,
            })),
        )
        .await;
        assert_eq!(
            restored.status(),
            StatusCode::OK,
            "{}",
            body_json(restored).await
        );
        assert_eq!(
            tokio::fs::read_to_string(tracked).await.unwrap(),
            "tracked before"
        );
        assert_eq!(
            tokio::fs::read_to_string(tracked_ignored).await.unwrap(),
            "ignored but tracked before"
        );
        assert_eq!(
            tokio::fs::read_to_string(untracked).await.unwrap(),
            "untracked before"
        );
        assert_eq!(
            tokio::fs::read_to_string(ignored_untracked).await.unwrap(),
            "ignored untracked after",
            "ignored untracked files stay outside the existing Git code scope"
        );
    }

    #[tokio::test]
    async fn submodule_working_edits_complete_restore() {
        let home_dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let source_file = source.path().join("library.rs");
        tokio::fs::write(&source_file, "pub fn version() -> u8 { 1 }\n")
            .await
            .unwrap();
        run_git(&["init", "-q"], Some(source.path())).await.unwrap();
        run_git(&["add", "library.rs"], Some(source.path()))
            .await
            .unwrap();
        run_git(
            &[
                "-c",
                "user.name=Checkpoint Test",
                "-c",
                "user.email=checkpoint@example.invalid",
                "commit",
                "-m",
                "submodule source",
            ],
            Some(source.path()),
        )
        .await
        .unwrap();

        run_git(&["init", "-q"], Some(workspace.path()))
            .await
            .unwrap();
        run_git(
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                source.path().to_str().unwrap(),
                "modules/library",
            ],
            Some(workspace.path()),
        )
        .await
        .unwrap();
        let submodule = workspace.path().join("modules/library");
        let original_head = run_git(&["rev-parse", "HEAD"], Some(&submodule))
            .await
            .unwrap();
        let working_file = submodule.join("library.rs");
        tokio::fs::write(&working_file, "pub fn version() -> u8 { 2 }\n")
            .await
            .unwrap();

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": workspace.path() })),
        )
        .await;
        let status = response.status();
        let entry = body_json(response).await;
        assert_eq!(status, StatusCode::OK, "{entry}");
        let id = entry["id"].as_str().unwrap().to_string();

        tokio::fs::write(&working_file, "pub fn version() -> u8 { 3 }\n")
            .await
            .unwrap();
        let restore = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": workspace.path(),
                "workspace": entry["workspace"],
                "id": id,
            })),
        )
        .await;
        assert_eq!(restore.status(), StatusCode::OK);
        assert_eq!(
            tokio::fs::read_to_string(working_file).await.unwrap(),
            "pub fn version() -> u8 { 2 }\n"
        );
        assert_eq!(
            run_git(&["rev-parse", "HEAD"], Some(&submodule))
                .await
                .unwrap(),
            original_head,
            "checkpoint restore does not move the nested repository's identity"
        );
        let git_dir = checkpoint_git_dir(home_dir.path(), workspace.path());
        let git_dir_arg = format!("--git-dir={}", git_dir.display());
        let tree = run_git(&[&git_dir_arg, "ls-tree", &id, "modules/library"], None)
            .await
            .unwrap();
        assert!(
            tree.starts_with("040000 tree "),
            "nested contents must be blobs, not a gitlink: {tree}"
        );
    }

    #[tokio::test]
    async fn checkpoint_failed_metadata_publication_never_becomes_restore_target() {
        let home_dir = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let file = workspace.path().join("source.txt");
        tokio::fs::write(&file, "current contents").await.unwrap();
        let git_dir = ensure_checkpoint_repo(home_dir.path(), workspace.path())
            .await
            .unwrap();
        tokio::fs::create_dir(checkpoint_metadata_path(&git_dir))
            .await
            .unwrap();

        let response = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": workspace.path(),
                "workspace": {
                    "path": workspace.path(),
                    "provenance": "directory-picker",
                },
                "requestId": "metadata-write-failure",
            })),
        )
        .await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let git_dir_arg = format!("--git-dir={}", git_dir.display());
        let fsck = run_git(
            &[&git_dir_arg, "fsck", "--no-reflogs", "--unreachable"],
            None,
        )
        .await
        .unwrap();
        let orphan = fsck
            .lines()
            .find_map(|line| {
                line.strip_prefix("unreachable commit ")
                    .or_else(|| line.strip_prefix("dangling commit "))
            })
            .unwrap_or_else(|| {
                panic!("metadata failure should leave an unreachable commit object: {fsck}")
            })
            .to_string();
        let current_head = run_git(&[&git_dir_arg, "rev-parse", "--verify", "HEAD"], None).await;
        assert!(
            current_head.is_err(),
            "failed target must not advance the published ref"
        );

        let list = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Query(HashMap::from([
                (
                    "cwd".to_string(),
                    workspace.path().to_string_lossy().into_owned(),
                ),
                (
                    "workspacePath".to_string(),
                    workspace.path().to_string_lossy().into_owned(),
                ),
                (
                    "workspaceProvenance".to_string(),
                    "directory-picker".to_string(),
                ),
            ])),
        )
        .await;
        let entries = body_json(list).await;
        assert_eq!(entries["checkpoints"], json!([]));

        tokio::fs::write(&file, "still current").await.unwrap();
        let restore = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": workspace.path(),
                "workspace": {
                    "path": workspace.path(),
                    "provenance": "directory-picker",
                },
                "id": orphan,
            })),
        )
        .await;
        assert_eq!(restore.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            tokio::fs::read_to_string(file).await.unwrap(),
            "still current"
        );
    }

    #[tokio::test]
    async fn default_label_is_checkpoint_when_absent() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
            })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["label"], json!("checkpoint"));
    }

    #[tokio::test]
    async fn label_is_trimmed_and_truncated_to_120_chars() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let long_label = "x".repeat(200);
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
                "label": format!("  {long_label}  "),
            })),
        )
        .await
        .into_response();
        let value = body_json(resp).await;
        let label = value["label"].as_str().unwrap();
        assert_eq!(label.len(), 120);
        assert!(!label.starts_with(' '));
    }

    #[tokio::test]
    async fn request_id_is_included_in_response_and_persisted_to_metadata_file() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
                "label": "with request id",
                "requestId": "req-123",
            })),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["requestId"], json!("req-123"));
        let sha = value["id"].as_str().unwrap().to_string();

        let git_dir = checkpoint_git_dir(home_dir.path(), cwd_dir.path());
        let metadata_raw = tokio::fs::read_to_string(checkpoint_metadata_path(&git_dir))
            .await
            .expect("metadata file must be written when requestId is supplied");
        let metadata: Value = serde_json::from_str(&metadata_raw).unwrap();
        assert_eq!(metadata[&sha]["requestId"], json!("req-123"));
    }

    #[tokio::test]
    async fn repeated_checkpoints_for_same_cwd_produce_distinct_shas_and_reuse_shadow_repo() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();

        let resp1 = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let value1 = body_json(resp1).await;
        let sha1 = value1["id"].as_str().unwrap().to_string();

        let resp2 = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let value2 = body_json(resp2).await;
        let sha2 = value2["id"].as_str().unwrap().to_string();

        assert_ne!(sha1, sha2, "each checkpoint call must create a new commit");

        // Only ONE shadow repo dir should exist for this cwd across both calls.
        let checkpoints_root = home_dir.path().join(".freshell").join("checkpoints");
        let mut entries = tokio::fs::read_dir(&checkpoints_root).await.unwrap();
        let mut count = 0;
        while entries.next_entry().await.unwrap().is_some() {
            count += 1;
        }
        assert_eq!(
            count, 1,
            "one shadow repo per distinct cwd, reused across calls"
        );
    }

    #[tokio::test]
    async fn cwds_own_git_state_is_never_touched() {
        // A cwd that IS its own git repo must be left completely alone: the
        // shadow repo lives entirely under `home`, never inside `cwd/.git`.
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        run_git(&["init", "-q"], Some(cwd_dir.path()))
            .await
            .unwrap();

        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        assert_eq!(resp.status(), StatusCode::OK);

        // The cwd's own .git must be untouched (still exactly what `git init`
        // produced) — no new refs/objects created by the shadow-repo commit.
        let head = tokio::fs::read_to_string(cwd_dir.path().join(".git/HEAD"))
            .await
            .unwrap();
        assert!(head.starts_with("ref:"));
    }

    #[tokio::test]
    async fn route_is_wired_at_api_fresh_agent_checkpoints() {
        use tower::ServiceExt;

        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let app = router(state(home_dir.path()));
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/api/fresh-agent/checkpoints")
            .header("content-type", "application/json")
            .header("x-auth-token", "tok")
            .body(axum::body::Body::from(
                serde_json::to_vec(&valid_body(cwd_dir.path().to_str().unwrap())).unwrap(),
            ))
            .unwrap();
        let resp = app.oneshot(request).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    // ── is_valid_checkpoint_id ──────────────────────────────────────────

    #[test]
    fn checkpoint_id_format_accepts_7_to_40_hex_chars_case_insensitively() {
        assert!(is_valid_checkpoint_id("abc1234")); // 7 chars, minimum
        assert!(is_valid_checkpoint_id("ABC1234")); // uppercase hex ok
        assert!(is_valid_checkpoint_id(&"a".repeat(40))); // 40 chars, maximum
    }

    #[test]
    fn checkpoint_id_format_rejects_too_short_too_long_or_non_hex() {
        assert!(!is_valid_checkpoint_id("abc123")); // 6 chars, too short
        assert!(!is_valid_checkpoint_id(&"a".repeat(41))); // 41 chars, too long
        assert!(!is_valid_checkpoint_id("nothexch")); // contains non-hex chars
        assert!(!is_valid_checkpoint_id(""));
    }

    // ── GET /checkpoints (list) ─────────────────────────────────────────

    fn list_query(cwd: &str) -> Query<HashMap<String, String>> {
        Query(HashMap::from([("cwd".to_string(), cwd.to_string())]))
    }

    #[tokio::test]
    async fn list_missing_auth_is_401() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = get_checkpoints(
            State(state(home_dir.path())),
            HeaderMap::new(),
            list_query("/tmp"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn list_wrong_auth_token_is_401() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("wrong"),
            list_query("/tmp"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn list_missing_cwd_query_param_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Query(HashMap::new()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn list_returns_empty_checkpoints_for_a_cwd_with_no_checkpoints_yet() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            list_query(cwd_dir.path().to_str().unwrap()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["checkpoints"], json!([]));
    }

    #[tokio::test]
    async fn list_does_not_require_cwd_to_exist_on_disk() {
        // Legacy GET /checkpoints has no fsp.access(cwd) guard (unlike POST
        // /checkpoints, /diff, /exec) -- fresh-agent-extras-router.ts:370-380.
        let home_dir = tempfile::tempdir().unwrap();
        let missing = home_dir.path().join("does-not-exist-anywhere");
        let resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            list_query(missing.to_str().unwrap()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["checkpoints"], json!([]));
    }

    #[tokio::test]
    async fn list_returns_checkpoints_newest_first_with_id_ts_label() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();

        let resp1 = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
                "label": "first"
            })),
        )
        .await
        .into_response();
        let id1 = body_json(resp1).await["id"].as_str().unwrap().to_string();

        let resp2 = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
                "label": "second"
            })),
        )
        .await
        .into_response();
        let id2 = body_json(resp2).await["id"].as_str().unwrap().to_string();
        assert_ne!(id1, id2);

        let resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            list_query(cwd_dir.path().to_str().unwrap()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        let checkpoints = value["checkpoints"].as_array().unwrap();
        assert_eq!(checkpoints.len(), 2);
        assert_eq!(checkpoints[0]["id"], json!(id2), "newest checkpoint first");
        assert_eq!(checkpoints[0]["label"], json!("second"));
        assert_eq!(checkpoints[1]["id"], json!(id1));
        assert_eq!(checkpoints[1]["label"], json!("first"));
        assert!(checkpoints[0]["ts"].as_u64().unwrap() > 0);
    }

    #[tokio::test]
    async fn list_includes_persisted_request_id_metadata() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
                "label": "with metadata",
                "requestId": "req-1",
            })),
        )
        .await
        .into_response();
        let id = body_json(resp).await["id"].as_str().unwrap().to_string();

        let resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            list_query(cwd_dir.path().to_str().unwrap()),
        )
        .await;
        let value = body_json(resp).await;
        let checkpoints = value["checkpoints"].as_array().unwrap();
        assert_eq!(checkpoints.len(), 1);
        assert_eq!(checkpoints[0]["id"], json!(id));
        assert_eq!(checkpoints[0]["requestId"], json!("req-1"));
    }

    // ── POST /checkpoints/metadata ──────────────────────────────────────

    #[tokio::test]
    async fn metadata_missing_auth_is_401() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            HeaderMap::new(),
            Json(json!({ "cwd": "/tmp", "id": "abc1234", "turnId": "t1" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn metadata_missing_cwd_or_id_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "turnId": "t1" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value["error"], json!("cwd and id are required"));
    }

    #[tokio::test]
    async fn metadata_missing_request_id_and_turn_id_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": "abc1234" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value["error"], json!("requestId or turnId is required"));
    }

    #[tokio::test]
    async fn metadata_nonexistent_cwd_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let missing = home_dir.path().join("does-not-exist");
        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": missing.to_str().unwrap(), "id": "abc1234", "turnId": "t1" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert!(
            value["error"]
                .as_str()
                .unwrap()
                .starts_with("cwd does not exist:")
        );
    }

    #[tokio::test]
    async fn metadata_invalid_checkpoint_id_format_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "id": "nothex!!", // fails the hex-chars format check
                "turnId": "t1",
            })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value["error"], json!("invalid checkpoint id"));
    }

    #[tokio::test]
    async fn metadata_well_formed_but_nonexistent_commit_id_is_500() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        // Create the shadow repo (with at least one commit) so rev-parse has
        // a repo to search, but reference a sha that was never committed.
        post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await;
        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "id": "0000000000000000000000000000000000000f",
                "turnId": "t1",
            })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn metadata_round_trip_persists_request_id_and_turn_id_and_returns_merged_entry() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let id = body_json(resp).await["id"].as_str().unwrap().to_string();

        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "id": id,
                "requestId": "req-9",
                "turnId": "turn-9",
            })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["id"], json!(id));
        assert_eq!(value["requestId"], json!("req-9"));
        assert_eq!(value["turnId"], json!("turn-9"));

        // The patch must be visible via the list route too (same persisted file).
        let list_resp = get_checkpoints(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            list_query(cwd_dir.path().to_str().unwrap()),
        )
        .await;
        let list_value = body_json(list_resp).await;
        let checkpoints = list_value["checkpoints"].as_array().unwrap();
        assert_eq!(checkpoints[0]["turnId"], json!("turn-9"));
    }

    #[tokio::test]
    async fn metadata_short_sha_prefix_resolves_to_full_sha_entry() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let full_id = body_json(resp).await["id"].as_str().unwrap().to_string();
        let short_id = &full_id[..8];

        let resp = post_checkpoint_metadata(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "id": short_id,
                "turnId": "turn-short",
            })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(
            value["id"],
            json!(full_id),
            "response id must be the resolved full sha, not the short prefix"
        );
    }

    // ── POST /checkpoints/restore ────────────────────────────────────────

    #[tokio::test]
    async fn restore_missing_auth_is_401() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            HeaderMap::new(),
            Json(json!({ "cwd": "/tmp", "id": "abc1234" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn restore_missing_cwd_or_id_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": "/tmp" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value["error"], json!("cwd and id are required"));
    }

    #[tokio::test]
    async fn restore_nonexistent_cwd_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let missing = home_dir.path().join("does-not-exist");
        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": missing.to_str().unwrap(), "id": "abc1234" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn restore_invalid_checkpoint_id_format_is_400() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": "nothex!!" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value["error"], json!("invalid checkpoint id"));
    }

    #[tokio::test]
    async fn restore_well_formed_but_nonexistent_commit_id_is_500() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({
                "cwd": cwd_dir.path().to_str().unwrap(),
                "id": "0000000000000000000000000000000000000f",
            })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn restore_reverts_a_tracked_file_mutation() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let file_path = cwd_dir.path().join("file.txt");
        tokio::fs::write(&file_path, "original").await.unwrap();

        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let id = body_json(resp).await["id"].as_str().unwrap().to_string();

        tokio::fs::write(&file_path, "modified after checkpoint")
            .await
            .unwrap();

        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": id })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["restored"], json!(true));

        let content = tokio::fs::read_to_string(&file_path).await.unwrap();
        assert_eq!(content, "original");
    }

    #[tokio::test]
    async fn restore_leaves_files_created_after_the_checkpoint_in_place() {
        // Pinning legacy's documented v1 semantics (fresh-agent-extras-router.ts:67-68,
        // and the client's own confirm-dialog copy in FreshAgentView.tsx:1719):
        // "Files created since are left in place." Restore uses overlay-mode
        // `git checkout <id> -- .`, which never deletes paths absent from the
        // checkpoint's tree.
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let tracked_path = cwd_dir.path().join("tracked.txt");
        tokio::fs::write(&tracked_path, "original").await.unwrap();

        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let id = body_json(resp).await["id"].as_str().unwrap().to_string();

        let new_path = cwd_dir.path().join("created-after.txt");
        tokio::fs::write(&new_path, "new stuff").await.unwrap();
        tokio::fs::write(&tracked_path, "modified").await.unwrap();

        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": id })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        assert_eq!(
            tokio::fs::read_to_string(&tracked_path).await.unwrap(),
            "original",
            "tracked file changed since the checkpoint must be reverted"
        );
        assert_eq!(
            tokio::fs::read_to_string(&new_path).await.unwrap(),
            "new stuff",
            "a file created after the checkpoint must be left in place, not deleted"
        );
    }

    #[tokio::test]
    async fn restore_recreates_a_tracked_file_deleted_after_the_checkpoint() {
        // Overlay-mode `git checkout <id> -- .` restores any path present in
        // the checkpoint's tree, including one that was deleted from the
        // working tree afterward -- pinning this less-obvious corner of the
        // "restore" contract (not merely "revert modifications").
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let file_path = cwd_dir.path().join("file.txt");
        tokio::fs::write(&file_path, "original").await.unwrap();

        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let id = body_json(resp).await["id"].as_str().unwrap().to_string();

        tokio::fs::remove_file(&file_path).await.unwrap();
        assert!(tokio::fs::metadata(&file_path).await.is_err());

        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": id })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let content = tokio::fs::read_to_string(&file_path).await.unwrap();
        assert_eq!(content, "original");
    }

    #[tokio::test]
    async fn restore_never_touches_cwds_own_git_state() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        run_git(&["init", "-q"], Some(cwd_dir.path()))
            .await
            .unwrap();
        let file_path = cwd_dir.path().join("file.txt");
        tokio::fs::write(&file_path, "original").await.unwrap();

        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(valid_body(cwd_dir.path().to_str().unwrap())),
        )
        .await
        .into_response();
        let id = body_json(resp).await["id"].as_str().unwrap().to_string();

        tokio::fs::write(&file_path, "modified").await.unwrap();
        let resp = post_checkpoint_restore(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": id })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // The cwd's own .git must remain exactly what `git init` produced --
        // no HEAD/index mutation from the shadow-repo restore.
        let head = tokio::fs::read_to_string(cwd_dir.path().join(".git/HEAD"))
            .await
            .unwrap();
        assert!(head.starts_with("ref:"));
    }

    // ── outer end-to-end test: real HTTP routes, create -> list -> mutate -> restore ──

    #[tokio::test]
    async fn end_to_end_rewind_actually_rewinds_via_real_http_routes() {
        use tower::ServiceExt;

        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let file_path = cwd_dir.path().join("code.rs");
        tokio::fs::write(&file_path, "fn original() {}")
            .await
            .unwrap();

        async fn send(app: &Router, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
            let request = axum::http::Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .header("x-auth-token", "tok")
                .body(axum::body::Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap();
            let resp = app.clone().oneshot(request).await.unwrap();
            let status = resp.status();
            let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap();
            let value: Value = if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes).unwrap()
            };
            (status, value)
        }

        let app = router(state(home_dir.path()));

        // 1. create
        let (status, body) = send(
            &app,
            "POST",
            "/api/fresh-agent/checkpoints",
            json!({
                "cwd": cwd_dir.path(),
                "workspace": { "path": cwd_dir.path(), "provenance": "directory-picker" },
                "label": "before the fix"
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let checkpoint_id = body["id"].as_str().unwrap().to_string();

        // 2. list -- the checkpoint we just created must appear.
        let (status, body) = send(
            &app,
            "GET",
            &format!(
                "/api/fresh-agent/checkpoints?cwd={}",
                cwd_dir.path().to_str().unwrap()
            ),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let checkpoints = body["checkpoints"].as_array().unwrap();
        assert_eq!(checkpoints.len(), 1);
        assert_eq!(checkpoints[0]["id"], json!(checkpoint_id));

        // 3. mutate the working tree (simulating an agent turn editing code).
        tokio::fs::write(&file_path, "fn broken() { panic!() }")
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(&file_path).await.unwrap(),
            "fn broken() { panic!() }"
        );

        // 4. restore -- the whole point of "rewind code to here".
        let (status, body) = send(
            &app,
            "POST",
            "/api/fresh-agent/checkpoints/restore",
            json!({ "cwd": cwd_dir.path().to_str().unwrap(), "id": checkpoint_id }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["restored"], json!(true));

        // 5. verify: the file bytes are back to their checkpointed state.
        let restored_content = tokio::fs::read_to_string(&file_path).await.unwrap();
        assert_eq!(
            restored_content, "fn original() {}",
            "rewind must actually rewind the file to its checkpointed contents"
        );
    }
}
