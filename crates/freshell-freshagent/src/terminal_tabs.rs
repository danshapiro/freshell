//! Slice 1 of the agent-API + MCP parity spec
//! (`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md`): terminal / browser /
//! editor `POST /api/tabs`, `GET /api/tabs`, and the terminal-pane extensions to
//! `send-keys` / `capture` / `wait-for`.
//!
//! Kept in its own module (not `lib.rs`) to bound file growth. Wired into
//! `router()` in `lib.rs`; the existing `agent:"opencode"` fresh-agent path in
//! `lib.rs::create_tab`/`send_keys`/`capture` is UNCHANGED -- this module only
//! adds a disjoint set of pane/tab kinds (`terminal_panes` / `content_panes` /
//! `tabs`, all new [`FreshAgentState`] fields) so AGENT-08 continuity cannot
//! regress.
//!
//! ## Scope (see the spec's §4.2 delta table + this crate's own report)
//!
//! - `POST /api/tabs` terminal mode: **`shell` only**. `claude`/`codex`/`gemini`/
//!   `kimi` require the full provider-settings + Codex-launch-planner stack the
//!   spec's own delta table lists as separate "BUILD" items; wiring those is
//!   deferred and returns an honest 400 naming the deferral (not a silent
//!   fallback or wrong behavior).
//! - `POST /api/tabs` `browser`/`editor`: the "cheap" content kinds -- no
//!   process, just the `paneContent` JSON the frozen client folds via
//!   `ui.command{tab.create}`.
//! - Terminal panes are spawned through the **shared** [`freshell_terminal::TerminalRegistry`]
//!   the WS `terminal.create` path uses (wired in from `freshell-server`'s
//!   `main.rs` via [`crate::FreshAgentState::with_terminal_registry`]) -- one
//!   registry, no orphan PTYs (spec §9 Risk 1).
//! - `send-keys`/`capture`/`wait-for` are extended for terminal panes only;
//!   browser/editor send-keys/wait-for fall through to the pre-existing 404
//!   ("pane not found") -- legacy returns "terminal not found" for the same
//!   case, a documented minor wording deviation.

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::Router;
use serde_json::{json, Value};
use uuid::Uuid;

use freshell_platform::SpawnSpec;
use freshell_protocol::{ServerMessage, UiCommand};

use crate::{
    authorized, fail_json, ok_json, text_plain, FreshAgentState, TabRecord, TerminalPaneEntry,
};

/// Modes Slice 1 actually wires to a real terminal. Every other value is an
/// honest 400 naming the deferral (spec §4.2's own "BUILD" backlog), never a
/// silent wrong-behavior fallback.
const SUPPORTED_TERMINAL_MODES: &[&str] = &["shell"];

// ── POST /api/tabs (terminal / browser / editor) ───────────────────────────

/// Dispatch the non-agent shapes of `POST /api/tabs` (`router.ts:695-831`):
/// `browser` truthy -> browser pane; `editor` truthy -> editor pane; otherwise
/// terminal (`mode||'shell'`). Mutually exclusive, matching the original's
/// `if/else if/else` chain.
pub(crate) async fn create_terminal_or_content_tab(
    state: FreshAgentState,
    body: Value,
) -> Response {
    let name = body.get("name").and_then(Value::as_str).map(str::to_string);

    if let Some(url) = body.get("browser").and_then(Value::as_str) {
        return create_content_tab(
            &state,
            name,
            "browser",
            json!({
                "kind": "browser",
                "url": url,
                "devToolsOpen": false,
            }),
        );
    }
    if let Some(file_path) = body.get("editor").and_then(Value::as_str) {
        return create_content_tab(
            &state,
            name,
            "editor",
            json!({
                "kind": "editor",
                "filePath": file_path,
                "language": Value::Null,
                "readOnly": false,
                "content": "",
                "viewMode": "source",
                "wordWrap": true,
            }),
        );
    }
    create_terminal_tab(&state, name, &body).await
}

/// The "cheap" content kinds (`router.ts:720-723`): no process, no rollback
/// concerns -- attach the pane content, broadcast, respond.
fn create_content_tab(
    state: &FreshAgentState,
    name: Option<String>,
    kind: &str,
    pane_content: Value,
) -> Response {
    let tab_id = Uuid::new_v4().to_string();
    let pane_id = Uuid::new_v4().to_string();

    state
        .content_panes
        .lock()
        .expect("content_panes mutex")
        .insert(pane_id.clone(), pane_content.clone());
    state.tabs.lock().expect("tabs mutex").insert(
        tab_id.clone(),
        TabRecord {
            id: tab_id.clone(),
            title: name.clone(),
            pane_id: pane_id.clone(),
            kind: kind.to_string(),
        },
    );

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "tab.create".to_string(),
        payload: Some(json!({
            "id": tab_id,
            "title": name,
            "paneId": pane_id,
            "paneContent": pane_content,
        })),
    }));

    ok_json(json!({ "tabId": tab_id, "paneId": pane_id }), "tab created")
}

/// `SHELL` env var, else `/bin/bash` -- the Linux default-shell fallback
/// (`getSystemShell`, `terminal-registry.ts`). Slice 1 scope note: this port
/// does NOT reproduce the original's `{system,cmd,powershell,wsl}` x
/// `{Linux,WSL,Windows}` resolution matrix (`freshell_platform::build_spawn_spec`
/// covers that fully, but wiring its `Env`/`FileProbe` injection here is out of
/// this slice's bounded scope) -- every requested `shell` value launches the
/// host's default shell. Acceptable because the QA lever's shell mode only
/// needs A real interactive shell, not shell-type fidelity.
fn shell_spawn_spec(cwd: Option<&str>) -> SpawnSpec {
    let program = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    SpawnSpec {
        program,
        args: vec![],
        env_overrides: BTreeMap::new(),
        cwd: cwd.map(str::to_string),
        cols: 120,
        rows: 30,
    }
}

/// The child env: parent env minus `STRIP_ENV` (`buildSpawnSpec`,
/// `terminal-registry.ts:1083-1097` -- never leak the server's own secrets
/// (`AUTH_TOKEN`, etc.) into a spawned shell).
fn build_shell_env() -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    for key in freshell_platform::spawn::STRIP_ENV {
        env.remove(*key);
    }
    env
}

/// The terminal-mode path (`router.ts:724-793`): resolve provider settings
/// (Slice 1: shell only), spawn through the shared registry, attach
/// `paneContent`, broadcast `ui.command{tab.create}` with the legacy-exact
/// payload keys. On failure: nothing was ever recorded (tab/pane ids are
/// local variables until the spawn succeeds) -- atomic rollback by
/// construction, matching the original's cleanup-then-error contract
/// (`router.ts:817-831`) without needing an explicit cleanup step.
async fn create_terminal_tab(
    state: &FreshAgentState,
    name: Option<String>,
    body: &Value,
) -> Response {
    let mode = body
        .get("mode")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .unwrap_or("shell")
        .to_string();

    if !SUPPORTED_TERMINAL_MODES.contains(&mode.as_str()) {
        return fail_json(
            StatusCode::BAD_REQUEST,
            format!(
                "mode \"{mode}\" is not yet supported by the Rust port's Agent-API terminal-create \
                 path (Slice 1 ships shell only; claude/codex/gemini/kimi terminal-mode wiring is \
                 deferred -- see docs/plans/2026-07-18-agent-api-mcp-parity-spec.md §4.2). Use \
                 {{\"agent\":\"opencode\"}} for the fresh-agent path, or open an issue if you need \
                 this mode."
            ),
        );
    }

    let Some(registry) = state.terminal_registry.clone() else {
        return fail_json(
            StatusCode::SERVICE_UNAVAILABLE,
            "terminal registry not wired on this server".to_string(),
        );
    };

    let shell = body
        .get("shell")
        .and_then(Value::as_str)
        .map(str::to_string);
    let cwd = body.get("cwd").and_then(Value::as_str).map(str::to_string);
    let resume_session_id = body
        .get("resumeSessionId")
        .and_then(Value::as_str)
        .map(str::to_string);

    // Validate `cwd` up front: a nonexistent directory would otherwise fail
    // INSIDE the spawned child (post-fork), which a synchronous `registry.create`
    // call cannot observe -- checking here keeps the atomic-rollback contract
    // (spec \u00a72.1 "Atomic rollback is part of the contract") honest and testable.
    if let Some(dir) = &cwd {
        if !std::path::Path::new(dir).is_dir() {
            return fail_json(
                StatusCode::BAD_REQUEST,
                format!("cwd \"{dir}\" does not exist"),
            );
        }
    }

    let terminal_id = Uuid::new_v4().to_string();
    let stream_id = Uuid::new_v4().to_string();

    let spec = shell_spawn_spec(cwd.as_deref());
    let env = build_shell_env();

    // NOTE: `on_exit` is `None` here -- harmless for this shell-only REST
    // create path (Slice 1), since shell terminals never arm a session
    // locator. A future rich-agent REST create path (claude/codex/gemini/
    // kimi terminal-mode) that arms a locator (e.g. `AmplifierLocator`,
    // `OpencodeLocator`) on create would also need to disarm it on exit --
    // this call site would need a real `on_exit` hook wired in for that to
    // happen. Flagging for the next slice
    // (docs/plans/2026-07-18-agent-api-mcp-parity-spec.md §4.2).
    if let Err(err) = registry.create(&spec, &env, terminal_id.clone(), stream_id, None, None) {
        // Nothing was recorded yet (no tab, no pane, no map entry) -> rollback
        // is a no-op by construction.
        return fail_json(
            StatusCode::BAD_REQUEST,
            format!("failed to spawn shell terminal: {err}"),
        );
    }

    let tab_id = Uuid::new_v4().to_string();
    let pane_id = Uuid::new_v4().to_string();

    let mut pane_content = json!({
        "kind": "terminal",
        "terminalId": terminal_id,
        "status": "running",
        "mode": mode,
        "shell": shell.clone().unwrap_or_else(|| "system".to_string()),
        "initialCwd": cwd,
    });
    if let Some(rsid) = &resume_session_id {
        pane_content["resumeSessionId"] = json!(rsid);
    }

    state
        .terminal_panes
        .lock()
        .expect("terminal_panes mutex")
        .insert(
            pane_id.clone(),
            TerminalPaneEntry {
                terminal_id: terminal_id.clone(),
            },
        );
    state.tabs.lock().expect("tabs mutex").insert(
        tab_id.clone(),
        TabRecord {
            id: tab_id.clone(),
            title: name.clone(),
            pane_id: pane_id.clone(),
            kind: "terminal".to_string(),
        },
    );

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "tab.create".to_string(),
        payload: Some(json!({
            "id": tab_id,
            "title": name,
            "mode": mode,
            "shell": shell,
            "terminalId": terminal_id,
            "initialCwd": cwd,
            "resumeSessionId": resume_session_id,
            "paneId": pane_id,
            "paneContent": pane_content,
        })),
    }));

    ok_json(
        json!({ "tabId": tab_id, "paneId": pane_id, "terminalId": terminal_id }),
        "tab created",
    )
}

// ── GET /api/tabs ───────────────────────────────────────────────────────────

/// `GET /api/tabs` (`router.ts:879-883`): `{tabs, activeTabId}`. Reduced shape
/// vs. the legacy `layoutStore.listTabs()` row (no split/layout tree -- this
/// port keeps no server-side layout store, see `rename_pane`'s doc comment in
/// `lib.rs` for the established precedent) -- sufficient for MCP target
/// resolution (`resolveTabTarget` only needs `id`/`title`).
pub(crate) async fn list_tabs(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let tabs: Vec<Value> = state
        .tabs
        .lock()
        .expect("tabs mutex")
        .values()
        .map(|t| json!({ "id": t.id, "title": t.title, "paneId": t.pane_id, "kind": t.kind }))
        .collect();
    ok_json(json!({ "tabs": tabs, "activeTabId": Value::Null }), "")
}

/// `GET /api/panes` (`router.ts:898-902`): `{panes}`, optionally filtered by
/// `?tabId=`. Added post-hoc (proof round in `docs/plans/2026-07-18-agent-api-mcp-parity-spec.md`
/// \u00a76.2/\u00a78.3): the legacy Node MCP binary's `resolvePaneTarget`/`fetchPanes`
/// (`freshell-tool.js:130-136`) calls this to resolve a bare pane-id target
/// before `send-keys`/`capture-pane`/`wait-for` -- WITHOUT it, every MCP action
/// past `new-tab` 404s inside the MCP client's own target resolution, even
/// though the underlying REST routes work fine when hit directly (proven by
/// the direct-REST e2e round trip). Each row carries `id`/`tabId`/`title`/
/// `kind`/`terminalId` -- the fields `resolvePaneTarget` and `handleDisplay`
/// read (`freshell-tool.js:151-207`).
pub(crate) async fn list_panes(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let tab_filter = params.get("tabId");
    let terminal_panes = state.terminal_panes.lock().expect("terminal_panes mutex").clone();
    let panes: Vec<Value> = state
        .tabs
        .lock()
        .expect("tabs mutex")
        .values()
        .filter(|t| tab_filter.is_none_or(|tid| tid == &t.id))
        .map(|t| {
            let terminal_id = terminal_panes.get(&t.pane_id).map(|p| p.terminal_id.clone());
            json!({
                "id": t.pane_id,
                "tabId": t.id,
                "title": t.title,
                "kind": t.kind,
                "terminalId": terminal_id,
            })
        })
        .collect();
    ok_json(json!({ "panes": panes }), "")
}

// ── terminal-pane extensions to send-keys / capture / wait-for ─────────────

/// If `pane_id` names a Slice-1 terminal pane, write `data|keys|text` to its
/// PTY and respond `{terminalId}` (`router.ts:1757-1781`'s terminal branch,
/// minus the Codex-identity/`expectedSessionRef` gating which does not apply
/// to shell mode). Returns `None` when the pane is not a terminal pane, so the
/// caller (`lib.rs::send_keys`) falls through to the existing fresh-agent-only
/// path unchanged.
pub(crate) fn maybe_send_keys(
    state: &FreshAgentState,
    pane_id: &str,
    body: &Value,
) -> Option<Response> {
    let terminal_id = state
        .terminal_panes
        .lock()
        .expect("terminal_panes mutex")
        .get(pane_id)
        .map(|p| p.terminal_id.clone())?;

    let Some(registry) = state.terminal_registry.clone() else {
        return Some(fail_json(
            StatusCode::SERVICE_UNAVAILABLE,
            "terminal registry not wired on this server".to_string(),
        ));
    };

    let text = body
        .get("data")
        .or_else(|| body.get("keys"))
        .or_else(|| body.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if text.is_empty() {
        return Some(fail_json(
            StatusCode::BAD_REQUEST,
            "text is required".to_string(),
        ));
    }
    if !registry.is_running(&terminal_id) {
        return Some(fail_json(
            StatusCode::NOT_FOUND,
            "terminal not found".to_string(),
        ));
    }
    registry.input(&terminal_id, text.as_bytes());
    Some(ok_json(json!({ "terminalId": terminal_id }), "input sent"))
}

/// Render a terminal pane's scrollback as text (`renderCapture`, `router.ts:904-935`
/// terminal branch). `S` (start line, 0-based; negative = last N lines) is
/// honored; `J`/`e` (join-wrapped-lines / include-ANSI) are Slice 1
/// no-ops -- documented reduced fidelity (the registry's retained scrollback
/// is already ANSI-stripped-free-form text, so `e` has nothing to add and
/// `J` has no wrap metadata to join). Returns `None` when the pane is not a
/// terminal or content pane, so the caller falls through unchanged.
pub(crate) fn maybe_capture(
    state: &FreshAgentState,
    pane_id: &str,
    params: &std::collections::HashMap<String, String>,
) -> Option<Response> {
    if let Some(terminal_id) = state
        .terminal_panes
        .lock()
        .expect("terminal_panes mutex")
        .get(pane_id)
        .map(|p| p.terminal_id.clone())
    {
        let Some(registry) = state.terminal_registry.clone() else {
            return Some(fail_json(
                StatusCode::SERVICE_UNAVAILABLE,
                "terminal registry not wired on this server".to_string(),
            ));
        };
        let snapshot = registry
            .directory()
            .into_iter()
            .find(|d| d.terminal_id == terminal_id)
            .map(|d| d.snapshot)
            .unwrap_or_default();
        let start = params.get("S").and_then(|s| s.parse::<i64>().ok());
        return Some(text_plain(apply_capture_start(&snapshot, start)));
    }

    if let Some(pane_content) = state
        .content_panes
        .lock()
        .expect("content_panes mutex")
        .get(pane_id)
        .cloned()
    {
        let kind = pane_content
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("");
        if kind == "editor" {
            let content = pane_content
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            return Some(text_plain(content));
        }
        // browser (or any other cheap content kind): 422, legacy-exact wording
        // (`router.ts:947-949`).
        return Some(fail_json(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("pane kind \"{kind}\" does not support capture-pane; use screenshot-pane"),
        ));
    }

    None
}

/// `S` semantics (`capture.ts`, best-effort Slice 1 port): a non-negative `S`
/// is a 0-based start line; a negative `S` is "last `|S|` lines". `None`
/// returns the full buffer.
fn apply_capture_start(snapshot: &str, start: Option<i64>) -> String {
    let Some(start) = start else {
        return snapshot.to_string();
    };
    let lines: Vec<&str> = snapshot.lines().collect();
    let from = if start < 0 {
        lines.len().saturating_sub((-start) as usize)
    } else {
        (start as usize).min(lines.len())
    };
    let mut out = lines[from..].join("\n");
    if snapshot.ends_with('\n') && !out.is_empty() {
        out.push('\n');
    }
    out
}

/// `GET /api/panes/:id/wait-for` (`router.ts:959-1067`), terminal branch only
/// (fresh-agent wait-for is Slice 3 -- not needed by the shell-mode QA lever
/// this spec's smoke test drives). `pattern` (regex) and `T`/`timeout` are
/// honored; `stable`/`exit`/`prompt` are Slice 3 (documented deferral -- an
/// absent pattern with none of those set matches legacy's "stable" fallback
/// path, which Slice 1 does not reproduce; such a request 400s here instead
/// of silently no-op-succeeding).
pub(crate) async fn wait_for(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let Some(terminal_id) = state
        .terminal_panes
        .lock()
        .expect("terminal_panes mutex")
        .get(&pane_id)
        .map(|p| p.terminal_id.clone())
    else {
        return fail_json(StatusCode::NOT_FOUND, "terminal not found".to_string());
    };
    let Some(registry) = state.terminal_registry.clone() else {
        return fail_json(
            StatusCode::SERVICE_UNAVAILABLE,
            "terminal registry not wired on this server".to_string(),
        );
    };

    let raw_pattern = params.get("pattern").or_else(|| params.get("p"));
    let pattern = match raw_pattern {
        Some(p) => match fancy_regex::Regex::new(p) {
            Ok(re) => Some(re),
            Err(_) => return fail_json(StatusCode::BAD_REQUEST, "invalid pattern".to_string()),
        },
        None => None,
    };
    if pattern.is_none() {
        // Slice 1 scope: `stable`/`exit`/`prompt` fallback modes are deferred.
        return fail_json(
            StatusCode::BAD_REQUEST,
            "wait-for requires `pattern` in this Rust port slice (stable/exit/prompt \
             are deferred -- see docs/plans/2026-07-18-agent-api-mcp-parity-spec.md §8)"
                .to_string(),
        );
    }
    let pattern = pattern.expect("checked above");

    let timeout_secs = params
        .get("T")
        .or_else(|| params.get("timeout"))
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(30.0);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs_f64(timeout_secs);

    loop {
        let text = registry
            .directory()
            .into_iter()
            .find(|d| d.terminal_id == terminal_id)
            .map(|d| d.snapshot)
            .unwrap_or_default();
        if pattern.is_match(&text).unwrap_or(false) {
            return ok_json(
                json!({ "matched": true, "reason": "pattern" }),
                "pattern matched",
            );
        }
        if std::time::Instant::now() >= deadline {
            return crate::approx_json(json!({ "matched": false }), "timeout");
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Slice 1 route tests (docs/plans/2026-07-18-agent-api-mcp-parity-spec.md §8.1)
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use std::sync::Arc;
    use tower::util::ServiceExt;

    fn state_with_registry() -> FreshAgentState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
            .with_terminal_registry(freshell_terminal::TerminalRegistry::new())
    }

    fn app(state: FreshAgentState) -> Router {
        crate::router(state)
    }

    async fn body_json(resp: Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn body_text(resp: Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    async fn post(router: Router, uri: &str, body: Value, auth: bool) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json");
        if auth {
            req = req.header("x-auth-token", "tok");
        }
        let resp = router
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        (status, body_json(resp).await)
    }

    async fn get(router: Router, uri: &str, auth: bool) -> (StatusCode, Value) {
        let mut req = Request::builder().method("GET").uri(uri);
        if auth {
            req = req.header("x-auth-token", "tok");
        }
        let resp = router
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        (status, body_json(resp).await)
    }

    async fn get_text(router: Router, uri: &str, auth: bool) -> (StatusCode, String) {
        let mut req = Request::builder().method("GET").uri(uri);
        if auth {
            req = req.header("x-auth-token", "tok");
        }
        let resp = router
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        (status, body_text(resp).await)
    }

    // ── POST /api/tabs (terminal: shell) ────────────────────────────────────

    #[tokio::test]
    async fn create_shell_tab_requires_auth() {
        let state = state_with_registry();
        let (status, body) = post(app(state), "/api/tabs", json!({ "mode": "shell" }), false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["status"], json!("error"));
    }

    #[tokio::test]
    async fn create_shell_tab_spawns_real_terminal_and_broadcasts_ui_command_tab_create() {
        let state = state_with_registry();
        let mut rx = state.broadcast_tx.subscribe();
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({ "mode": "shell", "cwd": tmp.to_string_lossy(), "name": "Test Shell" }),
            true,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], json!("ok"));
        let tab_id = body["data"]["tabId"].as_str().expect("tabId").to_string();
        let pane_id = body["data"]["paneId"].as_str().expect("paneId").to_string();
        let terminal_id = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();
        assert!(!tab_id.is_empty());
        assert!(!pane_id.is_empty());
        assert!(!terminal_id.is_empty());

        // The real PTY is alive in the SHARED registry (spec §9 Risk 1 -- no
        // second/orphan registry).
        let registry = state.terminal_registry.clone().expect("registry wired");
        assert!(registry.is_running(&terminal_id), "shell PTY is running");

        // ui.command{tab.create} broadcast, payload key-for-key against the
        // legacy shape (router.ts:775-789): id, title, mode, shell, terminalId,
        // initialCwd, paneId, paneContent{kind:'terminal',...}.
        let frame = rx.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(msg["type"], json!("ui.command"));
        assert_eq!(msg["command"], json!("tab.create"));
        let payload = &msg["payload"];
        assert_eq!(payload["id"], json!(tab_id));
        assert_eq!(payload["title"], json!("Test Shell"));
        assert_eq!(payload["mode"], json!("shell"));
        assert_eq!(payload["terminalId"], json!(terminal_id));
        assert_eq!(payload["initialCwd"], json!(tmp.to_string_lossy()));
        assert_eq!(payload["paneId"], json!(pane_id));
        assert_eq!(payload["paneContent"]["kind"], json!("terminal"));
        assert_eq!(payload["paneContent"]["terminalId"], json!(terminal_id));
        assert_eq!(payload["paneContent"]["status"], json!("running"));
    }

    #[tokio::test]
    async fn create_tab_defaults_to_shell_mode_when_mode_absent() {
        let state = state_with_registry();
        let (status, body) = post(app(state), "/api/tabs", json!({}), true).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["data"]["terminalId"].as_str().is_some());
    }

    #[tokio::test]
    async fn create_tab_unsupported_terminal_mode_is_400_with_deferral_message() {
        let state = state_with_registry();
        let (status, body) = post(app(state), "/api/tabs", json!({ "mode": "claude" }), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let msg = body["message"].as_str().unwrap();
        assert!(msg.contains("claude"), "{msg}");
        assert!(msg.contains("Slice 1"), "{msg}");
    }

    #[tokio::test]
    async fn create_tab_without_registry_wired_is_503() {
        // No `.with_terminal_registry(...)` -- mirrors every pre-Slice-1 test's
        // `FreshAgentState::new(...)` (existing opencode-only tests keep passing
        // unchanged; this asserts the NEW code path degrades safely too).
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let state = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let (status, _body) = post(app(state), "/api/tabs", json!({ "mode": "shell" }), true).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn create_tab_rollback_on_spawn_failure_leaves_no_tab_or_pane_or_registry_entry() {
        let state = state_with_registry();
        let (status, _body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({ "mode": "shell", "cwd": "/definitely/does/not/exist/xyz-slice1" }),
            true,
        )
        .await;
        assert_ne!(status, StatusCode::OK, "a bad cwd must fail the spawn");
        assert!(
            state.tabs.lock().unwrap().is_empty(),
            "no tab record left behind on failure"
        );
        assert!(
            state.terminal_panes.lock().unwrap().is_empty(),
            "no pane record left behind on failure"
        );
        assert!(
            state
                .terminal_registry
                .clone()
                .unwrap()
                .directory()
                .is_empty(),
            "no orphan PTY left behind on failure"
        );
    }

    // ── POST /api/tabs (browser / editor) ───────────────────────────────────

    #[tokio::test]
    async fn create_browser_tab_attaches_browser_pane_content_and_no_terminal() {
        let state = state_with_registry();
        let mut rx = state.broadcast_tx.subscribe();
        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({ "browser": "https://example.com" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["data"]["tabId"].as_str().is_some());
        assert!(body["data"]["paneId"].as_str().is_some());
        assert!(body["data"].get("terminalId").is_none());

        let frame = rx.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(msg["command"], json!("tab.create"));
        assert_eq!(msg["payload"]["paneContent"]["kind"], json!("browser"));
        assert_eq!(
            msg["payload"]["paneContent"]["url"],
            json!("https://example.com")
        );
    }

    #[tokio::test]
    async fn create_editor_tab_attaches_editor_pane_content() {
        let state = state_with_registry();
        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({ "editor": "/tmp/some/file.txt" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["data"]["tabId"].as_str().is_some());
    }

    // ── GET /api/tabs ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn get_tabs_requires_auth() {
        let state = state_with_registry();
        let (status, _body) = get(app(state), "/api/tabs", false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn get_panes_requires_auth() {
        let state = state_with_registry();
        let (status, _body) = get(app(state), "/api/panes", false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    /// The MCP reuse-proof regression guard: legacy's Node MCP binary
    /// (`freshell-tool.js resolvePaneTarget`/`fetchPanes`) resolves a bare
    /// pane-id target via `GET /api/panes` BEFORE calling send-keys/capture/
    /// wait-for -- without this route those MCP actions 404 inside the MCP
    /// client's own resolution, even though the underlying REST routes work.
    #[tokio::test]
    async fn get_panes_lists_created_panes_with_id_and_terminal_id() {
        let state = state_with_registry();
        let router = app(state);
        let (_status, body) = post(router.clone(), "/api/tabs", json!({ "mode": "shell" }), true).await;
        let pane_id = body["data"]["paneId"].as_str().unwrap().to_string();
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        let (status, panes_body) = get(router, "/api/panes", true).await;
        assert_eq!(status, StatusCode::OK);
        let panes = panes_body["data"]["panes"].as_array().expect("panes array");
        assert_eq!(panes.len(), 1);
        assert_eq!(panes[0]["id"], json!(pane_id));
        assert_eq!(panes[0]["terminalId"], json!(terminal_id));
        assert_eq!(panes[0]["kind"], json!("terminal"));
    }

    #[tokio::test]
    async fn get_tabs_lists_every_created_tab_kind() {
        let state = state_with_registry();
        let router = app(state.clone());
        let _ = post(
            router.clone(),
            "/api/tabs",
            json!({ "mode": "shell" }),
            true,
        )
        .await;
        let _ = post(
            router.clone(),
            "/api/tabs",
            json!({ "browser": "https://example.com" }),
            true,
        )
        .await;

        let (status, body) = get(router, "/api/tabs", true).await;
        assert_eq!(status, StatusCode::OK);
        let tabs = body["data"]["tabs"].as_array().expect("tabs array");
        assert_eq!(tabs.len(), 2);
        let kinds: Vec<&str> = tabs.iter().map(|t| t["kind"].as_str().unwrap()).collect();
        assert!(kinds.contains(&"terminal"));
        assert!(kinds.contains(&"browser"));
    }

    // ── terminal send-keys / capture / wait-for (real PTY round trip) ──────

    async fn create_shell(router: Router) -> (String, String) {
        let (status, body) = post(
            router,
            "/api/tabs",
            json!({ "mode": "shell", "cwd": std::env::temp_dir().to_string_lossy() }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        (
            body["data"]["paneId"].as_str().unwrap().to_string(),
            body["data"]["terminalId"].as_str().unwrap().to_string(),
        )
    }

    /// The QA-lever proof (spec §8.2/§6.3): create a shell pane, send-keys an
    /// echo with a unique marker, wait-for the marker, capture and assert it's
    /// present -- the exact sequence the e2e browser test and the MCP
    /// reuse-proof both drive over REST.
    #[tokio::test]
    async fn send_keys_then_wait_for_then_capture_round_trips_a_real_shell_command() {
        let state = state_with_registry();
        let router = app(state);
        let (pane_id, _terminal_id) = create_shell(router.clone()).await;

        let (send_status, _send_body) = post(
            router.clone(),
            &format!("/api/panes/{pane_id}/send-keys"),
            json!({ "data": "echo FRESHELL_SLICE1_MARKER\r" }),
            true,
        )
        .await;
        assert_eq!(send_status, StatusCode::OK);

        let (wait_status, wait_body) = get(
            router.clone(),
            &format!("/api/panes/{pane_id}/wait-for?pattern=FRESHELL_SLICE1_MARKER&T=15"),
            true,
        )
        .await;
        assert_eq!(wait_status, StatusCode::OK);
        assert_eq!(wait_body["data"]["matched"], json!(true));

        let (capture_status, capture_text) =
            get_text(router, &format!("/api/panes/{pane_id}/capture"), true).await;
        assert_eq!(capture_status, StatusCode::OK);
        assert!(
            capture_text.contains("FRESHELL_SLICE1_MARKER"),
            "capture must contain the echoed marker: {capture_text}"
        );
    }

    #[tokio::test]
    async fn send_keys_unknown_pane_falls_through_to_pane_not_found_404() {
        let state = state_with_registry();
        let (status, body) = post(
            app(state),
            "/api/panes/does-not-exist/send-keys",
            json!({ "data": "echo hi\r" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["message"], json!("pane not found"));
    }

    #[tokio::test]
    async fn wait_for_requires_auth() {
        let state = state_with_registry();
        let (status, _body) = get(app(state), "/api/panes/x/wait-for?pattern=y", false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn wait_for_unknown_pane_is_404_terminal_not_found() {
        let state = state_with_registry();
        let (status, body) = get(
            app(state),
            "/api/panes/does-not-exist/wait-for?pattern=x&T=1",
            true,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["message"], json!("terminal not found"));
    }

    #[tokio::test]
    async fn wait_for_never_matching_pattern_times_out_as_approx() {
        let state = state_with_registry();
        let router = app(state);
        let (pane_id, _terminal_id) = create_shell(router.clone()).await;

        let (status, body) = get(
            router,
            &format!("/api/panes/{pane_id}/wait-for?pattern=NEVER_APPEARS_XYZ&T=1"),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], json!("approx"));
        assert_eq!(body["data"]["matched"], json!(false));
        assert_eq!(body["message"], json!("timeout"));
    }

    // ── content-pane capture semantics ───────────────────────────────────────

    #[tokio::test]
    async fn capture_editor_pane_returns_content_text() {
        let state = state_with_registry();
        let router = app(state);
        let (_status, body) = post(
            router.clone(),
            "/api/tabs",
            json!({ "editor": "/tmp/some/file.txt" }),
            true,
        )
        .await;
        let pane_id = body["data"]["paneId"].as_str().unwrap();

        let (status, _text) =
            get_text(router, &format!("/api/panes/{pane_id}/capture"), true).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn capture_browser_pane_is_422_use_screenshot_pane() {
        let state = state_with_registry();
        let router = app(state);
        let (_status, body) = post(
            router.clone(),
            "/api/tabs",
            json!({ "browser": "https://example.com" }),
            true,
        )
        .await;
        let pane_id = body["data"]["paneId"].as_str().unwrap();

        let (status, resp_body) = get(router, &format!("/api/panes/{pane_id}/capture"), true).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(resp_body["message"]
            .as_str()
            .unwrap()
            .contains("use screenshot-pane"));
    }
}
