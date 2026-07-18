//! `POST /api/fresh-agent/checkpoints` — a faithful (create-only) port of
//! `server/fresh-agent-extras-router.ts:346-368` (`createCheckpoint`,
//! `ensureCheckpointRepo`, `checkpointGitDir`, `updateCheckpointMetadata`).
//!
//! ## What this is
//!
//! The SPA fires this on every fresh-agent send (`src/components/fresh-agent/
//! FreshAgentView.tsx:1583` `sendUserText`'s fire-and-forget pre-turn snapshot) so
//! "rewind code to here" can later restore the working tree to its state just
//! before a given user turn. Snapshots live in a **shadow bare git repository**
//! under `<home>/.freshell/checkpoints/<sha1-of-abs-cwd>.git` — the session cwd's
//! own git state (if any) is never touched; the shadow repo uses the cwd only as
//! `--work-tree`, so the cwd's own `.gitignore` still applies (`node_modules` and
//! friends never enter a snapshot) and a cwd that isn't itself a git repo works
//! identically (there is no "non-git cwd" degraded path in the legacy behavior —
//! `--work-tree` doesn't require the work tree to be a repo of its own).
//!
//! ## Scope (deliberately narrow — see the task's port-minimally guidance)
//!
//! Only `POST /checkpoints` (create) is ported here — the route that is 404ing
//! today and hit on every send. The sibling routes (`GET /checkpoints` list,
//! `POST /checkpoints/restore`, `POST /checkpoints/metadata`) back the "rewind
//! code to here" UI action, which is a SEPARATE, much rarer user gesture (not
//! fired on every send) — deferred to a follow-up port. The client's fire-and-
//! forget call site (`FreshAgentView.tsx:1596` `.catch(() => {})`) swallows any
//! error from this route entirely, so a partial rewind feature (no way to list or
//! restore checkpoints yet) causes no visible client error either way; it just
//! means "rewind to here" isn't wired up yet, which is already true today (404).
//!
//! ## Response shape (must match what the SPA reads)
//!
//! `src/components/fresh-agent/FreshAgentView.tsx:1583` does
//! `api.post<CheckpointEntry>('/api/fresh-agent/checkpoints', {...}).then((entry) =>
//! { if (entry?.id) {...} })` — a plain untyped-at-runtime cast (no zod parse for
//! this endpoint; confirmed by grep of `src/lib/api.ts` and
//! `src/lib/fresh-agent-checkpoints.ts` — only `.id` is read). The exact legacy
//! shape (`fresh-agent-extras-router.ts:183`) is
//! `{ id: string, ts: number, label: string, requestId?: string }` — `id` is the
//! full 40-hex commit sha, `ts` is Unix seconds, `requestId` is present iff the
//! caller supplied one (JS object spread of `metadata` drops absent keys, not
//! serializes `null`/`undefined`).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use std::collections::HashMap;

use axum::routing::get as get_method;
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
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
    if tokio::fs::metadata(cwd_path).await.is_err() {
        return bad_request(&format!("cwd does not exist: {cwd}"));
    }

    match create_checkpoint(&state.home, cwd_path, &label, request_id.as_deref()).await {
        Ok(entry) => Json(entry).into_response(),
        Err(message) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": message })),
        )
            .into_response(),
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

    run_git(&[&git_dir_arg, &work_tree_arg, "add", "-A"], Some(cwd)).await?;

    let mut commit_args: Vec<&str> = vec![&git_dir_arg, &work_tree_arg];
    commit_args.extend(CHECKPOINT_IDENTITY);
    commit_args.extend(["commit", "--allow-empty", "-q", "-m", label]);
    run_git(&commit_args, Some(cwd)).await?;

    let sha = run_git(&[&git_dir_arg, "rev-parse", "HEAD"], None)
        .await?
        .trim()
        .to_string();

    if let Some(request_id) = request_id {
        update_checkpoint_metadata(&git_dir, &sha, request_id).await?;
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
    if tokio::fs::metadata(git_dir.join("HEAD")).await.is_err() {
        tokio::fs::create_dir_all(&git_dir)
            .await
            .map_err(|e| format!("failed to create checkpoint dir: {e}"))?;
        run_git(&["init", "--bare", "-q", &git_dir.to_string_lossy()], None).await?;
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

/// `runGit` (`fresh-agent-extras-router.ts:80-94`): spawn the real `git` binary,
/// reject on non-zero exit with a legacy-shaped error message (`git <args[0]>
/// failed: <stderr>`) — legacy's `args[0]` is often a leading global flag (e.g.
/// `--git-dir=...`) rather than the subcommand name, since the identity/`--git-
/// dir`/`--work-tree` flags precede the subcommand on this router's git
/// invocations; mirrored verbatim rather than "fixed" since this message is
/// never read by the client (the one call site `.catch(() => {})`s every error).
async fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let first_arg = args.first().copied().unwrap_or("");
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("git {first_arg} failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = if stderr.trim().is_empty() {
            format!("git {first_arg} failed: exit status {}", output.status)
        } else {
            format!("git {first_arg} failed: {}", stderr.trim())
        };
        return Err(message);
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
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
    Ok(out.trim().to_string())
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
    let git_dir_arg = format!("--git-dir={}", git_dir.display());
    let work_tree_arg = format!("--work-tree={}", cwd.display());
    run_git(
        &[
            &git_dir_arg,
            &work_tree_arg,
            "checkout",
            "-q",
            id,
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
    match list_checkpoints(&state.home, Path::new(&cwd)).await {
        Ok(entries) => Json(json!({ "checkpoints": entries })).into_response(),
        Err(message) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": message })),
        )
            .into_response(),
    }
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
    if tokio::fs::metadata(cwd).await.is_err() {
        return bad_request(&format!("cwd does not exist: {cwd}"));
    }

    match apply_checkpoint_metadata_patch(&state.home, Path::new(cwd), id, request_id, turn_id)
        .await
    {
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
    if tokio::fs::metadata(cwd).await.is_err() {
        return bad_request(&format!("cwd does not exist: {cwd}"));
    }

    match restore_checkpoint(&state.home, Path::new(cwd), id).await {
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

    // ── route-level tests ────────────────────────────────────────────────

    fn valid_body(cwd: &str) -> Value {
        json!({ "cwd": cwd, "label": "fix the thing" })
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
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert!(value["error"]
            .as_str()
            .unwrap()
            .starts_with("cwd does not exist:"));
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
    async fn default_label_is_checkpoint_when_absent() {
        let home_dir = tempfile::tempdir().unwrap();
        let cwd_dir = tempfile::tempdir().unwrap();
        let resp = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap() })),
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
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "label": "first" })),
        )
        .await
        .into_response();
        let id1 = body_json(resp1).await["id"].as_str().unwrap().to_string();

        let resp2 = post_checkpoint(
            State(state(home_dir.path())),
            headers_with_token("tok"),
            Json(json!({ "cwd": cwd_dir.path().to_str().unwrap(), "label": "second" })),
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
        assert!(value["error"]
            .as_str()
            .unwrap()
            .starts_with("cwd does not exist:"));
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
            json!({ "cwd": cwd_dir.path().to_str().unwrap(), "label": "before the fix" }),
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
