//! Fresh-agent extras routes — faithful ports of
//! `server/fresh-agent-extras-router.ts`:
//! - `GET /api/fresh-agent/diff` (:304-321) backed by `runGitDiff` (:48-59) —
//!   `git diff --no-color [-- <path>]` in the session cwd's OWN repo (never
//!   the checkpoint shadow repo), 512 KiB stdout cap, 15 s timeout.
//! - `POST /api/fresh-agent/exec` (:289-302) backed by `runCommand` (:26-46)
//!   — `bash -lc` (login shell) with inherited env, 30 s timeout, 200 KiB
//!   per-stream capture caps with kill-on-cap, `${stdout}\n${stderr}`.trim()
//!   combine, `\n[output truncated]` marker, exitCode = numeric code / 1 on
//!   any kill or spawn error. Never a 500: failures are a non-zero exitCode
//!   in a 200.
//!
//! Recorded parity divergences from the Node oracle:
//! - Query-string edge cases: an authenticated-but-malformed query string
//!   (invalid percent-encoding/UTF-8) is rejected by axum's `Query`
//!   extractor with a plain-text 400 BEFORE the handler — status parity
//!   with the oracle's pinned 400s, but the body shape diverges
//!   (consistent with this crate's other `Query` extractors, e.g.
//!   `checkpoints.rs`). DUPLICATED params diverge per key: a duplicated
//!   `cwd` lands in Node's missing-cwd 400 (its `typeof req.query.cwd ===
//!   'string'` gate rejects qs's array) while a duplicated `path` makes
//!   Node return the FULL diff 200 (the array fails the same string gate
//!   and reads as "no path filter") where this port rejects with 400.
//!   The SPA always sends each param once, so the `path` edge is
//!   unreachable from the client; recorded, not repaired.
//! - Kill signals: Node's `execFile` timeout/maxBuffer kills deliver
//!   SIGTERM on Unix; this port's kills (timeout, cap) are tokio's
//!   SIGKILL. Response contracts are identical (kills keep the captured
//!   prefix and surface exitCode 1); only commands with TERM handlers
//!   observe the difference (their cleanup handlers never run here).
//!   Recorded, not repaired.
//! - Diff 500 detail suffix: Node's `git diff failed: <detail>` uses the
//!   execFile error text (`Command failed: …\n<stderr>`); this port uses
//!   git's stderr (trimmed), and `git exited without output` when git fails
//!   silently. The 500 status, the `{error}` envelope, and the
//!   `git diff failed: ` prefix are pinned. The permissive branch is shared
//!   with the timeout path: error/kill WITH captured stdout resolves
//!   `200 {diff: <captured prefix>}` (Node's `error && !stdout` reject
//!   guard), so the `git diff failed: timed out after 15s` 500 fires only
//!   when a timed-out git produced NO stdout.
//! - Over-cap diffs (>512 KiB): Node's execFile maxBuffer KILLS git at
//!   ~512 KiB but still resolves 200 with the captured prefix; this port
//!   drains stdout to EOF (never killing, never deadlocking on a full pipe)
//!   and clips the buffer to exactly 512 KiB. The response contract
//!   (200-with-captured-prefix) is identical; only git's process lifetime
//!   differs.
//! - Over-limit exec bodies: the Node route's 413 is express's non-JSON
//!   `PayloadTooLargeError` page (the app-wide `express.json({limit:
//!   '1mb'})`, server/index.ts:191); axum's route-scoped
//!   `DefaultBodyLimit` rejection is 413 with axum's own plain-text body.
//!   Status parity only. Auth still wins: an unauthenticated over-limit
//!   body is 401 (the router-level gate precedes the body limit).
//! - Malformed exec JSON bodies: express's `json()` parse failure routes
//!   through its HTML error page; this port returns 400 with the crate's
//!   `{error}` envelope. Status parity; the oracle body is an HTML page,
//!   so no `{error}`-shape parity exists to preserve.
//! - Exec truncation is measured in UTF-8 BYTES (`.len()`/
//!   `floor_char_boundary`) where Node uses UTF-16 code units
//!   (`String.length`/`slice`, which can split a surrogate pair). Identical
//!   for ASCII; multi-byte output can clip at a slightly different point.
//! - Exec timing on eternal-output commands (e.g. `yes`): Node's maxBuffer
//!   kill resolves promptly after the cap; this port's cap kill is prompt
//!   for ordinary pipelines (the dropped read end SIGPIPEs downstream
//!   writers), but a command producing output a reader can't saturate only
//!   resolves at the shared 30 s timeout. The response contract
//!   (prefix + marker + exitCode 1) is identical; only timing differs.
//! - Exact-cap kill boundary: this port kills the moment a stream's buffer
//!   REACHES 200 KiB (`drain_exec_stream`, `>=`), while Node kills only when
//!   consumed bytes EXCEED maxBuffer (`>`). A run producing exactly 200 KiB
//!   on a stream can therefore return exitCode 0 on Node vs 1 here (when the
//!   `start_kill` lands ahead of the child's natural exit — race-dependent).
//!   `truncated` is identical (both `>= cap`). Boundary-only; recorded, not
//!   repaired.

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

use crate::boot::{is_authed, unauthorized};

/// `DIFF_MAX_BYTES` / diff timeout (`fresh-agent-extras-router.ts:13, 52`).
const DIFF_MAX_BYTES: usize = 512 * 1024;
const DIFF_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// `EXEC_TIMEOUT_MS` / `EXEC_MAX_OUTPUT` (`fresh-agent-extras-router.ts:11-12`).
const EXEC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const EXEC_MAX_OUTPUT: usize = 200 * 1024;

/// The exec route's JSON-body limit: the app-wide `express.json({limit:
/// '1mb'})` the Node route parses under (`server/index.ts:191`; `bytes`
/// '1mb' = 1024²).
const EXEC_MAX_JSON_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub struct FreshAgentExtrasApiState {
    pub auth_token: Arc<String>,
    /// The USER's home (`os.homedir()` analogue, `fresh-agent-extras-router.ts:291`):
    /// the exec route's cwd fallback when the request carries no usable `cwd`.
    /// Resolved from `session_directory::provider_home()` semantics — HOME set
    /// and non-empty, else the passwd-entry home — NOT the FRESHELL_HOME-preferring
    /// storage root. `None` is a defensive funnel this port turns into the
    /// 400 `cwd does not exist: undefined` (Node docs type `os.homedir()` as
    /// always returning a string and real systems never hit the edge, so
    /// there is no observable Node behavior to mirror there).
    pub user_home: Option<Arc<PathBuf>>,
}

pub fn router(state: FreshAgentExtrasApiState) -> Router {
    Router::new()
        .route("/api/fresh-agent/diff", get(get_diff))
        .route(
            "/api/fresh-agent/exec",
            // Route-scoped limit mirroring the app-wide `express.json({limit:
            // '1mb'})` (server/index.ts:191) — axum's own 2 MiB `Bytes` default
            // would accept bodies Node rejects. Auth still runs first (the
            // router-level gate below): an unauthenticated over-limit body is
            // 401, never 413.
            post(post_exec).layer(DefaultBodyLimit::max(EXEC_MAX_JSON_BYTES)),
        )
        // Node-ordering parity (validated C8, axum 0.8.9 + the main.rs
        // router-level layering precedent): a ROUTER-level auth gate
        // short-circuits BEFORE route extractors, so an unauthenticated
        // request the extractor would otherwise reject (wrong content type,
        // malformed JSON, an over-limit body under any future route-scoped
        // limit) gets 401 — mirroring the Node global httpAuthMiddleware
        // before the extras router's parsers (server/index.ts:210-213,
        // :832). The in-handler `is_authed` checks stay as
        // defense-in-depth. LAST call after all .route(...) registrations;
        // survives `.merge()`.
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            |State(state): State<FreshAgentExtrasApiState>,
             request: axum::extract::Request,
             next: axum::middleware::Next| async move {
                if !is_authed(request.headers(), &state.auth_token) {
                    return unauthorized();
                }
                next.run(request).await
            },
        ))
        .with_state(state)
}

#[derive(serde::Deserialize)]
struct DiffQuery {
    cwd: Option<String>,
    path: Option<String>,
}

async fn get_diff(
    State(state): State<FreshAgentExtrasApiState>,
    headers: HeaderMap,
    Query(query): Query<DiffQuery>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // `fresh-agent-extras-router.ts:305-314` (verbatim strings; the state's
    // `user_home` is unused by diff — the cwd comes from the query).
    let cwd = match query.cwd.filter(|c| !c.is_empty()) {
        Some(c) => c,
        None => return bad_request("cwd query parameter required"),
    };
    if !std::path::Path::new(&cwd).exists() {
        return bad_request(&format!("cwd does not exist: {cwd}"));
    }
    // Node's truthiness gate (`fresh-agent-extras-router.ts:306`): an empty
    // `path` is absent, not `-- ""` (git rejects an empty pathspec).
    let path = query.path.as_deref().filter(|p| !p.is_empty());
    match run_git_diff(&cwd, path).await {
        Ok(diff) => Json(json!({ "diff": diff })).into_response(),
        Err(message) => {
            tracing::warn!(error = %message, "fresh_agent_extras.diff.failed");
            internal_error(message)
        }
    }
}

/// `POST /api/fresh-agent/exec` (`fresh-agent-extras-router.ts:289-302`).
/// Auth FIRST, then `command` validation BEFORE the cwd lookup — the Node
/// field order, observable when both are invalid. The body is read as raw
/// bytes and parsed here (not via axum's `Json` extractor) so the Node
/// funnels hold: a missing/wrong content type or an empty body leaves the
/// request unparsed (Node's `req.body` undefined → `Value::Null` here) and
/// funnels into the `command is required` 400, and a malformed JSON body is
/// a 400 (express's HTML-page status parity; the recorded body divergence
/// is documented in the module header).
async fn post_exec(
    State(state): State<FreshAgentExtrasApiState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let body = match parse_exec_body(&headers, &body) {
        Ok(value) => value,
        // Malformed JSON under a JSON content type — the oracle's pre-handler
        // 400 (express's HTML-page status parity; the body divergence is
        // recorded in the module header).
        Err(MalformedExecBody) => return bad_request("request body is not valid JSON"),
    };
    // `fresh-agent-extras-router.ts:290-294`: non-string, missing, and
    // empty-after-trim all funnel into the one 400.
    let command = body
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|c| !c.is_empty());
    let Some(command) = command else {
        return bad_request("command is required");
    };
    // `:291`: a non-string or empty cwd falls back to the USER's home
    // (`os.homedir()`), never a 400 by itself — except the defensive
    // unresolvable-home funnel below (Node docs type `os.homedir()` as
    // always returning a string; real systems never hit the edge, so the
    // 400 names the missing cwd rather than mirroring any Node behavior).
    let cwd = match body
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
    {
        Some(cwd) => cwd.to_string(),
        None => match &state.user_home {
            Some(home) => home.to_string_lossy().to_string(),
            None => return bad_request("cwd does not exist: undefined"),
        },
    };
    if !std::path::Path::new(&cwd).exists() {
        return bad_request(&format!("cwd does not exist: {cwd}"));
    }
    let result = run_command(command, &cwd).await;
    tracing::info!(
        exit_code = result.exit_code,
        truncated = result.truncated,
        "fresh_agent_extras.exec.completed"
    );
    Json(json!({
        "output": result.output,
        "exitCode": result.exit_code,
        "truncated": result.truncated,
    }))
    .into_response()
}

/// Node's express `json()` acceptance rule, mirrored: `application/json`, any
/// `*/*+json` suffix type, or an explicit charset parameter — media type
/// compared case-insensitively before any `;` parameters. Anything else (or no
/// content type at all) leaves the request unparsed.
fn is_json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            let media = v
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            media == "application/json" || media.ends_with("+json")
        })
        .unwrap_or(false)
}

/// Marker for a JSON-typed body that failed to parse.
struct MalformedExecBody;

/// The exec body parse (`express.json({limit: '1mb'})` semantics, minus the
/// limit itself which the route-scoped `DefaultBodyLimit` enforces): a
/// missing/wrong content type or an empty body leaves the request unparsed
/// (express's `req.body` undefined/`{}` → `Value::Null`, the same
/// missing-command funnel), and a JSON parse failure is the oracle's
/// pre-handler 400.
fn parse_exec_body(headers: &HeaderMap, body: &[u8]) -> Result<Value, MalformedExecBody> {
    if !is_json_content_type(headers) || body.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(body).map_err(|_| MalformedExecBody)
}

struct ExecOutcome {
    output: String,
    exit_code: i64,
    truncated: bool,
}

/// `runCommand` (`fresh-agent-extras-router.ts:26-46`): `bash -lc` (LOGIN
/// shell — profile init, never `-c` alone) with inherited env, 30 s timeout,
/// 200 KiB per-stream capture caps, combined
/// `${stdout}${stderr ? `\n${stderr}` : ''}`.trim(), slice+marker truncation,
/// exitCode = numeric child code / 1 on any kill or spawn error. Never a
/// 500: failures surface as a non-zero exitCode in a 200.
///
/// Kill semantics (pinned by Node's maxBuffer/timeout behavior):
/// - Kill on cap: Node's maxBuffer KILLS the child as a stream crosses the
///   cap, and that kill delivers a NON-numeric `error.code` → `exitCode: 1`.
///   Mirrored by `drain_exec_stream`, which kills the child at the cap.
/// - Kills keep captured output: on ANY kill (cap or timeout) the bytes
///   already captured flow through the same combine/trim/truncate rule, so a
///   killed run still returns its partial prefix. The shared
///   `Arc<Mutex<Vec<u8>>>` buffers survive the 30 s `tokio::time::timeout`
///   arm that takes the kill path, mirroring Node buffering up to the kill.
async fn run_command(command: &str, cwd: &str) -> ExecOutcome {
    let spawned = tokio::process::Command::new("bash")
        .arg("-lc")
        .arg(command)
        .current_dir(cwd)
        .kill_on_drop(true)
        // Node's `execFile` leaves the child's stdin an open pipe that
        // nothing ever writes to or ends — a stdin-consuming one-liner
        // (e.g. `cat`) hangs until the 30 s timeout kill (exitCode 1).
        // The write end is never taken here, so it stays open exactly as
        // long as the `Child` handle lives (dropped after `wait`).
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();
    let child = match spawned {
        Ok(c) => c,
        // Node surfaces spawn failure as exitCode 1 with empty output.
        Err(err) => {
            tracing::warn!(error = %err, "fresh_agent_extras.exec.spawn_failed");
            return ExecOutcome {
                output: String::new(),
                exit_code: 1,
                truncated: false,
            };
        }
    };
    freshell_platform::child_nofile::restore_after_spawn(child.id(), "bash");
    let mut child = child;
    let out_pipe = child.stdout.take().expect("piped stdout");
    let err_pipe = child.stderr.take().expect("piped stderr");
    let child = std::sync::Arc::new(tokio::sync::Mutex::new(child));
    let out_buf = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let err_buf = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));

    let drains_then_wait = {
        let child = std::sync::Arc::clone(&child);
        let out_fut = drain_exec_stream(
            out_pipe,
            std::sync::Arc::clone(&out_buf),
            std::sync::Arc::clone(&child),
        );
        let err_fut = drain_exec_stream(
            err_pipe,
            std::sync::Arc::clone(&err_buf),
            std::sync::Arc::clone(&child),
        );
        async move {
            tokio::join!(out_fut, err_fut);
            let mut guard = child.lock().await;
            guard.wait().await.ok()
        }
    };
    let status = match tokio::time::timeout(EXEC_TIMEOUT, drains_then_wait).await {
        Ok(status) => status,
        Err(_) => {
            tracing::warn!("fresh_agent_extras.exec.timed_out");
            let mut guard = child.lock().await;
            let _ = guard.kill().await;
            None
        }
    };

    let out = std::mem::take(&mut *out_buf.lock().await);
    let err = std::mem::take(&mut *err_buf.lock().await);
    let stdout = String::from_utf8_lossy(&out);
    let stderr = String::from_utf8_lossy(&err);
    let combined = if stderr.is_empty() {
        stdout.into_owned()
    } else {
        format!("{stdout}\n{stderr}")
    }
    .trim()
    .to_string();
    let truncated = combined.len() >= EXEC_MAX_OUTPUT;
    let output = if truncated {
        let mut s = combined;
        // Never split a UTF-8 char (Node slices UTF-16 units; see the module
        // divergence list).
        s.truncate(s.floor_char_boundary(EXEC_MAX_OUTPUT));
        s.push_str("\n[output truncated]");
        s
    } else {
        combined
    };
    let exit_code = match status {
        Some(s) => s.code().map(i64::from).unwrap_or(1),
        None => 1,
    };
    ExecOutcome {
        output,
        exit_code,
        truncated,
    }
}

/// Drains one child stream into `buf`, keeping at most `EXEC_MAX_OUTPUT`
/// bytes (Node's maxBuffer prefix). Node's maxBuffer KILLS the child as a
/// stream crosses the cap; on reaching the cap this kills the child (a kill
/// has no numeric exit code → `exitCode: 1`, same as a timeout kill) and
/// returns, dropping the read end — orphaned pipeline stages (e.g. the `tr`
/// in `head | tr`) then die on SIGPIPE, so the sibling drain still sees a
/// prompt EOF instead of hanging to the 30 s timeout. Bytes captured before
/// the kill are kept for the combine step (see `run_command`).
async fn drain_exec_stream(
    mut pipe: impl tokio::io::AsyncRead + Unpin,
    buf: std::sync::Arc<tokio::sync::Mutex<Vec<u8>>>,
    child: std::sync::Arc<tokio::sync::Mutex<tokio::process::Child>>,
) {
    use tokio::io::AsyncReadExt as _;
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let at_cap = {
                    let mut guard = buf.lock().await;
                    let room = EXEC_MAX_OUTPUT.saturating_sub(guard.len());
                    guard.extend_from_slice(&chunk[..n.min(room)]);
                    guard.len() >= EXEC_MAX_OUTPUT
                };
                if at_cap {
                    tracing::warn!("fresh_agent_extras.exec.output_cap_reached");
                    let mut guard = child.lock().await;
                    let _ = guard.start_kill();
                    return;
                }
            }
        }
    }
}

/// `runGitDiff` (`fresh-agent-extras-router.ts:48-59`): `git diff --no-color
/// [-- <path>]`, 512 KiB stdout cap, 15 s timeout. The permissive branch is
/// the contract — Node rejects only when `error && !stdout`, so error/kill
/// WITH captured stdout (a timed-out or maxBuffer-killed git that already
/// emitted its prefix) resolves `200 {diff: <captured prefix>}`, and only
/// error-with-empty-stdout rejects (`git diff failed: <detail>`). The
/// timeout path follows the same rule: buffers live OUTSIDE the timed
/// future so a kill can still read the captured prefix.
/// Recorded divergence: Node's detail is its execFile error text
/// (`Command failed: …\n<stderr>`); the port uses git's stderr (trimmed) with
/// the same `git diff failed: ` prefix. Node's `${stdout}` payload is
/// verbatim — no trim on the diff text.
async fn run_git_diff(cwd: &str, file_path: Option<&str>) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("diff").arg("--no-color");
    if let Some(p) = file_path {
        cmd.arg("--").arg(p);
    }
    cmd.current_dir(cwd)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // `git diff` never reads stdin (pathspecs come from argv), so
        // null-vs-Node's-open-pipe is observationally equivalent here;
        // null avoids holding a dead write end for the child's lifetime.
        .stdin(std::process::Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("git diff failed: {e}"))?;
    freshell_platform::child_nofile::restore_after_spawn(child.id(), "git");
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    // Drain both streams concurrently (a full pipe never blocks the child);
    // stdout capped at DIFF_MAX_BYTES keeping the prefix (the permissive
    // branch), stderr small-capped for the error message only. The buffers
    // are shared with the timeout arm so a killed git's captured bytes
    // survive the cancelled drain futures.
    let out_buf = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let err_buf = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let drained = tokio::time::timeout(DIFF_TIMEOUT, async {
        let (status, (), ()) = tokio::join!(
            child.wait(),
            drain_diff_stream(&mut stdout, std::sync::Arc::clone(&out_buf), DIFF_MAX_BYTES),
            drain_diff_stream(&mut stderr, std::sync::Arc::clone(&err_buf), 64 * 1024),
        );
        status
    })
    .await;

    match drained {
        Ok(status) => {
            let out = std::mem::take(&mut *out_buf.lock().await);
            let err = std::mem::take(&mut *err_buf.lock().await);
            let ok = matches!(status, Ok(s) if s.success());
            let stdout_text = String::from_utf8_lossy(&out).into_owned();
            if !ok && stdout_text.is_empty() {
                let detail = String::from_utf8_lossy(&err).trim().to_string();
                let detail = if detail.is_empty() {
                    "git exited without output".to_string()
                } else {
                    detail
                };
                return Err(format!("git diff failed: {detail}"));
            }
            Ok(stdout_text)
        }
        Err(_) => {
            let _ = child.kill().await;
            // The permissive branch on the timeout path: a git that already
            // emitted stdout resolves 200 with the captured prefix (Node's
            // `error && !stdout` reject guard); only a silent hang rejects.
            let out = std::mem::take(&mut *out_buf.lock().await);
            let stdout_text = String::from_utf8_lossy(&out).into_owned();
            if stdout_text.is_empty() {
                Err("git diff failed: timed out after 15s".to_string())
            } else {
                Ok(stdout_text)
            }
        }
    }
}

/// Drains one git stream into `buf`, keeping at most `cap` bytes (the
/// captured prefix). Never kills: an over-cap stdout clips and keeps
/// reading to EOF so the 15 s timeout can still fire the permissive branch
/// on a hung-but-chatty git.
async fn drain_diff_stream(
    pipe: &mut (impl tokio::io::AsyncRead + Unpin),
    buf: std::sync::Arc<tokio::sync::Mutex<Vec<u8>>>,
    cap: usize,
) {
    use tokio::io::AsyncReadExt as _;
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let mut guard = buf.lock().await;
                let room = cap.saturating_sub(guard.len());
                guard.extend_from_slice(&chunk[..n.min(room)]);
            }
        }
    }
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

fn internal_error(message: String) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": message })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header, Request};
    use serde_json::Value;
    use tower::ServiceExt;

    fn state(home: &std::path::Path) -> FreshAgentExtrasApiState {
        FreshAgentExtrasApiState {
            auth_token: Arc::new("tok".to_string()),
            user_home: Some(Arc::new(home.to_path_buf())),
        }
    }

    fn headers_with_token(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", token.parse().unwrap());
        headers
    }

    async fn body_json(resp: Response) -> Value {
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    /* ------------------------- GET /api/fresh-agent/diff ----------------- */

    fn git_repo_with_dirty_file() -> (tempfile::TempDir, std::path::PathBuf) {
        // git init && config && commit "one\n", then overwrite with "two\n".
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        (dir, repo)
    }

    fn diff_query(cwd: &std::path::Path, path: Option<&str>) -> Query<DiffQuery> {
        Query(DiffQuery {
            cwd: Some(cwd.to_string_lossy().to_string()),
            path: path.map(str::to_string),
        })
    }

    // Oracle `fresh-agent-extras.test.ts:117-150` "returns a diff payload for
    // a git repo cwd".
    #[tokio::test]
    async fn returns_unified_diff_for_dirty_file_and_scoped_path() {
        let (_d, repo) = git_repo_with_dirty_file();
        let home = tempfile::tempdir().unwrap();
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(&repo, Some("a.txt")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let diff = body_json(resp).await["diff"].as_str().unwrap().to_string();
        assert!(diff.contains("-one"), "{diff}");
        assert!(diff.contains("+two"), "{diff}");
    }

    #[tokio::test]
    async fn unknown_scoped_path_returns_empty_200() {
        let (_d, repo) = git_repo_with_dirty_file();
        let home = tempfile::tempdir().unwrap();
        // A scoped path with no changes (here: an unknown path) yields an
        // empty diff, and git exits 0 — `200 {"diff":""}` (a "500 on empty"
        // regression would fail this):
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(&repo, Some("does-not-exist.txt")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["diff"], json!(""));
    }

    #[tokio::test]
    async fn requires_cwd_and_validates_it_exists() {
        let home = tempfile::tempdir().unwrap();
        // Missing cwd — Node :308.
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            Query(DiffQuery {
                cwd: None,
                path: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(resp).await["error"],
            json!("cwd query parameter required")
        );
        // Nonexistent cwd — Node :309-311 (verbatim message).
        let ghost = home.path().join("nope");
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(&ghost, None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(resp).await["error"],
            json!(format!("cwd does not exist: {}", ghost.to_string_lossy()))
        );
    }

    #[tokio::test]
    async fn non_repo_cwd_is_a_500_with_the_oracle_prefix() {
        let not_repo = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(not_repo.path(), None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let err = body_json(resp).await["error"].as_str().unwrap().to_string();
        assert!(err.starts_with("git diff failed: "), "{err}");
    }

    // Coverage pin for the over-cap permissive branch (Task 2 review,
    // Minor 1 — Node resolves 200-with-captured-prefix on its maxBuffer
    // kill, `fresh-agent-extras-router.ts:48-59`). A dirty diff LARGER than
    // the 512 KiB cap must return 200 with the clipped prefix — never a 500,
    // never the whole output — and the concurrent drain keeps the full pipe
    // from blocking git (without it the 15 s timeout would fire a 500
    // instead).
    #[tokio::test]
    async fn over_cap_diff_returns_200_with_clipped_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        // ~720 KB of DISTINCT lines (12 bytes each) so the diff of the
        // rewrite is ~1.4 MB — well over the 512 KiB cap.
        let original: String = (0..60_000).map(|i| format!("line-{i:06}\n")).collect();
        let rewritten: String = (0..60_000).map(|i| format!("LINE-{i:06}\n")).collect();
        std::fs::write(repo.join("big.txt"), &original).unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("big.txt"), &rewritten).unwrap();

        let home = tempfile::tempdir().unwrap();
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(&repo, None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let diff = body_json(resp).await["diff"].as_str().unwrap().to_string();
        assert!(!diff.is_empty());
        // The oracle's LITERAL 512 KiB cap (fresh-agent-extras-router.ts:13),
        // deliberately not DIFF_MAX_BYTES: a wrong constant change must move
        // this boundary, not the assertion with it.
        const ORACLE_DIFF_MAX_BYTES: usize = 512 * 1024;
        assert!(
            diff.len() <= ORACLE_DIFF_MAX_BYTES + 1024,
            "clipped at the cap (+ small tolerance): {} bytes",
            diff.len()
        );
        // Prefix-keeping: early removed lines survived the clip (a cap that
        // discarded the prefix would fail this).
        assert!(diff.contains("-line-000000"), "{:.200}", diff);
        assert!(diff.contains("-line-000100"), "{:.200}", diff);
    }

    #[tokio::test]
    async fn route_is_wired_at_api_fresh_agent_diff() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/fresh-agent/diff")
                    .header("x-auth-token", "tok")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    /// A repo whose `*.txt` diffs run through an external diff driver
    /// (`gitattributes` + `[diff "<name>"] command`), letting a test script
    /// control git's stdout timing deterministically: the driver script's
    /// stdout IS the diff output git streams out, so a driver that emits and
    /// then sleeps makes git produce a partial prefix and hang. Unix-only
    /// (POSIX `chmod` + an `sh` driver script), gated like the neighboring
    /// unix-only tests.
    #[cfg(unix)]
    fn git_repo_with_diff_driver(driver_body: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let driver = dir.path().join("driver.sh");
        std::fs::write(&driver, driver_body).unwrap();
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&driver, std::fs::Permissions::from_mode(0o755)).unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        run(&["config", "diff.slow.command", &driver.to_string_lossy()]);
        std::fs::write(repo.join(".gitattributes"), "*.txt diff=slow\n").unwrap();
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        (dir, repo)
    }

    // The permissive branch on the timeout path (delta round 6, Major 1):
    // Node's `runGitDiff` rejects only when `error && !stdout`, so a git
    // that already streamed a partial diff and then hangs past the 15 s
    // timeout resolves `200 {diff: <captured prefix>}` — never a 500. The
    // driver emits one line then sleeps 60 s; the 15 s timeout kills git
    // with the prefix already captured.
    #[tokio::test]
    #[cfg(unix)]
    async fn diff_timeout_with_partial_stdout_resolves_200_with_prefix() {
        let (_d, repo) =
            git_repo_with_diff_driver("#!/bin/sh\necho diff-driver-output\nsleep 60\n");
        let home = tempfile::tempdir().unwrap();
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(&repo, Some("a.txt")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let diff = body_json(resp).await["diff"].as_str().unwrap().to_string();
        assert!(diff.contains("diff-driver-output"), "{diff}");
    }

    // The reject side of the same branch: a git that hangs WITHOUT any
    // stdout keeps the oracle's 500 timeout contract.
    #[tokio::test]
    #[cfg(unix)]
    async fn diff_timeout_with_empty_stdout_is_a_500() {
        let (_d, repo) = git_repo_with_diff_driver("#!/bin/sh\nsleep 60\n");
        let home = tempfile::tempdir().unwrap();
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(&repo, Some("a.txt")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            body_json(resp).await["error"],
            json!("git diff failed: timed out after 15s")
        );
    }

    /* ------------------------- POST /api/fresh-agent/exec ---------------- */

    async fn post_exec_authed(home: &std::path::Path, body: Value) -> Response {
        let mut headers = headers_with_token("tok");
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        post_exec(State(state(home)), headers, Bytes::from(body.to_string())).await
    }

    // Oracle `fresh-agent-extras.test.ts:84-94` happy path, made exact:
    // stdout and stderr fold into `${stdout}\n${stderr}`.trim() — stdout
    // first, exactly one newline between, stream contents verbatim. (printf
    // emits no trailing newline so the combined form has no blank line.)
    #[tokio::test]
    async fn exec_runs_command_and_combines_streams() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_exec_authed(
            home.path(),
            json!({
                "command": "printf out; printf err 1>&2",
                "cwd": home.path().to_string_lossy(),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["output"], json!("out\nerr"));
        assert_eq!(v["exitCode"], json!(0));
        assert_eq!(v["truncated"], json!(false));
    }

    // The combine rule is verbatim per-stream (NO per-stream trim): echo's
    // trailing newlines survive as a blank line between the streams, and only
    // the final combined string is trimmed (oracle :34).
    #[tokio::test]
    async fn exec_folds_streams_verbatim_without_per_stream_trims() {
        let home = tempfile::tempdir().unwrap();
        let resp =
            post_exec_authed(home.path(), json!({ "command": "echo out; echo err 1>&2" })).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["output"], json!("out\n\nerr"));
    }

    // Oracle `fresh-agent-extras.test.ts:96-103` — non-zero exit is a 200
    // with the numeric code (never a 500).
    #[tokio::test]
    async fn exec_reports_nonzero_exit_code() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_exec_authed(home.path(), json!({ "command": "exit 7" })).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["exitCode"], json!(7));
        assert_eq!(v["output"], json!(""));
    }

    // Oracle :289-298 (verbatim strings): missing/blank command is checked
    // BEFORE the cwd lookup; a nonexistent cwd names the cwd in the error.
    #[tokio::test]
    async fn exec_rejects_missing_command_and_bad_cwd() {
        let home = tempfile::tempdir().unwrap();
        for body in [json!({}), json!({ "command": "   " })] {
            let resp = post_exec_authed(home.path(), body).await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
            assert_eq!(body_json(resp).await["error"], json!("command is required"));
        }
        let ghost = home.path().join("nope");
        let resp = post_exec_authed(
            home.path(),
            json!({
                "command": "true",
                "cwd": ghost.to_string_lossy(),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(resp).await["error"],
            json!(format!("cwd does not exist: {}", ghost.to_string_lossy()))
        );
    }

    // The cwd default is the USER's home (the `os.homedir()` analogue,
    // oracle :291 — resolved via `session_directory::provider_home()`
    // semantics in main.rs's wiring) — not the server process's cwd and not
    // the FRESHELL_HOME storage root.
    #[tokio::test]
    async fn exec_defaults_to_the_user_home_cwd() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_exec_authed(home.path(), json!({ "command": "pwd" })).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let expected = std::fs::canonicalize(home.path()).unwrap();
        assert_eq!(v["output"], json!(expected.to_string_lossy()));
    }

    // The defensive unresolvable-home funnel: provider_home() can return
    // None (no HOME and no passwd entry — Node docs type os.homedir() as
    // always returning a string, and real systems never hit the edge, so
    // there is no observable Node behavior to mirror). The 400 names the
    // missing cwd honestly instead of running in an arbitrary directory.
    #[tokio::test]
    async fn exec_without_resolvable_home_is_the_undefined_cwd_400() {
        let no_home_state = FreshAgentExtrasApiState {
            auth_token: Arc::new("tok".to_string()),
            user_home: None,
        };
        let mut headers = headers_with_token("tok");
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        let resp = post_exec(
            State(no_home_state),
            headers,
            Bytes::from_static(br#"{"command":"pwd"}"#),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(resp).await["error"],
            json!("cwd does not exist: undefined")
        );
    }

    // Node's express `json()` body-limit funnels (server/index.ts:191,
    // `limit: '1mb'`): bodies OVER the 1 MiB route-scoped limit are 413,
    // bodies of EXACTLY the limit are parsed and served. A body between
    // 1 MiB and axum's old 2 MiB default would previously have been
    // accepted here while Node rejects it.
    #[tokio::test]
    async fn exec_bodies_over_1mib_are_413() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        // The oracle's LITERAL 1 MiB limit (server/index.ts:191,
        // express.json({limit: '1mb'})), deliberately not
        // EXEC_MAX_JSON_BYTES: a wrong constant change must move this
        // boundary, not the fixture with it.
        const ORACLE_JSON_LIMIT_BYTES: usize = 1024 * 1024;
        let body = format!(
            r#"{{"command":"true","padding":"{}"}}"#,
            "x".repeat(ORACLE_JSON_LIMIT_BYTES)
        );
        assert!(body.len() > ORACLE_JSON_LIMIT_BYTES);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fresh-agent/exec")
                    .header("x-auth-token", "tok")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn exec_body_of_exactly_1mib_is_accepted() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        // Valid JSON followed by trailing spaces (tolerated by both
        // body-parser and serde_json) padded to EXACTLY the oracle's literal
        // 1 MiB limit (server/index.ts:191).
        const ORACLE_JSON_LIMIT_BYTES: usize = 1024 * 1024;
        let mut body = r#"{"command":"true"}"#.to_string();
        body.push_str(&" ".repeat(ORACLE_JSON_LIMIT_BYTES - body.len()));
        assert_eq!(body.len(), ORACLE_JSON_LIMIT_BYTES);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fresh-agent/exec")
                    .header("x-auth-token", "tok")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    // The Node wrong-content-type funnel: express's `json()` leaves
    // `req.body` undefined for a non-JSON content type, so the request
    // surfaces the missing-command 400 — never a 415.
    #[tokio::test]
    async fn exec_wrong_content_type_funnels_to_command_required() {
        let home = tempfile::tempdir().unwrap();
        let mut headers = headers_with_token("tok");
        headers.insert(header::CONTENT_TYPE, "text/plain".parse().unwrap());
        let resp = post_exec(
            State(state(home.path())),
            headers,
            Bytes::from_static(br#"{"command":"true"}"#),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(resp).await["error"], json!("command is required"));
    }

    // An empty JSON-typed body parses as `{}` in express (the missing-command
    // 400 funnel) — not a parse error.
    #[tokio::test]
    async fn exec_empty_json_body_funnels_to_command_required() {
        let home = tempfile::tempdir().unwrap();
        let mut headers = headers_with_token("tok");
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        let resp = post_exec(State(state(home.path())), headers, Bytes::new()).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(resp).await["error"], json!("command is required"));
    }

    // A malformed JSON body under a JSON content type is the oracle's
    // pre-handler 400 (express routes it through its HTML error page; the
    // body-shape divergence is recorded in the module header).
    #[tokio::test]
    async fn exec_malformed_json_is_a_400() {
        let home = tempfile::tempdir().unwrap();
        let mut headers = headers_with_token("tok");
        headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        let resp = post_exec(
            State(state(home.path())),
            headers,
            Bytes::from_static(b"{not json"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(resp).await["error"],
            json!("request body is not valid JSON")
        );
    }

    // Oracle :36-43 — a stream crossing the 200 KiB cap kills the child
    // (Node's maxBuffer kill → non-numeric code → exitCode 1), keeps the
    // captured prefix, and slices the trimmed combination to the cap plus
    // the marker.
    #[tokio::test]
    async fn exec_truncates_oversized_output() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_exec_authed(
            home.path(),
            json!({
                "command": "head -c 300000 /dev/zero | tr '\\0' 'a'",
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["truncated"], json!(true));
        // Node's maxBuffer kill surfaces as exitCode 1 (non-numeric code).
        assert_eq!(v["exitCode"], json!(1));
        let output = v["output"].as_str().unwrap();
        assert_eq!(output.len(), 200 * 1024 + "\n[output truncated]".len());
        assert!(output.ends_with("\n[output truncated]"));
    }

    #[tokio::test]
    async fn exec_route_is_wired() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fresh-agent/exec")
                    .header("x-auth-token", "tok")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(axum::body::Body::from(r#"{"command":"true"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    // Exec-specific auth-ordering pin (Task 3 review, Nit 5a): the exec
    // route is registered BEFORE the router-level `.layer(...)`, so the auth
    // gate short-circuits BEFORE the body-limit layer and the manual parse —
    // an UNAUTHENTICATED request the body handling would otherwise reject
    // (wrong content type, malformed JSON, an over-1-MiB body) must be 401,
    // mirroring the Node global httpAuthMiddleware's run-before-parsers
    // ordering on this same router instance. With the route registered after
    // the layer, the requests below would surface the body-level rejection
    // instead.
    #[tokio::test]
    async fn unauthenticated_exec_is_401_before_json_extraction() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        const ORACLE_JSON_LIMIT_BYTES: usize = 1024 * 1024;
        let over_limit = format!(
            r#"{{"command":"true","padding":"{}"}}"#,
            "x".repeat(ORACLE_JSON_LIMIT_BYTES)
        );
        for (content_type, body) in [
            ("text/plain", "{}".to_string()),
            ("application/json", "{not json".to_string()),
            ("application/json", over_limit),
        ] {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/fresh-agent/exec")
                        .header(header::CONTENT_TYPE, content_type)
                        .body(axum::body::Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                resp.status(),
                StatusCode::UNAUTHORIZED,
                "content-type {content_type} must be 401 before body-level rejection"
            );
            assert_eq!(body_json(resp).await["error"], json!("Unauthorized"));
        }
    }

    // `floor_char_boundary` pin (Task 3 review, Nit 5b): the cap slice is in
    // UTF-8 BYTES and `String::truncate` PANICS off a char boundary, so the
    // slice must clip down to the char floor (the recorded divergence from
    // Node's UTF-16-unit slicing). The producer emits 1 ASCII byte then
    // 2-byte `é`s, so byte offset `EXEC_MAX_OUTPUT` (204800) is the SECOND
    // byte of an `é` — the slice must floor to 204799, never panic.
    #[tokio::test]
    async fn exec_truncation_clips_to_the_char_floor_on_multibyte_output() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_exec_authed(
            home.path(),
            json!({ "command": "printf a; printf 'é%.0s' {1..150000}" }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["truncated"], json!(true));
        // Cap-kill → exitCode 1, same as the ASCII oversize pin.
        assert_eq!(v["exitCode"], json!(1));
        let output = v["output"].as_str().unwrap();
        let prefix = output.strip_suffix("\n[output truncated]").unwrap();
        // The floor clip lands strictly BELOW the byte cap: 1 `a` plus
        // 102399 `é`s = 204799 bytes. An unfloored `truncate(204800)` would
        // panic the handler; this length is only reachable via the floor.
        assert_eq!(prefix.len(), EXEC_MAX_OUTPUT - 1);
        assert!(prefix.starts_with('a'));
        assert!(prefix.ends_with('é'));
    }
}
