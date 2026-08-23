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
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;

use freshell_platform::detect::{host_os_live, is_windows, is_wsl_env_live, HostOs};
use freshell_platform::mcp_inject::{cleanup_mcp_config, generate_mcp_injection, RealMcpRuntime};
use freshell_platform::spawn::{
    cli_provider_target, resolve_coding_cli_command, resolve_mcp_cwd, resolve_shell,
    resolve_unix_shell_cwd, CliLaunchInputs, LaunchIntent,
};
use freshell_platform::{
    build_cli_spawn_spec, build_spawn_spec, build_windows_cli_spawn_spec, CliLaunch, Env, RealEnv,
    RealFileProbe, ShellType, SpawnSpec,
};
use freshell_protocol::{ServerMessage, SessionLocator, UiCommand};
use freshell_terminal::registry::SessionRefClaim;

use crate::{
    authorized, fail_json, fail_json_code, ok_json, text_plain, FreshAgentState, TabRecord,
    TerminalPaneEntry,
};

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
/// (post-ejh6: the legacy raw `resumeSessionId` fallback it used to fall
/// through to is rejected at the REST door before this is ever consulted).
fn accepted_session_ref_for_mode<'a>(
    session_ref: Option<&'a SessionLocator>,
    mode: &str,
) -> Option<&'a SessionLocator> {
    session_ref.filter(|r| r.provider == mode)
}

/// `requestedResumeSessionIdForMode` (`router.ts:214-228`), post-ejh6:
/// resolve the ONE resume-session-id a create should launch with — the
/// provider-matched `sessionRef` only.
///
/// kata ejh6: the codex-specific legacy throw this function used to carry
/// moved UP to the door-top presence check in each axum handler (`lib.rs`
/// `create_tab`, `pane_ops.rs` `split_pane`/`respawn_pane`), which rejects
/// ANY body carrying `resumeSessionId` (every mode, every JSON value, even
/// alongside a matching `sessionRef`) with the frozen
/// `LEGACY_RESUME_IDENTITY_REFUSAL` text. The `_legacy_resume_session_id`
/// param is retained in the signature for caller compatibility
/// (`derive_resume_identity` still passes it through) but is now
/// INTENTIONALLY UNUSED — by the time control reaches here, no body can
/// still carry the field, so there is nothing left to resolve or reject.
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
    _legacy_resume_session_id: Option<&str>,
) -> Result<Option<String>, Response> {
    Ok(accepted_session_ref_for_mode(session_ref, mode).map(|s| s.session_id.clone()))
}

/// The terminal modes whose sessions live in a provider-durable store the
/// session directory can resolve (`amplifier`/`opencode`/`claude`/`gemini`/
/// `kimi`) -- the providers for which a bare `resumeSessionId` IS sufficient
/// canonical identity to mint `sessionRef {provider: mode, sessionId}`.
/// Deliberately NOT `codex`: a raw codex thread id alone is not restore
/// identity (`INVALID_RAW_CODEX_RESUME_MESSAGE` / `restore-decision.ts`).
/// (kata ejh6: wire-level legacy `resumeSessionId` is rejected at the REST
/// door-top before any of this runs — the plausibility/promotion machinery
/// below now only sees resume ids derived from an accepted `sessionRef`.)
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
/// concerns -- attach the pane content, broadcast, respond. Task 14 (AUTO-03):
/// the `{tabId,paneId}` pair is minted by the shared LayoutStore
/// (`layoutStore.createTab`, `router.ts:797`) and the pane content attached to
/// it (`attachPaneContent`, `:799`), so REST-created tabs are visible to the
/// store exactly like Node's `ensureSnapshot()` bootstrap; the legacy
/// `tabs`/`pane_tabs`/`content_panes` maps shadow it for bookkeeping only.
fn create_content_tab(
    state: &FreshAgentState,
    name: Option<String>,
    pane_content: Value,
    restore_key: Option<&str>,
    broadcast: bool,
) -> Response {
    let (tab_id, pane_id) = state.layout.create_tab(name.as_deref());
    state
        .layout
        .attach_pane_content(&tab_id, &pane_id, pane_content.clone());

    state
        .content_panes
        .lock()
        .expect("content_panes mutex")
        .insert(pane_id.clone(), pane_content.clone());
    state.tabs.lock().expect("tabs mutex").insert(
        tab_id.clone(),
        TabRecord {
            title: name.clone(),
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

/// Arm the opencode session locator for a freshly-created REST terminal,
/// iff it's a fresh (non-resuming) pane of the matching mode with a
/// resolved cwd -- mirrors `crates/freshell-ws/src/opencode_association::maybe_arm`
/// EXACTLY (same shared-instance `arm()` call, same argument shape); that
/// wrapper fn is `pub(crate)` inside `freshell-ws` and unreachable from this
/// crate (circular-dependency boundary, see this module's top doc), so this
/// is the thin, crate-local equivalent -- the actual mode/resume/cwd
/// admission logic lives ONCE, inside `OpencodeLocator::arm` itself (shared
/// by both crates via `freshell-sessions`), not duplicated here. (The
/// amplifier arm was deleted with the correlation-window locator, kata qmpk
/// — amplifier identity is launcher-assigned at create time.)
fn arm_locators_for_fresh_pane(
    state: &FreshAgentState,
    terminal_id: &str,
    mode: &str,
    cwd: Option<&str>,
    resume_session_id: Option<&str>,
    managed_codex: bool,
) {
    if let Some(locator) = &state.opencode_locator {
        locator.arm(terminal_id, mode, true, resume_session_id, cwd, now_ms());
    }
    // P1.14 / Incident-4: same shape as the WS-path codex arming call
    // (`crates/freshell-ws/src/codex_association.rs:46`) -- `CodexLocator::arm`
    // takes no timestamp (windows are Enter-anchored; arming schedules no
    // deadline, see `codex_locator.rs:166`).
    // S5.b / D-03: managed panes bind identity from the proxy Candidate stream,
    // so the CODEX locator never ARMS for them (mirrors
    // `freshell_ws::codex_association::should_arm_codex_locator`).
    if !managed_codex {
        if let Some(locator) = &state.codex_locator {
            locator.arm(terminal_id, mode, true, resume_session_id, cwd);
        }
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
///
/// The third element is the PRE-provider-filter parse result
/// (`session_ref_locator_present`: the `serde_json::from_value::<SessionLocator>`
/// parse above succeeded) — the fresh-claude preallocation predicate's
/// `has_session_ref` input (kata hbsa, ledger A1). It matches the WS door's
/// `create.session_ref.is_none()` on every mutually-accepted body shape
/// (absent / `null` / well-formed locator of ANY provider — any parsed
/// locator disables the mint), where the raw `body.get("sessionRef").is_some()`
/// check would see `Some(Value::Null)` and wrongly skip the mint.
#[allow(clippy::result_large_err)]
pub(crate) fn derive_resume_identity(
    body: &Value,
    mode: &str,
) -> Result<(Option<String>, Option<SessionLocator>, bool), Response> {
    let session_ref: Option<SessionLocator> = body
        .get("sessionRef")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok());
    let session_ref_locator_present = session_ref.is_some();
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
    Ok((
        resume_session_id,
        accepted_session_ref,
        session_ref_locator_present,
    ))
}

/// Door 3 (resume-validation): what [`validate_rest_resume`] decided for a
/// REST create's cached resume id. Mirrors `freshell-ws`'s
/// `ResumeValidationOutcome` (Task 6), including the claude-prealloc flag
/// (the healed pane_content stamping falls out of
/// `plausible_resume_session_id` on the minted id instead).
struct RestResumeOutcome {
    resume_session_id: Option<String>,
    launch_intent: LaunchIntent,
    /// True when the gate minted a fresh claude id as an absence fallback.
    /// The REST consumer must run the PIN 2 pre-spawn ledger write exactly
    /// as a natural fresh-claude create would (main #584), even though a
    /// resume_session_id is present (it is minted, not resumed).
    claude_fresh_prealloc: bool,
    /// Some(stale_id) iff the gate fired: caller clears the accepted wire
    /// ref (never stamp the stale sessionRef), invokes `on_stale_resume`,
    /// and injects the notice into the returned `paneContent`.
    stale_session_id: Option<String>,
    notice: Option<String>,
}

/// The Proceed shape — shared by [`validate_rest_resume`] and the wiring
/// site's live-candidate skip (a LIVE session must never be gated).
fn rest_resume_passthrough(
    resume_session_id: Option<String>,
    launch_intent: LaunchIntent,
) -> RestResumeOutcome {
    RestResumeOutcome {
        resume_session_id,
        launch_intent,
        claude_fresh_prealloc: false,
        stale_session_id: None,
        notice: None,
    }
}

/// Door 3 gate (resume-validation): before the REST create pipeline turns a
/// cached session id into resume argv, ask the disk-existence probe. On
/// POSITIVE absence, fall back to the same shape a genuinely fresh pane of
/// that mode uses (claude → new UUID + `Start`; amplifier → new UUID +
/// `Resume`; codex/opencode → `None`). Unknown/unavailable, unvalidated
/// providers, and `probe: None` (feature not wired — bare unit-test states)
/// all fail open. Body mirrors `freshell_ws::resume_validation::
/// validate_wire_resume`, using the `ResumeProbeFn` injection shape because
/// this crate must not depend on `freshell-ws`. SYNC by design: the wiring
/// site runs it inside `tokio::task::spawn_blocking` (A13 — the probe does
/// real filesystem walks). Minted UUIDs MUST be RFC-4122 v4 (`Uuid::new_v4()`,
/// the crate's existing mint convention) — `is_canonical_claude_session_id`
/// enforces version 1..=5 + RFC-4122 variant, so a v7 or nil UUID would fail
/// [`plausible_resume_session_id`] and break the healed identity stamping.
fn validate_rest_resume(
    mode: &str,
    resume_session_id: Option<String>,
    launch_intent: LaunchIntent,
    probe: Option<&freshell_platform::resume_gate::ResumeProbeFn>,
) -> RestResumeOutcome {
    use freshell_platform::resume_gate::{
        evaluate_resume_gate, provider_validated, stale_resume_notice, ResumeGateDecision,
    };
    let Some(probe) = probe else {
        return rest_resume_passthrough(resume_session_id, launch_intent);
    };
    let Some(sid) = resume_session_id.clone().filter(|s| !s.is_empty()) else {
        return rest_resume_passthrough(resume_session_id, launch_intent);
    };
    if !provider_validated(mode) {
        return rest_resume_passthrough(resume_session_id, launch_intent);
    }
    let answer = probe(mode, &sid);
    match evaluate_resume_gate(mode, answer.existence, answer.ever_observed_on_disk) {
        ResumeGateDecision::Proceed => rest_resume_passthrough(resume_session_id, launch_intent),
        ResumeGateDecision::SpawnFresh => {
            let notice = stale_resume_notice(mode, &sid);
            let (fresh_id, intent, claude_fresh_prealloc) = match mode {
                // Mirror the genuine fresh-pane shapes (same per-provider
                // fallbacks as the WS door's validate_wire_resume). The
                // claude arm MINTS a fresh id, so it must also carry the
                // prealloc marker (PIN 2 coupling, main #584).
                "claude" => (Some(Uuid::new_v4().to_string()), LaunchIntent::Start, true),
                "amplifier" => (
                    Some(Uuid::new_v4().to_string()),
                    LaunchIntent::Resume,
                    false,
                ),
                _ => (None, LaunchIntent::Resume, false),
            };
            RestResumeOutcome {
                resume_session_id: fresh_id,
                launch_intent: intent,
                claude_fresh_prealloc,
                stale_session_id: Some(sid),
                notice: Some(notice),
            }
        }
    }
}

/// The D7/D8 409 refusal envelope (reconnect-revive Task 7): the exact
/// `fail_json_code` shape plus, when the refusal can name a still-running
/// terminal, the additive `liveTerminalId` a caller reattaches to instead of
/// dead-ending on the message. The envelope and its message text stay
/// byte-identical to every other RESTORE_UNAVAILABLE refusal ("still running
/// on the server." — client regexes and muscle memory depend on it); all
/// novelty rides the additive field, and `live_terminal_id: None` keeps the
/// body byte-identical to the pre-feature shape (frozen-client parity).
fn fail_json_restore_unavailable(live_sid: &str, live_terminal_id: Option<&str>) -> Response {
    let mut body = json!({
        "status": "error",
        "code": "RESTORE_UNAVAILABLE",
        "message": format!("Session {live_sid} is still running on the server."),
    });
    if let Some(tid) = live_terminal_id {
        body["liveTerminalId"] = json!(tid);
    }
    (StatusCode::CONFLICT, Json(body)).into_response()
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

/// DEV-0006 gate, REST side (S5.e: default ON): a codex `POST /api/tabs` /
/// pane-split create plans a managed app-server launch when the mode is codex,
/// unless the `FRESHELL_CODEX_MANAGED_LAUNCH` flag is exactly `"0"` — the only
/// opt-out back to the plain-CLI REST codex behavior. SAME predicate the WS
/// `terminal.create` branch gates on
/// (`crates/freshell-ws/src/terminal.rs::codex_create_uses_managed_launch`).
fn codex_create_uses_managed_launch(mode: &str, flag_value: Option<&str>) -> bool {
    mode == "codex" && freshell_codex::launch_plan::codex_managed_launch_enabled(flag_value)
}

/// Freshell opencode TUI rebind plugin, REST side — the IO-layer half of the
/// injection (`cli_launch.rs` consumes the result via
/// `CliLaunchInputs::opencode_rebind_tui_config`, the `mcp_injection`
/// precedent; same precompute as the WS create path,
/// `crates/freshell-ws/src/terminal.rs::opencode_rebind_precompute`): install
/// the plugin + plugin-only tui.json under the real process env's home and
/// return the tui.json path. Home resolution mirrors
/// `ClaudeSignalWatcher::default_root` (`claude_signal.rs:52-66`):
/// `%USERPROFILE%` on Windows, `$HOME` otherwise; empty/unset ⇒ `None` ⇒
/// skip injection. Install failure warn-logs and returns `None` — it must
/// never block the launch.
fn opencode_rebind_precompute() -> Option<String> {
    #[cfg(windows)]
    let base = std::env::var("USERPROFILE").ok()?;
    #[cfg(not(windows))]
    let base = std::env::var("HOME").ok()?;
    if base.is_empty() {
        return None;
    }
    match freshell_platform::opencode_plugin::ensure_rebind_plugin_installed(std::path::Path::new(
        &base,
    )) {
        Ok(tui_config) => Some(tui_config.display().to_string()),
        Err(error) => {
            tracing::warn!(
                %error,
                "opencode_rebind_plugin_install_failed: launching without rebind signal"
            );
            None
        }
    }
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
        // Restore-class-only variants. The REST door is Interactive by
        // construction, so these are defensively mapped, mirroring
        // spawn_gate_error_response's QueueFull -> 429.
        CodexLaunchError::QueueFull => StatusCode::TOO_MANY_REQUESTS,
        CodexLaunchError::Cancelled => StatusCode::INTERNAL_SERVER_ERROR,
    };
    fail_json(status, error.to_string())
}

/// REST mapping of a spawn-gate rejection (WS analogue:
/// `spawn_gate_error_parts` in freshell-ws/src/terminal.rs).
/// QueueFull -> 429 with Retry-After (bccd item 1): header for HTTP
/// convention + `retryAfterMs` body field (house convention, session-lease
/// SESSION_RESERVED). The retry guidance ALSO stays in the MESSAGE because
/// the MCP bridge (server/mcp/freshell-tool.ts) surfaces only message text.
/// Timeout -> 503: spawn capacity unavailable right now.
/// Body key is `code`+`message` (never `error`).
fn spawn_gate_error_response(
    err: crate::spawn_gate::SpawnGateError,
    retry_after: std::time::Duration,
) -> Response {
    match err {
        crate::spawn_gate::SpawnGateError::QueueFull => crate::fail_json_code_retry_after(
            StatusCode::TOO_MANY_REQUESTS,
            "SPAWN_QUEUE_FULL",
            "Too many concurrent terminal spawns; retry shortly".to_string(),
            retry_after,
        ),
        crate::spawn_gate::SpawnGateError::Timeout => crate::fail_json_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "SPAWN_TIMEOUT",
            "Timed out waiting for a terminal spawn slot".to_string(),
        ),
        // Unreachable since acquire_uncancellable (znhn item 4): no cancel
        // sender exists on this door at all. Mapped like Timeout so an
        // impossible arm still fails safe.
        crate::spawn_gate::SpawnGateError::Cancelled => crate::fail_json_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "SPAWN_TIMEOUT",
            "Timed out waiting for a terminal spawn slot".to_string(),
        ),
    }
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
    requested
        .filter(|s| !s.is_empty())
        .map(|requested| plan_session_id.unwrap_or(requested).to_string())
}

/// RAII release of a D8 sessionRef lease claim on the REST rung (port of the
/// WS path's `SessionRefLeaseGuard`, `crates/freshell-ws/src/terminal.rs`):
/// on EVERY non-complete exit of [`spawn_terminal_pane`] between claim and
/// completion -- pre-spawn error, `registry.create` failure, codex adopt
/// failure, or axum cancelling the request future -- drop releases the lease
/// via `fail_session_ref_claim` (a no-op once `complete_session_ref_claim`
/// removed it). The winner path disarms and completes explicitly.
struct RestSessionRefLease {
    registry: freshell_terminal::TerminalRegistry,
    locator: SessionLocator,
    holder_create_request_id: String,
    armed: bool,
}

impl RestSessionRefLease {
    fn new(
        registry: freshell_terminal::TerminalRegistry,
        locator: SessionLocator,
        holder_create_request_id: String,
    ) -> Self {
        Self {
            registry,
            locator,
            holder_create_request_id,
            armed: true,
        }
    }

    /// Hand ownership of the release decision back to the caller (winner
    /// bind or the revoked-lease kill path).
    fn disarm(mut self) -> SessionLocator {
        self.armed = false;
        self.locator.clone()
    }
}

impl Drop for RestSessionRefLease {
    fn drop(&mut self) {
        if self.armed {
            self.registry
                .fail_session_ref_claim(&self.locator, &self.holder_create_request_id);
        }
    }
}

/// Poll `kill(pid, 0)` for ESRCH for up to 500ms (the PTY's dedicated waiter
/// thread reaps promptly -- `pty.rs` reader/waiter; same 20x25ms cadence as
/// the WS path's `confirm_pid_dead_within_500ms`). `true` = death CONFIRMED.
async fn confirm_pid_dead_within_500ms(pid: u32) -> bool {
    for _ in 0..20u8 {
        if !freshell_terminal::registry::pid_alive(pid) {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    !freshell_terminal::registry::pid_alive(pid)
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
    let mut cwd = body.get("cwd").and_then(Value::as_str).map(str::to_string);

    // Stable pane identity key (reconciliation-handshake design §5.5,
    // precondition 2): honor a caller-supplied key (snapshot restore passes
    // the captured one through `pane_to_create_body`), else mint one so every
    // REST-created terminal pane is keyed. Same Uuid::simple idiom as the
    // fresh-agent path (lib.rs `create_tab`).
    let create_request_id = body
        .get("createRequestId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().simple().to_string());

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

    let (mut resume_session_id, mut accepted_session_ref, session_ref_locator_present) =
        derive_resume_identity(body, &mode)?;

    // Door 3 (resume-validation): gate the cached resume id on disk existence
    // BEFORE the amplifier ensure_session below (or the re-stub would
    // resurrect the stale dir) and before CliLaunchInputs is built.
    //
    // In-gate liveness precondition (MANDATORY — ordering hazard, the A11
    // door-1 hazard with the constraint INVERTED: in THIS pipeline the
    // amplifier ensure comes BEFORE the REST D7 live-session guard and the D8
    // lease, so the gate cannot get liveness protection by after-D7 placement;
    // placed here, a gate fire on a LIVE candidate would clear
    // accepted_session_ref / replace resume_session_id and FALSIFY the D7-REST
    // applicability filter — its loud RESTORE_UNAVAILABLE/CONFLICT reject and
    // the D8 lease silently bypassed, and on_stale_resume → retire_missing
    // would destroy the Bound ledger row of a RUNNING session. Reachable: a
    // live zero-turn codex session genuinely has no rollout on disk.):
    // a LIVE session must never be gated. TWO ARMS, both load-bearing:
    // the registry arm reuses the REST D7 guard's own consult (below, which
    // owns the loud reject for registry-live sessions downstream); the
    // sidecar arm exists because that consult is PTY-scoped and blind to
    // sessions live inside the fresh-agent sidecars — the very
    // live-zero-turn-with-no-rollout-on-disk case. Dropping either arm
    // silently un-protects a class of live sessions (the live-session tests
    // pin BOTH arms).
    let candidate_is_live = match resume_session_id.as_deref() {
        None => false,
        Some(sid) => {
            // Arm 1 (registry): the SAME consult the REST D7 guard below
            // performs — shared, not reimplemented.
            let registry_live = registry
                .live_session_owner(state.session_identity.as_deref(), &mode, sid)
                .is_some();
            // Arm 2 (sidecar): the injected async probe. None (not wired,
            // e.g. bare unit-test states) => arm contributes false.
            let sidecar_live = if registry_live {
                true // short-circuit: already live
            } else {
                match &state.sidecar_liveness {
                    Some(probe) => probe(&mode, sid).await,
                    None => false,
                }
            };
            registry_live || sidecar_live
        }
    };
    // Today's hardcoded intent for this pipeline (see the CliLaunchInputs
    // comment in settle_gated_create) — the gate's claude fallback is the
    // one path that rewrites it to Start.
    let launch_intent = LaunchIntent::Resume;
    // Probe does real filesystem walks — never inline on the async runtime
    // (A13); run the sync helper in spawn_blocking. A LIVE candidate skips
    // the gate entirely (passthrough — same shape validate_rest_resume
    // returns for Proceed), so the unchanged create flows into the D7-REST
    // guard and D8 lease exactly as today.
    let rest_outcome = if candidate_is_live {
        rest_resume_passthrough(resume_session_id.take(), launch_intent)
    } else {
        let probe = state.resume_probe.clone();
        let mode_for_gate = mode.clone();
        let rid = resume_session_id.take();
        let intent = launch_intent;
        tokio::task::spawn_blocking(move || {
            validate_rest_resume(&mode_for_gate, rid, intent, probe.as_ref())
        })
        .await
        .expect("resume validation task panicked")
    };
    let mut resume_session_id = rest_outcome.resume_session_id;
    let launch_intent = rest_outcome.launch_intent;
    if let Some(stale) = rest_outcome.stale_session_id.as_deref() {
        // MANDATORY stale-ref guard (V7 row 10): the pane_content identity
        // stamping PREFERS accepted_session_ref — left in place, the STALE
        // wire ref would be stamped into the new tab's pane_content,
        // poisoning client persistence + tabs-sync replay and re-firing the
        // gate every restart. Clearing it makes stamping fall through to the
        // minted-ref branch, so gate-fired claude/amplifier panes are born
        // with the HEALED ref and codex/opencode panes with no ref.
        accepted_session_ref = None;
        if let Some(cb) = &state.on_stale_resume {
            cb(&mode, stale);
        }
    }
    let resume_notice = rest_outcome.notice;

    // Fresh-claude preallocation (kata hbsa): WS parity. The WS door's
    // fresh-claude special case (freshell-ws/src/terminal.rs, LIVE-PATH LAW
    // spec §2.1(3)) mints a server-preallocated --session-id for every fresh
    // claude create; this REST door historically did not (legacy router.ts
    // lineage), leaving REST claude panes un-resumable and invisible to the
    // A13 live-owner guard. Same predicate, same mint, both doors.
    //
    // PIN 2 (eaa25b7d): `claude_fresh_prealloc` marks that THIS create minted
    // the id — the pre-spawn ledger write and its spawn-failure delete (Task 5
    // call sites in settle_gated_create) are BOTH gated on this exact flag,
    // never on `mode == "claude"`.
    //
    // The MINT stays keyed on main's raw predicate ("no resume id"): a
    // gate-fired create already carries the gate-minted id, and re-minting
    // would overwrite it with a second UUID.
    let claude_prealloc_mint = freshell_platform::should_preallocate_fresh_claude(
        &mode,
        body.get("restore").and_then(serde_json::Value::as_bool),
        session_ref_locator_present,
        resume_session_id.as_deref(),
    );
    if claude_prealloc_mint {
        resume_session_id = Some(Uuid::new_v4().to_string());
    }
    // Door 3 (resume-validation) × PIN 2: a gate-fired claude fallback ALSO
    // minted a fresh id (in `validate_rest_resume`), so it must get the same
    // PIN 2 pre-spawn write / failure delete / `Start` intent as a natural
    // fresh claude create — fold the outcome flag in (WS door parity:
    // freshell-ws/src/terminal.rs does this exact OR-fold).
    let claude_fresh_prealloc = claude_prealloc_mint || rest_outcome.claude_fresh_prealloc;

    // Hoisted spawn-environment inputs, computed ONCE (Task 8's WS pattern,
    // REST twin): the amplifier windows-arm guard below and the spawn-spec
    // construction in `settle_gated_create` (its `windows_like` branch pick,
    // terminal_tabs.rs `spec = match &launch {...}`) must evaluate the SAME
    // values so guard and spawn can never disagree — `host_os`/`is_wsl` are
    // threaded through [`GatedSettleInputs`] instead of being re-read there.
    let host_os = host_os_live();
    let is_wsl = is_wsl_env_live();
    let shell_type = shell_str
        .as_deref()
        .and_then(ShellType::parse)
        .unwrap_or(ShellType::System);
    let effective_shell = resolve_shell(shell_type, host_os, is_wsl);
    let windows_like = is_windows(host_os) || (is_wsl && effective_shell != ShellType::System);

    // Launcher-assigned amplifier identity (kata qmpk) — REST twin of the WS
    // block in `crates/freshell-ws/src/terminal.rs` (Tasks 8-9), covering
    // POST /api/tabs, /api/panes/:id/split, and /respawn (every caller
    // funnels through this function). Sequential with (not replacing) the
    // D7 liveness guard below (PR #540) and the PR #559 spawn gate.
    // ORDERING IS LOAD-BEARING: the stub — including events.jsonl — must be
    // written BEFORE registry.create (the activity events-lane resolver
    // attaches at create time), and writing it HERE, before the detach
    // point, keeps every client-visible 4xx synchronous.
    let mut amplifier_stub: Option<freshell_sessions::amplifier_stub::EnsuredSession> = None;
    if mode == "amplifier" {
        // A10/B1 guard — REST twin of the WS windows-arm reject: a
        // client-supplied `shell` can route the spawn to
        // build_windows_cli_spawn_spec, whose cwd handling is a DIFFERENT
        // transformation than the one the stub slug is computed from.
        if windows_like {
            return Err(fail_json(
                StatusCode::BAD_REQUEST,
                "Amplifier terminals require the default system shell on a unix host (cwd is part of the session identity contract).".to_string(),
            ));
        }
        if resume_session_id
            .as_deref()
            .is_some_and(|s| s.starts_with("terminal:"))
        {
            // Defense-in-depth against the old correlation bug's poisoned
            // persisted tab state: `terminal:<id>` is Freshell's own
            // synthetic sidebar placeholder, never a resumable session.
            return Err(fail_json(
                StatusCode::BAD_REQUEST,
                format!(
                    "Invalid amplifier sessionRef '{}': synthetic terminal placeholder ids are not resumable sessions.",
                    resume_session_id.as_deref().unwrap_or_default()
                ),
            ));
        }
        // Launcher-assigned identity: a fresh (non-restore) create mints the
        // session UUID up front. Legacy persisted panes with NO resume id
        // and `restore: true` spawn a fresh identity-less amplifier (no
        // preallocation on restore — accepted scope clarification).
        let is_restore = body.get("restore").and_then(Value::as_bool) == Some(true);
        if resume_session_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .is_none()
            && !is_restore
        {
            resume_session_id = Some(Uuid::new_v4().to_string());
        }
        if let Some(requested) = resume_session_id.as_deref() {
            // Friendly pre-check; race-free enforcement is inside
            // TerminalRegistry::create (Task 7) and mapped to 409 in
            // `settle_gated_create`'s failure branch.
            if freshell_terminal::registry::has_live_resume(
                &registry.identity_probe_rows(),
                "amplifier",
                requested,
            ) {
                return Err(fail_json(
                    StatusCode::CONFLICT,
                    format!("Amplifier session {requested} is already open in a live terminal."),
                ));
            }
            // ONE effective spawn cwd (F4). The falsified path this closes:
            // cwd=None used to flow into build_cli_spawn_spec → spec.cwd =
            // None → the PTY inherited the BROKER's own cwd while the stub
            // sat under slug($HOME) — silent divergence. Compute the
            // effective cwd ONCE (explicit validated cwd, else $HOME),
            // verify it is a dir, slug the stub from it, and assign it back
            // so the spawn plumbing receives the SAME value.
            let raw_effective_cwd = match cwd
                .clone()
                .or_else(|| std::env::var("HOME").ok().filter(|v| !v.is_empty()))
            {
                Some(c) => c,
                None => {
                    return Err(fail_json(
                        StatusCode::BAD_REQUEST,
                        "Amplifier requires a resolvable working directory (cwd is part of the session identity contract).".to_string(),
                    ));
                }
            };
            // A10/B2 guard (validated falsification): REST's is_dir check
            // above ADMITS relative paths, but build_cli_spawn_spec resolves
            // a relative cwd to None (resolve_unix_shell_cwd) and the PTY
            // then inherits the BROKER's cwd while the stub slugs the
            // canonicalized path — silent divergence. Run the SAME
            // transformation the spawn layer applies (idempotent for
            // absolute unix paths) and reject what it cannot represent.
            let Some(mut effective_cwd) =
                resolve_unix_shell_cwd(Some(raw_effective_cwd.as_str()), &RealEnv, is_wsl)
            else {
                return Err(fail_json(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "Amplifier working directory \"{raw_effective_cwd}\" must be an absolute path."
                    ),
                ));
            };
            if !std::path::Path::new(&effective_cwd).is_dir() {
                return Err(fail_json(
                    StatusCode::BAD_REQUEST,
                    format!("Amplifier working directory \"{effective_cwd}\" does not exist."),
                ));
            }
            let ensured = freshell_sessions::amplifier_stub::resolve_amplifier_home()
                .ok_or_else(|| {
                    "amplifier home unresolvable (no FRESHELL_AMPLIFIER_HOME and no HOME)"
                        .to_string()
                })
                .and_then(|amp_home| {
                    freshell_sessions::amplifier_stub::ensure_session(
                        &amp_home,
                        requested,
                        &effective_cwd,
                        // terminal_id is minted later in settle_gated_create;
                        // the stub's freshell_terminal_id is a durable-linkage
                        // bonus, not a key — record the createRequestId.
                        &create_request_id,
                    )
                    .map_err(|e| e.to_string())
                });
            match ensured {
                Ok(ensured) => {
                    // Requested resume FOUND under a different slug than
                    // slug(effective_cwd) (F4): cwd is part of amplifier's
                    // identity contract — resuming from elsewhere finds
                    // nothing. Spawn at the session's own working_dir, or
                    // reject loudly if it no longer exists.
                    if ensured.found_under_divergent_slug {
                        match ensured
                            .working_dir_of_existing
                            .as_deref()
                            .filter(|d| std::path::Path::new(d).is_dir())
                        {
                            Some(existing_dir) => effective_cwd = existing_dir.to_string(),
                            None => {
                                return Err(fail_json(
                                    StatusCode::BAD_REQUEST,
                                    format!(
                                        "Amplifier session {requested} was created in {}, which no longer exists.",
                                        ensured
                                            .working_dir_of_existing
                                            .as_deref()
                                            .unwrap_or("an unknown directory")
                                    ),
                                ));
                            }
                        }
                    }
                    // CRITICAL (F4): the registry row and build_cli_spawn_spec
                    // must receive the effective cwd, never None.
                    cwd = Some(effective_cwd);
                    amplifier_stub = Some(ensured);
                }
                Err(detail) => {
                    // Fail LOUD: spawning `amplifier session resume
                    // --full-history <id>` without a
                    // resumable dir would hang a doomed CLI (the exact
                    // failure mode this feature deletes).
                    return Err(fail_json(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to pre-create amplifier session {requested}: {detail}"),
                    ));
                }
            }
        }
    }

    // D7 live-session guard, REST rung -- mirrors the WS terminal.create guard
    // (freshell-ws/src/terminal.rs D7 block) via the shared
    // TerminalRegistry::live_session_owner predicate: a resume derived from a
    // wire `sessionRef` whose (provider, sessionId) is already owned by a
    // RUNNING terminal is refused. Never spawn a second `<cli> --resume <sid>`
    // while the original live PTY owns <sid> (one-JSONL-writer doctrine).
    // Placement: before any side effect (no PTY, no MCP write, no port alloc,
    // no codex plan), so refusal needs zero rollback. This is the single choke
    // point for POST /api/tabs, /api/panes/:id/split, and /api/panes/:id/respawn
    // (every spawn_terminal_pane caller). No self-exemption for respawn: the
    // old terminal is deliberately never killed ("detach, don't kill"), so
    // resuming its live session in a second PTY would be exactly the
    // two-writers corruption this guard forbids.
    //
    // The guard arms on ONE effective session locator: the accepted wire
    // `sessionRef` first, else the PROMOTED legacy `resumeSessionId` rung --
    // `{provider: mode, sessionId}` per the reconcile door's §5.2 uniform
    // promotion rule (reconcile.rs `promoted_legacy_claim`). The legacy rung
    // was previously unguarded, which let a legacy-only carrier (the
    // `freshell` CLI's `--resume`) spawn a second live writer onto an owned
    // session (2026-08-16 duplicate-tab incident). Promotion is gated on the
    // SAME predicate the EDEV-07 pane_content synthesis uses
    // ([`is_session_provider_mode`] + [`plausible_resume_session_id`]), and
    // on the resume id still being the CALLER's wire value -- a gate-healed
    // or freshly-minted id (claude prealloc, amplifier launcher identity)
    // never came from the wire and claims nothing, exactly like the WS door.
    let wire_legacy_resume_id = body
        .get("resumeSessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let guard_locator: Option<SessionLocator> = accepted_session_ref
        .as_ref()
        .filter(|r| {
            !r.session_id.is_empty() && resume_session_id.as_deref() == Some(r.session_id.as_str())
        })
        .cloned()
        .or_else(|| {
            resume_session_id
                .as_deref()
                .filter(|sid| wire_legacy_resume_id == Some(*sid))
                .filter(|sid| {
                    is_session_provider_mode(&mode) && plausible_resume_session_id(&mode, sid)
                })
                .map(|sid| SessionLocator {
                    provider: mode.clone(),
                    session_id: sid.to_string(),
                })
        });
    let mut session_ref_lease: Option<RestSessionRefLease> = None;
    if let Some(live_sid) = guard_locator.as_ref().map(|r| r.session_id.as_str()) {
        // Reconnect-revive Task 7: every refusal that CAN name a live terminal
        // carries its id (`liveTerminalId`) so the caller can reattach instead
        // of dead-ending. The envelope and message text stay byte-identical.
        if let Some(owner_terminal_id) =
            registry.live_session_owner(state.session_identity.as_deref(), &mode, live_sid)
        {
            tracing::warn!(
                target: "freshell_freshagent::terminal_tabs",
                mode = %mode,
                session_id = %live_sid,
                pane_id = %pane_id,
                "spawn_refused: a Running terminal already owns this session (D7 live-guard, REST rung)"
            );
            return Err(fail_json_restore_unavailable(
                live_sid,
                Some(&owner_terminal_id),
            ));
        }

        // D8 session-ref lease, REST rung (Design Decision 6) -- D7 above is
        // check-then-spawn: two concurrent REST resumes (or REST x WS) could
        // both pass it and spawn two JSONL writers for one session. Claim the
        // registry's per-sessionRef lease (the same primitive the WS create
        // path holds) BEFORE spawning; the RAII guard releases it on every
        // error path between here and the post-create completion. Holder id
        // is the already-minted create_request_id; holder_conn is a fresh
        // registry connection id (collision-free with WS conn cleanup -- REST
        // leases rely on RAII drop + the lease TTL, not conn-death cleanup).
        let locator = guard_locator
            .clone()
            .expect("guard_locator is Some inside this branch");
        match registry.claim_session_ref(
            &locator,
            &create_request_id,
            registry.new_connection_id(),
            now_ms().max(0) as u64,
        ) {
            SessionRefClaim::Acquired => {
                session_ref_lease = Some(RestSessionRefLease::new(
                    registry.clone(),
                    locator,
                    create_request_id.clone(),
                ));
            }
            // Conservative v1 (Design Decision 6): Held/ExpiredNeedsKill answer
            // the nameless 409 envelope (a claim in flight / a crashed holder
            // has no live terminal to name). BoundElsewhere = a live winner
            // exists (D7's own answer): carry its terminal id too, so the
            // claim-race refusal is equally attachable (fresh-eyes F5).
            SessionRefClaim::BoundElsewhere { terminal_id } => {
                tracing::warn!(
                    target: "freshell_freshagent::terminal_tabs",
                    mode = %mode,
                    session_id = %live_sid,
                    pane_id = %pane_id,
                    "spawn_refused: sessionRef already bound to a live terminal (D8, REST rung)"
                );
                return Err(fail_json_restore_unavailable(live_sid, Some(&terminal_id)));
            }
            SessionRefClaim::Held { .. } | SessionRefClaim::ExpiredNeedsKill { .. } => {
                tracing::warn!(
                    target: "freshell_freshagent::terminal_tabs",
                    mode = %mode,
                    session_id = %live_sid,
                    pane_id = %pane_id,
                    "spawn_refused: sessionRef lease unavailable (D8, REST rung)"
                );
                return Err(fail_json_restore_unavailable(live_sid, None));
            }
        }
    }

    // F1 (council enn3; prior art da5d9b5c, pinned by the WS door's
    // `create_gate::hold_permit_across`): everything from here to the
    // settled terminal runs on a DETACHED task that OWNS the permit, the
    // session-ref lease, and (for codex) the launch plan. This handler
    // future is droppable at every await — a client abort (`curl
    // --max-time` does it) must NOT release the permit while the
    // uncancellable `spawn_blocking` fork proceeds (that was the gate
    // escape), nor skip the post-spawn bookkeeping (set_meta / lease bind /
    // codex adopt / `terminal_panes`+`pane_tabs`). With the settle task
    // detached, an aborted create is FULLY BOOKKEPT — never a
    // half-initialized orphan. (The WS door solves the same hazard by
    // spawning its settled restore create: `spawn_gated_restore_create`.)
    let settle = tokio::spawn(settle_gated_create(GatedSettleInputs {
        state: state.clone(),
        body: body.clone(),
        tab_id: tab_id.to_string(),
        pane_id: pane_id.to_string(),
        mode,
        shell_str,
        cwd,
        resume_session_id,
        launch_intent,
        resume_notice,
        accepted_session_ref,
        claude_fresh_prealloc,
        pane_identity: state.pane_identity.clone(),
        create_request_id,
        session_ref_lease,
        registry,
        host_os,
        is_wsl,
        amplifier_stub,
    }));
    match settle.await {
        Ok(result) => result,
        // JoinError = panic inside the settle task (the task's own
        // spawn_blocking JoinError arm already maps fork panics into the
        // 400 rollback path below). RAII (permit, lease) released on the
        // task's unwind.
        Err(join_err) => Err(fail_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("terminal create task panicked: {join_err}"),
        )),
    }
}

/// Owned inputs for [`settle_gated_create`]: the settle task must be
/// `'static` (it outlives an aborted handler future by design), so every
/// input moves in by value.
struct GatedSettleInputs {
    state: FreshAgentState,
    body: Value,
    tab_id: String,
    pane_id: String,
    mode: String,
    shell_str: Option<String>,
    cwd: Option<String>,
    resume_session_id: Option<String>,
    /// Door 3 (resume-validation): the gate's outcome intent — today's
    /// hardcoded `Resume` everywhere EXCEPT the gate-fired claude fallback,
    /// whose minted fresh id launches with `Start`.
    launch_intent: LaunchIntent,
    /// Door 3: the operator-visible stale-resume notice when the gate fired,
    /// injected into the returned `paneContent` as `reconcileNotice`.
    resume_notice: Option<String>,
    accepted_session_ref: Option<SessionLocator>,
    /// Fresh-claude preallocation (kata hbsa): `true` iff THIS create minted
    /// its own `--session-id` (the [`freshell_platform::should_preallocate_fresh_claude`]
    /// predicate fired in [`spawn_terminal_pane`]). Selects `LaunchIntent::Start`
    /// below, and PIN 2 (eaa25b7d): the pre-spawn ledger write and its
    /// spawn-failure delete (Task 5 call sites) are BOTH gated on this exact
    /// flag, never on `mode == "claude"`.
    claude_fresh_prealloc: bool,
    /// Write-side pane-identity seam (kata hbsa, Task 5): `Some` in
    /// production (wired by `freshell-server::main` via
    /// [`FreshAgentState::with_pane_identity_binder`]); `None` (tests
    /// without identity concerns) keeps the legacy no-write behavior —
    /// every call site below is `if let Some`-gated.
    pane_identity: Option<std::sync::Arc<dyn freshell_terminal::registry::PaneIdentityBinder>>,
    create_request_id: String,
    session_ref_lease: Option<RestSessionRefLease>,
    registry: freshell_terminal::TerminalRegistry,
    /// Hoisted spawn-environment inputs (Task 11): computed ONCE in
    /// [`spawn_terminal_pane`] so the amplifier windows-arm guard there and
    /// the spawn-spec construction here can never disagree.
    host_os: HostOs,
    is_wsl: bool,
    /// Launcher-assigned amplifier identity: the stub [`spawn_terminal_pane`]
    /// pre-created for this create (Task 11) — consumed here for the
    /// spawn-failure GC and the exit hook's never-used-stub GC.
    amplifier_stub: Option<freshell_sessions::amplifier_stub::EnsuredSession>,
}

/// The spawn-to-settled tail of [`spawn_terminal_pane`], run on a detached
/// `tokio::spawn` so a dropped (client-aborted) handler future can neither
/// release the spawn-gate permit early nor leave the created terminal
/// half-bookkept — the F1 fix (see the call site's comment). The permit is
/// held from before the PTY fork until every settle step (meta, lease bind,
/// codex adopt, pane bookkeeping) completed — the same spawn-to-settled
/// scope the WS door pins with `hold_permit_across`.
async fn settle_gated_create(inputs: GatedSettleInputs) -> Result<TerminalSpawnResult, Response> {
    // D-C-R (2026-07-30): the spawn-gate permit is now acquired BELOW, after
    // the (possibly ~long) codex managed plan, so codex planning never holds a
    // server-wide spawn permit. Declared first so it drops last (RAII scope:
    // acquire → PTY fork → every settle step → drop).
    let mut _spawn_permit: Option<tokio::sync::OwnedSemaphorePermit> = None;
    let GatedSettleInputs {
        state,
        body,
        tab_id,
        pane_id,
        mode,
        shell_str,
        cwd,
        mut resume_session_id,
        launch_intent,
        resume_notice,
        accepted_session_ref,
        claude_fresh_prealloc,
        pane_identity,
        create_request_id,
        mut session_ref_lease,
        registry,
        host_os,
        is_wsl,
        amplifier_stub,
    } = inputs;

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
        // `host_os`/`is_wsl` arrive from `spawn_terminal_pane` (hoisted, Task
        // 11) — computed once so the amplifier guard and this spawn agree.
        let shell_type = shell_str
            .as_deref()
            .and_then(ShellType::parse)
            .unwrap_or(ShellType::System);
        let overrides =
            build_terminal_base_env(&RealEnv, &terminal_id, Some(&tab_id), Some(&pane_id));
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

        // D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH) — RESOLVED 2026-07-30
        // (DEV-0006 S5.e precondition): this plan no longer runs under the
        // held spawn permit (acquire moved below the plan, WS-auto-resume
        // mirror), and concurrent plans are bounded by the manager's sidecar
        // planning budget (CODEX_SIDECAR_PLAN_CONCURRENCY=2; fail-fast for
        // LaunchClass::Interactive — this door; restore-class queues per
        // graceful restore/resume S1).
        // Decision record: docs/plans/2026-07-27-rest-spawn-gate.md §D-C addendum.
        //
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
                .plan_create_with_retry_uncancellable(
                    &input,
                    freshell_codex::launch_plan::CODEX_INITIAL_LAUNCH_ATTEMPTS,
                    freshell_codex::launch_lifecycle::LaunchClass::Interactive,
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

        // Freshell opencode TUI rebind plugin: the install (fs I/O) happens
        // HERE at the IO layer; the pure resolver only reads the result from
        // CliLaunchInputs (mcp_injection precedent). Failure must never block
        // the launch.
        let opencode_rebind_tui_config = if mode == "opencode" {
            opencode_rebind_precompute()
        } else {
            None
        };

        let inputs = CliLaunchInputs {
            mode: &mode,
            target,
            resume_session_id: resume_session_id.as_deref(),
            // WS-parity launch intent (kata hbsa). `Start` selects claude's
            // `create_session_args` template (`--session-id {{sessionId}}`,
            // cli_launch_goldens.rs:52) for the id THIS create minted;
            // everything else is a genuine resume — an accepted `sessionRef`,
            // a legacy `resumeSessionId`, or the fresh-amplifier mint at
            // `spawn_terminal_pane` (:820-831), which deliberately keeps
            // `Resume` (amplifier's manifest has `resume_args` only and
            // `Start` would hard-error `StartIntentUnsupported`,
            // cli_launch.rs:496-510). Mirrors the WS door
            // (freshell-ws/src/terminal.rs fresh-claude special case).
            //
            // Door 3 (resume-validation): the non-prealloc arm threads the
            // gate outcome through `GatedSettleInputs.launch_intent` — the
            // gate-fired claude fallback's minted fresh id must launch with
            // `Start` (the claude spec's `createSessionArgs`); every
            // non-gated `Some(resume_session_id)` is still a genuine resume
            // (accepted `sessionRef` or legacy `resumeSessionId`), exactly
            // as before. (A gate-fired claude fallback yields `Start` via
            // the outcome anyway; the prealloc override only matters for
            // main's no-resume-id mint path.)
            launch_intent: if claude_fresh_prealloc {
                LaunchIntent::Start
            } else {
                launch_intent
            },
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
            opencode_rebind_tui_config,
        };
        let launch = match resolve_coding_cli_command(&state.cli_commands, &inputs, &RealEnv) {
            Ok(l) => l,
            Err(e) => return Err(fail_json(StatusCode::BAD_REQUEST, e.message())),
        };

        let effective_shell = resolve_shell(shell_type, host_os, is_wsl);
        let windows_like = is_windows(host_os) || (is_wsl && effective_shell != ShellType::System);
        let overrides =
            build_terminal_base_env(&RealEnv, &terminal_id, Some(&tab_id), Some(&pane_id));

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
    // registry bookkeeping, then disarm the opencode locator -- so a
    // REST-created opencode pane's armed entry is never left dangling on exit,
    // exactly like the WS path's on_exit closes this same gap (the parity
    // fix this slice's scope item 2 requires). Identity retire (kata hbsa):
    // the FORMER known gap here -- `TerminalIdentityRegistry` is
    // `freshell-ws`-owned and unreachable across the crate boundary -- is
    // closed by the `PaneIdentityBinder` seam: the hook calls
    // `retire_pane_identity` (identity retire + pending-marker delete,
    // mirroring the WS exit hook's inline-sync pair, terminal.rs:1334-1342)
    // as a PLAIN SYNC CALL. That is deliberate: the ExitHook (`pty.rs:55`,
    // `FnOnce + Send`) runs on the PTY reader OS thread with NO tokio
    // runtime (`Handle::current()` would panic there), where blocking IO is
    // safe -- the one truly-synchronous ledger call site. Non-shell creates
    // only; idempotent no-op for panes without identity rows. Ledger A2
    // stakes: without it the session directory lists dead REST panes as
    // running (session_directory.rs), the rename cascade persists
    // `titleOverride` for dead terminals (sessions.rs), and a late new-id
    // SessionStart can durably rebind a dead pane (claude_signal.rs).
    let on_exit: Option<freshell_terminal::pty::ExitHook> = {
        let tid = terminal_id.clone();
        let cleanup_mode = mode.clone();
        let cleanup_cwd = mcp_cwd.clone();
        let registry_for_exit = registry.clone();
        let opencode_locator = state.opencode_locator.clone();
        // Owned binder clone for the exit-side retire (see the block comment
        // above): shell panes are never session-identified by design.
        let exit_binder: Option<
            std::sync::Arc<dyn freshell_terminal::registry::PaneIdentityBinder>,
        > = if mode == "shell" {
            None
        } else {
            pane_identity.clone()
        };
        // Launcher-assigned amplifier identity (Task 11, REST twin of the WS
        // Task 10 hook): only a stub THIS create wrote (`created == true`) is
        // ours to GC on exit; found/existing sessions are never touched.
        let amplifier_stub_gc: Option<(std::path::PathBuf, String)> = amplifier_stub
            .as_ref()
            .filter(|s| s.created)
            .zip(resume_session_id.as_ref())
            .map(|(s, sid)| (s.session_dir.clone(), sid.clone()));
        Some(Box::new(move |exit_code: i64| {
            cleanup_mcp_config(&RealMcpRuntime, &tid, &cleanup_mode, cleanup_cwd.as_deref());
            registry_for_exit.finish_pty_exit(&tid, exit_code);
            // DEV-0006 S4: tear down this pane's managed codex sidecar + remote proxy
            // (no-op for terminals without a managed launch). Sync-safe: hands the
            // handle to the manager's async teardown worker. Same call as the WS
            // path's on_exit (`crates/freshell-ws/src/terminal.rs`).
            freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                .notify_terminal_exit(&tid);
            // Identity retire + pending-marker delete (kata hbsa, ledger A2):
            // inline sync on the PTY reader thread — see the block comment
            // above the hook for why this must NOT hop through tokio.
            if let Some(binder) = &exit_binder {
                binder.retire_pane_identity(&tid);
            }
            if let Some(locator) = &opencode_locator {
                locator.disarm(&tid);
            }
            // GC the never-used stub this create pre-wrote. Runs AFTER
            // finish_pty_exit (our own row is no longer Running). Guarded
            // (GC-vs-second-resume race, F5/V7): a NEW live terminal may
            // already be resuming this same id — deleting the dir out from
            // under it would doom its resume, so skip in that case.
            if let Some((session_dir, session_id)) = &amplifier_stub_gc {
                if freshell_terminal::registry::has_other_live_resume(
                    &registry_for_exit.identity_probe_rows(),
                    "amplifier",
                    session_id,
                    &tid,
                ) {
                    tracing::debug!(
                        terminal_id = %tid,
                        session_id = %session_id,
                        "amplifier_stub_gc: skipped — another live terminal holds this resume id"
                    );
                } else if freshell_sessions::amplifier_stub::gc_stub_if_unused(session_dir) {
                    tracing::debug!(
                        terminal_id = %tid,
                        dir = %session_dir.display(),
                        "amplifier_stub_gc: removed never-used pre-created session"
                    );
                }
            }
        }))
    };

    // Server-wide spawn gate — acquired AFTER the codex managed plan (D-C-R,
    // 2026-07-30): mirrors the WS auto-resume door (plan → acquire → discard
    // on rejection). Decision record: docs/plans/2026-07-27-rest-spawn-gate.md
    // §D-C addendum. `None` (unwired) = ungated.
    // MERGE ORDER (2026-07-30): the gate runs BEFORE the PIN2 prespawn
    // binding below — a gate rejection must not leave a stale prespawn
    // ledger row (the exit hook that retires the row never runs when
    // nothing spawns), so the durable write happens only after a permit
    // is secured.
    if let Some(rest_gate) = state.spawn_gate() {
        match rest_gate
            .gate
            .acquire_uncancellable(rest_gate.timeout)
            .await
        {
            Ok(permit) => _spawn_permit = Some(permit),
            Err(err) => {
                if let Some(launch) = codex_launch.take() {
                    freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                        .discard(launch)
                        .await;
                }
                // The SAME cleanup statements the PTY-spawn-failure arm below
                // runs (MCP config cleanup + amplifier-stub GC): nothing has
                // been spawned yet, but the mode branch above may already have
                // written MCP config file(s), and the amplifier stub was
                // pre-created in `spawn_terminal_pane` — both are litter for a
                // create that will never happen.
                if mode != "shell" {
                    cleanup_mcp_config(&RealMcpRuntime, &terminal_id, &mode, mcp_cwd.as_deref());
                }
                if let Some(stub) = amplifier_stub.as_ref().filter(|s| s.created) {
                    let _ = freshell_sessions::amplifier_stub::gc_stub_if_unused(&stub.session_dir);
                }
                return Err(spawn_gate_error_response(err, rest_gate.timeout));
            }
        }
    }

    // PIN2_CLAUDE_PRE_SPAWN_BINDING (REST rung, kata hbsa): durability
    // before observability — the spawn below puts the preallocated id in
    // argv; a SIGKILL right after spawn must still find a durable ledger
    // row. Gated on `claude_fresh_prealloc` ONLY (eaa25b7d: this create
    // minted the id, so the row is provably exclusive; a resume-create's
    // row belongs to the prior epoch). Mirrors
    // freshell-ws/src/terminal.rs's PIN2 block.
    if claude_fresh_prealloc {
        if let (Some(binder), Some(session_id)) =
            (pane_identity.as_ref(), resume_session_id.as_deref())
        {
            // Binder methods are sync (blocking fsync IO inside) — hop
            // through spawn_blocking, the WS create path's own idiom
            // (terminal.rs:2211-2234). Awaited: PIN 2 requires the
            // durable row to exist BEFORE the spawn below.
            let binder = std::sync::Arc::clone(binder);
            let (sid, tid, m) = (session_id.to_string(), terminal_id.clone(), mode.clone());
            let (c, rid) = (cwd.clone(), create_request_id.clone());
            if let Err(join_err) = tokio::task::spawn_blocking(move || {
                binder.record_prespawn_claude_binding(&sid, &tid, &m, c.as_deref(), Some(&rid));
            })
            .await
            {
                // JoinError means the closure panicked — write failures are warned inside the binder
                tracing::warn!(target: "freshell_freshagent::invariants", error = %join_err, "prespawn-claude-binding binder task panicked");
            }
        }
    }

    // The PTY spawn is synchronous; run it on the blocking pool so hung/slow
    // spawns occupy a permit + a blocking thread, never an async worker (WS
    // lane ledger A4: on hosts with nproc <= spawn_concurrency, N inline
    // blocking spawns would wedge the runtime incl. the timer driver, and
    // gate timeouts could never fire). The permit stays held throughout
    // BECAUSE this whole function runs on the detached settle task that owns
    // it (F1): a client abort drops only the handler future, never this
    // task, so the fork can no longer outlive its permit. Mirrors the WS
    // door (`crates/freshell-ws/src/terminal.rs`). Values consumed by the
    // call and unused afterwards (`child_env`, `stream_id`, `on_exit`)
    // move in without cloning.
    let spawn_registry = registry.clone();
    let spawn_spec = spec.clone();
    let spawn_terminal_id = terminal_id.clone();
    let spawn_mode = mode.clone();
    let spawn_resume = resume_session_id.clone();
    let spawn_request_id = create_request_id.clone();
    let create_result = match tokio::task::spawn_blocking(move || {
        spawn_registry.create(
            &spawn_spec,
            &child_env,
            spawn_terminal_id,
            stream_id,
            &spawn_mode,
            spawn_resume.as_deref(),
            Some(spawn_request_id.as_str()), // create_request_id: REST accept-or-mint key (this task)
            None,                            // ring_max_bytes: registry default
            on_exit,
        )
    })
    .await
    {
        Ok(result) => result,
        // JoinError (incl. panic inside the closure) surfaces as a spawn
        // failure into the unchanged rollback + 400 path below, same as the
        // WS path.
        Err(join_err) => Err(std::io::Error::other(format!(
            "terminal spawn task panicked: {join_err}"
        ))),
    };
    if let Err(err) = create_result {
        // PIN 2 compensating delete — SAME gate as the write (eaa25b7d).
        // MUST be the FIRST thing in this branch: the error arm below has
        // TWO returns (the AlreadyExists 409 and the wrapped 400), and this
        // branch is the only exit between the pre-spawn write above and
        // spawn success (ledger A3) — the delete must precede both.
        if claude_fresh_prealloc {
            if let (Some(binder), Some(session_id)) =
                (pane_identity.as_ref(), resume_session_id.as_deref())
            {
                let binder = std::sync::Arc::clone(binder);
                let sid = session_id.to_string();
                if let Err(join_err) = tokio::task::spawn_blocking(move || {
                    binder.delete_prespawn_claude_binding(&sid);
                })
                .await
                {
                    // JoinError means the closure panicked
                    tracing::warn!(target: "freshell_freshagent::invariants", error = %join_err, "prespawn-claude-binding delete binder task panicked");
                }
            }
        }
        // Nothing was recorded yet (no tab, no pane, no map entry) -> rollback
        // is a no-op by construction, EXCEPT the MCP config file(s)
        // `generate_mcp_injection` may already have written -- clean those up
        // too (`router.ts:819`, `cw:429-448` -- the original's failed-create
        // cleanup path).
        if mode != "shell" {
            cleanup_mcp_config(&RealMcpRuntime, &terminal_id, &mode, mcp_cwd.as_deref());
        }
        // Task 7's race-free duplicate-live-resume enforcement inside
        // registry.create (F5/V7): the friendly pre-check in
        // `spawn_terminal_pane` is check-then-act — concurrent WS/REST
        // creates can both pass it. Map the registry's distinguishable error
        // to the SAME user-facing 409. ORDER IS LOAD-BEARING: this
        // early-return must precede the stub GC below — `ensure_session` is
        // not serialized, so two truly concurrent creates of one id can BOTH
        // observe "no dir yet" and race the mkdir; the LOSER here can hold
        // `created == true` while the WINNER's live terminal is already
        // using the dir, and GC'ing it would delete the winner's session
        // out from under it.
        if err.kind() == std::io::ErrorKind::AlreadyExists {
            return Err(fail_json(
                StatusCode::CONFLICT,
                format!(
                    "Amplifier session {} is already open in a live terminal.",
                    resume_session_id.as_deref().unwrap_or_default()
                ),
            ));
        }
        // A stub written for a spawn that never happened is pure litter.
        if let Some(stub) = amplifier_stub.as_ref().filter(|s| s.created) {
            let _ = freshell_sessions::amplifier_stub::gc_stub_if_unused(&stub.session_dir);
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

    // D8: arm the lease's TTL kill path -- record the just-spawned child's pid
    // on the winner's lease immediately (its presence decides ExpiredNeedsKill
    // vs revoke-and-hold-closed on expiry). Mirrors the WS create path.
    if let Some(guard) = &session_ref_lease {
        if let Some(pid) = registry.pid_of(&terminal_id) {
            registry.set_session_ref_lease_pid(
                &guard.locator,
                &guard.holder_create_request_id,
                pid,
            );
        }
    }

    // DEV-0006 S4: adopt the managed codex launch for this terminal
    // (`adoptCodexLaunch` → `launch.codexPlan.sidecar.adopt({terminalId, generation: 0})`,
    // `router.ts:254,1591`) — ownership transfers from the planner to the terminal; the
    // exit hook above tears it down. Adoption only fails when the planner/sidecar is
    // already shutting down (server exit); legacy's thrown adopt fails the create, so
    // kill the just-spawned pty and surface the error (500 — not an input error).
    // S5.b / D-03: capture "managed?" BEFORE the adopt below takes the launch
    // out of the Option — the arm suppression further down keys off it.
    let managed_codex = codex_launch.is_some();
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

    // Identity registration (kata hbsa): identity row + durable binding
    // for any create with a session id (fresh mint OR resume — the
    // resume half is what made REST-resumed claude panes die at
    // restart), pending marker for the locator-resolved providers.
    // The identity row is the prerequisite for BOTH the A13 live-owner
    // guard's identity arm and the SessionStart signal drain acting
    // (claude_signal.rs retains signals for identity-less panes forever).
    if let Some(binder) = pane_identity.as_ref() {
        let binder = std::sync::Arc::clone(binder);
        let (tid, m) = (terminal_id.clone(), mode.clone());
        let (sid, c, rid) = (
            resume_session_id.clone(),
            cwd.clone(),
            create_request_id.clone(),
        );
        if let Err(join_err) = tokio::task::spawn_blocking(move || {
            binder.register_create_identity(&tid, &m, sid.as_deref(), c.as_deref(), Some(&rid));
        })
        .await
        {
            // JoinError means the closure panicked
            tracing::warn!(target: "freshell_freshagent::invariants", error = %join_err, "create-identity binder task panicked");
        }
    }

    // Restore-across-restart fix (amplifier) + OpenCode terminal-pane restore
    // fix (opencode): arm the SHARED locator for a FRESH (non-resuming) pane
    // of the matching mode. No-ops for every other mode/resume case (the
    // admission checks live inside `arm()` itself, see
    // `arm_locators_for_fresh_pane`'s doc comment).
    arm_locators_for_fresh_pane(
        &state,
        &terminal_id,
        &mode,
        cwd.as_deref(),
        resume_session_id.as_deref(),
        managed_codex,
    );

    // D8 winner bind (REST rung): record sessionRef->terminalId in the
    // REGISTRY binding map (inside `complete_session_ref_claim` -- atomic with
    // the lease release, then the duplicate alarm). A completed binding makes
    // later WS claims answer BoundElsewhere (adopt) instead of double-spawning.
    if let Some(guard) = session_ref_lease.take() {
        let locator = guard.disarm();
        if registry.complete_session_ref_claim(&locator, &create_request_id, &terminal_id) {
            tracing::info!(
                target: "freshell_freshagent::terminal_tabs",
                terminal_id = %terminal_id,
                provider = %locator.provider,
                session_id = %locator.session_id,
                "session_ref.winner_bound (REST rung)"
            );
        } else {
            // Revoked while spawning (TTL expired on the then-pid-less lease):
            // kill OUR OWN just-spawned child via the registry handle
            // (group-kill discipline), confirm, and fail the create loudly --
            // never leave an orphan running.
            let pid = registry.pid_of(&terminal_id);
            registry.kill(&terminal_id);
            let confirmed = match pid {
                Some(pid) => confirm_pid_dead_within_500ms(pid).await,
                // No pid handle to probe: the registry kill removed the row;
                // nothing is left to signal, so treat as confirmed.
                None => true,
            };
            if confirmed {
                registry.force_release_after_confirmed_kill(&locator);
            } else {
                tracing::error!(target: "invariant",
                    terminal_id = %terminal_id,
                    provider = %locator.provider,
                    session_id = %locator.session_id,
                    "session_ref_lease_revoked_child_kill_unconfirmed: holding lease closed (REST rung)");
            }
            return Err(fail_json_code(
                StatusCode::CONFLICT,
                "RESTORE_UNAVAILABLE",
                format!(
                    "Session {} is still running on the server.",
                    locator.session_id
                ),
            ));
        }
    }

    let mut pane_content = json!({
        "kind": "terminal",
        "terminalId": terminal_id,
        "createRequestId": create_request_id,
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
    // Door 3 (resume-validation): the gate-fired stale-resume notice rides
    // the returned `paneContent` as `reconcileNotice` — the SAME key the
    // frozen client's reconcile chip/xterm rendering already consumes, so no
    // client change. (Accepted caveat: a hidden/background tab defers the
    // render until a later visible attach pass — the notice is preserved in
    // pane content, never dropped.)
    if let Some(notice) = &resume_notice {
        pane_content["reconcileNotice"] = json!(notice);
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

    // Fix round 1 (Task 23 gap): fire the injected post-create hook -- Node's
    // registry-'terminal.created'-event analog (`server/index.ts:647-655` ->
    // `seedFromTerminal` for EVERY terminal). `freshell-server` wires it to the
    // SAME meta seed -> async git enrich -> `terminal.meta.updated` broadcast
    // the WS `terminal.create` path runs, so REST-created terminals get git
    // badges too. Fired AFTER the bookkeeping (create fully succeeded), with
    // the RESOLVED spawn cwd (`spec.cwd` -- what the registry record carries).
    // The production hook is non-blocking (record build + `tokio::spawn`).
    if let Some(hook) = &state.terminal_created_hook {
        hook(crate::TerminalCreatedEvent {
            terminal_id: terminal_id.clone(),
            mode: mode.clone(),
            resume_session_id: resume_session_id.clone(),
            cwd: spec.cwd.clone(),
        });
    }

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
    // path's `create.tab_id`/`create.pane_id` plumbing. Task 14 (AUTO-03):
    // minted BY the shared LayoutStore now — the store registers the ordered
    // tab row + terminal leaf under the SAME ids this route returns, exactly
    // like Node's `ensureSnapshot()` bootstrap.
    let (tab_id, pane_id) = state.layout.create_tab(name.as_deref());

    let spawned = match spawn_terminal_pane(state, body, &tab_id, &pane_id).await {
        Ok(s) => s,
        Err(resp) => {
            // Node's failed-create catch closes the store tab it minted
            // (`layoutStore.closeTab(createdTabId)`, `router.ts:824-830`) —
            // no phantom tab survives a failed spawn.
            state.layout.close_tab(&tab_id);
            return resp;
        }
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
            title: name.clone(),
        },
    );
    // The SAME paneContent this route broadcasts, attached to the store leaf
    // (`layoutStore.attachPaneContent(tabId, paneId, paneContent)`,
    // `router.ts:774`) — `GET /api/layout/snapshot`/`listPanes` consumers see
    // the real terminal content, not `createTab`'s detached placeholder.
    state
        .layout
        .attach_pane_content(&tab_id, &pane_id, pane_content.clone());
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
        // kata hbsa: fresh claude REST creates now mint their own identity
        // (paneContent.sessionRef) — a create that ended up with a real
        // sessionRef is not identity-less, so it must not alarm.
        && payload
            .get("paneContent")
            .and_then(|c| c.get("sessionRef"))
            .is_none()
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

/// `GET /api/tabs` (`router.ts:879-883`): `{tabs, activeTabId}` from the
/// shared LayoutStore (Task 14, AUTO-03 — retires Slice 1's unordered
/// legacy-map rows and hard-coded `activeTabId: null`). Node-exact row shape:
/// `{id, title /*falls back to id*/, activePaneId}`, in snapshot order
/// (`listTabs`, `layout-store.ts:327-334`; `getActiveTabId`, `:187-189`).
pub(crate) async fn list_tabs(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let (tabs, active_tab_id) = state.layout.list_tabs();
    ok_json(json!({ "tabs": tabs, "activeTabId": active_tab_id }), "")
}

/// `GET /api/panes` (`router.ts:898-902`): `{panes}` from the shared
/// LayoutStore (Task 15, AUTO-06 -- retires the Slice-1 `pane_tabs`
/// reverse-index rows). Node-exact row shape `{id, index, kind?,
/// terminalId?, title?}` in depth-first leaf order, default tab = active
/// then first (`listPanes`, `layout-store.ts:341-355`); absent fields are
/// OMITTED like `JSON.stringify` drops `undefined`. An empty `?tabId=`
/// normalizes to no filter; an empty store is `[]` (Node's `listPanes?.() ||
/// []`).
pub(crate) async fn list_panes(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let tab_filter = params
        .get("tabId")
        .map(String::as_str)
        .filter(|t| !t.is_empty());
    let rows = state.layout.list_panes(tab_filter).unwrap_or_default();
    let panes: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let mut pane = serde_json::Map::new();
            pane.insert("id".to_string(), json!(row.id));
            pane.insert("index".to_string(), json!(row.index));
            if let Some(kind) = row.kind {
                pane.insert("kind".to_string(), json!(kind));
            }
            if let Some(terminal_id) = row.terminal_id {
                pane.insert("terminalId".to_string(), json!(terminal_id));
            }
            if let Some(title) = row.title {
                pane.insert("title".to_string(), json!(title));
            }
            Value::Object(pane)
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
    // P1.14 / Incident-4: feed the codex locator BEFORE the PTY write.
    // Contract (`codex_association.rs:49-56`): the first `note_submit`'s
    // `known_files` re-snapshot must COMPLETE before the Enter byte reaches
    // the PTY -- a re-snapshot racing after the write can capture
    // (permanently exclude) the pane's own rollout file. `maybe_send_keys`
    // is synchronous, so a plain call placed before `registry.input`
    // satisfies the ordering. First submit does a bounded sessions-tree
    // walk; later submits are a cheap mutex hop. No mode check needed:
    // `note_submit` no-ops for terminals the locator never armed, and only
    // codex panes are armed.
    if is_submit_input(text) {
        if let Some(locator) = &state.codex_locator {
            locator.note_submit(&terminal_id, now_ms());
        }
    }
    let outcome = registry.input(&terminal_id, text.as_bytes());
    if !outcome.found {
        tracing::warn!(terminal_id = %terminal_id, "send_keys_to_unknown_terminal");
    }
    // Feed the opencode locator's Enter<->session correlation
    // (`is_submit_input`/`note_possible_submit`,
    // `crates/freshell-ws/src/opencode_association.rs`): a REST-created
    // fresh opencode pane only associates once its FIRST submit-shaped
    // input (a bare CR/LF run) is observed here -- a REST `send-keys` must
    // feed the SAME shared locator the WS `terminal.input` path does, or a
    // REST-driven Enter would silently never open the locator's correlation
    // window. No-ops (`note_submit` itself checks "is this terminal
    // armed?") for every non-armed/non-Enter case.
    if is_submit_input(text) {
        if let Some(locator) = &state.opencode_locator {
            locator.note_submit(&terminal_id, now_ms());
        }
    }
    Some(ok_json(json!({ "terminalId": terminal_id }), "input sent"))
}

/// `isSubmitInput` (`shared/turn-complete-signal.ts:125-127`, mirrored from
/// `crates/freshell-ws/src/opencode_association.rs`'s twin): the input is
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

    /// Launcher-assigned amplifier identity (F7/V9): REST amplifier creates
    /// now WRITE stub dirs into the amplifier home — sandbox every test that
    /// can reach one so no test ever touches the real `~/.amplifier`.
    /// `set_var` is process-global: ONE shared value per test process, same
    /// OnceLock pattern as
    /// `crates/freshell-ws/tests/common/mod.rs::isolate_amplifier_home`.
    fn isolate_amplifier_home() -> std::path::PathBuf {
        static AMP_HOME: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
        AMP_HOME
            .get_or_init(|| {
                let amp_home = std::env::temp_dir().join(format!(
                    "freshell-freshagent-amp-home-{}",
                    std::process::id()
                ));
                let _ = std::fs::create_dir_all(&amp_home);
                std::env::set_var("FRESHELL_AMPLIFIER_HOME", &amp_home);
                amp_home
            })
            .clone()
    }

    fn state_with_registry() -> FreshAgentState {
        // Every REST test that can reach an amplifier create flows through
        // this constructor — isolate at the choke point (Task 11 Step 1).
        let _ = isolate_amplifier_home();
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

    /// DEV-0006 S5.e, same gate as the WS path: managed codex launch defaults ON;
    /// only the exact string "0" opts out. Mode scoping is unchanged: non-codex
    /// modes never plan.
    #[test]
    fn rest_codex_managed_launch_gate_is_mode_and_flag_scoped() {
        assert!(codex_create_uses_managed_launch("codex", Some("1")));
        assert!(codex_create_uses_managed_launch("codex", None));
        assert!(codex_create_uses_managed_launch("codex", Some("")));
        assert!(!codex_create_uses_managed_launch("codex", Some("0")));
        assert!(!codex_create_uses_managed_launch("shell", Some("1")));
        assert!(!codex_create_uses_managed_launch("claude", None));
        assert!(!codex_create_uses_managed_launch("opencode", None));
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

    /// Fix round 1 (Task 23 gap): a REST-created terminal must fire the
    /// injected terminal-created hook with the create identity, so
    /// `freshell-server`'s wiring can run the SAME meta seed -> async git
    /// enrich -> `terminal.meta.updated` broadcast the WS `terminal.create`
    /// path gets (Node seeds off the registry's 'terminal.created' event for
    /// EVERY terminal, `server/index.ts:647-655` -> `seedFromTerminal`).
    /// The hook is the seam: `freshell-ws` depends on THIS crate, so the
    /// `TerminalMetaRegistry` itself is unreachable here (same constraint the
    /// exit hook documents for `identity.retire`).
    #[tokio::test]
    async fn create_shell_tab_invokes_terminal_created_hook_with_create_identity() {
        let captured: Arc<std::sync::Mutex<Vec<crate::TerminalCreatedEvent>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let hook_captured = Arc::clone(&captured);
        let state = state_with_registry().with_terminal_created_hook(Arc::new(move |event| {
            hook_captured.lock().unwrap().push(event);
        }));
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({ "mode": "shell", "cwd": tmp.to_string_lossy() }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let terminal_id = body["data"]["terminalId"].as_str().expect("terminalId");

        let events = captured.lock().unwrap();
        assert_eq!(events.len(), 1, "exactly one hook call per create");
        let event = &events[0];
        assert_eq!(event.terminal_id, terminal_id);
        assert_eq!(event.mode, "shell");
        assert_eq!(event.resume_session_id, None);
        // The RESOLVED spawn cwd (what the registry record carries -- Node's
        // `seedFromTerminal` reads `record.cwd`), not the raw request field.
        assert_eq!(event.cwd.as_deref(), Some(tmp.to_string_lossy().as_ref()));
    }

    /// The hook is optional wiring (the `rename_persistence` convention):
    /// an unwired state creates terminals exactly as before -- no panic, no
    /// behavior change (every pre-existing test in this module already runs
    /// unwired; this pins the contract explicitly).
    #[tokio::test]
    async fn create_shell_tab_without_hook_wired_still_creates() {
        let state = state_with_registry();
        let (status, body) = post(app(state), "/api/tabs", json!({ "mode": "shell" }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["data"]["terminalId"].as_str().is_some());
    }

    #[tokio::test]
    async fn rest_create_terminal_tab_mints_and_stamps_create_request_id() {
        let state = state_with_registry();
        let mut rx = state.broadcast_tx.subscribe();
        let router = app(state.clone());

        let tmp = std::env::temp_dir();
        let (status, body) = post(
            router,
            "/api/tabs",
            json!({ "mode": "shell", "cwd": tmp.to_string_lossy() }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "create failed: {body}");

        // Drain the broadcast bus for the ui.command{tab.create} frame.
        let mut pane_content = None;
        while let Ok(frame) = rx.try_recv() {
            let msg: Value = serde_json::from_str(&frame).unwrap();
            if msg["command"] == json!("tab.create") {
                pane_content = msg
                    .get("payload")
                    .and_then(|p| p.get("paneContent"))
                    .cloned();
            }
        }
        let pane_content = pane_content.expect("no tab.create broadcast");
        let crid = pane_content
            .get("createRequestId")
            .and_then(Value::as_str)
            .expect("paneContent.createRequestId missing");
        assert_eq!(crid.len(), 32, "expected Uuid::simple format, got {crid:?}");
        assert!(crid.chars().all(|c| c.is_ascii_hexdigit()));

        // The registry row was stamped with the SAME key (atomic insert).
        let terminal_id = pane_content
            .get("terminalId")
            .and_then(Value::as_str)
            .expect("paneContent.terminalId missing");
        let registry = state.terminal_registry.clone().expect("registry wired");
        assert_eq!(
            registry.probe_create_request_id(terminal_id).as_deref(),
            Some(crid),
        );
    }

    #[tokio::test]
    async fn rest_create_honors_caller_supplied_create_request_id() {
        let state = state_with_registry();
        let mut rx = state.broadcast_tx.subscribe();
        let router = app(state.clone());

        let tmp = std::env::temp_dir();
        let (status, body) = post(
            router,
            "/api/tabs",
            json!({
                "mode": "shell",
                "cwd": tmp.to_string_lossy(),
                "createRequestId": "crid-fixed-key",
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "create failed: {body}");

        let mut pane_content = None;
        while let Ok(frame) = rx.try_recv() {
            let msg: Value = serde_json::from_str(&frame).unwrap();
            if msg["command"] == json!("tab.create") {
                pane_content = msg
                    .get("payload")
                    .and_then(|p| p.get("paneContent"))
                    .cloned();
            }
        }
        let pane_content = pane_content.expect("no tab.create broadcast");
        assert_eq!(
            pane_content.get("createRequestId").and_then(Value::as_str),
            Some("crid-fixed-key"),
        );
        let terminal_id = pane_content
            .get("terminalId")
            .and_then(Value::as_str)
            .expect("paneContent.terminalId missing");
        let registry = state.terminal_registry.clone().expect("registry wired");
        assert_eq!(
            registry.probe_create_request_id(terminal_id).as_deref(),
            Some("crid-fixed-key"),
        );
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

    // `GET /api/tabs` row-shape tests live in `pane_ops_tab_tests.rs` (Task
    // 14, AUTO-03): the route now reads the shared LayoutStore, and its tests
    // sit with the rest of the tab-route suite.

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
        let _env_guard = crate::codex::tests::ENV_LOCK.blocking_lock();
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

    fn state_with_opencode_locator(home: std::path::PathBuf) -> FreshAgentState {
        state_with_registry().with_opencode_locator(Some(std::sync::Arc::new(
            freshell_sessions::opencode_locator::OpencodeLocator::new(home),
        )))
    }

    /// P1.14 / Incident-4 hardening: the REST create path must arm the codex
    /// locator exactly like amplifier/opencode, or a REST-created codex pane's
    /// provisional identity can never be superseded by B2 adoption.
    #[test]
    fn arm_locators_for_fresh_pane_arms_the_codex_locator() {
        let root = std::env::temp_dir().join(format!("codex-arm-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let locator =
            std::sync::Arc::new(freshell_sessions::codex_locator::CodexLocator::new(root));
        let state = state_with_registry().with_codex_locator(Some(locator.clone()));
        // Some(...) matches the sibling test-helper convention: the existing
        // locator tests pass Some(std::sync::Arc::new(...)) because the
        // builders take Option (with_opencode_locator / with_codex_locator).

        // S5.b / D-03: a MANAGED codex pane binds identity from the proxy
        // Candidate stream, so the REST door must never arm the codex locator.
        arm_locators_for_fresh_pane(
            &state,
            "term-codex-0",
            "codex",
            Some("/tmp/proj"),
            None,
            true,
        );
        assert_eq!(
            locator.armed_count(),
            0,
            "managed codex panes must never arm the locator (D-03)"
        );

        arm_locators_for_fresh_pane(
            &state,
            "term-codex-1",
            "codex",
            Some("/tmp/proj"),
            None,
            false,
        );

        assert_eq!(
            locator.armed_count(),
            1,
            "codex mode must arm the codex locator"
        );
    }

    /// A recording spec whose `resume_args` mirror the REAL amplifier
    /// manifest (`extensions/amplifier/freshell.json`: `["session", "resume",
    /// "--full-history", "{{sessionId}}"]`) so the recorded argv is the
    /// launcher-assigned identity contract's exact `amplifier session resume
    /// --full-history <uuid>` shape (minus argv[0], which the recorder script
    /// does not capture).
    fn amplifier_recording_cli_spec(
        argv_file: &std::path::Path,
    ) -> freshell_platform::CliCommandSpec {
        let mut spec = recording_cli_spec("amplifier", argv_file);
        spec.resume_args = Some(vec![
            "session".to_string(),
            "resume".to_string(),
            "--full-history".to_string(),
            "{{sessionId}}".to_string(),
        ]);
        spec
    }

    /// The stub dir the launcher-assigned pre-create must have written for
    /// `session_id` launched from `cwd`:
    /// `$FRESHELL_AMPLIFIER_HOME/projects/<cwd_slug(canonical cwd)>/sessions/<id>`.
    fn expected_stub_dir(cwd: &str, session_id: &str) -> std::path::PathBuf {
        let canonical = freshell_sessions::amplifier_stub::canonical_cwd(cwd);
        let slug = freshell_sessions::amplifier_stub::cwd_slug(&canonical.to_string_lossy());
        isolate_amplifier_home()
            .join("projects")
            .join(slug)
            .join("sessions")
            .join(session_id)
    }

    /// Task 11 (launcher-assigned identity, REST twin of the WS Task 8
    /// contract): a fresh `POST /api/tabs {mode:"amplifier"}` mints the
    /// session UUID, pre-creates the on-disk stub BEFORE spawn, spawns
    /// `amplifier session resume --full-history <uuid>`, and promotes the
    /// minted id into the broadcast `paneContent.sessionRef` (EDEV-07).
    #[tokio::test]
    async fn create_amplifier_tab_fresh_mints_identity_prestubs_and_spawns_resume_argv() {
        let argv_file = unique_argv_file("amplifier-fresh");
        let state = state_with_registry().with_cli_commands(std::sync::Arc::new(vec![
            amplifier_recording_cli_spec(&argv_file),
        ]));
        let mut rx = state.broadcast_tx.subscribe();
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

        // 1) Recorded argv is exactly `session resume --full-history <uuid>`
        //    (the recorder captures "$@" — everything after the program itself).
        let argv = read_argv_file_eventually(&argv_file).await;
        let lines: Vec<&str> = argv.lines().collect();
        assert_eq!(
            lines.len(),
            4,
            "expected `session resume --full-history <uuid>` argv, got: {argv}"
        );
        assert_eq!(lines[0], "session", "argv: {argv}");
        assert_eq!(lines[1], "resume", "argv: {argv}");
        assert_eq!(lines[2], "--full-history", "argv: {argv}");
        let minted = Uuid::parse_str(lines[3])
            .expect("minted amplifier session id must parse as a Uuid")
            .to_string();

        // 2) The stub dir exists under slug(canonical cwd) with the designed
        //    shape: metadata.json + empty transcript.jsonl + empty events.jsonl.
        let stub_dir = expected_stub_dir(&tmp.to_string_lossy(), &minted);
        assert!(stub_dir.is_dir(), "missing stub dir {}", stub_dir.display());
        assert!(stub_dir.join("metadata.json").is_file());
        let transcript = stub_dir.join("transcript.jsonl");
        assert!(transcript.is_file());
        assert_eq!(std::fs::read(&transcript).unwrap(), b"", "transcript empty");
        let events = stub_dir.join("events.jsonl");
        assert!(events.is_file(), "events.jsonl is load-bearing");
        assert_eq!(std::fs::read(&events).unwrap(), b"", "events empty");

        // 3) The broadcast paneContent carries the minted identity as a
        //    canonical sessionRef (EDEV-07 promotion — uuids pass
        //    plausible_resume_session_id for amplifier).
        let mut pane_content = None;
        while let Ok(frame) = rx.try_recv() {
            let msg: Value = serde_json::from_str(&frame).unwrap();
            if msg["command"] == json!("tab.create") {
                pane_content = msg
                    .get("payload")
                    .and_then(|p| p.get("paneContent"))
                    .cloned();
            }
        }
        let pane_content = pane_content.expect("no tab.create broadcast");
        assert_eq!(
            pane_content["sessionRef"],
            json!({ "provider": "amplifier", "sessionId": minted }),
            "paneContent: {pane_content}"
        );

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
    }

    /// Defense-in-depth against the old correlation bug's poisoned persisted
    /// tab state (REST twin of the WS guard): `terminal:<id>` is Freshell's
    /// own synthetic sidebar placeholder, never a resumable amplifier session.
    #[tokio::test]
    async fn create_amplifier_tab_rejects_terminal_placeholder_ref_with_400() {
        let argv_file = unique_argv_file("amplifier-placeholder");
        let state = state_with_registry().with_cli_commands(std::sync::Arc::new(vec![
            amplifier_recording_cli_spec(&argv_file),
        ]));
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "amplifier",
                "cwd": tmp.to_string_lossy(),
                "sessionRef": { "provider": "amplifier", "sessionId": "terminal:abc" }
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let msg = body["message"].as_str().unwrap();
        assert!(msg.contains("synthetic terminal placeholder"), "{msg}");
        let _ = std::fs::remove_file(&argv_file);
    }

    /// Same-id double-resume guard, REST rung: never spawn a second
    /// `amplifier session resume --full-history <sid>` while a live terminal
    /// owns <sid>.
    #[tokio::test]
    async fn create_amplifier_tab_rejects_duplicate_live_resume_with_409() {
        let argv_file = unique_argv_file("amplifier-dup");
        let state = state_with_registry().with_cli_commands(std::sync::Arc::new(vec![
            amplifier_recording_cli_spec(&argv_file),
        ]));
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
        let registry = state.terminal_registry.clone().unwrap();
        let sid = registry
            .probe(&terminal_id)
            .expect("registry row for first create")
            .resume_session_id
            .expect("fresh amplifier create must mint a resume session id");

        let (status2, body2) = post(
            app(state.clone()),
            "/api/tabs",
            json!({
                "mode": "amplifier",
                "cwd": tmp.to_string_lossy(),
                "sessionRef": { "provider": "amplifier", "sessionId": sid }
            }),
            true,
        )
        .await;
        assert_eq!(status2, StatusCode::CONFLICT, "{body2}");
        let msg = body2["message"].as_str().unwrap();
        assert!(msg.contains("already open in a live terminal"), "{msg}");

        registry.kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
    }

    /// F4 falsified-path fix, REST rung: a create with NO cwd must compute
    /// ONE effective cwd ($HOME), slug the stub from it, AND hand the same
    /// value to the spawn/registry — never let `cwd = None` flow into
    /// `build_cli_spawn_spec` while the stub sits under slug($HOME) (the PTY
    /// would inherit the BROKER's own cwd — silent divergence).
    #[tokio::test]
    async fn create_amplifier_tab_with_no_cwd_stubs_under_home_slug() {
        let argv_file = unique_argv_file("amplifier-nocwd");
        let state = state_with_registry().with_cli_commands(std::sync::Arc::new(vec![
            amplifier_recording_cli_spec(&argv_file),
        ]));
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({ "mode": "amplifier" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
        let registry = state.terminal_registry.clone().unwrap();
        let row = registry.probe(&terminal_id).expect("registry row");
        let home = std::env::var("HOME").expect("HOME set in test env");
        assert_eq!(
            row.cwd.as_deref(),
            Some(home.as_str()),
            "registry row cwd must be $HOME, never None"
        );
        let sid = row
            .resume_session_id
            .expect("fresh amplifier create must mint a resume session id");

        // Stub under slug(canonical($HOME))...
        let home_stub = expected_stub_dir(&home, &sid);
        assert!(
            home_stub.is_dir(),
            "stub must land under the $HOME slug: {}",
            home_stub.display()
        );
        // ...and NEVER under the broker's own cwd slug.
        let broker_cwd = std::env::current_dir().unwrap();
        let broker_stub = expected_stub_dir(&broker_cwd.to_string_lossy(), &sid);
        if broker_stub != home_stub {
            assert!(
                !broker_stub.exists(),
                "stub must never land under the broker's own cwd: {}",
                broker_stub.display()
            );
        }

        registry.kill(&terminal_id);
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

    // ── kata hbsa: fresh-claude REST preallocation ──────────────────────────

    /// A claude recording spec for the fresh-prealloc tests: same recorder
    /// script as [`recording_cli_spec`], plus the REAL claude manifest's
    /// `create_session_args` (`--session-id {{sessionId}}`,
    /// cli_launch_goldens.rs:52) — `LaunchIntent::Start` hard-errors
    /// `StartIntentUnsupported` without it (cli_launch.rs:496-510).
    fn claude_prealloc_recording_cli_spec(
        argv_file: &std::path::Path,
    ) -> freshell_platform::CliCommandSpec {
        let mut spec = recording_cli_spec("claude", argv_file);
        spec.create_session_args = Some(vec![
            "--session-id".to_string(),
            "{{sessionId}}".to_string(),
        ]);
        spec
    }

    /// Harness for the fresh-claude prealloc tests (the `:3321` opencode
    /// spawning test's state/spec/argv-capture idiom, spec swapped for the
    /// claude one above): state + shared registry + argv capture path.
    fn state_with_claude_capture_spec(
        label: &str,
    ) -> (
        FreshAgentState,
        freshell_terminal::TerminalRegistry,
        std::path::PathBuf,
    ) {
        let argv_file = unique_argv_file(label);
        let state = state_with_registry().with_cli_commands(std::sync::Arc::new(vec![
            claude_prealloc_recording_cli_spec(&argv_file),
        ]));
        let registry = state.terminal_registry.clone().expect("registry wired");
        (state, registry, argv_file)
    }

    /// The spawn-failure twin of [`state_with_claude_capture_spec`]: same
    /// spec shape (`create_session_args` present, so `LaunchIntent::Start`
    /// resolves fine; no `env_var`) but `default_cmd` points at a
    /// nonexistent path (the `:4444` broken-spawn idiom) — resolution
    /// succeeds and the PTY fork itself fails.
    fn state_with_broken_claude_spec() -> (FreshAgentState, freshell_terminal::TerminalRegistry) {
        let argv_file = unique_argv_file("binder-broken");
        let mut spec = claude_prealloc_recording_cli_spec(&argv_file);
        spec.default_cmd = "/nonexistent/freshell-task5-missing-claude".to_string();
        let state = state_with_registry().with_cli_commands(std::sync::Arc::new(vec![spec]));
        let registry = state.terminal_registry.clone().expect("registry wired");
        (state, registry)
    }

    /// Subscribe BEFORE the POST — the `:3383` sibling's broadcast-capture
    /// idiom (`state.broadcast_tx.subscribe()`).
    fn subscribe_broadcast_frames(
        state: &FreshAgentState,
    ) -> tokio::sync::broadcast::Receiver<String> {
        state.broadcast_tx.subscribe()
    }

    /// Read the next `ui.command{tab.create}` frame off the broadcast channel
    /// and return its `payload.paneContent` (the `:3383` frame-reading idiom).
    async fn next_ui_command_pane_content(
        frames: &mut tokio::sync::broadcast::Receiver<String>,
    ) -> Value {
        let frame = frames.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(msg["command"], json!("tab.create"), "{msg}");
        msg["payload"]["paneContent"].clone()
    }

    /// The `:3321` argv-capture idiom, split into one-arg-per-line entries
    /// (the recorder script's `printf '%s\n' "$@"`).
    async fn wait_for_captured_argv(path: &std::path::Path) -> Vec<String> {
        read_argv_file_eventually(path)
            .await
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[tokio::test]
    async fn create_fresh_claude_tab_preallocates_session_identity() {
        // kata hbsa P1: REST parity with the WS fresh-claude special case.
        // A fresh POST /api/tabs {mode:"claude"} must mint a --session-id,
        // carry it in the registry row, and expose it as paneContent.sessionRef
        // on the broadcast `ui.command` frame. NOTE the surfaces: the REST HTTP
        // body carries ONLY {tabId, paneId, terminalId} (terminal_tabs.rs:
        // 1828-1832) — paneContent (and its sessionRef) travels on the broadcast
        // frame, because the REST route always calls with broadcast=true
        // (terminal_tabs.rs:196-197).
        let (state, registry, argv_capture_path) =
            state_with_claude_capture_spec("claude-prealloc");
        // Subscribe BEFORE the POST, exactly the way the sibling test at :3383
        // captures its ui.command frames off the state's broadcast channel —
        // reuse that subscription + frame-reading code verbatim.
        let mut frames = subscribe_broadcast_frames(&state);
        let (status, body) = post(
            app(state),
            "/api/tabs",
            serde_json::json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
            }),
            true,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "create failed: {body}");

        // 1. sessionRef surfaced on the broadcast paneContent (the create-time
        //    reporting surface — the HTTP body has NO paneContent). Read the
        //    ui.command frame the same way the :3383 sibling does.
        let pane_content = next_ui_command_pane_content(&mut frames).await;
        let session_ref = pane_content["sessionRef"].clone();
        assert_eq!(
            session_ref["provider"],
            serde_json::json!("claude"),
            "sessionRef: {pane_content}"
        );
        let sid = session_ref["sessionId"]
            .as_str()
            .expect("sessionId string")
            .to_string();
        uuid::Uuid::parse_str(&sid).expect("preallocated id is a canonical UUID");

        // 2. Registry row carries the id (this is GET /api/terminals rung 0,
        //    terminals.rs:686-698 — populating it makes sessionRef real there
        //    with zero changes to terminals.rs).
        let terminal_id = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();
        let row = registry
            .identity_probe_rows()
            .into_iter()
            .find(|r| r.terminal_id == terminal_id)
            .expect("registry row exists");
        assert_eq!(row.resume_session_id.as_deref(), Some(sid.as_str()));

        // 3. argv proof: `claude --session-id <uuid>` (LaunchIntent::Start),
        //    NOT `--resume` and NOT bare argv.
        let argv = wait_for_captured_argv(&argv_capture_path).await;
        let pos = argv
            .iter()
            .position(|a| a == "--session-id")
            .expect("--session-id in argv");
        assert_eq!(argv.get(pos + 1).map(String::as_str), Some(sid.as_str()));
        assert!(
            !argv.iter().any(|a| a == "--resume"),
            "fresh create must not resume: {argv:?}"
        );

        registry.kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_capture_path);
    }

    #[tokio::test]
    async fn create_fresh_claude_tab_with_null_session_ref_still_mints() {
        // Ledger A1 regression: `"sessionRef": null` is ABSENT on both doors.
        // Same harness and assertions as
        // create_fresh_claude_tab_preallocates_session_identity, with
        // `"sessionRef": serde_json::Value::Null` added to the POST body —
        // the broadcast paneContent must still carry a minted claude sessionRef.
        // (WS deserializes `"sessionRef": null` to `None` and MINTS,
        // client_messages.rs:233-234; a raw `body.get("sessionRef").is_some()`
        // check would see `Some(Value::Null)` and skip the mint — the
        // predicate input must be the PARSED locator presence.)
        let (state, registry, argv_capture_path) =
            state_with_claude_capture_spec("claude-null-sref");
        let mut frames = subscribe_broadcast_frames(&state);
        let (status, body) = post(
            app(state),
            "/api/tabs",
            serde_json::json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": serde_json::Value::Null,
            }),
            true,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "create failed: {body}");

        let pane_content = next_ui_command_pane_content(&mut frames).await;
        let session_ref = pane_content["sessionRef"].clone();
        assert_eq!(
            session_ref["provider"],
            serde_json::json!("claude"),
            "sessionRef: {pane_content}"
        );
        let sid = session_ref["sessionId"]
            .as_str()
            .expect("sessionId string")
            .to_string();
        uuid::Uuid::parse_str(&sid).expect("preallocated id is a canonical UUID");

        let terminal_id = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();
        let row = registry
            .identity_probe_rows()
            .into_iter()
            .find(|r| r.terminal_id == terminal_id)
            .expect("registry row exists");
        assert_eq!(row.resume_session_id.as_deref(), Some(sid.as_str()));

        let argv = wait_for_captured_argv(&argv_capture_path).await;
        let pos = argv
            .iter()
            .position(|a| a == "--session-id")
            .expect("--session-id in argv");
        assert_eq!(argv.get(pos + 1).map(String::as_str), Some(sid.as_str()));
        assert!(
            !argv.iter().any(|a| a == "--resume"),
            "fresh create must not resume: {argv:?}"
        );

        registry.kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_capture_path);
    }

    #[tokio::test]
    async fn split_pane_claude_preallocates_fresh_session_identity() {
        // kata hbsa P2: POST /api/panes/:id/split shares spawn_terminal_pane,
        // so a claude split must mint its OWN fresh identity (distinct from
        // the source pane's).
        let (state, registry, _capture) = state_with_claude_capture_spec("claude-split");
        let router = app(state);

        let (status, tab) = post(
            router.clone(),
            "/api/tabs",
            serde_json::json!({"mode":"claude","cwd": std::env::temp_dir().to_string_lossy()}),
            true,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        // The /api/tabs body is {tabId, paneId, terminalId} — no paneContent.
        // Identity is read from the registry rows (rung 0), keyed by terminalId.
        let pane_id = tab["data"]["paneId"]
            .as_str()
            .expect("pane id in create response")
            .to_string();
        let first_tid = tab["data"]["terminalId"]
            .as_str()
            .expect("terminal id in create response")
            .to_string();
        let first_sid = registry
            .identity_probe_rows()
            .into_iter()
            .find(|r| r.terminal_id == first_tid)
            .expect("create registry row")
            .resume_session_id
            .expect("first pane minted");

        let (status, split) = post(
            router,
            &format!("/api/panes/{pane_id}/split"),
            serde_json::json!({"mode":"claude"}),
            true,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "split failed: {split}");
        // The split body is {paneId, terminalId} — again, identity via registry.
        let split_tid = split["data"]["terminalId"]
            .as_str()
            .expect("terminal id in split response")
            .to_string();
        let split_sid = registry
            .identity_probe_rows()
            .into_iter()
            .find(|r| r.terminal_id == split_tid)
            .expect("split registry row")
            .resume_session_id
            .expect("split minted");
        uuid::Uuid::parse_str(&split_sid).expect("canonical UUID");
        assert_ne!(split_sid, first_sid, "split must mint its OWN identity");

        // Registry rows for BOTH panes carry their ids.
        let rows = registry.identity_probe_rows();
        assert_eq!(
            rows.iter()
                .filter(|r| r.resume_session_id.is_some())
                .count(),
            2,
            "both claude panes carry resume identity: {rows:?}"
        );
        for r in rows {
            registry.kill(&r.terminal_id);
        }
        let _ = std::fs::remove_file(&_capture);
    }

    #[tokio::test]
    async fn respawn_pane_claude_ends_with_session_identity() {
        // kata hbsa P2: POST /api/panes/:id/respawn also funnels through
        // spawn_terminal_pane. The pin is the identity GAP being closed: the
        // respawned claude pane must end with a real sessionRef (whether the
        // respawn resumes the prior id or mints fresh is respawn policy, pinned
        // elsewhere — the bug here was ending with NO identity at all).
        // NOTE: respawn identity is BODY-driven, not pane-inherited — the
        // client body is forwarded untouched (pane_ops.rs:716) and
        // spawn_terminal_pane derives mode solely from body["mode"], defaulting
        // to "shell" (terminal_tabs.rs:710-715). An empty body respawns a SHELL
        // pane (no mint). The body below must therefore carry mode:"claude".
        let (state, registry, _capture) = state_with_claude_capture_spec("claude-respawn");
        let router = app(state);

        let (status, tab) = post(
            router.clone(),
            "/api/tabs",
            serde_json::json!({"mode":"claude","cwd": std::env::temp_dir().to_string_lossy()}),
            true,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        let pane_id = tab["data"]["paneId"].as_str().expect("pane id").to_string();

        let (status, respawned) = post(
            router,
            &format!("/api/panes/{pane_id}/respawn"),
            serde_json::json!({"mode":"claude"}),
            true,
        )
        .await;
        assert_eq!(
            status,
            axum::http::StatusCode::OK,
            "respawn failed: {respawned}"
        );
        // The respawn body is {terminalId} only — identity via the registry row.
        let respawn_tid = respawned["data"]["terminalId"]
            .as_str()
            .expect("terminal id in respawn response")
            .to_string();
        let sid = registry
            .identity_probe_rows()
            .into_iter()
            .find(|r| r.terminal_id == respawn_tid)
            .expect("respawn registry row")
            .resume_session_id
            .expect("respawned pane has identity");
        uuid::Uuid::parse_str(&sid).expect("canonical UUID");

        for r in registry.identity_probe_rows() {
            registry.kill(&r.terminal_id);
        }
        let _ = std::fs::remove_file(&_capture);
    }

    // ── kata hbsa Task 5: PaneIdentityBinder threading through the REST rung ─

    /// Recording fake for the write-side identity seam: appends one string
    /// per binder call so the tests can assert call ORDER (PIN 2: durability
    /// before observability) as well as presence/absence.
    #[derive(Default, Debug)]
    struct RecordingBinder {
        events: std::sync::Mutex<Vec<String>>,
    }

    impl RecordingBinder {
        fn events(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }
    }

    impl freshell_terminal::registry::PaneIdentityBinder for RecordingBinder {
        fn record_prespawn_claude_binding(
            &self,
            session_id: &str,
            terminal_id: &str,
            _mode: &str,
            _cwd: Option<&str>,
            _create_request_id: Option<&str>,
        ) {
            self.events
                .lock()
                .unwrap()
                .push(format!("prespawn:{terminal_id}:{session_id}"));
        }
        fn delete_prespawn_claude_binding(&self, session_id: &str) {
            self.events
                .lock()
                .unwrap()
                .push(format!("delete:{session_id}"));
        }
        fn register_create_identity(
            &self,
            terminal_id: &str,
            mode: &str,
            resume_session_id: Option<&str>,
            _cwd: Option<&str>,
            _create_request_id: Option<&str>,
        ) {
            self.events.lock().unwrap().push(format!(
                "register:{terminal_id}:{mode}:{}",
                resume_session_id.unwrap_or("-")
            ));
        }
        fn retire_pane_identity(&self, terminal_id: &str) {
            self.events
                .lock()
                .unwrap()
                .push(format!("retire:{terminal_id}"));
        }
    }

    #[tokio::test]
    async fn fresh_claude_rest_create_drives_binder_prespawn_then_register() {
        // kata hbsa P1: PIN 2 ordering on the REST rung — durable pre-spawn
        // binding, then spawn, then identity registration.
        let binder = std::sync::Arc::new(RecordingBinder::default());
        let (state, registry, _capture) = state_with_claude_capture_spec("binder-prespawn");
        let state = state.with_pane_identity_binder(binder.clone());

        let (status, body) = post(
            app(state),
            "/api/tabs",
            serde_json::json!({"mode":"claude","cwd": std::env::temp_dir().to_string_lossy()}),
            true,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        // The REST body carries only ids; the minted sid comes from the
        // registry row (same read as Task 2's assertion 2).
        let tid = body["data"]["terminalId"].as_str().unwrap().to_string();
        let sid = registry
            .identity_probe_rows()
            .into_iter()
            .find(|r| r.terminal_id == tid)
            .and_then(|r| r.resume_session_id)
            .expect("minted id in the registry row");

        let events = binder.events();
        let prespawn = events
            .iter()
            .position(|e| e == &format!("prespawn:{tid}:{sid}"))
            .unwrap_or_else(|| panic!("prespawn event missing: {events:?}"));
        let register = events
            .iter()
            .position(|e| e == &format!("register:{tid}:claude:{sid}"))
            .unwrap_or_else(|| panic!("register event missing: {events:?}"));
        assert!(
            prespawn < register,
            "PIN 2: durability before registration: {events:?}"
        );
        assert!(
            !events.iter().any(|e| e.starts_with("delete:")),
            "no failure-delete on success"
        );

        registry.kill(&tid);
        let _ = std::fs::remove_file(&_capture);
    }

    #[tokio::test]
    async fn resume_claude_rest_create_registers_identity_without_prespawn_write() {
        // eaa25b7d scoping on the REST rung: a RESUME create never writes the
        // pre-spawn row (it belongs to the prior epoch) but DOES register
        // identity post-spawn — this closes the resume-direction half of the
        // gap (REST resumes previously died at restart: pane_ledger_restore.rs).
        let binder = std::sync::Arc::new(RecordingBinder::default());
        let (state, registry, _capture) = state_with_claude_capture_spec("binder-resume");
        let state = state.with_pane_identity_binder(binder.clone());

        const S: &str = "29a53649-2222-4333-8444-555566667777";
        // Mirror the request shape of the existing passing with-identity create
        // test (create_tab_with_identity_or_shell_mode_does_not_warn_invariant).
        let (status, body) = post(
            app(state),
            "/api/tabs",
            serde_json::json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": {"provider": "claude", "sessionId": S},
            }),
            true,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        let tid = body["data"]["terminalId"].as_str().unwrap().to_string();

        let events = binder.events();
        assert!(
            !events.iter().any(|e| e.starts_with("prespawn:")),
            "resume creates must not write the pre-spawn row (eaa25b7d): {events:?}"
        );
        assert!(
            events.contains(&format!("register:{tid}:claude:{S}")),
            "{events:?}"
        );

        registry.kill(&tid);
        let _ = std::fs::remove_file(&_capture);
    }

    #[tokio::test]
    async fn failed_fresh_claude_spawn_deletes_its_prespawn_binding() {
        // eaa25b7d symmetry: the failure-delete fires with the SAME gate as the
        // write, for the id THIS create minted.
        let binder = std::sync::Arc::new(RecordingBinder::default());
        // A spec whose command cannot spawn: point default_cmd at a
        // nonexistent path (no env_var), same spec shape as the capture spec.
        let (state, _registry) = state_with_broken_claude_spec();
        let state = state.with_pane_identity_binder(binder.clone());

        let (status, _body) = post(
            app(state),
            "/api/tabs",
            serde_json::json!({"mode":"claude","cwd": std::env::temp_dir().to_string_lossy()}),
            true,
        )
        .await;
        assert!(!status.is_success(), "spawn must fail");

        let events = binder.events();
        let prespawn_sid = events
            .iter()
            .find_map(|e| {
                e.strip_prefix("prespawn:")
                    .and_then(|rest| rest.split(':').nth(1))
                    .map(str::to_string)
            })
            .unwrap_or_else(|| panic!("prespawn happened before the spawn attempt: {events:?}"));
        assert!(
            events.contains(&format!("delete:{prespawn_sid}")),
            "failure-delete for the minted id: {events:?}"
        );
        assert!(
            !events.iter().any(|e| e.starts_with("register:")),
            "{events:?}"
        );
    }

    #[tokio::test]
    async fn rest_pane_exit_retires_identity_via_binder() {
        // Ledger A2: dead REST panes must not keep live-looking identity rows.
        let binder = std::sync::Arc::new(RecordingBinder::default());
        let (state, registry, _capture) = state_with_claude_capture_spec("binder-exit");
        let state = state.with_pane_identity_binder(binder.clone());

        let (status, body) = post(
            app(state),
            "/api/tabs",
            serde_json::json!({"mode":"claude","cwd": std::env::temp_dir().to_string_lossy()}),
            true,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        let tid = body["data"]["terminalId"].as_str().unwrap().to_string();

        registry.kill(&tid);
        // The exit hook runs asynchronously — poll with a bounded deadline.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if binder.events().contains(&format!("retire:{tid}")) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "exit hook never retired the pane: {:?}",
                binder.events()
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let _ = std::fs::remove_file(&_capture);
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

    /// kata ejh6: the legacy `resumeSessionId` wire field is REFUSED at the
    /// `POST /api/tabs` door on EVERY registered mode (uniform any-carry
    /// ruling) — 400 with the frozen text, before any mode branch. The cli
    /// specs are registered so a pre-guard build would ACCEPT the create
    /// (200), proving the door check is what flips the behavior.
    #[tokio::test]
    async fn legacy_reject_rest_create_all_modes() {
        let modes = ["claude", "opencode", "amplifier"];
        let argv_files: Vec<std::path::PathBuf> = modes
            .iter()
            .map(|m| unique_argv_file(&format!("legacy-reject-{m}")))
            .collect();
        let specs: Vec<freshell_platform::CliCommandSpec> = modes
            .iter()
            .zip(&argv_files)
            .map(|(m, f)| recording_cli_spec(m, f))
            .collect();
        let state = state_with_registry().with_cli_commands(std::sync::Arc::new(specs));
        let router = app(state);
        let tmp = std::env::temp_dir();
        for (mode, argv_file) in modes.iter().zip(&argv_files) {
            let (status, body) = post(
                router.clone(),
                "/api/tabs",
                json!({
                    "mode": mode,
                    "cwd": tmp.to_string_lossy(),
                    "resumeSessionId": format!("legacy-{mode}-id")
                }),
                true,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{mode}: {body}");
            assert_eq!(
                body["message"],
                json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
                "{mode}: {body}"
            );
            let _ = std::fs::remove_file(argv_file);
        }
    }

    /// kata ejh6 (uniform any-carry ruling): a body carrying BOTH a matching
    /// `sessionRef` AND the legacy field still rejects — legacy presence is
    /// checked BEFORE the sessionRef early-return.
    #[tokio::test]
    async fn legacy_reject_rest_create_dual_carrier() {
        let argv_file = unique_argv_file("legacy-reject-dual");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "claude", &argv_file,
            )]));
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": tmp.to_string_lossy(),
                "resumeSessionId": "legacy",
                "sessionRef": { "provider": "claude", "sessionId": "canonical" }
            }),
            true,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "dual-carrier must reject: {body}"
        );
        assert_eq!(
            body["message"],
            json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
            "{body}"
        );
        let _ = std::fs::remove_file(&argv_file);
    }

    /// ejh6 presence-based (finding 2): the contract is "any create that
    /// CARRIES the field". REST reads raw Value, so null/number/empty-string
    /// values ARE rejected.
    #[tokio::test]
    async fn legacy_reject_rest_create_presence_edge_cases() {
        let argv_file = unique_argv_file("legacy-reject-edge");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "claude", &argv_file,
            )]));
        let router = app(state);
        let tmp = std::env::temp_dir();
        for (label, val) in [
            ("empty-string", json!("")),
            ("null", json!(null)),
            ("number", json!(42)),
        ] {
            let (status, body) = post(
                router.clone(),
                "/api/tabs",
                json!({
                    "mode": "claude",
                    "cwd": tmp.to_string_lossy(),
                    "resumeSessionId": val
                }),
                true,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{label}: {body}");
            assert_eq!(
                body["message"],
                json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
                "{label}: {body}"
            );
        }
        let _ = std::fs::remove_file(&argv_file);
    }

    /// ejh6 finding 3: browser/editor branches also 400 when carrying the
    /// field — the door-top check fires BEFORE the agent/browser/editor/
    /// terminal delegation, so no branch can bypass it.
    #[tokio::test]
    async fn legacy_reject_rest_browser_editor_branches() {
        let state = state_with_registry();
        let router = app(state);
        for (label, mut body) in [
            ("browser", json!({"browser": "https://example.com"})),
            ("editor", json!({"editor": "/tmp/file.ts"})),
        ] {
            body.as_object_mut()
                .unwrap()
                .insert("resumeSessionId".into(), json!("legacy"));
            let (status, resp) = post(router.clone(), "/api/tabs", body, true).await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "{label} branch must reject: {resp}"
            );
            assert_eq!(
                resp["message"],
                json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
                "{label}: {resp}"
            );
        }
    }

    #[tokio::test]
    async fn create_codex_tab_accepts_session_ref_and_derives_resume_args() {
        // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
        // plain-CLI codex path (recording CLI spec, no app-server), so pin OFF.
        std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
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
                "sessionRef": { "provider": "amplifier", "sessionId": "legacy-resume-id-xyz" }
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
    async fn create_amplifier_tab_with_session_ref_flows_into_tab_create_frame() {
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
                "sessionRef": { "provider": "amplifier", "sessionId": "web-1737000000000-abc123" }
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
    async fn create_claude_tab_with_session_ref_flows_into_pane_content() {
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
                "sessionRef": { "provider": "claude", "sessionId": "550e8400-e29b-41d4-a716-446655440000" }
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

    // ── D7 live-session guard, REST rung (ks38) ──────────────────────────────

    #[derive(Debug)]
    struct StubSessionIdentity {
        provider: &'static str,
        session_id: &'static str,
        terminal_id: &'static str,
    }

    impl freshell_terminal::registry::SessionIdentityLookup for StubSessionIdentity {
        fn terminal_for_session(&self, provider: &str, session_id: &str) -> Option<String> {
            (provider == self.provider && session_id == self.session_id)
                .then(|| self.terminal_id.to_string())
        }
    }

    const LIVE_SESSION: &str = "22222222-3333-4444-8555-666666666666";

    /// Forge what a REST-spawned live resume leaves behind: a Running registry
    /// row carrying (mode, resume_session_id). Headless: no real PTY.
    fn forge_live_owner(registry: &freshell_terminal::TerminalRegistry, terminal_id: &str) {
        registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
            terminal_id: terminal_id.to_string(),
            stream_id: format!("s-{terminal_id}"),
            mode: "claude".to_string(),
            resume_session_id: Some(LIVE_SESSION.to_string()),
            create_request_id: None,
            created_at: None,
        });
    }

    async fn create_shell_tab(router: Router) -> (String, String, String) {
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            router,
            "/api/tabs",
            json!({ "mode": "shell", "cwd": tmp.to_string_lossy() }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        (
            body["data"]["tabId"].as_str().unwrap().to_string(),
            body["data"]["paneId"].as_str().unwrap().to_string(),
            body["data"]["terminalId"].as_str().unwrap().to_string(),
        )
    }

    #[tokio::test]
    async fn rest_create_resume_onto_live_session_is_refused_409_restore_unavailable() {
        let argv_file = unique_argv_file("d7-rest-live-refusal");
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]));
        let registry = state.terminal_registry.clone().unwrap();
        forge_live_owner(&registry, "t-live-owner");
        let rows_before = registry.identity_probe_rows().len();

        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["status"], json!("error"), "{body}");
        assert_eq!(
            body["code"],
            json!("RESTORE_UNAVAILABLE"),
            "exact wire code: {body}"
        );
        let msg = body["message"].as_str().expect("message");
        assert!(
            msg.contains(LIVE_SESSION),
            "message must name the live session: {msg}"
        );
        // Reconnect-revive Task 7: the refusal must NAME the live owner
        // terminal so a caller (client reattach fold, CLI, MCP) can revive the
        // still-running session instead of dead-ending. Additive field; the
        // message text itself stays byte-identical.
        assert_eq!(
            body["liveTerminalId"],
            json!("t-live-owner"),
            "the 409 must carry the still-running owner's terminal id: {body}"
        );
        // No duplicate spawn: only the forged owner exists.
        assert_eq!(
            registry.identity_probe_rows().len(),
            rows_before,
            "no new terminal"
        );

        registry.kill("t-live-owner");
    }

    #[tokio::test]
    async fn rest_create_resume_onto_exited_session_still_works() {
        let argv_file = unique_argv_file("d7-rest-exited-ok");
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]));
        let registry = state.terminal_registry.clone().unwrap();
        forge_live_owner(&registry, "t-old-owner");
        assert!(registry.finish_pty_exit("t-old-owner", 0));

        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{body}");
        let new_tid = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();
        assert!(
            registry.is_running(&new_tid),
            "resume onto an exited session spawns"
        );

        registry.kill(&new_tid);
    }

    #[tokio::test]
    async fn rest_create_resume_refused_when_identity_registry_owns_live_session() {
        // Locator-adopted shape (d9b71f50): Running row with NO resume id; the
        // binding lives only in the injected identity store.
        let argv_file = unique_argv_file("d7-rest-identity-refusal");
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]))
            .with_session_identity(Arc::new(StubSessionIdentity {
                provider: "claude",
                session_id: LIVE_SESSION,
                terminal_id: "t-adopted",
            }));
        let registry = state.terminal_registry.clone().unwrap();
        registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
            terminal_id: "t-adopted".to_string(),
            stream_id: "s-t-adopted".to_string(),
            mode: "claude".to_string(),
            resume_session_id: None,
            create_request_id: None,
            created_at: None,
        });

        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");
        // Reconnect-revive Task 7: the owner comes from the identity-store arm
        // of the D7 join, but the refusal names it just the same.
        assert_eq!(
            body["liveTerminalId"],
            json!("t-adopted"),
            "the 409 must carry the identity-arm owner's terminal id: {body}"
        );

        registry.kill("t-adopted");
    }

    #[tokio::test]
    async fn rest_respawn_resume_onto_live_session_is_refused_409() {
        let argv_file = unique_argv_file("d7-respawn-live-refusal");
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]));
        let registry = state.terminal_registry.clone().unwrap();
        let router = app(state);
        let (_tab_id, pane_id, shell_tid) = create_shell_tab(router.clone()).await;
        forge_live_owner(&registry, "t-live-owner-respawn");

        let (status, body) = post(
            router,
            &format!("/api/panes/{pane_id}/respawn"),
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");

        registry.kill("t-live-owner-respawn");
        registry.kill(&shell_tid);
    }

    #[tokio::test]
    async fn rest_respawn_resume_after_owner_exits_succeeds() {
        let argv_file = unique_argv_file("d7-respawn-after-exit");
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]));
        let registry = state.terminal_registry.clone().unwrap();
        let router = app(state);
        let (_tab_id, pane_id, shell_tid) = create_shell_tab(router.clone()).await;
        forge_live_owner(&registry, "t-exited-owner-respawn");
        assert!(registry.finish_pty_exit("t-exited-owner-respawn", 0));

        let (status, body) = post(
            router,
            &format!("/api/panes/{pane_id}/respawn"),
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{body}");
        let new_tid = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();
        assert!(registry.is_running(&new_tid));

        registry.kill(&new_tid);
        registry.kill(&shell_tid);
    }

    /// No self-exemption: the pane's OWN still-running terminal counts as the
    /// live owner. Respawning pane P (which detaches -- never kills -- its old
    /// terminal) with the same sessionRef would make two live writers for S.
    #[tokio::test]
    async fn rest_respawn_same_pane_own_live_session_is_refused_409() {
        let argv_file = unique_argv_file("d7-respawn-self-collision");
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]));
        let registry = state.terminal_registry.clone().unwrap();
        let router = app(state);

        // First create resumes S with no live owner -> 200; leaves a Running
        // claude terminal whose row is stamped resume_session_id = S.
        let (status, body) = post(
            router.clone(),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let pane_id = body["data"]["paneId"].as_str().expect("paneId").to_string();
        let first_tid = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();
        assert!(registry.is_running(&first_tid));

        let (status, body) = post(
            router,
            &format!("/api/panes/{pane_id}/respawn"),
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");
        assert!(
            registry.is_running(&first_tid),
            "old terminal untouched by refusal"
        );

        registry.kill(&first_tid);
    }

    #[tokio::test]
    async fn rest_split_resume_onto_live_session_is_refused_409() {
        let argv_file = unique_argv_file("d7-split-live-refusal");
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]));
        let registry = state.terminal_registry.clone().unwrap();
        let router = app(state);
        let (_tab_id, pane_id, shell_tid) = create_shell_tab(router.clone()).await;
        forge_live_owner(&registry, "t-live-owner-split");

        let (status, body) = post(
            router,
            &format!("/api/panes/{pane_id}/split"),
            json!({
                "direction": "vertical",
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");

        registry.kill("t-live-owner-split");
        registry.kill(&shell_tid);
    }

    // ── REST spawn-gate tests (kata enn3) ──────────────────────────────────

    // ── Door 3: REST create resume validation (resume-validation Task 8) ────

    fn probe_answering(
        existence: freshell_platform::resume_gate::ResumeExistence,
        ever_on_disk: bool,
    ) -> freshell_platform::resume_gate::ResumeProbeFn {
        std::sync::Arc::new(move |_provider: &str, _sid: &str| {
            freshell_platform::resume_gate::ResumeProbeAnswer {
                existence,
                ever_observed_on_disk: ever_on_disk,
            }
        })
    }

    #[test]
    fn rest_resume_amplifier_absent_mints_fresh_and_notices() {
        use freshell_platform::resume_gate::ResumeExistence;
        let probe = probe_answering(ResumeExistence::Absent, true);
        let out = validate_rest_resume(
            "amplifier",
            Some("stale-amp".into()),
            LaunchIntent::Resume,
            Some(&probe),
        );
        assert_ne!(out.resume_session_id.as_deref(), Some("stale-amp"));
        assert!(out.resume_session_id.is_some());
        assert_eq!(out.stale_session_id.as_deref(), Some("stale-amp"));
        assert!(out.notice.as_deref().unwrap().contains("stale-amp"));
    }

    #[test]
    fn rest_resume_without_probe_is_passthrough() {
        let out = validate_rest_resume(
            "amplifier",
            Some("anything".into()),
            LaunchIntent::Resume,
            None,
        );
        assert_eq!(out.resume_session_id.as_deref(), Some("anything"));
        assert!(out.stale_session_id.is_none());
        assert!(out.notice.is_none());
    }

    #[test]
    fn rest_resume_unknown_and_present_fail_open() {
        use freshell_platform::resume_gate::ResumeExistence;
        for e in [ResumeExistence::Unknown, ResumeExistence::Present] {
            let probe = probe_answering(e, false);
            let out = validate_rest_resume(
                "opencode",
                Some("ses_x".into()),
                LaunchIntent::Resume,
                Some(&probe),
            );
            assert_eq!(out.resume_session_id.as_deref(), Some("ses_x"));
            assert!(out.notice.is_none());
        }
    }

    #[test]
    fn rest_resume_codex_absent_drops_resume() {
        use freshell_platform::resume_gate::ResumeExistence;
        let probe = probe_answering(ResumeExistence::Absent, true);
        let out = validate_rest_resume(
            "codex",
            Some("stale-cx".into()),
            LaunchIntent::Resume,
            Some(&probe),
        );
        assert!(out.resume_session_id.is_none());
        assert_eq!(out.stale_session_id.as_deref(), Some("stale-cx"));
    }

    #[test]
    fn rest_resume_minted_claude_id_is_v4_and_plausible() {
        // Pins the Uuid::new_v4() requirement (V9): is_canonical_claude_
        // session_id enforces version 1..=5 + RFC-4122 variant — v7/nil
        // would fail and the healed pane_content stamping would silently
        // fall through.
        use freshell_platform::resume_gate::ResumeExistence;
        let probe = probe_answering(ResumeExistence::Absent, true);
        let out = validate_rest_resume(
            "claude",
            Some("stale-cl".into()),
            LaunchIntent::Resume,
            Some(&probe),
        );
        assert_eq!(out.launch_intent, LaunchIntent::Start);
        let minted = out.resume_session_id.expect("fresh claude id minted");
        assert!(plausible_resume_session_id("claude", &minted));
    }

    /// Invocation counter + callback pair returned by `counting_on_stale_resume`.
    type CountingStaleResume = (
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
        std::sync::Arc<dyn Fn(&str, &str) + Send + Sync>,
    );

    /// Counting `on_stale_resume` fake: the Bound ledger row of a running
    /// session must survive, so the live-session tests pin "never invoked".
    fn counting_on_stale_resume() -> CountingStaleResume {
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cb = {
            let count = std::sync::Arc::clone(&count);
            std::sync::Arc::new(move |_provider: &str, _sid: &str| {
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }) as std::sync::Arc<dyn Fn(&str, &str) + Send + Sync>
        };
        (count, cb)
    }

    /// A recording claude spec with the REAL manifest's `createSessionArgs`
    /// (`extensions/claude-code/freshell.json:11`) so the gate's `Start` +
    /// minted-id fallback resolves (V9 — no `StartIntentUnsupported`).
    fn claude_recording_cli_spec_with_start(
        argv_file: &std::path::Path,
    ) -> freshell_platform::CliCommandSpec {
        let mut spec = recording_cli_spec("claude", argv_file);
        spec.create_session_args = Some(vec![
            "--session-id".to_string(),
            "{{sessionId}}".to_string(),
        ]);
        spec
    }

    /// Gate fires (claude, positive absence): the built pane_content carries
    /// the notice AND the HEALED ref — `sessionRef.sessionId` equals the
    /// minted fresh id, NOT the stale wire ref (pins the stale-ref guard's
    /// fall-through to the minted-ref stamping branch).
    #[tokio::test]
    async fn rest_gate_fire_heals_pane_content_ref_and_injects_notice() {
        const STALE: &str = "99999999-8888-4777-8666-555555555555";
        let argv_file = unique_argv_file("door3-claude-heal");
        let (stale_count, on_stale) = counting_on_stale_resume();
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![claude_recording_cli_spec_with_start(
                &argv_file,
            )]))
            .with_resume_probe(probe_answering(
                freshell_platform::resume_gate::ResumeExistence::Absent,
                true,
            ))
            .with_on_stale_resume(on_stale);
        let registry = state.terminal_registry.clone().unwrap();
        let mut rx = state.broadcast_tx.subscribe();

        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": STALE },
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        let frame = rx.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        let pane_content = &msg["payload"]["paneContent"];
        let notice = pane_content["reconcileNotice"]
            .as_str()
            .expect("gate fire injects reconcileNotice");
        assert!(
            notice.contains(STALE),
            "notice names the stale id: {notice}"
        );
        let healed = pane_content["sessionRef"]["sessionId"]
            .as_str()
            .expect("healed sessionRef stamped");
        assert_ne!(healed, STALE, "stale wire ref must never be stamped");
        assert!(
            plausible_resume_session_id("claude", healed),
            "healed ref is a canonical claude id: {healed}"
        );
        assert_eq!(
            stale_count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "on_stale_resume invoked exactly once"
        );
        // The claude fallback launches with Start: createSessionArgs argv,
        // carrying the MINTED id (never the stale one).
        let argv = read_argv_file_eventually(&argv_file).await;
        assert!(argv.contains("--session-id"), "Start argv: {argv}");
        assert!(argv.contains(healed), "minted id in argv: {argv}");
        assert!(
            !argv.contains(STALE),
            "stale id must not reach argv: {argv}"
        );

        registry.kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
    }

    /// PIN 2 coupling (main #584 × Door 3): a gate-fired claude fallback
    /// carries a gate-MINTED `resume_session_id`, so main's
    /// `should_preallocate_fresh_claude` (keyed on "no resume id") returns
    /// false — without the outcome's `claude_fresh_prealloc` fold the minted
    /// fresh pane silently skips the pre-spawn ledger binding every natural
    /// fresh claude create gets.
    #[tokio::test(flavor = "multi_thread")]
    async fn rest_gate_fired_claude_fallback_preallocates_fresh_identity() {
        // Same arrangement as rest_gate_fire_heals_pane_content_ref_and_
        // injects_notice (claude REST create carrying a stale resume id,
        // probe answers Absent + ever_observed_on_disk=true, gate fires and
        // mints a fresh id) — PLUS the #584 identity seam wired so the PIN 2
        // write is observable (skipped entirely when no binder is wired).
        const STALE: &str = "99999999-8888-4777-8666-555555555555";
        let argv_file = unique_argv_file("door3-claude-prealloc");
        let (stale_count, on_stale) = counting_on_stale_resume();
        let binder = std::sync::Arc::new(RecordingBinder::default());
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![claude_recording_cli_spec_with_start(
                &argv_file,
            )]))
            .with_resume_probe(probe_answering(
                freshell_platform::resume_gate::ResumeExistence::Absent,
                true,
            ))
            .with_on_stale_resume(on_stale)
            .with_pane_identity_binder(binder.clone());
        let registry = state.terminal_registry.clone().unwrap();
        let mut rx = state.broadcast_tx.subscribe();

        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": STALE },
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let tid = body["data"]["terminalId"].as_str().unwrap().to_string();
        assert_eq!(
            stale_count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "precondition: the gate fired"
        );

        // Extract the minted id from the healed pane content, as the
        // neighbor test does.
        let frame = rx.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        let minted = msg["payload"]["paneContent"]["sessionRef"]["sessionId"]
            .as_str()
            .expect("healed sessionRef stamped")
            .to_string();
        assert_ne!(minted, STALE, "stale wire ref must never be stamped");

        // The gate-minted fresh claude pane must get the same PIN 2
        // pre-spawn treatment as a natural fresh claude create.
        let events = binder.events();
        let prespawn = events
            .iter()
            .position(|e| e == &format!("prespawn:{tid}:{minted}"))
            .unwrap_or_else(|| {
                panic!(
                    "gate-minted fresh claude id must receive the PIN 2 pre-spawn \
                     identity binding: {events:?}"
                )
            });
        let register = events
            .iter()
            .position(|e| e == &format!("register:{tid}:claude:{minted}"))
            .unwrap_or_else(|| panic!("register event missing: {events:?}"));
        assert!(
            prespawn < register,
            "PIN 2: durability before registration: {events:?}"
        );
        assert!(
            !events.iter().any(|e| e.starts_with("delete:")),
            "no failure-delete on success: {events:?}"
        );

        registry.kill(&tid);
        let _ = std::fs::remove_file(&argv_file);
    }

    /// MANDATORY liveness precondition, arm 1 (registry): a REGISTRY-LIVE
    /// candidate skips the gate entirely — the D7-REST guard then issues its
    /// loud reject exactly as today, `on_stale_resume` is never invoked (the
    /// Bound ledger row of the running session survives), and no notice is
    /// injected. Fails RED if the gate runs before the liveness check.
    #[tokio::test]
    async fn rest_gate_skips_registry_live_candidate_d7_reject_still_fires() {
        let argv_file = unique_argv_file("door3-live-skip");
        let (stale_count, on_stale) = counting_on_stale_resume();
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]))
            .with_resume_probe(probe_answering(
                freshell_platform::resume_gate::ResumeExistence::Absent,
                true,
            ))
            .with_on_stale_resume(on_stale);
        let registry = state.terminal_registry.clone().unwrap();
        forge_live_owner(&registry, "t-live-owner-door3");
        let rows_before = registry.identity_probe_rows().len();

        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;

        // The D7-REST loud reject, NOT a gate-fired fresh spawn.
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");
        assert_eq!(
            stale_count.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "on_stale_resume must never fire for a live session"
        );
        assert_eq!(
            registry.identity_probe_rows().len(),
            rows_before,
            "no new terminal (no gate-fired fresh spawn)"
        );

        registry.kill("t-live-owner-door3");
    }

    /// MANDATORY liveness precondition, arm 2 (sidecar — mirrors Task 6 case
    /// 6): the registry holds NO row for the candidate, but a fresh-agent
    /// sidecar owns it live. The registry-live test above stays GREEN if this
    /// arm is dropped, so it cannot pin it. The create must proceed UNCHANGED
    /// (resume id reaches CliLaunchInputs intact — today's behavior for a
    /// sidecar-live resume; no D7-REST reject since the registry has no row),
    /// `on_stale_resume` never invoked, no notice injected.
    #[tokio::test]
    async fn rest_gate_skips_sidecar_live_candidate_create_proceeds_unchanged() {
        // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
        // plain-CLI codex path (recording CLI spec, no app-server), so pin OFF.
        std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
        const SIDECAR_LIVE: &str = "stale-cx";
        let argv_file = unique_argv_file("door3-sidecar-skip");
        let (stale_count, on_stale) = counting_on_stale_resume();
        let sidecar: crate::SidecarLivenessProbe =
            std::sync::Arc::new(move |mode: &str, sid: &str| {
                let live = mode == "codex" && sid == SIDECAR_LIVE;
                Box::pin(async move { live })
                    as std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
            });
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("codex", &argv_file)]))
            .with_resume_probe(probe_answering(
                freshell_platform::resume_gate::ResumeExistence::Absent,
                true,
            ))
            .with_on_stale_resume(on_stale)
            .with_sidecar_liveness(sidecar);
        let registry = state.terminal_registry.clone().unwrap();
        let mut rx = state.broadcast_tx.subscribe();

        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "codex",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "codex", "sessionId": SIDECAR_LIVE },
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        // The resume id reaching CliLaunchInputs is STILL the live one — the
        // registry row records it, and no gate-fired fresh spawn happened.
        let entry = registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == terminal_id)
            .expect("directory entry");
        assert_eq!(entry.resume_session_id.as_deref(), Some(SIDECAR_LIVE));
        assert_eq!(
            stale_count.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "on_stale_resume must never fire for a sidecar-live session"
        );
        let frame = rx.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        let pane_content = &msg["payload"]["paneContent"];
        assert!(
            pane_content.get("reconcileNotice").is_none(),
            "no notice for a skipped (live) candidate: {pane_content}"
        );
        assert_eq!(
            pane_content["sessionRef"],
            json!({ "provider": "codex", "sessionId": SIDECAR_LIVE }),
            "wire ref stamped unchanged: {pane_content}"
        );

        registry.kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
    }

    fn shell_create_body() -> Value {
        json!({
            "mode": "shell",
            "cwd": std::env::temp_dir().to_string_lossy(),
        })
    }

    #[tokio::test]
    async fn zero_permit_gate_times_out_rest_create_with_503() {
        // 0 permits => acquire can never succeed => deterministic Timeout.
        // The cheapest "gate is actually on the REST path" pin (same trick
        // as crates/freshell-ws/tests/create_protection.rs).
        let state = state_with_registry();
        state.set_spawn_gate(
            Arc::new(crate::spawn_gate::SpawnGate::new(0, 64)),
            std::time::Duration::from_millis(100),
        );
        let (status, body) = post(app(state), "/api/tabs", shell_create_body(), true).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["status"], json!("error"));
        assert_eq!(body["code"], json!("SPAWN_TIMEOUT"));
        assert_eq!(
            body["message"],
            json!("Timed out waiting for a terminal spawn slot")
        );
    }

    #[tokio::test]
    async fn queue_cap_exceeded_rest_create_is_429_spawn_queue_full() {
        // 0 permits AND 0 queue slots => the very first waiter is rejected
        // loudly with QueueFull (no wait at all).
        let state = state_with_registry();
        state.set_spawn_gate(
            Arc::new(crate::spawn_gate::SpawnGate::new(0, 0)),
            std::time::Duration::from_secs(5),
        );
        // Raw oneshot (not the `post` helper): this test also asserts the
        // Retry-After HEADER, which the (status, body) helper discards.
        let req = Request::builder()
            .method("POST")
            .uri("/api/tabs")
            .header("content-type", "application/json")
            .header("x-auth-token", "tok")
            .body(Body::from(shell_create_body().to_string()))
            .unwrap();
        let response = app(state).oneshot(req).await.unwrap();
        let status = response.status();
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::RETRY_AFTER)
                .map(|v| v.to_str().unwrap().to_string()),
            Some("5".to_string()),
            "429 must carry a machine-readable Retry-After (bccd item 1)"
        );
        let body = body_json(response).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
        assert_eq!(body["status"], json!("error"));
        assert_eq!(body["code"], json!("SPAWN_QUEUE_FULL"));
        assert_eq!(
            body["message"],
            json!("Too many concurrent terminal spawns; retry shortly")
        );
        assert_eq!(body["retryAfterMs"], 5_000);
    }

    #[tokio::test]
    async fn split_and_respawn_also_flow_through_the_gate() {
        // Create a real pane while UNGATED (OnceLock unset), then wire a
        // 0-permit gate and prove split AND respawn hit it too — the gate
        // lives in spawn_terminal_pane, the one shared seam.
        let state = state_with_registry();
        let registry = state.terminal_registry.clone().unwrap();
        let router = app(state.clone());
        let (_tab_id, pane_id, shell_tid) = create_shell_tab(router.clone()).await;

        state.set_spawn_gate(
            Arc::new(crate::spawn_gate::SpawnGate::new(0, 64)),
            std::time::Duration::from_millis(100),
        );

        let mut split_body = shell_create_body();
        split_body["direction"] = json!("vertical");
        let (status, body) = post(
            router.clone(),
            &format!("/api/panes/{pane_id}/split"),
            split_body,
            true,
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "split: {body}");
        assert_eq!(body["code"], json!("SPAWN_TIMEOUT"));

        let (status, body) = post(
            router,
            &format!("/api/panes/{pane_id}/respawn"),
            shell_create_body(),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "respawn: {body}");
        assert_eq!(body["code"], json!("SPAWN_TIMEOUT"));

        registry.kill(&shell_tid);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fifteen_plus_rest_create_burst_is_bounded_and_all_complete() {
        // Deterministic pin (kata bccd item 2, council enn3): pre-holding the
        // single permit forces EVERY burst request through the queue —
        // queued_total() reaches exactly 16 (the fast path cannot fire while
        // the budget is held), and ZERO requests may complete while the
        // budget is exhausted. That pins max-in-flight <= budget without the
        // probabilistic `queued_total >= 8` lower bound (the fast path skips
        // the counter). Mirrors the re-acquire precedent at
        // `abort_burst_rest_creates_stay_gated...`.
        let state = state_with_registry();
        let registry = state.terminal_registry.clone().unwrap();
        let gate = Arc::new(crate::spawn_gate::SpawnGate::new(1, 64));
        state.set_spawn_gate(Arc::clone(&gate), std::time::Duration::from_secs(30));
        let router = app(state);

        let held = gate
            .acquire_uncancellable(std::time::Duration::from_secs(1))
            .await
            .expect("test pre-hold of the single permit");

        let mut handles = Vec::new();
        for _ in 0..16 {
            let r = router.clone();
            handles.push(tokio::spawn(async move {
                post(r, "/api/tabs", shell_create_body(), true).await
            }));
        }

        // Every request must queue behind the held permit — exact, not
        // probabilistic.
        for _ in 0..600 {
            if gate.queued_total() == 16 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            gate.queued_total(),
            16,
            "all 16 burst requests must queue while the permit is held"
        );
        assert!(
            handles.iter().all(|h| !h.is_finished()),
            "no request may complete while the budget is fully held (max-in-flight <= budget)"
        );

        drop(held);
        let mut terminal_ids = Vec::new();
        for h in handles {
            let (status, body) = h.await.expect("request task");
            assert_eq!(status, StatusCode::OK, "{body}");
            terminal_ids.push(body["data"]["terminalId"].as_str().unwrap().to_string());
        }
        assert_eq!(gate.queue_rejections(), 0, "no loud rejections expected");
        assert_eq!(gate.timeouts(), 0, "no permit-wait timeouts expected");

        for tid in &terminal_ids {
            registry.kill(tid);
        }
    }

    #[tokio::test]
    async fn held_permit_blocks_rest_create_until_released() {
        // End-to-end permit accounting at the REST seam: while the single
        // permit is held (here by the test itself — in production, by the
        // OTHER door), REST creates time out; after release they succeed.
        let state = state_with_registry();
        let registry = state.terminal_registry.clone().unwrap();
        let gate = Arc::new(crate::spawn_gate::SpawnGate::new(1, 64));
        state.set_spawn_gate(Arc::clone(&gate), std::time::Duration::from_millis(200));
        let router = app(state);

        let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
        let held = gate
            .acquire(std::time::Duration::from_secs(1), &mut cancel_rx)
            .await
            .expect("test holds the only permit");
        let (status, body) = post(router.clone(), "/api/tabs", shell_create_body(), true).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["code"], json!("SPAWN_TIMEOUT"));

        drop(held);
        let (status, body) = post(router, "/api/tabs", shell_create_body(), true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        registry.kill(body["data"]["terminalId"].as_str().unwrap());
    }

    #[tokio::test]
    async fn failed_spawn_releases_its_permit() {
        // Concurrency-1 gate: if a FAILED spawn leaked its permit, the next
        // create could never acquire and would 503. Force the failure with a
        // registered CLI whose command does not exist (reuses the local
        // recording_cli_spec helper, pointing default_cmd at a nonexistent
        // path instead of its script).
        let argv_file = unique_argv_file("gate-broken-spawn");
        let broken = {
            let mut spec = recording_cli_spec("brokencli", &argv_file);
            spec.default_cmd = "/nonexistent/definitely-missing-binary".to_string();
            spec
        };
        let state = state_with_registry().with_cli_commands(Arc::new(vec![broken]));
        let registry = state.terminal_registry.clone().unwrap();
        state.set_spawn_gate(
            Arc::new(crate::spawn_gate::SpawnGate::new(1, 64)),
            std::time::Duration::from_millis(500),
        );
        let router = app(state);

        let (status, body) = post(
            router.clone(),
            "/api/tabs",
            json!({
                "mode": "brokencli",
                "cwd": std::env::temp_dir().to_string_lossy(),
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "spawn should fail: {body}");

        // The failed spawn's RAII permit must be back: a healthy create
        // succeeds instead of hitting SPAWN_TIMEOUT on the 1-permit gate.
        let (status, body) = post(router, "/api/tabs", shell_create_body(), true).await;
        assert_eq!(status, StatusCode::OK, "permit leaked? {body}");
        registry.kill(body["data"]["terminalId"].as_str().unwrap());
    }

    /// F1 (council enn3): the RAII spawn-gate permit lived in the DROPPABLE
    /// axum handler future while the uncancellable `spawn_blocking` fork did
    /// not capture it. A client abort (`curl --max-time 2` does it) dropped
    /// the future, releasing the permit while the detached fork proceeded —
    /// gate escaped exactly under load (`max concurrent registry.create >
    /// spawn_concurrency`) — AND skipped every post-spawn bookkeeping step
    /// (`set_meta`, `terminal_panes`/`pane_tabs`) — a half-initialized
    /// orphan. Same bug class as WS prior art da5d9b5c (permit released
    /// before settle), pinned there by `create_gate::hold_permit_across`.
    ///
    /// Choreography per iteration (the council's named breaking input:
    /// aborted HTTP creates in a loop): the test holds the ONLY permit, a
    /// create queues behind it, the test releases, then aborts the request
    /// task while the fork is in flight. Two assertions:
    ///  1. Gate bound (`<= spawn_concurrency`): re-acquiring the single
    ///     permit is only possible once the aborted create fully settled —
    ///     so at the moment the test holds it, no half-settled terminal may
    ///     exist.
    ///  2. No orphan: every terminal the registry gained must be fully
    ///     bookkept (a `terminal_panes` entry points at it and its meta
    ///     mode was recorded).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn abort_burst_rest_creates_stay_gated_and_leave_no_half_bookkept_terminal() {
        let state = state_with_registry();
        let registry = state.terminal_registry.clone().unwrap();
        let gate = Arc::new(crate::spawn_gate::SpawnGate::new(1, 64));
        state.set_spawn_gate(Arc::clone(&gate), std::time::Duration::from_secs(30));
        let router = app(state.clone());

        let inventory_ids = |registry: &freshell_terminal::TerminalRegistry| {
            registry
                .inventory()
                .into_iter()
                .map(|t| t.terminal_id)
                .collect::<std::collections::HashSet<String>>()
        };
        let bookkept = |state: &FreshAgentState, tid: &str| {
            state
                .terminal_panes
                .lock()
                .expect("terminal_panes mutex")
                .values()
                .any(|e| e.terminal_id == tid)
        };

        let mut forked_iterations = 0u32;
        let mut all_forked: Vec<String> = Vec::new();
        for i in 0..20u64 {
            let before = inventory_ids(&registry);

            // Hold the only permit so the request deterministically QUEUES.
            let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
            let held = gate
                .acquire(std::time::Duration::from_secs(5), &mut cancel_rx)
                .await
                .expect("test acquires the only permit");
            let queued_before = gate.queued_total();

            let r = router.clone();
            let req =
                tokio::spawn(async move { post(r, "/api/tabs", shell_create_body(), true).await });
            // Wait until the request is a queued waiter (held permit => the
            // fast path fails and the waiter counts toward queued_total).
            let mut waited = 0u32;
            while gate.queued_total() == queued_before {
                waited += 1;
                assert!(waited < 2000, "request never queued on the gate");
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }

            // Release the permit to the queued create, give it a sliver of
            // runway (sweep the abort across the fork window), then ABORT
            // the handler future — the simulated client disconnect.
            drop(held);
            tokio::time::sleep(std::time::Duration::from_micros(200 * i)).await;
            req.abort();
            let _ = req.await;

            // Did this iteration actually fork? (An abort landing before the
            // granted permit was ever polled forks nothing — inconclusive.)
            let mut new_terminals: Vec<String> = Vec::new();
            for _ in 0..200u32 {
                new_terminals = inventory_ids(&registry)
                    .difference(&before)
                    .cloned()
                    .collect();
                if !new_terminals.is_empty() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            if new_terminals.is_empty() {
                continue;
            }
            forked_iterations += 1;
            all_forked.extend(new_terminals.iter().cloned());

            // Assertion 1 — gate bound: the single permit must be
            // re-acquirable ONLY once the aborted create fully settled.
            let (_cancel_tx2, mut cancel_rx2) = tokio::sync::watch::channel(false);
            let reacquired = gate
                .acquire(std::time::Duration::from_secs(10), &mut cancel_rx2)
                .await
                .expect("permit must return after the aborted create settles");

            // Assertion 2 — no half-initialized orphan: while WE hold the
            // only permit, every forked terminal is fully bookkept.
            for tid in &new_terminals {
                assert!(
                    bookkept(&state, tid),
                    "aborted create escaped the gate and left a half-initialized orphan: \
                     terminal {tid} exists in the registry but has no terminal_panes entry \
                     (iteration {i})"
                );
            }
            drop(reacquired);
        }

        assert!(
            forked_iterations >= 1,
            "abort sweep never landed inside the fork window; widen the sweep"
        );
        for tid in &all_forked {
            registry.kill(tid);
        }
    }

    // ── D8 session-ref lease, REST rung (ks38) ──────────────────────────────

    /// `claim_session_ref` takes a u64 wall-clock ms; reuse the module's
    /// `now_ms()` (i64 `Date.now()` semantics) clamped exactly like the WS
    /// claim site (`freshell-ws/src/terminal.rs`: `now_ms().max(0) as u64`).
    fn test_now_ms() -> u64 {
        now_ms().max(0) as u64
    }

    #[tokio::test]
    async fn rest_create_resume_while_lease_held_is_refused_409() {
        let argv_file = unique_argv_file("d8-lease-held-refusal");
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]));
        let registry = state.terminal_registry.clone().unwrap();
        let router = app(state);

        // A foreign holder (e.g. an in-flight WS create) holds the lease.
        let locator = SessionLocator {
            provider: "claude".into(),
            session_id: LIVE_SESSION.into(),
        };
        assert!(matches!(
            registry.claim_session_ref(
                &locator,
                "foreign-holder",
                registry.new_connection_id(),
                test_now_ms()
            ),
            SessionRefClaim::Acquired
        ));

        let (status, body) = post(
            router,
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");

        registry.fail_session_ref_claim(&locator, "foreign-holder");
    }

    #[tokio::test]
    async fn rest_create_resume_completes_claim_into_binding() {
        let argv_file = unique_argv_file("d8-lease-completion");
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]));
        let registry = state.terminal_registry.clone().unwrap();
        let router = app(state);

        let locator = SessionLocator {
            provider: "claude".into(),
            session_id: LIVE_SESSION.into(),
        };
        // Precondition: nothing is bound before the spawn.
        assert_eq!(registry.bound_terminal_for_session_ref(&locator), None);

        let (status, body) = post(
            router,
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let tid = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();

        // The REST spawn must have completed its claim into a sessionRef->terminalId
        // binding. Observe the bindings map DIRECTLY via the pub test probe
        // `bound_terminal_for_session_ref` (registry.rs:2007-2013; only
        // complete_session_ref_claim writes that map). Do NOT probe this with a
        // late claim_session_ref call: its row-join arm (registry.rs:1771-1773)
        // answers BoundElsewhere from the Running row's resume_session_id stamp
        // alone, so that probe passes even when no binding was ever recorded --
        // it cannot distinguish completion from the D7 row-join.
        assert_eq!(
            registry.bound_terminal_for_session_ref(&locator),
            Some(tid.clone()),
            "REST resume spawn must complete its lease into a sessionRef binding"
        );

        registry.kill(&tid);
    }

    // ── D7/D8 409 ladder on the sessionRef carrier (REST rung) ─────────────
    // The 2026-08-16 duplicate-tab incident: a legacy-only carrier (the
    // `freshell` CLI's `new-tab --resume`) walked past both guards and spawned
    // a second `opencode --session <sid>` writer onto a live session. The tests
    // below pin the SAME D7/LEASE ladder via the canonical `sessionRef` carrier
    // (kata ejh6 Task 3 re-carriered them off the legacy field; the legacy
    // field's own door-level rejection coverage lands with the REST reject).

    #[tokio::test]
    async fn rest_create_legacy_resume_onto_live_session_is_refused_409() {
        let argv_file = unique_argv_file("d7-rest-legacy-live-refusal");
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]));
        let registry = state.terminal_registry.clone().unwrap();
        forge_live_owner(&registry, "t-legacy-live-owner");
        let rows_before = registry.identity_probe_rows().len();

        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");
        assert_eq!(
            registry.identity_probe_rows().len(),
            rows_before,
            "no duplicate spawn"
        );

        registry.kill("t-legacy-live-owner");
    }

    /// Reconnect-revive Task 7 (fresh-eyes F5): the D8 `BoundElsewhere` arm
    /// (claim race: a completed lease binding already points at the winner,
    /// so D7's live-row join legitimately sees nothing) must name the claim's
    /// terminal id too, making the race refusal equally attachable.
    #[tokio::test]
    async fn rest_create_resume_handle_race_bound_elsewhere_409_names_the_live_terminal() {
        let argv_file = unique_argv_file("d8-bound-elsewhere-live-terminal-id");
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]));
        let registry = state.terminal_registry.clone().unwrap();
        let rows_before = registry.identity_probe_rows().len();

        let locator = SessionLocator {
            provider: "claude".into(),
            session_id: LIVE_SESSION.into(),
        };
        // A winner completed its lease into a sessionRef->terminal binding.
        // The winner's registry ROW is not visible to this door (the
        // claim-race window: bound but not yet directory-registered here), so
        // D7's live-owner join passes and the refusal comes from the binding.
        assert!(matches!(
            registry.claim_session_ref(
                &locator,
                "winner-create",
                registry.new_connection_id(),
                test_now_ms()
            ),
            SessionRefClaim::Acquired
        ));
        assert!(registry.complete_session_ref_claim(&locator, "winner-create", "t-claim-winner"));

        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");
        assert_eq!(
            body["liveTerminalId"],
            json!("t-claim-winner"),
            "the claim-race refusal names the bound winner's terminal id: {body}"
        );
        assert_eq!(
            registry.identity_probe_rows().len(),
            rows_before,
            "no duplicate spawn"
        );
    }

    #[tokio::test]
    async fn rest_create_legacy_resume_while_lease_held_is_refused_409() {
        let argv_file = unique_argv_file("d8-legacy-lease-held-refusal");
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]));
        let registry = state.terminal_registry.clone().unwrap();
        let router = app(state);

        let locator = SessionLocator {
            provider: "claude".into(),
            session_id: LIVE_SESSION.into(),
        };
        assert!(matches!(
            registry.claim_session_ref(
                &locator,
                "foreign-holder",
                registry.new_connection_id(),
                test_now_ms()
            ),
            SessionRefClaim::Acquired
        ));

        let (status, body) = post(
            router,
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");

        registry.fail_session_ref_claim(&locator, "foreign-holder");
    }

    #[tokio::test]
    async fn rest_create_legacy_resume_completes_claim_into_binding() {
        let argv_file = unique_argv_file("d8-legacy-lease-completion");
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec("claude", &argv_file)]));
        let registry = state.terminal_registry.clone().unwrap();
        let router = app(state);

        let locator = SessionLocator {
            provider: "claude".into(),
            session_id: LIVE_SESSION.into(),
        };
        assert_eq!(registry.bound_terminal_for_session_ref(&locator), None);

        let (status, body) = post(
            router,
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": LIVE_SESSION },
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let tid = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();

        assert_eq!(
            registry.bound_terminal_for_session_ref(&locator),
            Some(tid.clone()),
            "a resume spawn must complete its lease into a sessionRef binding"
        );

        registry.kill(&tid);
    }

    #[tokio::test]
    async fn create_claude_tab_with_non_canonical_resume_id_does_not_synthesize() {
        // ejh6: wire-level legacy resumeSessionId is REFUSED at the door — the
        // implausible-id "no-synthesize/keep" EDEV-07 branch is now wire-
        // unreachable; the branch stays in production code (content concern,
        // out of scope for ejh6). This test pins the refusal: 400 + frozen
        // text, and NO ui.command frame is broadcast (no spawn).
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
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(
            body["message"],
            json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.")
        );
        // No spawn -> no ui.command broadcast. subscribe-before-post means any
        // frame would land in rx; a short timeout proves none arrived.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(250), rx.recv())
                .await
                .is_err(),
            "no broadcast frame may arrive for a rejected create"
        );
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn create_amplifier_tab_with_whitespace_resume_id_does_not_synthesize() {
        // ejh6: wire-level legacy resumeSessionId is REFUSED at the door — the
        // implausible-id "no-synthesize/keep" EDEV-07 branch is now wire-
        // unreachable; the branch stays in production code (content concern,
        // out of scope for ejh6). This test pins the refusal: 400 + frozen
        // text, and NO ui.command frame is broadcast (no spawn).
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
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(
            body["message"],
            json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.")
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(250), rx.recv())
                .await
                .is_err(),
            "no broadcast frame may arrive for a rejected create"
        );
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn create_opencode_tab_with_non_ses_resume_id_does_not_synthesize() {
        // ejh6: wire-level legacy resumeSessionId is REFUSED at the door — the
        // implausible-id "no-synthesize/keep" EDEV-07 branch is now wire-
        // unreachable (opencode ids are `ses_*` rows,
        // `shared/session-flavor.ts:65` `isDurableProviderSessionId`); the
        // branch stays in production code (content concern, out of scope for
        // ejh6). This test pins the refusal: 400 + frozen text, and NO
        // ui.command frame is broadcast (no spawn).
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
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(
            body["message"],
            json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.")
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(250), rx.recv())
                .await
                .is_err(),
            "no broadcast frame may arrive for a rejected create"
        );
        let _ = std::fs::remove_file(&argv_file);
    }

    #[tokio::test]
    async fn create_opencode_tab_with_session_ref_flows_into_pane_content() {
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
                "sessionRef": { "provider": "opencode", "sessionId": "ses_abc123" }
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

    /// P1.14 / Incident-4 hardening, Step 5: a REST `send-keys` Enter must
    /// feed the codex locator's `note_submit` (the codex window is
    /// Enter-anchored -- without this, a REST-driven codex pane's window
    /// never opens). Observable via the locator's own seams, mirroring the
    /// WS-path test (`codex_association.rs:311-321`): the first submit
    /// re-snapshots `known_files` (`fs_scan_count` 1 -> 2), and a direct
    /// `note_submit` afterwards returns false (a still-pending window never
    /// re-opens); non-submit text must not touch either.
    #[tokio::test]
    async fn send_keys_enter_feeds_codex_locator() {
        // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
        // plain-CLI codex path (sh-script fake codex, no app-server), so pin OFF.
        std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
        let root = unique_temp_home("codex-submit");
        let argv_file = unique_argv_file("codex-submit");
        let locator = std::sync::Arc::new(freshell_sessions::codex_locator::CodexLocator::new(
            root.clone(),
        ));
        let state = state_with_registry()
            .with_codex_locator(Some(locator.clone()))
            .with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "codex", &argv_file,
            )]));
        let router = app(state.clone());
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            router.clone(),
            "/api/tabs",
            json!({ "mode": "codex", "cwd": tmp.to_string_lossy() }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let pane_id = body["data"]["paneId"].as_str().unwrap().to_string();
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
        assert_eq!(
            locator.armed_count(),
            1,
            "REST codex create must arm the codex locator"
        );
        assert_eq!(locator.fs_scan_count(), 1); // the arm snapshot

        // Non-submit text (the `is_submit_input` gate): no window, no rescan.
        let (send_status, _) = post(
            router.clone(),
            &format!("/api/panes/{pane_id}/send-keys"),
            json!({ "data": "hello" }),
            true,
        )
        .await;
        assert_eq!(send_status, StatusCode::OK);
        assert_eq!(
            locator.fs_scan_count(),
            1,
            "non-submit input must not open the codex window"
        );

        // A lone Enter: the FIRST submit re-snapshots known_files.
        let (send_status, _) = post(
            router.clone(),
            &format!("/api/panes/{pane_id}/send-keys"),
            json!({ "data": "\r" }),
            true,
        )
        .await;
        assert_eq!(send_status, StatusCode::OK);
        assert_eq!(
            locator.fs_scan_count(),
            2,
            "the REST Enter must feed note_submit (first-submit re-snapshot)"
        );
        assert!(
            !locator.note_submit(&terminal_id, now_ms()),
            "the REST Enter already opened a still-pending window -- a direct \
             note_submit must not re-open it"
        );

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_dir_all(&root);
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
                "sessionRef": { "provider": "amplifier", "sessionId": "sess-no-warn-1" }
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
    async fn create_fresh_claude_tab_does_not_warn_missing_identity() {
        // kata hbsa: the mint closes the identity gap, so the invariant alarm
        // must stay quiet for fresh claude REST creates.
        // (Same harness as create_tab_with_identity_or_shell_mode_does_not_warn_invariant,
        // with a fresh {mode:"claude"} body and no sessionRef/resumeSessionId.)
        let (events, _guard) = invariant_capture::capture();
        let (state, registry, argv_file) = state_with_claude_capture_spec("claude-no-warn");
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({ "mode": "claude", "cwd": tmp.to_string_lossy() }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();

        assert!(
            missing_identity_warnings(&events.lock().unwrap()).is_empty(),
            "a fresh claude create mints its own identity (paneContent.sessionRef) \
             and must not trip the missing-identity alarm"
        );

        registry.kill(&terminal_id);
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
