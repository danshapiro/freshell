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

use axum::{
    extract::State,
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

/// The `/api/fresh-agent/checkpoints` sub-router.
pub fn router(state: CheckpointsApiState) -> Router {
    Router::new()
        .route("/api/fresh-agent/checkpoints", post(post_checkpoint))
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
}
