//! `GET /api/fresh-agent/diff` — a faithful port of the legacy Node route at
//! `server/fresh-agent-extras-router.ts:304-321` plus its `runGitDiff` helper
//! (`fresh-agent-extras-router.ts:48-60`). Closes the `/diff` half of parity
//! checklist item **AGENT-13**
//! (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:353`) per
//! Task 1 of the port plan `docs/plans/2026-09-06-ekc6.md`. The sibling
//! `POST /api/fresh-agent/exec` route lands separately as that plan's Task 2
//! and deliberately reuses the `run_bounded` subprocess helper introduced
//! here — this task adds ONLY the diff route.
//!
//! ## What this is
//!
//! The SPA's `FreshAgentDiffPanel` (`src/components/fresh-agent/
//! FreshAgentDiffPanel.tsx`) fetches this route when the user expands a
//! "Files changed" row in a fresh-agent transcript: it returns the
//! working-tree `git diff` for the session cwd (optionally limited to a
//! single path) so the row renders the actual patch. Against the Rust server
//! this 404'd, leaving the panel perpetually loading; the port restores real
//! diffs (and the panel's already-implemented inline error rendering).
//!
//! ## Response shape (Node oracle — replicated exactly)
//!
//! - Auth failure → 401 via `crate::boot::unauthorized()`.
//! - `cwd` query param missing/empty →
//!   `400 {"error":"cwd query parameter required"}`.
//! - `cwd` not existing on disk (existence-only check — Node uses
//!   `fsp.access`, so a regular FILE passes this gate and fails later inside
//!   git; never require a directory) →
//!   `400 {"error":"cwd does not exist: <cwd verbatim as passed>"}`.
//! - Otherwise spawn `git diff --no-color [-- <path>]` in `cwd` with a 15s
//!   timeout and a 512KB retained-stdout cap:
//!   - git errored (nonzero exit, signal, OR timeout) AND captured stdout is
//!     empty → `500 {"error":"git diff failed: Command failed: git diff
//!     --no-color[ -- <path>]\n<stderr verbatim>"}` — the port SYNTHESIZES
//!     Node's execFile error-message wrapper (`Command failed: <joined
//!     commandline>` followed by `\n<stderr>` only when stderr is non-empty)
//!     and embeds live git stderr unmodified, exactly like Node.
//!   - Otherwise (clean exit, OR errored-with-nonempty-stdout — Node's
//!     `error && !stdout` rule at `fresh-agent-extras-router.ts:53-58`) →
//!     `200 {"diff":"<stdout, lossy-decoded utf8, trailing newlines
//!     preserved>"}`; a clean repo yields exactly `{"diff":""}`.
//! - Spawn failure (git missing from PATH) →
//!   `500 {"error":"git diff failed: spawn git <io error text>"}` (divergence
//!   6: the suffix text is runtime-specific on both servers; prefix pinned).
//!
//! ## `run_bounded` — shared bounded-subprocess helper (built here; Task 2 reuses)
//!
//! Spawns `program` via `tokio::process::Command` with piped stdout/stderr,
//! drains BOTH pipes to EOF concurrently with `wait()` (so a verbose child
//! cannot deadlock on a full pipe buffer), retains at most `per_pipe_cap`
//! bytes of each pipe (drain-and-cap: the child is NEVER killed on overflow,
//! it runs to completion), and wraps `wait()` in `timeout`: on expiry the
//! child is killed + reaped and the result is `exit_code: None,
//! timed_out: true`. Lossy UTF-8 decoding happens at the route layer, not
//! here, so the helper stays byte-oriented for both routes.
//!
//! ## Documented port divergences (planner-owned —
//!   `docs/plans/2026-09-06-ekc6.md` "Documented port divergences"; oracle
//!   bytes in the Darkforge log `reports/load-bearing-validator-A.md`)
//!
//! - **#3 duplicate `cwd` query key** (`?cwd=/a&cwd=/b`): Node coerces the
//!   array to missing → 400 `cwd query parameter required`; axum rejects the
//!   serde_urlencoded parse with its own 400 text. Edge no good-faith client
//!   produces; recorded, not replicated.
//! - **#5 500 error suffix** after the pinned prefix embeds live git stderr
//!   (a git-version-specific usage page) — identical mechanism to Node; the
//!   tests pin the exact prefix and the version-portable fragment
//!   `ot a git repository`, never the full body.
//! - **#7 non-UTF-8 subprocess output** is lossy-decoded (U+FFFD) — Node
//!   coerces via Buffer→string with the same replacement behavior.
//! - **#8 maxBuffer kill**: Node kills the child mid-stream on overflow; this
//!   port drains-and-caps (the child's wall-clock lifetime is longer; no
//!   response-shape difference for `/diff`, whose truncation point is never
//!   reported in the body).
//! - Divergences 1, 2, 4, and 9 concern only the `/exec` route and are
//!   documented with it in Task 2.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use tokio::process::Command;

use crate::boot::{is_authed, unauthorized};

/// `DIFF_MAX_BYTES` (`fresh-agent-extras-router.ts:13`): retained-stdout cap
/// for `git diff`.
const DIFF_MAX_BYTES: usize = 512 * 1024;

/// `runGitDiff`'s `timeout: 15_000` (`fresh-agent-extras-router.ts:52`).
const DIFF_TIMEOUT: Duration = Duration::from_secs(15);

/// Shared state for the `/api/fresh-agent/*` extras routes.
#[derive(Clone)]
pub struct FreshAgentExtrasApiState {
    pub auth_token: Arc<String>,
    /// Boot-resolved home directory. The `/diff` handler ignores it; Task 2's
    /// `/exec` handler uses it as the default cwd (documented divergence 4 —
    /// FRESHELL_HOME-aware boot home, vs Node's raw `os.homedir()`), matching
    /// how every other Rust state object resolves home.
    #[allow(dead_code)] // consumed by Task 2's exec route
    pub home: Arc<PathBuf>,
}

/// The `/api/fresh-agent` extras sub-router (this task: `/diff` only).
pub fn router(state: FreshAgentExtrasApiState) -> Router {
    Router::new()
        .route("/api/fresh-agent/diff", get(get_diff))
        .with_state(state)
}

/// Query parameters for `GET /api/fresh-agent/diff`. A struct (not a
/// `HashMap`) so a duplicated `cwd` key fails the serde_urlencoded parse with
/// axum's own 400 — the recorded behavior of documented divergence 3.
#[derive(Debug, Deserialize)]
struct DiffQuery {
    cwd: Option<String>,
    path: Option<String>,
}

async fn get_diff(
    State(state): State<FreshAgentExtrasApiState>,
    headers: HeaderMap,
    Query(params): Query<DiffQuery>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    let cwd = match params.cwd.as_deref().filter(|s| !s.is_empty()) {
        Some(cwd) => cwd.to_string(),
        None => return bad_request("cwd query parameter required"),
    };
    let path = params.path.as_deref().filter(|s| !s.is_empty());

    // Existence-only (Node `fsp.access`; `fresh-agent-extras-router.ts:310-314`)
    // — a regular file passes this gate and fails later inside git.
    if tokio::fs::metadata(&cwd).await.is_err() {
        return bad_request(&format!("cwd does not exist: {cwd}"));
    }

    let mut args: Vec<&str> = vec!["diff", "--no-color"];
    if let Some(path) = path {
        args.push("--");
        args.push(path);
    }
    // Node's execFile error message opens with `Command failed: <file> <args
    // joined by " ">` (fresh-agent-extras-router.ts:52, surfaced via the pin
    // at validator-A case 4); the joined commandline is synthesized the same
    // way here.
    let command_line = format!("git {}", args.join(" "));

    let output = match run_bounded("git", &args, &cwd, DIFF_TIMEOUT, DIFF_MAX_BYTES).await {
        Ok(output) => output,
        Err(spawn_error) => {
            return internal_error(&format!("git diff failed: spawn git {spawn_error}"));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    // Node's rule (`fresh-agent-extras-router.ts:53-58`): a git error only
    // rejects when stdout is empty; nonzero-exit-WITH-stdout resolves 200
    // with the partial stdout.
    let errored = output.timed_out || output.exit_code != Some(0);
    if errored && stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let wrapper = if stderr.is_empty() {
            format!("Command failed: {command_line}")
        } else {
            format!("Command failed: {command_line}\n{stderr}")
        };
        return internal_error(&format!("git diff failed: {wrapper}"));
    }

    Json(json!({ "diff": stdout })).into_response()
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

fn internal_error(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": message })),
    )
        .into_response()
}

// ── bounded subprocess helper (shared with Task 2's /exec) ─────────────────

/// Retained bytes and outcome of one `run_bounded` subprocess run.
struct BoundedOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    /// `None` when the child was killed (timeout) or reaped by signal —
    /// mirrors Node's `error.code` being non-numeric in those cases.
    exit_code: Option<i32>,
    timed_out: bool,
}

/// See the module doc comment ("`run_bounded` — shared bounded-subprocess
/// helper") for the contract. Spawn errors surface as `Err`; every other
/// outcome (including nonzero exit and timeout-kill) is `Ok`.
async fn run_bounded(
    program: &str,
    args: &[&str],
    cwd: &str,
    timeout: Duration,
    per_pipe_cap: usize,
) -> std::io::Result<BoundedOutput> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let mut child_stdout = child.stdout.take().expect("stdout was piped");
    let mut child_stderr = child.stderr.take().expect("stderr was piped");

    // Drain both pipes to EOF concurrently with the bounded wait so a child
    // that fills a pipe buffer neither deadlocks the parent nor is killed on
    // overflow (drain-and-cap; divergence 8).
    let (stdout, stderr, (exit_code, timed_out)) = tokio::join!(
        read_capped(&mut child_stdout, per_pipe_cap),
        read_capped(&mut child_stderr, per_pipe_cap),
        async move {
            match tokio::time::timeout(timeout, child.wait()).await {
                Ok(status) => (status.ok().and_then(|s| s.code()), false),
                Err(_) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    (None, true)
                }
            }
        },
    );

    Ok(BoundedOutput {
        stdout: stdout?,
        stderr: stderr?,
        exit_code,
        timed_out,
    })
}

/// Reads `reader` to EOF, retaining at most `cap` bytes (drain-and-cap:
/// overflow bytes are consumed and discarded, never a reason to kill).
async fn read_capped<R>(reader: &mut R, cap: usize) -> std::io::Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    let mut kept = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            return Ok(kept);
        }
        let remaining = cap.saturating_sub(kept.len());
        if remaining > 0 {
            kept.extend_from_slice(&buf[..n.min(remaining)]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::Path;

    const TOKEN: &str = "tok";

    fn headers_with_token(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", token.parse().unwrap());
        headers
    }

    fn state(dir: &Path) -> FreshAgentExtrasApiState {
        FreshAgentExtrasApiState {
            auth_token: Arc::new(TOKEN.to_string()),
            home: Arc::new(dir.to_path_buf()),
        }
    }

    async fn body_json(resp: Response) -> Value {
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn query(cwd: Option<&str>, path: Option<&str>) -> Query<DiffQuery> {
        Query(DiffQuery {
            cwd: cwd.map(str::to_string),
            path: path.map(str::to_string),
        })
    }

    async fn call_diff(dir: &Path, headers: HeaderMap, params: Query<DiffQuery>) -> Response {
        get_diff(State(state(dir)), headers, params).await
    }

    /// Runs `git <args>` in `dir`, asserting success. Synchronous fixture
    /// setup only (std::process, per the task brief); never touches $HOME.
    fn git(dir: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("spawn git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Creates a git repo at `dir`, commits every (name, content) pair in
    /// `committed` as the initial commit, then rewrites every pair in `dirty`
    /// so the working tree differs from HEAD. The commit identity always
    /// comes from `-c` flags — never from ~/.gitconfig (hermetic).
    fn init_repo(dir: &Path, committed: &[(&str, &str)], dirty: &[(&str, &str)]) {
        git(dir, &["init", "-q"]);
        for (name, content) in committed {
            std::fs::write(dir.join(name), content).unwrap();
        }
        git(dir, &["add", "."]);
        git(
            dir,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "init",
            ],
        );
        for (name, content) in dirty {
            std::fs::write(dir.join(name), content).unwrap();
        }
    }

    // ── auth ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn missing_auth_header_is_401() {
        let dir = tempfile::tempdir().unwrap();
        let resp = call_diff(
            dir.path(),
            HeaderMap::new(),
            query(Some(dir.path().to_str().unwrap()), None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn wrong_auth_token_is_401() {
        let dir = tempfile::tempdir().unwrap();
        let resp = call_diff(
            dir.path(),
            headers_with_token("wrong"),
            query(Some(dir.path().to_str().unwrap()), None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    // ── cwd validation (validator-A cases 2-3) ────────────────────────

    #[tokio::test]
    async fn missing_cwd_is_400() {
        let dir = tempfile::tempdir().unwrap();
        let resp = call_diff(dir.path(), headers_with_token(TOKEN), query(None, None)).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value, json!({ "error": "cwd query parameter required" }));
    }

    #[tokio::test]
    async fn nonexistent_cwd_is_400() {
        let dir = tempfile::tempdir().unwrap();
        let resp = call_diff(
            dir.path(),
            headers_with_token(TOKEN),
            query(Some("/definitely/not/a/real/dir"), None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(
            value,
            json!({ "error": "cwd does not exist: /definitely/not/a/real/dir" })
        );
    }

    // ── git failures (validator-A case 4) ─────────────────────────────

    #[tokio::test]
    async fn non_git_cwd_is_500_with_node_wrapped_message() {
        let dir = tempfile::tempdir().unwrap();
        let resp = call_diff(
            dir.path(),
            headers_with_token(TOKEN),
            query(Some(dir.path().to_str().unwrap()), None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let value = body_json(resp).await;
        let error = value["error"].as_str().unwrap();
        assert!(
            error.starts_with("git diff failed: Command failed: git diff --no-color"),
            "unexpected error prefix: {error:?}"
        );
        assert!(
            error.contains("ot a git repository"),
            "expected git's not-a-repository stderr embedded: {error:?}"
        );
    }

    // ── happy paths (validator-A cases 5-7) ───────────────────────────

    #[tokio::test]
    async fn dirty_repo_returns_diff_identical_with_and_without_path() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path(), &[("a.txt", "one\n")], &[("a.txt", "two\n")]);
        let cwd = dir.path().to_str().unwrap();

        let resp = call_diff(
            dir.path(),
            headers_with_token(TOKEN),
            query(Some(cwd), None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let without_path = body_json(resp).await;

        let resp = call_diff(
            dir.path(),
            headers_with_token(TOKEN),
            query(Some(cwd), Some("a.txt")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let with_path = body_json(resp).await;

        assert_eq!(with_path, without_path);
        let diff = without_path["diff"].as_str().unwrap();
        assert!(diff.contains("-one"), "expected removed line: {diff:?}");
        assert!(diff.contains("+two"), "expected added line: {diff:?}");
    }

    #[tokio::test]
    async fn clean_repo_returns_empty_diff_exactly() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path(), &[("a.txt", "one\n")], &[]);
        let resp = call_diff(
            dir.path(),
            headers_with_token(TOKEN),
            query(Some(dir.path().to_str().unwrap()), None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value, json!({ "diff": "" }));
    }

    #[tokio::test]
    async fn path_filter_limits_diff_to_that_file() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(
            dir.path(),
            &[("a.txt", "one\n"), ("b.txt", "alpha\n")],
            &[("a.txt", "two\n"), ("b.txt", "beta\n")],
        );
        let resp = call_diff(
            dir.path(),
            headers_with_token(TOKEN),
            query(Some(dir.path().to_str().unwrap()), Some("b.txt")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        let diff = value["diff"].as_str().unwrap();
        assert!(diff.contains("b.txt"), "expected b.txt in diff: {diff:?}");
        assert!(
            !diff.contains("a.txt"),
            "a.txt must be filtered out: {diff:?}"
        );
    }
}
