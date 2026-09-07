//! `GET /api/fresh-agent/diff` and `POST /api/fresh-agent/exec` — faithful
//! ports of the legacy Node routes at
//! `server/fresh-agent-extras-router.ts:289-321` plus their `runCommand`
//! (`:25-46`) and `runGitDiff` (`:48-60`) helpers. Together they close parity
//! checklist item **AGENT-13**
//! (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:353`) per
//! Tasks 1-2 of the port plan `docs/plans/2026-09-06-ekc6.md`; both routes
//! share the `run_bounded` subprocess helper built here.
//!
//! ## What this is
//!
//! The SPA's `FreshAgentDiffPanel` (`src/components/fresh-agent/
//! FreshAgentDiffPanel.tsx`) fetches `/diff` when the user expands a
//! "Files changed" row in a fresh-agent transcript: it returns the
//! working-tree `git diff` for the session cwd (optionally limited to a
//! single path) so the row renders the actual patch. The fresh-agent client
//! shells out through `/exec` (`bash -lc <command>`) for pane-scoped helper
//! actions. Against the Rust server both 404'd, leaving the panel
//! perpetually loading; the ports restore real behavior (and the panel's
//! already-implemented inline error rendering).
//!
//! ## `/diff` response shape (Node oracle — replicated exactly)
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
//! ## `/exec` response shape (Node oracle — replicated exactly)
//!
//! Body parsing replicates express's `json()` middleware (mounted at
//! `fresh-agent-extras-router.ts:266`) rather than using axum's `Json`
//! extractor: parsing applies ONLY to an exactly-`application/json`
//! content-type (parameters stripped, trimmed, case-folded — express's
//! default matcher does NOT accept `application/*+json` structured-suffix
//! vendor types). A missing, empty, or non-matching content-type body, and
//! valid JSON whose top level is not an object, are all treated as `{}`
//! (validation then fails with command-is-required); an
//! exactly-`application/json` content-type with malformed bytes returns
//! `400 {"error":"invalid JSON body"}` (divergence 1 — Node serves
//! express's HTML SyntaxError page there).
//!
//! - Auth failure → 401 via `crate::boot::unauthorized()`.
//! - `command` missing, non-string, null, or whitespace-only (Node:
//!   `typeof body.command === 'string' ? command.trim() : ''`,
//!   `fresh-agent-extras-router.ts:290`) →
//!   `400 {"error":"command is required"}` — checked BEFORE the cwd gate.
//! - `cwd` non-empty string → used verbatim; otherwise the boot-resolved
//!   `state.home` (divergence 4 — FRESHELL_HOME-aware boot home vs Node's
//!   raw `os.homedir()`).
//! - `cwd` not existing on disk (existence-only, like the `/diff` gate) →
//!   `400 {"error":"cwd does not exist: <cwd verbatim>"}`.
//! - Otherwise spawn `bash -lc <command>` (its own argv, never
//!   string-split) in `cwd` with the full inherited process env (Node:
//!   `env: process.env`), a 30s timeout, and a 200KB per-pipe retained cap;
//!   the response is always `200 {"output","exitCode","truncated"}` on this
//!   path (Node's `runCommand` never rejects):
//!   - `output` = `stdout + (stderr ? "\n" + stderr : "")`, trimmed — so
//!     stderr-only output has no leading newline (validator-A case 9).
//!   - Spawn failure → `{"output":"","exitCode":1,"truncated":false}`.
//!   - Timeout or signal kill (`exit_code` None) → `exitCode` 1.
//!   - `truncated` = combined length ≥ 200KB (divergence 9: byte count vs
//!     Node's UTF-16 units; ASCII-identical). When truncated, `output` =
//!     the first 204800 bytes of combined + `"\n[output truncated]"`, and
//!     `exitCode` is forced to 1 when a pipe overflow coincided with a
//!     natural exit 0 — the drain-and-cap equivalent of Node's maxBuffer
//!     signal-kill collapse (divergence 8; validator-A case 12 pins
//!     `{"exitCode":1,"truncated":true}` byte-for-byte).
//!
//! ## `run_bounded` — shared bounded-subprocess helper (built here; Task 2 reuses)
//!
//! Spawns `program` via `tokio::process::Command` with piped stdin, stdout,
//! and stderr. The child stdin handle is held open — never written, never
//! closed early — until the child exits or is reaped, matching Node
//! execFile's open-pipe semantics (a stdin-reading command blocks rather
//! than seeing an immediate EOF). Both output pipes drain to EOF
//! concurrently with `wait()` (so a verbose child cannot deadlock on a full
//! pipe buffer), retaining at most `per_pipe_cap` bytes of each pipe
//! (drain-and-cap: the child is NEVER killed on overflow, it runs to
//! completion), and `wait()` is wrapped in `timeout`: on expiry the child
//! is killed + reaped and the result is `exit_code: None,
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
//! - **#8 maxBuffer kill** (`/exec`): Node kills the child mid-stream on
//!   overflow; this port drains with retained-output caps and forces
//!   `exitCode: 1` on any overflowed run — the drain-and-cap equivalent of
//!   Node's signal-kill code collapse. `truncated` is NOT part of this
//!   mapping: it derives independently from the trimmed combined length on
//!   both stacks (validator-A case 12's overflow body
//!   `{exitCode: 1, truncated: true}` is pinned byte-for-byte). The child's
//!   wall-clock lifetime is longer under drain-and-cap; there is no
//!   response-shape difference. For `/diff` the truncation point is never
//!   reported in the body, so no mapping is needed there.
//! - **#1 malformed-JSON exec body** → `400 {"error":"invalid JSON body"}`
//!   where Node serves express's HTML SyntaxError page (embeds absolute
//!   module paths — not byte-stable; good-faith clients never reach either).
//! - **#2 non-JSON / empty exec body**: express skips parsing →
//!   `400 {"error":"command is required"}` — REPLICATED (custom body parse,
//!   no bare `Json` extractor).
//! - **#4 exec default cwd** is the boot-resolved home (FRESHELL_HOME-aware,
//!   matching every other Rust state object) rather than raw `os.homedir()`;
//!   identical under every fixture.
//! - **#9 truncation counting**: this port counts UTF-8 bytes; Node counts
//!   UTF-16 code units. Identical for ASCII; boundary differences only for
//!   multi-byte output at exactly the 200KB line (same accepted divergence
//!   class as the AGENT-14 checkpoints port documented).

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{header::CONTENT_TYPE, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use tokio::process::Command;

use crate::boot::{is_authed, unauthorized};

/// `EXEC_TIMEOUT_MS` (`fresh-agent-extras-router.ts:11`): `bash -lc` wall
/// clock limit before the child is killed.
const EXEC_TIMEOUT: Duration = Duration::from_secs(30);

/// `EXEC_MAX_OUTPUT` (`fresh-agent-extras-router.ts:12`): per-pipe retained
/// cap, and the combined-output length at/above which the response reports
/// `truncated: true`.
const EXEC_MAX_OUTPUT: usize = 200 * 1024;

/// `DIFF_MAX_BYTES` (`fresh-agent-extras-router.ts:13`): retained-stdout cap
/// for `git diff`.
const DIFF_MAX_BYTES: usize = 512 * 1024;

/// `runGitDiff`'s `timeout: 15_000` (`fresh-agent-extras-router.ts:52`).
const DIFF_TIMEOUT: Duration = Duration::from_secs(15);

/// Shared state for the `/api/fresh-agent/*` extras routes.
#[derive(Clone)]
pub struct FreshAgentExtrasApiState {
    pub auth_token: Arc<String>,
    /// Boot-resolved home directory. The `/diff` handler ignores it; the
    /// `/exec` handler uses it as the default cwd (documented divergence 4 —
    /// FRESHELL_HOME-aware boot home, vs Node's raw `os.homedir()`), matching
    /// how every other Rust state object resolves home.
    pub home: Arc<PathBuf>,
}

/// The `/api/fresh-agent` extras sub-router (`/diff` + `/exec`).
pub fn router(state: FreshAgentExtrasApiState) -> Router {
    Router::new()
        .route("/api/fresh-agent/diff", get(get_diff))
        .route("/api/fresh-agent/exec", post(post_exec))
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

/// `POST /api/fresh-agent/exec` — parity port of Node's `/exec` route
/// (`fresh-agent-extras-router.ts:289-302` + `runCommand` at `:25-46`). See
/// the module doc comment ("`/exec` response shape") for the contract.
async fn post_exec(
    State(state): State<FreshAgentExtrasApiState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    // Replicate express's `json()` middleware skip semantics (divergences
    // 1-2): a missing, empty, or non-JSON-content-type body is NEVER parsed
    // (the handler sees `{}`); a JSON content-type with malformed bytes is a
    // 400. axum's bare `Json` extractor conflates all of these, so the body
    // is taken as raw `Bytes` and parsed manually.
    let body_json: Option<serde_json::Value> = if is_json_content_type(&headers) && !body.is_empty()
    {
        match serde_json::from_slice(&body) {
            Ok(value) => Some(value),
            Err(_) => return bad_request("invalid JSON body"),
        }
    } else {
        None
    };

    // `typeof req.body?.command === 'string' ? req.body.command.trim() : ''`
    // (fresh-agent-extras-router.ts:290) — missing key, null, and non-string
    // all collapse to '', and an empty-after-trim command is "required".
    let command = body_json
        .as_ref()
        .and_then(|value| value.get("command"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if command.is_empty() {
        return bad_request("command is required");
    }

    // `typeof req.body?.cwd === 'string' && req.body.cwd ? req.body.cwd :
    // os.homedir()` (`:291`) — divergence 4 substitutes the boot-resolved
    // home for `os.homedir()`.
    let cwd = body_json
        .as_ref()
        .and_then(|value| value.get("cwd"))
        .and_then(serde_json::Value::as_str)
        .filter(|cwd| !cwd.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| state.home.to_string_lossy().into_owned());

    // Existence-only (Node `fsp.access`; `:295-299`) — after the command
    // gate, matching Node's validation order.
    if tokio::fs::metadata(&cwd).await.is_err() {
        return bad_request(&format!("cwd does not exist: {cwd}"));
    }

    // execFile('bash', ['-lc', command], { cwd, timeout, maxBuffer,
    // env: process.env }) (`:28-32`): a dedicated argv (never string-split),
    // the full inherited process env (tokio inherits by default), Node's
    // execFile stdin semantics (an open pipe the parent never writes to or
    // closes — held open across the wait inside `run_bounded`), a 30s
    // timeout, and per-pipe retained caps.
    let output = match run_bounded(
        "bash",
        &["-lc", command],
        &cwd,
        EXEC_TIMEOUT,
        EXEC_MAX_OUTPUT,
    )
    .await
    {
        Ok(output) => output,
        // Spawn failure: Node's execFile errors with a non-numeric code →
        // exitCode 1, empty output (`:36-38`).
        Err(_) => {
            return Json(json!({ "output": "", "exitCode": 1, "truncated": false }))
                .into_response();
        }
    };

    // `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim() (`:34`) — the
    // fold-then-trim that keeps stderr-only output free of a leading
    // newline (validator-A case 9).
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = if stderr.is_empty() {
        stdout.into_owned()
    } else {
        format!("{stdout}\n{stderr}")
    };
    let combined = combined.trim();

    // `combined.length >= EXEC_MAX_OUTPUT` (`:35`) — byte count where Node
    // counts UTF-16 units (divergence 9; ASCII-identical).
    let truncated = combined.len() >= EXEC_MAX_OUTPUT;
    let response_output = if truncated {
        // `${combined.slice(0, EXEC_MAX_OUTPUT)}\n[output truncated]` (`:40`)
        let mut end = EXEC_MAX_OUTPUT.min(combined.len());
        while !combined.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n[output truncated]", &combined[..end])
    } else {
        combined.to_string()
    };

    // `error && typeof error.code === 'number' ? code : error ? 1 : 0`
    // (`:36-38`): nonzero exits keep their code; signal kills, timeouts, and
    // spawn errors collapse to 1. A pipe overflow coinciding with a natural
    // exit 0 is ALSO 1 — the drain-and-cap equivalent of Node's maxBuffer
    // kill (divergence 8; validator-A case 12).
    let exit_code = match output.exit_code {
        Some(code) if !output.timed_out && !output.overflowed => code,
        _ => 1,
    };

    Json(json!({
        "output": response_output,
        "exitCode": exit_code,
        "truncated": truncated,
    }))
    .into_response()
}

/// Express's `json()` middleware is mounted with body-parser's default
/// `type: 'application/json'`, so it parses ONLY when the request
/// content-type — media parameters stripped, trimmed, case-folded — is
/// exactly `application/json`. Structured-suffix vendor types
/// (`application/cloudevents+json`, `application/hal+json`, ...) do NOT
/// match that expected pattern, so their bodies are skipped and the handler
/// sees `{}`; a missing content-type skips parsing too.
fn is_json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|raw| {
            raw.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/json")
        })
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
    /// `true` when either pipe emitted more bytes than `per_pipe_cap`
    /// retained (drain-and-cap: the child ran to completion, but output was
    /// discarded). The `/exec` route maps this to Node's maxBuffer
    /// signal-kill collapse (divergence 8); `/diff` ignores it.
    overflowed: bool,
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
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    // Node's execFile leaves the child's stdin an open pipe the parent
    // never writes to and never closes (fresh-agent-extras-router.ts:28-32),
    // so a stdin-reading command blocks until it finishes reading or the
    // timeout kill — it never sees an immediate EOF. Take the handle and
    // hold it across the wait below; dropping it earlier would deliver that
    // EOF. Both routes want this: `/exec` per Node parity, and `/diff`'s
    // `git diff` never reads stdin so the open pipe is inert there.
    let child_stdin = child.stdin.take().expect("stdin was piped");
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
    // The child has exited or been killed + reaped above; only now is it
    // safe to close our end of its stdin — closing it mid-run would change
    // observable behavior for stdin-reading commands (early EOF).
    drop(child_stdin);

    let (stdout, stdout_overflowed) = stdout?;
    let (stderr, stderr_overflowed) = stderr?;

    Ok(BoundedOutput {
        stdout,
        stderr,
        exit_code,
        timed_out,
        overflowed: stdout_overflowed || stderr_overflowed,
    })
}

/// Reads `reader` to EOF, retaining at most `cap` bytes (drain-and-cap:
/// overflow bytes are consumed and discarded, never a reason to kill). The
/// second tuple element reports whether any bytes were discarded.
async fn read_capped<R>(reader: &mut R, cap: usize) -> std::io::Result<(Vec<u8>, bool)>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    let mut kept = Vec::new();
    let mut overflowed = false;
    let mut buf = [0u8; 8192];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            return Ok((kept, overflowed));
        }
        let remaining = cap.saturating_sub(kept.len());
        let take = n.min(remaining);
        if take < n {
            overflowed = true;
        }
        kept.extend_from_slice(&buf[..take]);
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

    // ── run_bounded helper failure machinery (task 1 review M1) ──────

    #[tokio::test]
    async fn read_capped_retains_prefix_to_cap_and_drains_overflow_to_eof() {
        // 10_000 bytes exceeds the internal 8KiB read chunk, so a 9_000 cap
        // boundary lands mid-chunk, exercising partial-chunk retention. The
        // contract (module docs) is prefix retention up to the cap plus
        // drain-to-EOF — the latter asserted via the exhausted slice
        // reader, the former via the retained prefix and overflow flag.
        let input: Vec<u8> = (0u32..10_000).map(|i| (i % 251) as u8).collect();
        let cap = 9_000;
        let mut reader: &[u8] = &input[..];
        let (kept, overflowed) = read_capped(&mut reader, cap).await.unwrap();
        assert_eq!(kept.len(), cap);
        assert_eq!(kept.as_slice(), &input[..cap]);
        assert!(overflowed, "10_000 bytes through a 9_000 cap must overflow");
        assert!(
            reader.is_empty(),
            "overflow bytes must be drained to EOF, not retained or fatal"
        );
        // Exactly-at-cap input retains everything but does NOT count as
        // overflow — matching Node, whose maxBuffer kills only past the cap.
        let exact: Vec<u8> = (0u32..9_000).map(|i| (i % 251) as u8).collect();
        let mut reader: &[u8] = &exact[..];
        let (kept, overflowed) = read_capped(&mut reader, cap).await.unwrap();
        assert_eq!(kept.as_slice(), exact.as_slice());
        assert!(!overflowed);
    }

    #[tokio::test]
    async fn run_bounded_timeout_kills_and_reaps_child() {
        let dir = tempfile::tempdir().unwrap();
        let started = std::time::Instant::now();
        let output = run_bounded(
            "sleep",
            &["2"],
            dir.path().to_str().unwrap(),
            Duration::from_millis(50),
            1_024,
        )
        .await
        .unwrap();
        assert!(output.timed_out);
        assert!(output.exit_code.is_none());
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
        // Returning long before the 2s sleep could end proves the child was
        // killed and reaped: an un-killed child would hold `wait()` (and its
        // open pipes) pending until exit.
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "timeout kill+reap must return promptly, took {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn run_bounded_stdin_is_an_open_silent_pipe_not_eof() {
        // Node's execFile leaves the child's stdin an open pipe the parent
        // never writes to and never closes
        // (fresh-agent-extras-router.ts:28-32), so a stdin-reading command
        // blocks for input rather than seeing an immediate EOF. The
        // discrimination is encoded in OUTPUT, not wall clock, so the pin
        // is deterministic under load: a bounded `read -t` against an open
        // silent pipe TIMES OUT (bash status >128), while against an EOF'd
        // (null) stdin it fails instantly (status 1). With `Stdio::null()`
        // this test FAILS red (`read-got-eof` instead of `read-timed-out`).
        let dir = tempfile::tempdir().unwrap();
        let output = run_bounded(
            "bash",
            &[
                "-lc",
                "read -t 0.01 line; s=$?; \
                 if [ $s -gt 128 ]; then echo read-timed-out; \
                 elif [ $s -eq 0 ]; then echo read-got-data; \
                 else echo read-got-eof; fi",
            ],
            dir.path().to_str().unwrap(),
            Duration::from_secs(5), // safety net only — never hit
            1_024,
        )
        .await
        .unwrap();
        assert!(!output.timed_out);
        assert_eq!(output.exit_code, Some(0));
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "read-timed-out\n",
            "a held-open silent stdin pipe must time out a bounded read, not EOF it"
        );
    }

    // ── POST /api/fresh-agent/exec (Node oracle
    //    fresh-agent-extras-router.ts:289-302 + runCommand :25-46; oracle
    //    bytes: load-bearing-validator-A.md cases 8-16) ─────────────────

    fn exec_headers(token: Option<&str>, content_type: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(token) = token {
            headers.insert("x-auth-token", token.parse().unwrap());
        }
        if let Some(content_type) = content_type {
            headers.insert("content-type", content_type.parse().unwrap());
        }
        headers
    }

    async fn call_exec(home: &Path, headers: HeaderMap, body: &[u8]) -> Response {
        post_exec(
            State(state(home)),
            headers,
            axum::body::Bytes::copy_from_slice(body),
        )
        .await
    }

    fn json_body(command: &str, cwd: Option<&Path>) -> Vec<u8> {
        match cwd {
            Some(cwd) => format!(
                r#"{{"command":{},"cwd":{}}}"#,
                serde_json::to_string(command).unwrap(),
                serde_json::to_string(&cwd.to_string_lossy()).unwrap()
            )
            .into_bytes(),
            None => format!(
                r#"{{"command":{}}}"#,
                serde_json::to_string(command).unwrap()
            )
            .into_bytes(),
        }
    }

    // ── exec auth ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn exec_missing_auth_header_is_401() {
        let dir = tempfile::tempdir().unwrap();
        let resp = call_exec(
            dir.path(),
            exec_headers(None, Some("application/json")),
            &json_body("true", Some(dir.path())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn exec_wrong_auth_token_is_401() {
        let dir = tempfile::tempdir().unwrap();
        let resp = call_exec(
            dir.path(),
            exec_headers(Some("wrong"), Some("application/json")),
            &json_body("true", Some(dir.path())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    // ── exec validation (Node-first order: command, then cwd) ─────────

    #[tokio::test]
    async fn exec_missing_or_non_string_command_is_400() {
        // Validator-A case 10; Node: `typeof body.command === 'string' ?
        // trim : ''` — missing key, non-string, and null all collapse to
        // the same 400, BEFORE any cwd check (the bogus cwd here would
        // fail validation if the order were reversed).
        let dir = tempfile::tempdir().unwrap();
        let bogus_cwd = serde_json::to_string("/definitely/not/a/real/dir").unwrap();
        let bodies: Vec<Vec<u8>> = vec![
            format!(r#"{{"cwd":{bogus_cwd}}}"#).into_bytes(),
            br#"{"command":null}"#.to_vec(),
            br#"{"command":42}"#.to_vec(),
            br#"{"command":["echo","hi"]}"#.to_vec(),
        ];
        for body in bodies {
            let resp = call_exec(
                dir.path(),
                exec_headers(Some(TOKEN), Some("application/json")),
                &body,
            )
            .await;
            assert_eq!(
                resp.status(),
                StatusCode::BAD_REQUEST,
                "body: {}",
                String::from_utf8_lossy(&body)
            );
            let value = body_json(resp).await;
            assert_eq!(value, json!({ "error": "command is required" }));
        }
    }

    #[tokio::test]
    async fn exec_whitespace_only_command_is_400() {
        // Node trims the command; whitespace-only collapses to required.
        let dir = tempfile::tempdir().unwrap();
        let resp = call_exec(
            dir.path(),
            exec_headers(Some(TOKEN), Some("application/json")),
            br#"{"command":"  \t\n "}"#,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value, json!({ "error": "command is required" }));
    }

    #[tokio::test]
    async fn exec_nonexistent_cwd_is_400_exact_message() {
        // Validator-A case 11 (byte-exact).
        let dir = tempfile::tempdir().unwrap();
        let resp = call_exec(
            dir.path(),
            exec_headers(Some(TOKEN), Some("application/json")),
            br#"{"command":"true","cwd":"/definitely/not/a/real/dir"}"#,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(
            value,
            json!({ "error": "cwd does not exist: /definitely/not/a/real/dir" })
        );
    }

    // ── exec happy paths (validator-A cases 8, 9, 16) ─────────────────

    #[tokio::test]
    async fn exec_echo_runs_in_given_cwd() {
        // Validator-A case 8.
        let dir = tempfile::tempdir().unwrap();
        let resp = call_exec(
            dir.path(),
            exec_headers(Some(TOKEN), Some("application/json")),
            &json_body("echo hello-exec && pwd", Some(dir.path())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        let output = value["output"].as_str().unwrap();
        assert!(output.contains("hello-exec"), "output: {output:?}");
        assert!(
            output.contains(dir.path().to_str().unwrap()),
            "expected pwd of the tempdir in output: {output:?}"
        );
        assert_eq!(value["exitCode"], 0);
        assert_eq!(value["truncated"], false);
    }

    #[tokio::test]
    async fn exec_stderr_only_output_has_no_leading_newline() {
        // Validator-A case 9 (exact body): the fold is stdout + "\n" +
        // stderr, THEN trim — so stderr-only output never leads with "\n".
        let dir = tempfile::tempdir().unwrap();
        let resp = call_exec(
            dir.path(),
            exec_headers(Some(TOKEN), Some("application/json")),
            &json_body("echo to-stderr >&2; exit 3", Some(dir.path())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(
            value,
            json!({ "output": "to-stderr", "exitCode": 3, "truncated": false })
        );
    }

    #[tokio::test]
    async fn exec_mixed_stdout_stderr_fold_uses_single_separator() {
        // Fold boundary pin (task 2 review M2): stdout + "\n" + stderr,
        // THEN trim — mixed output joins the streams with exactly one
        // newline, no doubling, no leading/trailing whitespace.
        let dir = tempfile::tempdir().unwrap();
        let resp = call_exec(
            dir.path(),
            exec_headers(Some(TOKEN), Some("application/json")),
            &json_body("printf out; printf err >&2", Some(dir.path())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(
            value,
            json!({ "output": "out\nerr", "exitCode": 0, "truncated": false })
        );
    }

    #[tokio::test]
    async fn exec_bounded_stdin_read_completes_under_held_open_stdin() {
        // execFile stdin parity (task 2 review I2): the child's stdin is an
        // open pipe the parent never writes to or closes, so an UNBOUNDED
        // `read` hangs to the 30s timeout kill — but a command that bounds
        // its own read completes normally: the held-open pipe carries no
        // data, and output capture is unaffected.
        let dir = tempfile::tempdir().unwrap();
        let resp = call_exec(
            dir.path(),
            exec_headers(Some(TOKEN), Some("application/json")),
            &json_body(
                "read -t 0.2 line || true; echo after-stdin",
                Some(dir.path()),
            ),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(
            value,
            json!({ "output": "after-stdin", "exitCode": 0, "truncated": false })
        );
    }

    #[tokio::test]
    async fn exec_without_cwd_runs_in_state_home() {
        // Documented divergence 4: default cwd is the boot-resolved home
        // (here the tempdir passed as state home), vs Node's os.homedir()
        // (validator-A case 16 observed "/home/dan").
        let dir = tempfile::tempdir().unwrap();
        let resp = call_exec(
            dir.path(),
            exec_headers(Some(TOKEN), Some("application/json")),
            &json_body("pwd", None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["output"], dir.path().to_str().unwrap());
        assert_eq!(value["exitCode"], 0);
        assert_eq!(value["truncated"], false);
    }

    #[tokio::test]
    async fn exec_truncates_at_output_cap_with_exit_code_1() {
        // Validator-A case 12, byte-for-byte: `seq 1 60000` overflows the
        // 200KB cap; Node kills the child on maxBuffer (signal-kill →
        // exitCode 1), retains the first 204800 units, appends the marker.
        let dir = tempfile::tempdir().unwrap();
        let resp = call_exec(
            dir.path(),
            exec_headers(Some(TOKEN), Some("application/json")),
            &json_body("seq 1 60000", Some(dir.path())),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let value = body_json(resp).await;
        assert_eq!(value["truncated"], true);
        assert_eq!(value["exitCode"], 1);
        let output = value["output"].as_str().unwrap();
        let cap = 200 * 1024; // EXEC_MAX_OUTPUT (fresh-agent-extras-router.ts:12)
        let marker = "\n[output truncated]";
        assert!(
            output.ends_with(marker),
            "output tail: {:?}",
            &output[output.len() - 64..]
        );
        assert_eq!(output.len(), cap + marker.len());
        assert!(output.starts_with("1\n2\n3"), "deterministic ASCII prefix");
    }

    // ── exec body-parse edges (validator-A cases 13-15) ───────────────

    #[tokio::test]
    async fn exec_non_json_or_empty_body_is_treated_as_empty_object() {
        // Validator-A cases 13-14: express's json() middleware skips bodies
        // whose content-type isn't JSON (and skips empty bodies), so the
        // handler sees `{}` and falls into command-is-required.
        let dir = tempfile::tempdir().unwrap();
        let cases: Vec<(Option<&str>, &[u8])> = vec![
            (Some("text/plain"), b"command=true"),
            (Some("application/json"), b""),
            (None, b""),
        ];
        for (content_type, body) in cases {
            let resp = call_exec(dir.path(), exec_headers(Some(TOKEN), content_type), body).await;
            assert_eq!(
                resp.status(),
                StatusCode::BAD_REQUEST,
                "content_type: {content_type:?}"
            );
            let value = body_json(resp).await;
            assert_eq!(value, json!({ "error": "command is required" }));
        }
    }

    #[tokio::test]
    async fn exec_malformed_json_body_is_400_invalid_json_body() {
        // Documented divergence 1: Node serves express's HTML SyntaxError
        // page (not byte-stable); this port returns a JSON envelope.
        let dir = tempfile::tempdir().unwrap();
        let resp = call_exec(
            dir.path(),
            exec_headers(Some(TOKEN), Some("application/json")),
            b"{bad json",
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let value = body_json(resp).await;
        assert_eq!(value, json!({ "error": "invalid JSON body" }));
    }

    #[tokio::test]
    async fn exec_vendor_suffix_json_content_type_is_skipped_not_parsed() {
        // Task 2 review I1: express's json() default type is EXACTLY
        // `application/json` — type-is's expected pattern does NOT match
        // `application/*+json` structured-suffix vendor types, so
        // body-parser skips parsing and the handler sees `{}` →
        // command-is-required (it must NOT parse the body and execute).
        let dir = tempfile::tempdir().unwrap();
        let command_body = json_body("echo should-not-run", Some(dir.path()));
        for content_type in ["application/cloudevents+json", "application/hal+json"] {
            let resp = call_exec(
                dir.path(),
                exec_headers(Some(TOKEN), Some(content_type)),
                &command_body,
            )
            .await;
            assert_eq!(
                resp.status(),
                StatusCode::BAD_REQUEST,
                "content_type: {content_type}"
            );
            let value = body_json(resp).await;
            assert_eq!(value, json!({ "error": "command is required" }));
        }
        // Positive control: the same body IS parsed and executed under the
        // exact type, with parameters or in any casing.
        for content_type in ["application/json; charset=utf-8", "APPLICATION/JSON"] {
            let resp = call_exec(
                dir.path(),
                exec_headers(Some(TOKEN), Some(content_type)),
                &command_body,
            )
            .await;
            assert_eq!(
                resp.status(),
                StatusCode::OK,
                "content_type: {content_type}"
            );
            let value = body_json(resp).await;
            assert_eq!(value["output"], "should-not-run");
        }
    }

    #[tokio::test]
    async fn exec_valid_non_object_json_body_is_400_command_required() {
        // Task 2 review Minor: valid JSON whose top level is not an object
        // has no `command` key (Node: JSON.parse then `body.command` is
        // undefined), so it collapses to `{}` → command-is-required — NOT
        // the invalid-JSON envelope. (Divergence-1 class for top-level
        // primitives, which body-parser strict mode rejects with an HTML
        // page; exact match for arrays, which body-parser parses.)
        let dir = tempfile::tempdir().unwrap();
        let bodies: [&[u8]; 3] = [b"5", b"\"x\"", b"[1]"];
        for body in bodies {
            let resp = call_exec(
                dir.path(),
                exec_headers(Some(TOKEN), Some("application/json")),
                body,
            )
            .await;
            assert_eq!(
                resp.status(),
                StatusCode::BAD_REQUEST,
                "body: {}",
                String::from_utf8_lossy(body)
            );
            let value = body_json(resp).await;
            assert_eq!(value, json!({ "error": "command is required" }));
        }
    }
}
