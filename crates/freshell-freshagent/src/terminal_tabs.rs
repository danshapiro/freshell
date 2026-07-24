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
use std::collections::HashSet;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Value};
use uuid::Uuid;

use freshell_platform::detect::{host_os_live, is_windows, is_wsl_env_live};
use freshell_platform::mcp_inject::{cleanup_mcp_config, generate_mcp_injection, RealMcpRuntime};
use freshell_platform::spawn::{
    cli_provider_target, resolve_coding_cli_command, resolve_mcp_cwd, resolve_shell,
    CliLaunchInputs, LaunchIntent,
};
use freshell_platform::{
    build_cli_spawn_spec, build_spawn_spec, build_windows_cli_spawn_spec, CliLaunch, Env, RealEnv,
    RealFileProbe, ShellType, SpawnSpec,
};
use freshell_protocol::{ServerMessage, SessionLocator, UiCommand};

use crate::{
    authorized, fail_json, ok_json, text_plain, FreshAgentState, TabRecord, TerminalPaneEntry,
};

/// The exact legacy rejection text for a raw (non-`sessionRef`) `resumeSessionId`
/// on a `mode:"codex"` create -- mirrors
/// `server/coding-cli/codex-app-server/restore-decision.ts:27-28`'s
/// `INVALID_RAW_CODEX_RESUME_MESSAGE` verbatim (a frozen TS string literal,
/// not importable from Rust) so a REST client sees byte-identical text to the
/// legacy Node server for this specific rejection.
const INVALID_RAW_CODEX_RESUME_MESSAGE: &str = "Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.";

// -- mode / resume-id / sessionRef derivation (router.ts:695-793 semantics) --

/// Is `mode` a real, registered terminal launch target? `shell` always is;
/// every other value must be a known coding-CLI spec (`state.cli_commands`,
/// the SAME list the WS `terminal.create` path resolves `mode` against --
/// `crates/freshell-ws/src/terminal.rs:716` `cli_spec_known`). Unlike Slice
/// 1's hardcoded single-mode allowlist, this is generic over whatever the
/// server's extension registry discovered at boot (claude/codex/gemini/kimi/
/// opencode/amplifier/...), so REST/WS create-mode parity does not require
/// updating two lists in lockstep.
fn mode_is_known(state: &FreshAgentState, mode: &str) -> bool {
    mode == "shell" || state.cli_commands.iter().any(|s| s.name == mode)
}

/// `acceptedSessionRefForMode` (`router.ts:230-236`): a `sessionRef` is only
/// honored when its `provider` matches the terminal's own `mode` -- a
/// `sessionRef` minted for a different provider is silently NOT accepted
/// (falls through to the raw `resumeSessionId` path instead).
fn accepted_session_ref_for_mode<'a>(
    session_ref: Option<&'a SessionLocator>,
    mode: &str,
) -> Option<&'a SessionLocator> {
    session_ref.filter(|r| r.provider == mode)
}

/// `requestedResumeSessionIdForMode` (`router.ts:214-228`): resolve the ONE
/// resume-session-id a create should launch with -- the accepted
/// `sessionRef` first, else (every mode EXCEPT `codex`) the legacy raw
/// `resumeSessionId` field. `codex` is special-cased (`router.ts:221-226`,
/// throwing `AgentRouteInputError(INVALID_RAW_CODEX_RESUME_MESSAGE)`): a raw
/// `resumeSessionId` with no matching `sessionRef` is REJECTED outright
/// (400), not silently accepted -- a bare codex thread id alone is not
/// sufficient restore identity per the durable-thread contract
/// (`restore-decision.ts`).
///
/// NOTE: the Rust port's WS `terminal.create` handler
/// (`crates/freshell-ws/src/terminal.rs:763-766`) does NOT yet enforce this
/// rejection -- it accepts a raw codex `resumeSessionId` unconditionally, a
/// known, separately-tracked deviation (DEV-0006: the codex app-server
/// launch planner is not wired into `terminal.create` yet). This REST path
/// mirrors the ROUTER (the frozen legacy contract) for this specific
/// decision, per this slice's explicit scope, rather than the WS Rust port's
/// current interim state.
///
/// `Response` is a large `Err` payload (`clippy::result_large_err`), but this
/// mirrors every other handler in this module (`fail_json` returns `Response`
/// directly everywhere else) -- boxing just this one call site would be
/// inconsistent with the module's own established convention for no real
/// benefit at this call volume (one per `POST /api/tabs`).
#[allow(clippy::result_large_err)]
fn requested_resume_session_id_for_mode(
    session_ref: Option<&SessionLocator>,
    mode: &str,
    legacy_resume_session_id: Option<&str>,
) -> Result<Option<String>, Response> {
    if let Some(accepted) = accepted_session_ref_for_mode(session_ref, mode) {
        return Ok(Some(accepted.session_id.clone()));
    }
    let legacy = legacy_resume_session_id.filter(|s| !s.is_empty());
    if mode == "codex" {
        if legacy.is_some() {
            return Err(fail_json(
                StatusCode::BAD_REQUEST,
                INVALID_RAW_CODEX_RESUME_MESSAGE.to_string(),
            ));
        }
        return Ok(None);
    }
    Ok(legacy.map(str::to_string))
}

/// The terminal modes whose sessions live in a provider-durable store the
/// session directory can resolve (`amplifier`/`opencode`/`claude`/`gemini`/
/// `kimi`) -- the providers for which a bare `resumeSessionId` IS sufficient
/// canonical identity to mint `sessionRef {provider: mode, sessionId}`.
/// Deliberately NOT `codex`: a raw codex thread id alone is not restore
/// identity (`INVALID_RAW_CODEX_RESUME_MESSAGE` / `restore-decision.ts`), and
/// [`requested_resume_session_id_for_mode`] rejects it before this list is
/// ever consulted.
fn is_session_provider_mode(mode: &str) -> bool {
    matches!(
        mode,
        "amplifier" | "opencode" | "claude" | "gemini" | "kimi"
    )
}

/// Plausibility gate for synthesizing a `sessionRef` from a caller-supplied
/// legacy `resumeSessionId` (EDEV-07): `claude` ids must be canonical session
/// UUIDs (reuses `freshell_sessions::text::is_canonical_claude_session_id`,
/// the SAME validator the session indexer and the frozen client's
/// `CLAUDE_SESSION_ID_RE` enforce), and `opencode` ids must be `ses_*` rows
/// (the published shape contract: `shared/session-flavor.ts:65`
/// `isDurableProviderSessionId` requires `/^ses_/` for opencode). The
/// remaining session providers have no published id-shape contract (amplifier
/// ids are directory names, gemini/kimi are opaque), so their gate is the
/// honest minimum: non-empty with no whitespace -- an id that couldn't
/// possibly name a stored session is left on the legacy `resumeSessionId`
/// path instead of being promoted to canonical identity.
fn plausible_resume_session_id(mode: &str, id: &str) -> bool {
    if mode == "claude" {
        return freshell_sessions::text::is_canonical_claude_session_id(id);
    }
    if mode == "opencode" && !id.starts_with("ses_") {
        return false;
    }
    !id.is_empty() && !id.chars().any(char::is_whitespace)
}

/// `now_ms()` (`Date.now()`) -- the locator arm/note-submit clock. Mirrors
/// `crates/freshell-ws/src/terminal.rs::now_ms` (a separate, private copy per
/// crate boundary -- see this module's top-level doc for why
/// `freshell-freshagent` cannot depend on `freshell-ws`).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── POST /api/tabs (terminal / browser / editor) ───────────────────────────

/// Dispatch the non-agent shapes of `POST /api/tabs` (`router.ts:695-831`):
/// `browser` truthy -> browser pane; `editor` truthy -> editor pane; otherwise
/// terminal (`mode||'shell'`). Mutually exclusive, matching the original's
/// `if/else if/else` chain.
///
/// Also driven in-process by `freshell-server`'s `POST /api/tabs-sync/restore`
/// (continuity trio) — restore MUST reuse this exact pipeline because it is the
/// path that stamps session identity.
pub async fn create_terminal_or_content_tab(state: FreshAgentState, body: Value) -> Response {
    create_terminal_or_content_tab_with_delivery(state, body, true).await
}

/// Run the ordinary create pipeline but return its `ui.command` instead of
/// broadcasting it. Snapshot restore uses this to deliver the command to the
/// exact WebSocket connection selected under its restore lock.
pub async fn create_terminal_or_content_tab_deferred(
    state: FreshAgentState,
    body: Value,
) -> Response {
    create_terminal_or_content_tab_with_delivery(state, body, false).await
}

async fn create_terminal_or_content_tab_with_delivery(
    state: FreshAgentState,
    body: Value,
    broadcast: bool,
) -> Response {
    let name = body.get("name").and_then(Value::as_str).map(str::to_string);
    // Continuity trio (`tabs_snapshots.rs:632`): a restore-driven create tags
    // itself with a deterministic `restoreKey` so a restore RETRY can reconcile
    // a create whose write-ahead marker promotion never landed. Recorded after
    // the create succeeds; absent for ordinary creates.
    let restore_key = body
        .get("restoreKey")
        .and_then(Value::as_str)
        .map(str::to_string);

    if let Some(url) = body.get("browser").and_then(Value::as_str) {
        // `devToolsOpen` flows into the frozen client verbatim via
        // `paneContent` (ui-commands.ts `tab.create` -> initLayout), so a
        // snapshot restore can round-trip the captured value. Default stays
        // `false` for ordinary creates.
        return create_content_tab(
            &state,
            name,
            "browser",
            json!({
                "kind": "browser",
                "url": url,
                "devToolsOpen": body.get("devToolsOpen").and_then(Value::as_bool).unwrap_or(false),
            }),
            restore_key.as_deref(),
            broadcast,
        );
    }
    if let Some(file_path) = body
        .get("editor")
        .filter(|file_path| file_path.is_string() || file_path.is_null())
    {
        // language/readOnly/viewMode/wordWrap flow into the frozen client
        // verbatim via `paneContent` (same round-trip rationale as browser's
        // `devToolsOpen` above); defaults match the pre-existing behavior.
        return create_content_tab(
            &state,
            name,
            "editor",
            json!({
                "kind": "editor",
                "filePath": file_path,
                "language": body.get("language").and_then(Value::as_str)
                    .map(Value::from).unwrap_or(Value::Null),
                "readOnly": body.get("readOnly").and_then(Value::as_bool).unwrap_or(false),
                "content": "",
                "viewMode": body.get("viewMode").and_then(Value::as_str).unwrap_or("source"),
                "wordWrap": body.get("wordWrap").and_then(Value::as_bool).unwrap_or(true),
            }),
            restore_key.as_deref(),
            broadcast,
        );
    }
    create_terminal_tab(&state, name, &body, restore_key.as_deref(), broadcast).await
}

/// The "cheap" content kinds (`router.ts:720-723`): no process, no rollback
/// concerns -- attach the pane content, broadcast, respond.
fn create_content_tab(
    state: &FreshAgentState,
    name: Option<String>,
    kind: &str,
    pane_content: Value,
    restore_key: Option<&str>,
    broadcast: bool,
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
    state
        .pane_tabs
        .lock()
        .expect("pane_tabs mutex")
        .insert(pane_id.clone(), tab_id.clone());
    let command = ServerMessage::UiCommand(UiCommand {
        command: "tab.create".to_string(),
        payload: Some(json!({
            "id": tab_id,
            "title": name,
            "paneId": pane_id,
            "paneContent": pane_content,
        })),
    });
    // Record the replayable command BEFORE any delivery. A restore retry can
    // distinguish "created but never sent" from a send to its exact target.
    if let Some(key) = restore_key {
        state.record_restore_key(
            key,
            crate::RestoreKeyEntry {
                tab_id: tab_id.clone(),
                pane_id: pane_id.clone(),
                terminal_id: None,
                ui_command: command.clone(),
                delivered_to: HashSet::new(),
            },
        );
    }
    if broadcast {
        state.broadcast(&command);
    }

    let mut data = json!({ "tabId": tab_id, "paneId": pane_id });
    if !broadcast {
        data["uiCommand"] = serde_json::to_value(command).expect("UiCommand serializes");
    }
    ok_json(data, "tab created")
}

/// `getModeLabel` (`terminal-registry.ts:439-443`, mirrored from
/// `crates/freshell-ws/src/terminal.rs:1258` -- a separate, private copy per
/// crate boundary, see this module's top doc): `'Shell'` for shell, the CLI
/// spec label otherwise (capitalized-mode fallback is unreachable here --
/// unknown modes are rejected before launch by `mode_is_known`).
fn mode_label(mode: &str, cli: Option<&CliLaunch>) -> String {
    if mode == "shell" {
        return "Shell".to_string();
    }
    match cli {
        Some(l) if !l.label.is_empty() => l.label.clone(),
        _ => {
            let mut chars = mode.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        }
    }
}

/// `buildTerminalBaseEnv` (`terminal-registry.ts:1529-1542`, mirrored from
/// `crates/freshell-ws/src/terminal.rs:1278`): `FRESHELL`/`FRESHELL_URL`/
/// `FRESHELL_TOKEN`/`FRESHELL_TERMINAL_ID`/`+TAB`/`PANE` -- the Rust server's
/// canonical `PORT`/`AUTH_TOKEN` env plumbing carries over verbatim.
fn build_terminal_base_env(
    env: &dyn Env,
    terminal_id: &str,
    tab_id: Option<&str>,
    pane_id: Option<&str>,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    out.insert("FRESHELL".to_string(), "1".to_string());
    let port_raw = env
        .get("PORT")
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "3001".to_string());
    let url = env
        .get("FRESHELL_URL")
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("http://localhost:{}", js_number_string(&port_raw)));
    out.insert("FRESHELL_URL".to_string(), url);
    out.insert(
        "FRESHELL_TOKEN".to_string(),
        env.get("AUTH_TOKEN").unwrap_or_default(),
    );
    out.insert("FRESHELL_TERMINAL_ID".to_string(), terminal_id.to_string());
    if let Some(t) = tab_id.filter(|s| !s.is_empty()) {
        out.insert("FRESHELL_TAB_ID".to_string(), t.to_string());
    }
    if let Some(p) = pane_id.filter(|s| !s.is_empty()) {
        out.insert("FRESHELL_PANE_ID".to_string(), p.to_string());
    }
    out
}

/// JS `String(Number(s))` for the `PORT` template slot (mirrored from
/// `crates/freshell-ws/src/terminal.rs:1313`).
fn js_number_string(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        return "0".to_string();
    }
    match t.parse::<f64>() {
        Ok(n) if n.is_finite() => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                format!("{}", n as i64)
            } else {
                format!("{n}")
            }
        }
        _ => "NaN".to_string(),
    }
}

/// `wrapTerminalSpawnError` (`terminal-registry.ts:450-481`, mirrored from
/// `crates/freshell-ws/src/terminal.rs:1334`): the user-facing spawn-failure
/// message.
fn wrap_terminal_spawn_error(
    err: &std::io::Error,
    label: &str,
    file: &str,
    env_var: Option<&str>,
    resumed: bool,
) -> String {
    let action = if resumed {
        format!("Could not restore {label}")
    } else {
        format!("Could not start {label}")
    };
    if err.kind() == std::io::ErrorKind::NotFound {
        let common = format!(
            "\"{file}\" could not be started because the executable or working directory was not found on the server."
        );
        return match env_var {
            Some(v) => {
                format!("{action}: {common} Reinstall it or set {v} to the correct executable.")
            }
            None => format!(
                "{action}: {common} Check that the executable exists and the working directory is valid."
            ),
        };
    }
    let base = err.to_string();
    if base.is_empty() {
        format!("{action}: Failed to spawn terminal")
    } else if base.starts_with(&format!("{action}:")) {
        base
    } else {
        format!("{action}: {base}")
    }
}

/// Arm the amplifier/opencode session locator for a freshly-created REST
/// terminal, iff it's a fresh (non-resuming) pane of the matching mode with a
/// resolved cwd -- mirrors `crates/freshell-ws/src/amplifier_association::maybe_arm`
/// / `opencode_association::maybe_arm` EXACTLY (same shared-instance `arm()`
/// call, same argument shape); those wrapper fns are `pub(crate)` inside
/// `freshell-ws` and unreachable from this crate (circular-dependency
/// boundary, see this module's top doc), so this is the thin, crate-local
/// equivalent -- the actual mode/resume/cwd admission logic lives ONCE, inside
/// `AmplifierLocator::arm`/`OpencodeLocator::arm` themselves (shared by both
/// crates via `freshell-sessions`), not duplicated here.
fn arm_locators_for_fresh_pane(
    state: &FreshAgentState,
    terminal_id: &str,
    mode: &str,
    cwd: Option<&str>,
    resume_session_id: Option<&str>,
) {
    if let Some(locator) = &state.amplifier_locator {
        locator.arm(terminal_id, mode, true, resume_session_id, cwd, now_ms());
    }
    if let Some(locator) = &state.opencode_locator {
        locator.arm(terminal_id, mode, true, resume_session_id, cwd, now_ms());
    }
}

/// `sanitizeSessionRef` (`shared/session-contract.ts:55-62`) + `acceptedSessionRefForMode` /
/// `requestedResumeSessionIdForMode` (`router.ts:214-236`), fused into one call so both
/// `POST /api/tabs` ([`create_terminal_tab`]) and `POST /api/panes/:id/split`
/// (`pane_ops::split_pane`) derive the SAME resume identity from the SAME body shape,
/// matching the original router's own reuse of these two helpers across both routes
/// (`router.ts:726-731` / `:1290-1300`). A malformed `sessionRef` (missing/empty
/// `provider`/`sessionId`) is silently treated as absent, never a 400 -- `serde_json::from_value`
/// on the `{provider,sessionId}` shape gives the same "well-formed or `None`" behavior a
/// wrong-shaped JSON value would (`Err` -> `None`, since `SessionLocator`'s fields are
/// non-optional strings).
#[allow(clippy::result_large_err)]
pub(crate) fn derive_resume_identity(
    body: &Value,
    mode: &str,
) -> Result<(Option<String>, Option<SessionLocator>), Response> {
    let session_ref: Option<SessionLocator> = body
        .get("sessionRef")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok());
    let legacy_resume_session_id = body
        .get("resumeSessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let resume_session_id = requested_resume_session_id_for_mode(
        session_ref.as_ref(),
        mode,
        legacy_resume_session_id.as_deref(),
    )?;
    let accepted_session_ref = accepted_session_ref_for_mode(session_ref.as_ref(), mode).cloned();
    Ok((resume_session_id, accepted_session_ref))
}

/// The successful result of [`spawn_terminal_pane`]: the `paneContent` JSON + the
/// resolved `mode`/`shell`/`cwd`/`terminal_id`, everything a caller (tab-create or
/// pane-split) needs to build its own `ui.command` payload and success envelope
/// without re-deriving anything this function already computed.
pub(crate) struct TerminalSpawnResult {
    pub(crate) pane_content: Value,
    pub(crate) terminal_id: String,
    pub(crate) mode: String,
    pub(crate) shell: Option<String>,
    pub(crate) cwd: Option<String>,
}

/// DEV-0006 S4 gate, REST side (council fence: FLAG-GATED, default OFF): a codex
/// `POST /api/tabs` / pane-split create plans a managed app-server launch ONLY when the
/// mode is codex AND the `FRESHELL_CODEX_MANAGED_LAUNCH` flag is exactly `"1"` — the
/// SAME predicate the WS `terminal.create` branch gates on
/// (`crates/freshell-ws/src/terminal.rs::codex_create_uses_managed_launch`). Flag OFF
/// keeps the shipped plain-CLI REST codex behavior byte-identical.
fn codex_create_uses_managed_launch(mode: &str, flag_value: Option<&str>) -> bool {
    mode == "codex" && freshell_codex::launch_plan::codex_managed_launch_enabled(flag_value)
}

/// `agentRouteErrorStatus` (`router.ts:54-59`), scoped to the launch errors this
/// branch can produce: `CodexLaunchConfigError` → 400 (an input error — invalid
/// sandbox); every other launch failure (runtime/proxy IO, planner shutdown) → 500.
fn codex_launch_error_response(
    error: freshell_codex::launch_lifecycle::CodexLaunchError,
) -> Response {
    use freshell_codex::launch_lifecycle::CodexLaunchError;
    let status = match &error {
        CodexLaunchError::Config(_) => StatusCode::BAD_REQUEST,
        CodexLaunchError::Failed(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    fail_json(status, error.to_string())
}

/// The resumeSessionId ECHO (`router.ts:177`):
/// `opts.resumeSessionId ? (plan.sessionId ?? opts.resumeSessionId) : undefined`.
/// The registry record (and everything keyed off it — set_meta, paneContent
/// sessionRef promotion) carries THIS value, not the raw request field. TS truthiness:
/// an empty requested id counts as "not requested".
fn codex_effective_resume_session_id(
    requested: Option<&str>,
    plan_session_id: Option<&str>,
) -> Option<String> {
    match requested.filter(|s| !s.is_empty()) {
        Some(requested) => Some(plan_session_id.unwrap_or(requested).to_string()),
        None => None,
    }
}

/// The terminal-mode spawn pipeline (`router.ts:724-793` for create,
/// `router.ts:1326-1369` for split -- the original reuses the SAME
/// `resolveSpawnProviderSettings`/`registry.create` sequence for both routes, and this
/// port mirrors that reuse): resolve the requested mode against the registered
/// coding-CLI specs, derive the resume identity ([`derive_resume_identity`]), spawn
/// through the shared registry with the SAME argv/env-building pipeline the WS
/// `terminal.create` handler uses for `mode != "shell"`
/// (`crates/freshell-ws/src/terminal.rs:700-1050`: `cli_provider_target` ->
/// `resolve_mcp_cwd` -> `generate_mcp_injection` -> `CliLaunchInputs` ->
/// `resolve_coding_cli_command` -> `build_{cli_,windows_cli_,}spawn_spec`), arm the
/// amplifier/opencode locator for a fresh pane, register the `terminal_panes` +
/// `pane_tabs` bookkeeping, and return the built `paneContent`. Takes the caller-minted
/// `tab_id`/`pane_id` as parameters (a brand-new pair for create; an existing tab + a
/// brand-new pane for split) so this ONE pipeline serves both call sites -- on failure,
/// NOTHING is recorded (no `terminal_panes`/`pane_tabs` entry, no registry entry left
/// running) -- atomic rollback by construction, matching the original's
/// cleanup-then-error contract (`router.ts:817-831`, `:1387-1393`) without needing an
/// explicit cleanup step, PLUS the MCP-config cleanup the original also performs on a
/// failed create (`router.ts:819`, `cw:429-448`).
pub(crate) async fn spawn_terminal_pane(
    state: &FreshAgentState,
    body: &Value,
    tab_id: &str,
    pane_id: &str,
) -> Result<TerminalSpawnResult, Response> {
    let mode = body
        .get("mode")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .unwrap_or("shell")
        .to_string();

    if !mode_is_known(state, &mode) {
        return Err(fail_json(
            StatusCode::BAD_REQUEST,
            format!(
                "mode \"{mode}\" is not a registered terminal launch target on this server \
                 (no matching coding-CLI extension manifest, and it isn't \"shell\"). Use \
                 {{\"agent\":\"opencode\"}} for the fresh-agent path, or open an issue if you \
                 need this mode."
            ),
        ));
    }

    let Some(registry) = state.terminal_registry.clone() else {
        return Err(fail_json(
            StatusCode::SERVICE_UNAVAILABLE,
            "terminal registry not wired on this server".to_string(),
        ));
    };

    let shell_str = body
        .get("shell")
        .and_then(Value::as_str)
        .map(str::to_string);
    let cwd = body.get("cwd").and_then(Value::as_str).map(str::to_string);

    // Validate `cwd` up front: a nonexistent directory would otherwise fail
    // INSIDE the spawned child (post-fork), which a synchronous `registry.create`
    // call cannot observe -- checking here keeps the atomic-rollback contract
    // (spec 2.1 "Atomic rollback is part of the contract") honest and testable.
    if let Some(dir) = &cwd {
        if !std::path::Path::new(dir).is_dir() {
            return Err(fail_json(
                StatusCode::BAD_REQUEST,
                format!("cwd \"{dir}\" does not exist"),
            ));
        }
    }

    let (mut resume_session_id, accepted_session_ref) = derive_resume_identity(body, &mode)?;

    let terminal_id = Uuid::new_v4().to_string();
    let stream_id = Uuid::new_v4().to_string();

    let mut cli: Option<CliLaunch> = None;
    let mut mcp_cwd: Option<String> = None;
    // DEV-0006 S4 inc.2: the flag-gated managed codex launch (None for every other
    // mode, and for codex with the flag OFF). Planned inside the non-shell branch;
    // consumed at create-failure (discard) and post-create (adopt) below.
    let mut codex_launch: Option<freshell_codex::launch_lifecycle::CodexTerminalLaunch> = None;
    let spec: SpawnSpec;
    let child_env: BTreeMap<String, String>;

    if mode == "shell" {
        let host_os = host_os_live();
        let is_wsl = is_wsl_env_live();
        let shell_type = shell_str
            .as_deref()
            .and_then(ShellType::parse)
            .unwrap_or(ShellType::System);
        let overrides =
            build_terminal_base_env(&RealEnv, &terminal_id, Some(tab_id), Some(pane_id));
        spec = build_spawn_spec(
            shell_type,
            host_os,
            is_wsl,
            cwd.as_deref(),
            &RealEnv,
            &RealFileProbe,
            &overrides,
            None,
            None,
        );
        child_env = freshell_terminal::build_child_env_from_process(&spec);
    } else {
        let host_os = host_os_live();
        let is_wsl = is_wsl_env_live();
        let shell_type = shell_str
            .as_deref()
            .and_then(ShellType::parse)
            .unwrap_or(ShellType::System);

        let target = cli_provider_target(shell_type, host_os, is_wsl, cwd.as_deref(), &RealEnv);
        mcp_cwd = resolve_mcp_cwd(cwd.as_deref(), &RealEnv, host_os, is_wsl);

        let mcp_injection = match generate_mcp_injection(
            &RealMcpRuntime,
            &mode,
            &terminal_id,
            mcp_cwd.as_deref(),
            target,
        ) {
            Ok(i) => i,
            Err(e) => return Err(fail_json(StatusCode::BAD_REQUEST, e.message)),
        };

        // opencode: allocate the loopback control endpoint BEFORE building the
        // launch (mirrors `crates/freshell-ws/src/terminal.rs:802-813`).
        let opencode_endpoint = if mode == "opencode" {
            use freshell_opencode::serve::PortAllocator as _;
            match freshell_opencode::transport::LoopbackPortAllocator.allocate() {
                Ok(ep) => Some(ep),
                Err(e) => return Err(fail_json(StatusCode::BAD_REQUEST, e)),
            }
        } else {
            None
        };

        // `model`/`sandbox`/`permissionMode` overrides: explicit body values
        // only (Slice 3a scope note -- unlike the WS path, `FreshAgentState`
        // has no `settings.codingCli.providers[mode]` defaults tree wired in,
        // so there is no settings-derived fallback layer here; a client that
        // wants non-default provider settings must pass them explicitly on
        // the create call).
        let permission_mode = body
            .get("permissionMode")
            .and_then(Value::as_str)
            .map(str::to_string);
        let model = body
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string);
        let sandbox = body
            .get("sandbox")
            .and_then(Value::as_str)
            .map(str::to_string);

        // DEV-0006 S4 inc.2 (FLAG-GATED, default OFF — council fence): with
        // `FRESHELL_CODEX_MANAGED_LAUNCH=1`, plan the managed app-server launch through
        // the SAME `CodexTerminalLaunchManager` the WS path uses (`router.ts:160-195`
        // semantics: `planCodexLaunchWithRetry` default budget = 5 attempts,
        // launch-retry.ts:19; raw create cwd; body model/sandbox/permissionMode routed
        // through the PLAN and STRIPPED from the spawn, matching legacy's codex-only
        // `{codexAppServer}` providerSettings). Flag OFF: today's plain-CLI behavior,
        // byte-identical. The raw-resume rejection already ran in
        // `derive_resume_identity` — planning happens strictly after it.
        let managed_flag =
            std::env::var(freshell_codex::launch_plan::FRESHELL_CODEX_MANAGED_LAUNCH_ENV).ok();
        codex_launch = if codex_create_uses_managed_launch(&mode, managed_flag.as_deref()) {
            let input = freshell_codex::launch_plan::CodexLaunchPlanInput {
                cwd: cwd.as_deref(),
                resume_session_id: resume_session_id.as_deref(),
                model: model.as_deref(),
                sandbox: sandbox.as_deref(),
                approval_policy: permission_mode.as_deref(),
            };
            match freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                .plan_create_with_retry(
                    &input,
                    freshell_codex::launch_plan::CODEX_INITIAL_LAUNCH_ATTEMPTS,
                )
                .await
            {
                Ok(launch) => Some(launch),
                Err(error) => return Err(codex_launch_error_response(error)),
            }
        } else {
            None
        };
        let managed_codex = codex_launch.is_some();
        // The resumeSessionId ECHO (`router.ts:177`): the registry record and every
        // downstream identity consumer carry the echoed value.
        if let Some(launch) = &codex_launch {
            resume_session_id = codex_effective_resume_session_id(
                resume_session_id.as_deref(),
                launch.session_id.as_deref(),
            );
        }

        let inputs = CliLaunchInputs {
            mode: &mode,
            target,
            resume_session_id: resume_session_id.as_deref(),
            // Always `Resume`: this path never mints its OWN preallocated
            // session id the way the WS path's fresh-claude special case
            // does (`crates/freshell-ws/src/terminal.rs:749-762`, out of this
            // slice's scope, matches `router.ts`, which has no such
            // preallocation either) -- `LaunchIntent` only matters when
            // `resume_session_id` is `Some`, and every `Some` here IS a
            // genuine resume (accepted `sessionRef` or legacy
            // `resumeSessionId`).
            launch_intent: LaunchIntent::Resume,
            // Managed codex (flag ON): model/sandbox/permissionMode route through the
            // PLAN, not argv (legacy's spawn providerSettings for codex carry ONLY
            // `codexAppServer`, `router.ts:178-193`).
            permission_mode: (!managed_codex)
                .then_some(())
                .and(permission_mode.as_deref()),
            model: (!managed_codex).then_some(()).and(model.as_deref()),
            sandbox: (!managed_codex).then_some(()).and(sandbox.as_deref()),
            // DEV-0006 S4 inc.2: the PROXY's ws URL when the flag-gated managed launch
            // planned one; `None` (today's shipped shape) otherwise.
            codex_remote_ws_url: codex_launch
                .as_ref()
                .map(|launch| launch.remote_ws_url.as_str()),
            opencode_server: opencode_endpoint
                .as_ref()
                .map(|ep| (ep.hostname.as_str(), ep.port as i64)),
            mcp_injection,
        };
        let launch = match resolve_coding_cli_command(&state.cli_commands, &inputs, &RealEnv) {
            Ok(l) => l,
            Err(e) => return Err(fail_json(StatusCode::BAD_REQUEST, e.message())),
        };

        let effective_shell = resolve_shell(shell_type, host_os, is_wsl);
        let windows_like = is_windows(host_os) || (is_wsl && effective_shell != ShellType::System);
        let overrides =
            build_terminal_base_env(&RealEnv, &terminal_id, Some(tab_id), Some(pane_id));

        spec = match &launch {
            Some(l) if windows_like => build_windows_cli_spawn_spec(
                l,
                shell_type,
                host_os,
                is_wsl,
                cwd.as_deref(),
                &RealEnv,
                &overrides,
                None,
                None,
            ),
            Some(l) => {
                build_cli_spawn_spec(l, is_wsl, cwd.as_deref(), &RealEnv, &overrides, None, None)
            }
            None => build_spawn_spec(
                shell_type,
                host_os,
                is_wsl,
                cwd.as_deref(),
                &RealEnv,
                &RealFileProbe,
                &overrides,
                None,
                None,
            ),
        };
        child_env = freshell_terminal::build_child_env_from_process(&spec);
        cli = launch;
    }

    // Exit hook (`tr:1479-1510` finishTerminalPtyExit, mirrored from
    // `crates/freshell-ws/src/terminal.rs:937-972`): cleanupMcpConfig BEFORE
    // registry bookkeeping, then disarm both locators -- so a REST-created
    // amplifier/opencode pane's armed entry is never left dangling on exit,
    // exactly like the WS path's on_exit closes this same gap (the parity
    // fix this slice's scope item 2 requires). KNOWN GAP (documented, not
    // silently dropped): unlike the WS on_exit, this hook cannot call
    // `identity.retire(&tid)` -- `TerminalIdentityRegistry` is
    // `freshell-ws`-owned and unreachable here without a circular crate
    // dependency; a REST-created terminal's identity entry (written by the
    // SHARED locator sweep once association resolves) simply persists past
    // exit instead of being explicitly retired. Acceptable: the entry is
    // inert once the terminal is gone, and a future create for the same
    // terminal id (a fresh UUID) never collides with it.
    let on_exit: Option<freshell_terminal::pty::ExitHook> = {
        let tid = terminal_id.clone();
        let cleanup_mode = mode.clone();
        let cleanup_cwd = mcp_cwd.clone();
        let registry_for_exit = registry.clone();
        let amplifier_locator = state.amplifier_locator.clone();
        let opencode_locator = state.opencode_locator.clone();
        Some(Box::new(move |exit_code: i64| {
            cleanup_mcp_config(&RealMcpRuntime, &tid, &cleanup_mode, cleanup_cwd.as_deref());
            registry_for_exit.finish_pty_exit(&tid, exit_code);
            // DEV-0006 S4: tear down this pane's managed codex sidecar + remote proxy
            // (no-op for terminals without a managed launch). Sync-safe: hands the
            // handle to the manager's async teardown worker. Same call as the WS
            // path's on_exit (`crates/freshell-ws/src/terminal.rs`).
            freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                .notify_terminal_exit(&tid);
            if let Some(locator) = &amplifier_locator {
                locator.disarm(&tid);
            }
            if let Some(locator) = &opencode_locator {
                locator.disarm(&tid);
            }
        }))
    };

    if let Err(err) = registry.create(
        &spec,
        &child_env,
        terminal_id.clone(),
        stream_id,
        &mode,
        resume_session_id.as_deref(),
        // REST ingress mints no createRequestId (reconciliation design §5.5
        // precondition 2 — booked for the Phase-3 adoption change).
        None,
        None,
        on_exit,
    ) {
        // Nothing was recorded yet (no tab, no pane, no map entry) -> rollback
        // is a no-op by construction, EXCEPT the MCP config file(s)
        // `generate_mcp_injection` may already have written -- clean those up
        // too (`router.ts:819`, `cw:429-448` -- the original's failed-create
        // cleanup path).
        if mode != "shell" {
            cleanup_mcp_config(&RealMcpRuntime, &terminal_id, &mode, mcp_cwd.as_deref());
        }
        // DEV-0006 S4: a planned-but-unadopted codex launch dies with the failed create
        // (`cleanupUnadoptedCodexLaunch`, `router.ts:445`) — sidecar + proxy torn down.
        if let Some(launch) = codex_launch {
            freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                .discard(launch)
                .await;
        }
        let label = mode_label(&mode, cli.as_ref());
        let env_var = state
            .cli_commands
            .iter()
            .find(|s| s.name == mode)
            .and_then(|s| s.env_var.clone());
        let message = wrap_terminal_spawn_error(
            &err,
            &label,
            &spec.program,
            env_var.as_deref(),
            resume_session_id.is_some(),
        );
        return Err(fail_json(StatusCode::BAD_REQUEST, message));
    }

    // DEV-0006 S4: adopt the managed codex launch for this terminal
    // (`adoptCodexLaunch` → `launch.codexPlan.sidecar.adopt({terminalId, generation: 0})`,
    // `router.ts:254,1591`) — ownership transfers from the planner to the terminal; the
    // exit hook above tears it down. Adoption only fails when the planner/sidecar is
    // already shutting down (server exit); legacy's thrown adopt fails the create, so
    // kill the just-spawned pty and surface the error (500 — not an input error).
    if let Some(launch) = codex_launch.take() {
        if let Err(message) = freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
            .adopt(&terminal_id, launch, 0)
            .await
        {
            registry.kill(&terminal_id);
            return Err(fail_json(StatusCode::INTERNAL_SERVER_ERROR, message));
        }
    }

    registry.set_meta(
        &terminal_id,
        Some(mode_label(&mode, cli.as_ref())),
        None,
        Some(mode.clone()),
        resume_session_id.clone(),
    );

    // Restore-across-restart fix (amplifier) + OpenCode terminal-pane restore
    // fix (opencode): arm the SHARED locator for a FRESH (non-resuming) pane
    // of the matching mode. No-ops for every other mode/resume case (the
    // admission checks live inside `arm()` itself, see
    // `arm_locators_for_fresh_pane`'s doc comment).
    arm_locators_for_fresh_pane(
        state,
        &terminal_id,
        &mode,
        cwd.as_deref(),
        resume_session_id.as_deref(),
    );

    let mut pane_content = json!({
        "kind": "terminal",
        "terminalId": terminal_id,
        "status": "running",
        "mode": mode,
        "shell": shell_str.clone().unwrap_or_else(|| "system".to_string()),
        "initialCwd": cwd,
    });
    // Continuity trio (`tabs_snapshots.rs:245`): a restore-driven create passes
    // the CAPTURED `codexDurability` record through so the frozen client's
    // terminal pane state round-trips (the client folds `paneContent`
    // verbatim via ui-commands.ts `tab.create` -> initLayout). Body-driven and
    // optional: absent for ordinary creates, and only ever an object.
    if let Some(cd) = body.get("codexDurability").filter(|v| v.is_object()) {
        pane_content["codexDurability"] = cd.clone();
    }
    // `paneContent` sessionRef/resumeSessionId, still mutually exclusive like
    // `router.ts:762-771` -- but with the EDEV-07 upgrade over legacy: a legacy
    // `resumeSessionId` for a known session provider is PROMOTED to the
    // canonical `sessionRef {provider: mode, sessionId}` the frozen client's
    // sidebar matcher / dedupe / persistence all key on (the legacy
    // resumeSessionId-only shape is invisible to all three for every mode but
    // `claude` -- see `port/oracle/DEVIATIONS.md` EDEV-07). An implausible id
    // shape ([`plausible_resume_session_id`]) is NOT promoted and keeps the
    // legacy resumeSessionId-only shape.
    if let Some(sref) = &accepted_session_ref {
        pane_content["sessionRef"] =
            json!({ "provider": sref.provider, "sessionId": sref.session_id });
    } else if let Some(rsid) = &resume_session_id {
        if is_session_provider_mode(&mode) && plausible_resume_session_id(&mode, rsid) {
            pane_content["sessionRef"] = json!({ "provider": mode, "sessionId": rsid });
        } else {
            pane_content["resumeSessionId"] = json!(rsid);
        }
    }

    state
        .terminal_panes
        .lock()
        .expect("terminal_panes mutex")
        .insert(
            pane_id.to_string(),
            TerminalPaneEntry {
                terminal_id: terminal_id.clone(),
            },
        );
    // Slice 3b-1: every pane-minting path records its owning tab in the
    // shared reverse index (see `FreshAgentState::pane_tabs`'s doc comment)
    // so `pane_ops`'s split/close/select handlers can resolve this pane's
    // tab without a server-side layout tree.
    state
        .pane_tabs
        .lock()
        .expect("pane_tabs mutex")
        .insert(pane_id.to_string(), tab_id.to_string());

    Ok(TerminalSpawnResult {
        pane_content,
        terminal_id,
        mode,
        shell: shell_str,
        cwd,
    })
}

/// `POST /api/tabs` terminal-mode path (`router.ts:695-793`'s `else` branch):
/// mint a fresh `{tabId,paneId}`, spawn via [`spawn_terminal_pane`], record the
/// `TabRecord`, and broadcast `ui.command{tab.create}` with the legacy-exact
/// payload keys.
async fn create_terminal_tab(
    state: &FreshAgentState,
    name: Option<String>,
    body: &Value,
    restore_key: Option<&str>,
    broadcast: bool,
) -> Response {
    // Minted BEFORE spawn (`router.ts:740-744` mints `{tabId,paneId}` via
    // `layoutStore.createTab()` before `registry.create()`) so the CLI env
    // (`FRESHELL_TAB_ID`/`FRESHELL_PANE_ID`) can carry them, matching the WS
    // path's `create.tab_id`/`create.pane_id` plumbing.
    let tab_id = Uuid::new_v4().to_string();
    let pane_id = Uuid::new_v4().to_string();

    let spawned = match spawn_terminal_pane(state, body, &tab_id, &pane_id).await {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let TerminalSpawnResult {
        pane_content,
        terminal_id,
        mode,
        shell: shell_str,
        cwd,
    } = spawned;

    state.tabs.lock().expect("tabs mutex").insert(
        tab_id.clone(),
        TabRecord {
            id: tab_id.clone(),
            title: name.clone(),
            pane_id: pane_id.clone(),
            kind: "terminal".to_string(),
        },
    );
    // `ui.command{tab.create}` payload (`router.ts:775-789`): id, title, mode,
    // shell, terminalId, initialCwd, then EITHER `resumeSessionId` OR
    // `sessionRef` (whichever `paneContent` carries -- mutually exclusive,
    // matching the original's `...(paneContent?.resumeSessionId ? {...} : {}),
    // ...(paneContent?.sessionRef ? {...} : {})`), paneId, paneContent.
    let mut payload = json!({
        "id": tab_id,
        "title": name,
        "mode": mode,
        "shell": shell_str,
        "terminalId": terminal_id,
        "initialCwd": cwd,
        "paneId": pane_id,
        "paneContent": pane_content,
    });
    if let Some(rsid) = pane_content.get("resumeSessionId") {
        payload["resumeSessionId"] = rsid.clone();
    }
    if let Some(sref) = pane_content.get("sessionRef") {
        payload["sessionRef"] = sref.clone();
    }

    // STATE-SYNC FIX 1 increment 2b invariant alarm: a `tab.create` for a
    // session-provider mode carrying NEITHER `sessionRef` nor
    // `resumeSessionId` is exactly the payload shape that minted every
    // grey-sidebar pane (the frozen client has no identity key to join on
    // until a locator association lands — and gemini/kimi have no locator at
    // all). Legitimate for a fresh create, but worth a bounded WARN (one
    // create per terminal) on the shared invariants target so identity loss
    // is observable at the write path that mints it.
    if is_session_provider_mode(&mode)
        && payload.get("sessionRef").is_none()
        && payload.get("resumeSessionId").is_none()
    {
        tracing::warn!(
            target: "freshell_ws::invariants",
            terminal_id = %terminal_id,
            mode = %mode,
            "tab_create_missing_session_identity: ui.command tab.create for a \
             session-provider mode carries neither sessionRef nor resumeSessionId; \
             the pane has no identity key until (and unless) a locator association \
             resolves"
        );
    }

    let command = ServerMessage::UiCommand(UiCommand {
        command: "tab.create".to_string(),
        payload: Some(payload),
    });
    // Record the live process and replayable command before any delivery.
    if let Some(key) = restore_key {
        state.record_restore_key(
            key,
            crate::RestoreKeyEntry {
                tab_id: tab_id.clone(),
                pane_id: pane_id.clone(),
                terminal_id: Some(terminal_id.clone()),
                ui_command: command.clone(),
                delivered_to: HashSet::new(),
            },
        );
    }
    if broadcast {
        state.broadcast(&command);
    }

    let mut data = json!({ "tabId": tab_id, "paneId": pane_id, "terminalId": terminal_id });
    if !broadcast {
        data["uiCommand"] = serde_json::to_value(command).expect("UiCommand serializes");
    }
    ok_json(data, "tab created")
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
/// `GET /api/panes` (`router.ts:898-902`): iterates the [`FreshAgentState::pane_tabs`]
/// reverse index (NOT `state.tabs`) so every pane ANY pane-minting path has ever
/// registered is listed -- including `pane_ops::split_pane` panes, which have no
/// `TabRecord` of their own (a tab can now own more than one pane; `TabRecord` still
/// only carries the tab's ORIGINAL pane for `GET /api/tabs`'s reduced row shape). Falls
/// back to the owning tab's title (no independent per-pane title is tracked at this
/// slice, matching `rename_pane`'s documented reduced fidelity) and resolves `kind`/
/// `terminalId` from whichever per-kind map (`terminal_panes`/`content_panes`/
/// fresh-agent `panes`) actually holds the pane.
pub(crate) async fn list_panes(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let tab_filter = params.get("tabId");
    let pane_tabs = state.pane_tabs.lock().expect("pane_tabs mutex").clone();
    let tabs = state.tabs.lock().expect("tabs mutex").clone();
    let terminal_panes = state
        .terminal_panes
        .lock()
        .expect("terminal_panes mutex")
        .clone();
    let content_panes = state
        .content_panes
        .lock()
        .expect("content_panes mutex")
        .clone();
    let panes: Vec<Value> = pane_tabs
        .iter()
        .filter(|(_, tab_id)| tab_filter.is_none_or(|tid| tid == *tab_id))
        .map(|(pane_id, tab_id)| {
            let title = tabs.get(tab_id).and_then(|t| t.title.clone());
            let (kind, terminal_id) = if let Some(tp) = terminal_panes.get(pane_id) {
                ("terminal".to_string(), Some(tp.terminal_id.clone()))
            } else if let Some(content) = content_panes.get(pane_id) {
                (
                    content
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    None,
                )
            } else {
                ("fresh-agent".to_string(), None)
            };
            json!({
                "id": pane_id,
                "tabId": tab_id,
                "title": title,
                "kind": kind,
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
    // Feed the amplifier/opencode locator's Enter<->session correlation
    // (`is_submit_input`/`note_possible_submit`,
    // `crates/freshell-ws/src/amplifier_association.rs:29-33,66-72`): a
    // REST-created fresh amplifier/opencode pane only associates once its
    // FIRST submit-shaped input (a bare CR/LF run) is observed here -- a
    // REST `send-keys` must feed the SAME shared locator the WS `terminal.input`
    // path does, or a REST-driven Enter would silently never open the
    // locator's correlation window. No-ops (`note_submit` itself checks
    // "is this terminal armed?") for every non-armed/non-Enter case.
    if is_submit_input(text) {
        if let Some(locator) = &state.amplifier_locator {
            locator.note_submit(&terminal_id, now_ms());
        }
        if let Some(locator) = &state.opencode_locator {
            locator.note_submit(&terminal_id, now_ms());
        }
    }
    Some(ok_json(json!({ "terminalId": terminal_id }), "input sent"))
}

/// `isSubmitInput` (`shared/turn-complete-signal.ts:125-127`, mirrored from
/// `crates/freshell-ws/src/amplifier_association.rs:29-33`): the input is
/// ONLY a run of CR/LF bytes -- an Enter keypress, possibly repeated.
/// Anything else (real text, control sequences, partial lines) is not a
/// submit.
fn is_submit_input(data: &str) -> bool {
    !data.is_empty() && data.chars().all(|c| c == '\r' || c == '\n')
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
    use axum::Router;
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

    // ── DEV-0006 S4 inc.2: the REST codex managed-launch gate + resume echo ─────────────

    /// Same council fence as the WS path: managed codex launch is FLAG-GATED,
    /// default OFF; only mode=codex + flag exactly "1" plans a launch. Flag OFF
    /// keeps the shipped REST codex behavior byte-identical.
    #[test]
    fn rest_codex_managed_launch_gate_is_mode_and_flag_scoped() {
        assert!(codex_create_uses_managed_launch("codex", Some("1")));
        assert!(!codex_create_uses_managed_launch("codex", None));
        assert!(!codex_create_uses_managed_launch("codex", Some("0")));
        assert!(!codex_create_uses_managed_launch("codex", Some("")));
        assert!(!codex_create_uses_managed_launch("shell", Some("1")));
        assert!(!codex_create_uses_managed_launch("claude", Some("1")));
        assert!(!codex_create_uses_managed_launch("opencode", Some("1")));
    }

    /// `agentRouteErrorStatus` (`router.ts:54-59`): a `CodexLaunchConfigError` (invalid
    /// sandbox etc.) is an INPUT error → 400; any other launch failure (runtime/proxy
    /// IO, planner shutdown) → 500.
    #[test]
    fn rest_codex_launch_error_maps_config_to_400_and_failed_to_500() {
        use freshell_codex::launch_lifecycle::CodexLaunchError;
        use freshell_codex::launch_plan::CodexLaunchConfigError;
        let config =
            codex_launch_error_response(CodexLaunchError::Config(CodexLaunchConfigError {
                message: "Invalid Codex sandbox setting \"x\".".to_string(),
            }));
        assert_eq!(config.status(), StatusCode::BAD_REQUEST);
        let failed = codex_launch_error_response(CodexLaunchError::Failed(
            "codex app-server WS never came up".to_string(),
        ));
        assert_eq!(failed.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    /// `router.ts:177`: `resumeSessionId: opts.resumeSessionId ? (plan.sessionId ??
    /// opts.resumeSessionId) : undefined` — the plan's sessionId wins when a resume was
    /// requested; a fresh create yields NO resume id even if the plan carried one; TS
    /// truthiness makes an empty requested id count as "not requested".
    #[test]
    fn rest_codex_resume_echo_matches_router_semantics() {
        // resume requested + plan echoes it back (the normal resume shape).
        assert_eq!(
            codex_effective_resume_session_id(Some("thread-a"), Some("thread-a")),
            Some("thread-a".to_string())
        );
        // resume requested, plan.sessionId differs → the PLAN's id wins (`??` picks
        // the first non-nullish operand).
        assert_eq!(
            codex_effective_resume_session_id(Some("thread-a"), Some("thread-b")),
            Some("thread-b".to_string())
        );
        // resume requested, plan carries none → fall back to the requested id.
        assert_eq!(
            codex_effective_resume_session_id(Some("thread-a"), None),
            Some("thread-a".to_string())
        );
        // fresh create → undefined, even if the plan somehow carried a session id.
        assert_eq!(
            codex_effective_resume_session_id(None, Some("thread-x")),
            None
        );
        // TS truthiness: the empty string is falsy → undefined.
        assert_eq!(codex_effective_resume_session_id(Some(""), Some("t")), None);
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
    async fn create_tab_passes_codex_durability_through_and_records_restore_key() {
        // Continuity trio (`tabs_snapshots.rs:245`/`:632`): a restore-driven
        // create carries the captured `codexDurability` into the broadcast
        // paneContent verbatim, and its `restoreKey` is recorded in the
        // ledger with the spawned terminal id for crash-window reconciliation.
        let state = state_with_registry();
        let mut rx = state.broadcast_tx.subscribe();
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({ "mode": "shell", "cwd": tmp.to_string_lossy(),
                    "codexDurability": { "schemaVersion": 1, "state": "durable" },
                    "restoreKey": "restore:dev:src:pk" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
        let frame = rx.recv().await.expect("tab.create broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(
            msg["payload"]["paneContent"]["codexDurability"]["state"],
            json!("durable")
        );
        let entry = state
            .lookup_restore_key("restore:dev:src:pk")
            .expect("restore key recorded");
        assert_eq!(entry.terminal_id.as_deref(), Some(terminal_id.as_str()));
        assert_eq!(entry.tab_id, body["data"]["tabId"].as_str().unwrap());
    }

    #[tokio::test]
    async fn forced_terminal_reissue_preserves_process_environment_identity() {
        let state = state_with_registry();
        let router = app(state.clone());
        let restore_key = "restore:dev:source:tab#pane";
        let (status, body) = post(
            router.clone(),
            "/api/tabs",
            json!({
                "mode": "shell",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "restoreKey": restore_key,
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let original = state.lookup_restore_key(restore_key).unwrap();

        let (closed_tab_id, reissued) = state
            .reissue_restore_key_terminal(restore_key)
            .expect("live terminal restore entry");
        assert_eq!(closed_tab_id, original.tab_id);
        assert_eq!(reissued.tab_id, original.tab_id);
        assert_eq!(reissued.pane_id, original.pane_id);
        assert_eq!(reissued.terminal_id, original.terminal_id);

        let marker = format!("ENV_IDS={}/{}", original.tab_id, original.pane_id);
        let encoded_marker = marker.replace('=', "%3D").replace('/', "%2F");
        let (send_status, _) = post(
            router.clone(),
            &format!("/api/panes/{}/send-keys", original.pane_id),
            json!({
                "data": "printf 'ENV_IDS=%s/%s\\n' \"$FRESHELL_TAB_ID\" \"$FRESHELL_PANE_ID\"\r"
            }),
            true,
        )
        .await;
        assert_eq!(send_status, StatusCode::OK);
        let (wait_status, wait_body) = get(
            router.clone(),
            &format!(
                "/api/panes/{}/wait-for?pattern={encoded_marker}&T=15",
                original.pane_id,
            ),
            true,
        )
        .await;
        assert_eq!(wait_status, StatusCode::OK, "{wait_body}");
        let (_, capture) = get_text(
            router,
            &format!("/api/panes/{}/capture", original.pane_id),
            true,
        )
        .await;
        assert!(
            capture.contains(&marker),
            "the reused process must still point at resolvable ids: {capture}"
        );
    }

    #[tokio::test]
    async fn create_tab_defaults_to_shell_mode_when_mode_absent() {
        let state = state_with_registry();
        let (status, body) = post(app(state), "/api/tabs", json!({}), true).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["data"]["terminalId"].as_str().is_some());
    }

    #[tokio::test]
    async fn create_tab_unregistered_terminal_mode_is_400() {
        let state = state_with_registry();
        let (status, body) = post(app(state), "/api/tabs", json!({ "mode": "claude" }), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let msg = body["message"].as_str().unwrap();
        assert!(msg.contains("claude"), "{msg}");
        assert!(
            msg.contains("not a registered terminal launch target"),
            "{msg}"
        );
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
        let (_status, body) = post(
            router.clone(),
            "/api/tabs",
            json!({ "mode": "shell" }),
            true,
        )
        .await;
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

    #[cfg(unix)]
    #[test]
    fn requested_powershell_shell_spawns_the_configured_powershell_program_on_wsl() {
        if !is_wsl_env_live() {
            return;
        }
        let _env_guard = crate::codex::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let prior = std::env::var_os("POWERSHELL_EXE");
        struct RestoreEnv(Option<std::ffi::OsString>);
        impl Drop for RestoreEnv {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(value) => unsafe { std::env::set_var("POWERSHELL_EXE", value) },
                    None => unsafe { std::env::remove_var("POWERSHELL_EXE") },
                }
            }
        }
        let _restore = RestoreEnv(prior);

        let temp = unique_temp_home("powershell-shell");
        let fake_powershell = temp.join("fake-powershell");
        std::fs::write(
            &fake_powershell,
            "#!/bin/sh\nprintf 'REQUESTED_POWERSHELL_SPAWNED\\n'\nexec sleep 30\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&fake_powershell).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&fake_powershell, permissions).unwrap();
        unsafe { std::env::set_var("POWERSHELL_EXE", &fake_powershell) };

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let state = state_with_registry();
            let registry = state.terminal_registry.clone().unwrap();
            let (status, body) = post(
                app(state),
                "/api/tabs",
                json!({ "mode": "shell", "shell": "powershell", "cwd": "/tmp" }),
                true,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            let terminal_id = body["data"]["terminalId"].as_str().unwrap();

            let mut snapshot = String::new();
            for _ in 0..50 {
                snapshot = registry
                    .directory()
                    .into_iter()
                    .find(|entry| entry.terminal_id == terminal_id)
                    .map(|entry| entry.snapshot)
                    .unwrap_or_default();
                if snapshot.contains("REQUESTED_POWERSHELL_SPAWNED") {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            assert!(
                snapshot.contains("REQUESTED_POWERSHELL_SPAWNED"),
                "requested PowerShell executable did not run; snapshot: {snapshot:?}"
            );
            assert!(registry.kill(terminal_id));
        });
        std::fs::remove_dir_all(temp).unwrap();
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

    // -- Slice 3a: rich-mode terminal create (amplifier / opencode / codex) --

    /// A test-only [`freshell_platform::CliCommandSpec`] whose `default_cmd`
    /// is a real, always-present binary (`/bin/sh`) so `registry.create()`
    /// genuinely spawns (no ENOENT) -- `-c "... ; exec sleep 30"` keeps the
    /// PTY alive long enough for send-keys/is_running assertions, and the
    /// leading `printf '%s\n' "$@" > argv_file` records the FULL resolved
    /// argv (provider/base/settings/resume segments, in order) so tests can
    /// assert on the real computed CLI launch, not just the registry's
    /// mode/resume_session_id bookkeeping.
    /// Writes a standalone, executable recording script (`#!/bin/sh` +
    /// `printf '%s\n' "$@" > argv_file; exec sleep 30`) and points
    /// `default_cmd` straight at it with EMPTY `base_args`. Deliberately NOT
    /// a `/bin/sh -c "..."` wrapper: `codex`'s own `provider_args`
    /// (`CODEX_TUI_NOTIFICATION_ARGS`, a run of `-c key=value` pairs)
    /// PREPEND before `base_args` (`resolve_coding_cli_command`'s segment
    /// order, `[remote, provider, base, settings, resume]`) -- if this
    /// spec's own `base_args` also started with `-c`, `/bin/sh` would parse
    /// codex's FIRST injected `-c value` as ITS `-c` flag instead, and this
    /// script would never run. A real executable file has no such
    /// first-arg-parsing collision: whatever argv the resolver computes for
    /// ANY mode just lands in the script's own `"$@"`, faithfully.
    fn recording_cli_spec(
        name: &str,
        argv_file: &std::path::Path,
    ) -> freshell_platform::CliCommandSpec {
        let script_path = std::env::temp_dir().join(format!(
            "freshell-slice3a-recorder-{name}-{}-{}.sh",
            std::process::id(),
            argv_file.file_name().unwrap().to_string_lossy()
        ));
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > {} 2>/dev/null\nexec sleep 30\n",
            argv_file.display()
        );
        std::fs::write(&script_path, script).expect("write recording script");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script_path, perms).unwrap();
        }
        freshell_platform::CliCommandSpec {
            name: name.to_string(),
            label: format!("{name}-label"),
            env_var: None,
            default_cmd: script_path.to_string_lossy().to_string(),
            base_args: vec![],
            base_env: BTreeMap::new(),
            resume_args: Some(vec!["--resume".to_string(), "{{sessionId}}".to_string()]),
            create_session_args: None,
            model_args: None,
            sandbox_args: None,
            permission_mode_args: None,
        }
    }

    fn unique_argv_file(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "freshell-slice3a-argv-{label}-{}-{n}.txt",
            std::process::id()
        ))
    }

    fn unique_temp_home(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-slice3a-home-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Poll `path` (bounded) until it has content -- the recording script
    /// writes its argv line asynchronously right after the PTY forks.
    async fn read_argv_file_eventually(path: &std::path::Path) -> String {
        for _ in 0..50 {
            if let Ok(content) = std::fs::read_to_string(path) {
                if !content.is_empty() {
                    return content;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        std::fs::read_to_string(path).unwrap_or_default()
    }

    fn state_with_amplifier_locator(home: std::path::PathBuf) -> FreshAgentState {
        state_with_registry().with_amplifier_locator(Some(std::sync::Arc::new(
            freshell_sessions::amplifier_locator::AmplifierLocator::new(home),
        )))
    }

    fn state_with_opencode_locator(home: std::path::PathBuf) -> FreshAgentState {
        state_with_registry().with_opencode_locator(Some(std::sync::Arc::new(
            freshell_sessions::opencode_locator::OpencodeLocator::new(home),
        )))
    }

    #[tokio::test]
    async fn create_amplifier_tab_fresh_spawns_recorded_argv_with_no_resume_and_arms_locator() {
        let home = unique_temp_home("amplifier-fresh");
        let argv_file = unique_argv_file("amplifier-fresh");
        let state = state_with_amplifier_locator(home.clone()).with_cli_commands(
            std::sync::Arc::new(vec![recording_cli_spec("amplifier", &argv_file)]),
        );
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({ "mode": "amplifier", "cwd": tmp.to_string_lossy() }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
        assert!(state
            .terminal_registry
            .clone()
            .unwrap()
            .is_running(&terminal_id));

        // Locator ARMED for the fresh amplifier pane (scope item 2's parity
        // fix -- REST-created amplifier panes previously never armed).
        assert_eq!(
            state.amplifier_locator.as_ref().unwrap().armed_count(),
            1,
            "fresh amplifier REST create must arm the shared locator"
        );

        // No resume args in the recorded argv (fresh launch).
        let argv = read_argv_file_eventually(&argv_file).await;
        assert!(!argv.contains("--resume"), "fresh launch argv: {argv}");

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn create_amplifier_tab_disarms_locator_on_exit() {
        let home = unique_temp_home("amplifier-disarm");
        let argv_file = unique_argv_file("amplifier-disarm");
        let state = state_with_amplifier_locator(home.clone()).with_cli_commands(
            std::sync::Arc::new(vec![recording_cli_spec("amplifier", &argv_file)]),
        );
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({ "mode": "amplifier", "cwd": tmp.to_string_lossy() }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
        assert_eq!(state.amplifier_locator.as_ref().unwrap().armed_count(), 1);

        let registry = state.terminal_registry.clone().unwrap();
        registry.kill(&terminal_id);
        // `kill` drives the PTY's on_exit hook synchronously-enough that a
        // short bounded poll always observes the disarm.
        for _ in 0..30 {
            if state.amplifier_locator.as_ref().unwrap().armed_count() == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(
            state.amplifier_locator.as_ref().unwrap().armed_count(),
            0,
            "on_exit must disarm the locator (parity with the WS create path)"
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn create_opencode_tab_fresh_spawns_with_hostname_port_args_and_arms_locator() {
        let home = unique_temp_home("opencode-fresh");
        let argv_file = unique_argv_file("opencode-fresh");
        let state =
            state_with_opencode_locator(home.clone()).with_cli_commands(std::sync::Arc::new(vec![
                recording_cli_spec("opencode", &argv_file),
            ]));
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({ "mode": "opencode", "cwd": tmp.to_string_lossy() }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
        assert!(state
            .terminal_registry
            .clone()
            .unwrap()
            .is_running(&terminal_id));
        assert_eq!(
            state.opencode_locator.as_ref().unwrap().armed_count(),
            1,
            "fresh opencode REST create must arm the shared locator"
        );

        let argv = read_argv_file_eventually(&argv_file).await;
        assert!(argv.contains("--hostname"), "opencode argv: {argv}");
        assert!(argv.contains("--port"), "opencode argv: {argv}");
        assert!(!argv.contains("--resume"), "fresh launch argv: {argv}");

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn create_codex_tab_rejects_raw_resume_session_id_without_session_ref() {
        let argv_file = unique_argv_file("codex-reject");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "codex", &argv_file,
            )]));
        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({ "mode": "codex", "resumeSessionId": "raw-thread-id-not-a-sessionref" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let msg = body["message"].as_str().unwrap();
        assert!(
            msg.contains("sessionRef") && msg.contains("resumeSessionId"),
            "{msg}"
        );
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn create_codex_tab_accepts_session_ref_and_derives_resume_args() {
        let argv_file = unique_argv_file("codex-accept");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "codex", &argv_file,
            )]));
        let mut rx = state.broadcast_tx.subscribe();
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({
                "mode": "codex",
                "cwd": tmp.to_string_lossy(),
                "sessionRef": { "provider": "codex", "sessionId": "thread-abc-123" }
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        let argv = read_argv_file_eventually(&argv_file).await;
        assert!(argv.contains("--resume"), "codex resume argv: {argv}");
        assert!(argv.contains("thread-abc-123"), "codex resume argv: {argv}");

        // `paneContent`/`ui.command` carry `sessionRef`, NOT `resumeSessionId`
        // (mutually exclusive, `router.ts:762-771,784-785`).
        let frame = rx.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(msg["command"], json!("tab.create"));
        assert_eq!(
            msg["payload"]["sessionRef"],
            json!({ "provider": "codex", "sessionId": "thread-abc-123" })
        );
        assert!(msg["payload"].get("resumeSessionId").is_none());
        assert_eq!(
            msg["payload"]["paneContent"]["sessionRef"],
            json!({ "provider": "codex", "sessionId": "thread-abc-123" })
        );
        assert!(msg["payload"]["paneContent"]
            .get("resumeSessionId")
            .is_none());

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn create_tab_resume_session_id_flows_to_registry_directory_for_non_codex_mode() {
        let argv_file = unique_argv_file("amplifier-resume");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "amplifier",
                &argv_file,
            )]));
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({
                "mode": "amplifier",
                "cwd": tmp.to_string_lossy(),
                "resumeSessionId": "legacy-resume-id-xyz"
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
        let registry = state.terminal_registry.clone().unwrap();
        let entry = registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == terminal_id)
            .expect("directory entry");
        assert_eq!(entry.mode, "amplifier");
        assert_eq!(
            entry.resume_session_id.as_deref(),
            Some("legacy-resume-id-xyz")
        );

        let argv = read_argv_file_eventually(&argv_file).await;
        assert!(argv.contains("--resume"), "resume argv: {argv}");
        assert!(argv.contains("legacy-resume-id-xyz"), "resume argv: {argv}");

        registry.kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
    }

    // ── STATE-SYNC FIX 1 / Increment 1: REST create sessionRef synthesis ────
    //
    // The frozen client's sidebar matcher (`src/lib/session-utils.ts:135-139`)
    // promotes a terminal pane's bare `resumeSessionId` to a session locator
    // ONLY for `mode === 'claude'`, and persist-save strips `resumeSessionId`
    // entirely — so a REST-created resume tab for any other session provider
    // renders grey in the sidebar, duplicates on sidebar click, and loses its
    // durable identity across server restart. The server must therefore mint
    // the canonical `sessionRef {provider: mode, sessionId}` itself (EDEV-07,
    // `port/oracle/DEVIATIONS.md`).

    #[tokio::test]
    async fn create_amplifier_tab_with_legacy_resume_synthesizes_session_ref() {
        let argv_file = unique_argv_file("amplifier-synth");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "amplifier",
                &argv_file,
            )]));
        let mut rx = state.broadcast_tx.subscribe();
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({
                "mode": "amplifier",
                "cwd": tmp.to_string_lossy(),
                "resumeSessionId": "web-1737000000000-abc123"
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        let frame = rx.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(msg["command"], json!("tab.create"));
        let expected_ref =
            json!({ "provider": "amplifier", "sessionId": "web-1737000000000-abc123" });
        assert_eq!(
            msg["payload"]["paneContent"]["sessionRef"], expected_ref,
            "paneContent must carry the synthesized sessionRef: {msg}"
        );
        assert!(
            msg["payload"]["paneContent"]
                .get("resumeSessionId")
                .is_none(),
            "sessionRef and resumeSessionId stay mutually exclusive: {msg}"
        );
        assert_eq!(
            msg["payload"]["sessionRef"], expected_ref,
            "the tab.create payload mirrors the synthesized sessionRef: {msg}"
        );
        assert!(msg["payload"].get("resumeSessionId").is_none(), "{msg}");

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn create_claude_tab_with_canonical_resume_id_synthesizes_session_ref() {
        let argv_file = unique_argv_file("claude-synth");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "claude", &argv_file,
            )]));
        let mut rx = state.broadcast_tx.subscribe();
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": tmp.to_string_lossy(),
                "resumeSessionId": "550e8400-e29b-41d4-a716-446655440000"
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        let frame = rx.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(
            msg["payload"]["paneContent"]["sessionRef"],
            json!({ "provider": "claude", "sessionId": "550e8400-e29b-41d4-a716-446655440000" }),
            "{msg}"
        );
        assert!(
            msg["payload"]["paneContent"]
                .get("resumeSessionId")
                .is_none(),
            "{msg}"
        );

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn create_claude_tab_with_non_canonical_resume_id_does_not_synthesize() {
        let argv_file = unique_argv_file("claude-implausible");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "claude", &argv_file,
            )]));
        let mut rx = state.broadcast_tx.subscribe();
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": tmp.to_string_lossy(),
                "resumeSessionId": "not-a-canonical-uuid"
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        // Implausible id shape (claude ids must be canonical UUIDs,
        // `freshell_sessions::text::is_canonical_claude_session_id`) -> NO
        // synthesis; legacy resumeSessionId-only shape is preserved.
        let frame = rx.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert!(
            msg["payload"]["paneContent"].get("sessionRef").is_none(),
            "{msg}"
        );
        assert_eq!(
            msg["payload"]["paneContent"]["resumeSessionId"],
            json!("not-a-canonical-uuid"),
            "{msg}"
        );

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn create_amplifier_tab_with_whitespace_resume_id_does_not_synthesize() {
        let argv_file = unique_argv_file("amplifier-implausible");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "amplifier",
                &argv_file,
            )]));
        let mut rx = state.broadcast_tx.subscribe();
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({
                "mode": "amplifier",
                "cwd": tmp.to_string_lossy(),
                "resumeSessionId": "not a plausible id"
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        let frame = rx.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert!(
            msg["payload"]["paneContent"].get("sessionRef").is_none(),
            "{msg}"
        );
        assert_eq!(
            msg["payload"]["paneContent"]["resumeSessionId"],
            json!("not a plausible id"),
            "{msg}"
        );

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn create_opencode_tab_with_non_ses_resume_id_does_not_synthesize() {
        let argv_file = unique_argv_file("opencode-implausible");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "opencode", &argv_file,
            )]));
        let mut rx = state.broadcast_tx.subscribe();
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({
                "mode": "opencode",
                "cwd": tmp.to_string_lossy(),
                "resumeSessionId": "foo"
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        // Implausible id shape (opencode ids are `ses_*` rows,
        // `shared/session-flavor.ts:65` `isDurableProviderSessionId`) -> NO
        // synthesis; legacy resumeSessionId-only shape is preserved.
        let frame = rx.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert!(
            msg["payload"]["paneContent"].get("sessionRef").is_none(),
            "{msg}"
        );
        assert_eq!(
            msg["payload"]["paneContent"]["resumeSessionId"],
            json!("foo"),
            "{msg}"
        );

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn create_opencode_tab_with_ses_prefixed_resume_id_synthesizes_session_ref() {
        let argv_file = unique_argv_file("opencode-synth");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "opencode", &argv_file,
            )]));
        let mut rx = state.broadcast_tx.subscribe();
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({
                "mode": "opencode",
                "cwd": tmp.to_string_lossy(),
                "resumeSessionId": "ses_abc123"
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        let frame = rx.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(
            msg["payload"]["paneContent"]["sessionRef"],
            json!({ "provider": "opencode", "sessionId": "ses_abc123" }),
            "{msg}"
        );
        assert!(
            msg["payload"]["paneContent"]
                .get("resumeSessionId")
                .is_none(),
            "{msg}"
        );

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn send_keys_enter_feeds_amplifier_locator_and_tick_locates_session() {
        let home = unique_temp_home("amplifier-e2e");
        let argv_file = unique_argv_file("amplifier-e2e");
        let state = state_with_amplifier_locator(home.clone()).with_cli_commands(
            std::sync::Arc::new(vec![recording_cli_spec("amplifier", &argv_file)]),
        );
        let router = app(state.clone());
        let cwd_dir = home.join("workspace-cwd");
        std::fs::create_dir_all(&cwd_dir).unwrap();
        let (status, body) = post(
            router.clone(),
            "/api/tabs",
            json!({ "mode": "amplifier", "cwd": cwd_dir.to_string_lossy() }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let pane_id = body["data"]["paneId"].as_str().unwrap().to_string();
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
        assert_eq!(state.amplifier_locator.as_ref().unwrap().armed_count(), 1);

        // REST send-keys with a lone Enter must feed the SAME shared locator
        // the WS `terminal.input` path feeds (`maybe_send_keys` ->
        // `is_submit_input` -> `note_submit`) -- proven here by driving the
        // locator's own `tick()` directly (the periodic sweep's core
        // mechanism, `freshell_sessions::amplifier_locator::AmplifierLocator::tick`,
        // is public and crate-reachable; the WS-owned broadcast fan-out
        // `drain_and_associate` wraps is NOT reachable from this crate --
        // see this module's doc comment -- so THAT half is covered by
        // `crates/freshell-ws/src/amplifier_association.rs`'s own test
        // suite, not duplicated here).
        let (send_status, _) = post(
            router.clone(),
            &format!("/api/panes/{pane_id}/send-keys"),
            json!({ "data": "\r" }),
            true,
        )
        .await;
        assert_eq!(send_status, StatusCode::OK);

        let dir = home
            .join("projects")
            .join("proj")
            .join("sessions")
            .join("sess-rest-e2e");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("events.jsonl"),
            format!(
                "{{\"event\":\"session:start\"}}\n{{\"event\":\"session:config\",\"working_dir\":\"{}\"}}\n",
                cwd_dir.display()
            ),
        )
        .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let mut located_ids: Vec<String> = Vec::new();
        for _ in 0..30 {
            let located = state.amplifier_locator.as_ref().unwrap().tick(now_ms());
            located_ids.extend(located.into_iter().map(|l| l.session_id));
            if !located_ids.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(
            located_ids.contains(&"sess-rest-e2e".to_string()),
            "expected the REST-armed + REST-note_submit'd terminal to correlate with the new \
             session dir via tick(); located: {located_ids:?}"
        );

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_file(&argv_file);
    }

    // ── STATE-SYNC FIX 1 / Increment 2b: tab.create identity invariant alarm ─

    mod invariant_capture {
        //! Thread-local capturing subscriber recording TARGET + message +
        //! fields — the `codex.rs` `tracing_capture` convention, extended
        //! with `metadata().target()` because the invariant alarms are
        //! target-scoped (`freshell_ws::invariants`).
        use std::collections::BTreeMap;
        use std::sync::{Arc, Mutex};
        use tracing::field::{Field, Visit};
        use tracing::{Event, Subscriber};
        use tracing_subscriber::layer::{Context, SubscriberExt};
        use tracing_subscriber::Layer;

        #[derive(Debug, Clone, Default)]
        pub struct CapturedEvent {
            pub target: String,
            pub message: String,
            pub fields: BTreeMap<String, String>,
        }

        #[derive(Default)]
        struct FieldVisitor {
            message: String,
            fields: BTreeMap<String, String>,
        }

        impl Visit for FieldVisitor {
            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                let rendered = format!("{value:?}");
                if field.name() == "message" {
                    self.message = rendered;
                } else {
                    self.fields.insert(field.name().to_string(), rendered);
                }
            }
            fn record_str(&mut self, field: &Field, value: &str) {
                if field.name() == "message" {
                    self.message = value.to_string();
                } else {
                    self.fields
                        .insert(field.name().to_string(), value.to_string());
                }
            }
        }

        struct CaptureLayer {
            events: Arc<Mutex<Vec<CapturedEvent>>>,
        }

        impl<S: Subscriber> Layer<S> for CaptureLayer {
            fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
                let mut visitor = FieldVisitor::default();
                event.record(&mut visitor);
                self.events
                    .lock()
                    .expect("capture lock")
                    .push(CapturedEvent {
                        target: event.metadata().target().to_string(),
                        message: visitor.message,
                        fields: visitor.fields,
                    });
            }
        }

        pub fn capture() -> (
            Arc<Mutex<Vec<CapturedEvent>>>,
            tracing::subscriber::DefaultGuard,
        ) {
            let events = Arc::new(Mutex::new(Vec::new()));
            let layer = CaptureLayer {
                events: Arc::clone(&events),
            };
            let subscriber = tracing_subscriber::registry().with(layer);
            let guard = tracing::subscriber::set_default(subscriber);
            (events, guard)
        }
    }

    fn missing_identity_warnings(
        events: &[invariant_capture::CapturedEvent],
    ) -> Vec<invariant_capture::CapturedEvent> {
        events
            .iter()
            .filter(|e| {
                e.target == "freshell_ws::invariants"
                    && e.message.contains("tab_create_missing_session_identity")
            })
            .cloned()
            .collect()
    }

    /// A fresh (no resume) session-provider tab.create legitimately starts
    /// with NO identity — but the payload carrying NEITHER `sessionRef` nor
    /// `resumeSessionId` is exactly the shape that minted every grey-sidebar
    /// pane, so it must WARN (bounded: one create per terminal) on the
    /// `freshell_ws::invariants` target for observability.
    #[tokio::test]
    async fn create_fresh_session_provider_tab_without_identity_warns_invariant() {
        let (events, _guard) = invariant_capture::capture();
        let argv_file = unique_argv_file("gemini-invariant");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "gemini", &argv_file,
            )]));
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({ "mode": "gemini", "cwd": tmp.to_string_lossy() }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        let warnings = missing_identity_warnings(&events.lock().unwrap());
        assert_eq!(
            warnings.len(),
            1,
            "a fresh session-provider tab.create with no identity keys must warn once"
        );
        assert_eq!(
            warnings[0].fields.get("mode").map(String::as_str),
            Some("gemini")
        );

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
    }

    /// The alarm must stay QUIET when the payload carries identity (a resume
    /// create, whose sessionRef increment 1 synthesizes) and for shell tabs
    /// (never session-identified by design).
    #[tokio::test]
    async fn create_tab_with_identity_or_shell_mode_does_not_warn_invariant() {
        let (events, _guard) = invariant_capture::capture();
        let argv_file = unique_argv_file("amplifier-no-warn");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "amplifier",
                &argv_file,
            )]));
        let tmp = std::env::temp_dir();
        let router = app(state.clone());

        let (status, body) = post(
            router.clone(),
            "/api/tabs",
            json!({
                "mode": "amplifier",
                "cwd": tmp.to_string_lossy(),
                "resumeSessionId": "sess-no-warn-1"
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let resumed_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        let (status, body) = post(
            router,
            "/api/tabs",
            json!({ "mode": "shell", "cwd": tmp.to_string_lossy() }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let shell_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        assert!(
            missing_identity_warnings(&events.lock().unwrap()).is_empty(),
            "identity-carrying and shell tab.creates must not trip the alarm"
        );

        let registry = state.terminal_registry.clone().unwrap();
        registry.kill(&resumed_id);
        registry.kill(&shell_id);
        let _ = std::fs::remove_file(&argv_file);
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
