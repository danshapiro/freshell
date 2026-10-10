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
use sha2::{Digest, Sha256};
use uuid::Uuid;

use freshell_platform::detect::{host_os_live, is_windows, is_wsl_env_live, HostOs};
use freshell_platform::mcp_inject::{
    build_managed_codex_mcp_renderings, cleanup_mcp_config, generate_mcp_injection, RealMcpRuntime,
};
use freshell_platform::spawn::{
    cli_provider_target, resolve_coding_cli_command, resolve_mcp_cwd, resolve_shell,
    resolve_unix_shell_cwd, CliLaunchInputs, LaunchIntent, McpInjection,
};
use freshell_platform::{
    build_cli_spawn_spec, build_spawn_spec, build_windows_cli_spawn_spec, CliLaunch, Env, RealEnv,
    RealFileProbe, ShellType, SpawnSpec,
};
use freshell_protocol::{ServerMessage, SessionLocator, UiCommand};
use freshell_terminal::registry::{ManagedTerminalLaunch, SessionRefClaim};

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

fn managed_runtime_mode(mode: &str) -> bool {
    mode == "shell" || freshell_agent_runtime::managed_provider_enabled(mode)
}

fn stable_managed_uuid(create_request_id: &str, domain: &[u8]) -> Uuid {
    let mut hasher = Sha256::new();
    hasher.update(b"freshell-managed-terminal-v1\0");
    hasher.update(domain);
    hasher.update(b"\0");
    hasher.update(create_request_id.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn mint_terminal_id(create_request_id: &str, use_managed_runtime: bool) -> String {
    if use_managed_runtime {
        stable_managed_uuid(create_request_id, b"terminal")
            .simple()
            .to_string()
    } else {
        Uuid::new_v4().to_string()
    }
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

    // `hostStats: true` -> stateless host-stats pane (router.ts `wantsHostStats`
    // branch before browser): no process, no terminal admission.
    if body
        .get("hostStats")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return create_content_tab(
            &state,
            name,
            json!({ "kind": "host-stats" }),
            restore_key.as_deref(),
            broadcast,
        );
    }
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

/// One value-safe managed Codex rendering for this terminal tab's TUI and a
/// newly spawned app-server. It intentionally does not implement `Debug` so
/// terminal context values cannot reach log or error surfaces.
struct CodexManagedLaunchSetup {
    terminal_id: String,
    runtime_cwd: Option<String>,
    tui_mcp_injection: McpInjection,
    terminal_env: BTreeMap<String, String>,
    sidecar_context: freshell_codex::launch_plan::CodexSidecarLaunchContext,
}

/// Construct the managed pair once. The app-server receives the host-native
/// rendering plus the terminal's canonical environment; the TUI receives its
/// selected target rendering. A claimed survivor is selected below without
/// consuming or rewriting this spawn-only setup.
fn build_codex_managed_launch_setup(
    terminal_id: String,
    shell: ShellType,
    host_os: HostOs,
    is_wsl: bool,
    resolved_cwd: Option<&str>,
    tab_id: Option<&str>,
    pane_id: Option<&str>,
) -> Result<CodexManagedLaunchSetup, String> {
    let runtime_cwd = resolve_mcp_cwd(resolved_cwd, &RealEnv, host_os, is_wsl);
    let tui_target = cli_provider_target(shell, host_os, is_wsl, resolved_cwd, &RealEnv);
    let renderings =
        build_managed_codex_mcp_renderings(&RealMcpRuntime, &RealEnv, host_os, is_wsl, tui_target)
            .map_err(|error| error.message)?;
    let freshell_platform::mcp_inject::ManagedCodexMcpRenderings { tui, sidecar } = renderings;
    let terminal_env = build_terminal_base_env(&RealEnv, &terminal_id, tab_id, pane_id);
    let mut sidecar_env = sidecar.env;
    // Canonical terminal values own any overlap with a future renderer.
    sidecar_env.extend(terminal_env.clone());

    Ok(CodexManagedLaunchSetup {
        terminal_id,
        runtime_cwd,
        tui_mcp_injection: tui,
        terminal_env,
        sidecar_context: freshell_codex::launch_plan::CodexSidecarLaunchContext {
            config_args: sidecar.args,
            env: sidecar_env,
        },
    })
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
    managed_runtime: bool,
) {
    if managed_runtime {
        return;
    }
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
    if !managed_runtime {
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
    /// Some(stale_id) iff the gate fired: the spawn REFUSES with the typed
    /// SESSION_MISSING outcome (b8ke ext r16 F3 — no substitution), after
    /// invoking `on_stale_resume` (the ledger retire).
    stale_session_id: Option<String>,
    /// A managed recovery without positive native-session evidence must stop
    /// before spawning, without retiring the durable identity.
    blocked_recovery: bool,
    blocked_session_id: Option<String>,
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
        blocked_recovery: false,
        blocked_session_id: None,
    }
}

fn rest_resume_blocked(
    resume_session_id: Option<String>,
    launch_intent: LaunchIntent,
) -> RestResumeOutcome {
    RestResumeOutcome {
        resume_session_id: None,
        launch_intent,
        claude_fresh_prealloc: false,
        stale_session_id: None,
        blocked_recovery: true,
        blocked_session_id: resume_session_id,
    }
}

/// Door 3 gate (resume-validation): before the REST create pipeline turns a
/// cached session id into resume argv, ask the disk-existence probe. On
/// POSITIVE absence, refuse the exact resume with SESSION_MISSING. A user
/// create still fails open on unknown/unavailable evidence, an unvalidated
/// provider, or `probe: None` (feature not wired in bare unit-test states).
/// Managed recovery requires positive evidence and refuses in all of those
/// cases. Body mirrors `freshell_ws::resume_validation::
/// validate_wire_resume`, using the `ResumeProbeFn` injection shape because
/// this crate must not depend on `freshell-ws`. SYNC by design: the wiring
/// site runs it inside `tokio::task::spawn_blocking` (A13 — the probe does
/// real filesystem walks).
fn validate_rest_resume(
    mode: &str,
    resume_session_id: Option<String>,
    launch_intent: LaunchIntent,
    probe: Option<&freshell_platform::resume_gate::ResumeProbeFn>,
    intent: freshell_platform::resume_gate::ResumeIntent,
) -> RestResumeOutcome {
    use freshell_platform::resume_gate::{
        evaluate_resume_gate_for_intent, provider_validated, ResumeGateDecision, ResumeIntent,
    };
    let Some(probe) = probe else {
        if intent == ResumeIntent::ManagedRecovery {
            return rest_resume_blocked(resume_session_id, launch_intent);
        }
        return rest_resume_passthrough(resume_session_id, launch_intent);
    };
    let Some(sid) = resume_session_id.clone().filter(|s| !s.is_empty()) else {
        if intent == ResumeIntent::ManagedRecovery {
            return rest_resume_blocked(resume_session_id, launch_intent);
        }
        return rest_resume_passthrough(resume_session_id, launch_intent);
    };
    if !provider_validated(mode) {
        if intent == ResumeIntent::ManagedRecovery {
            return rest_resume_blocked(resume_session_id, launch_intent);
        }
        return rest_resume_passthrough(resume_session_id, launch_intent);
    }
    let answer = probe(mode, &sid);
    match evaluate_resume_gate_for_intent(
        mode,
        answer.existence,
        answer.ever_observed_on_disk,
        intent,
    ) {
        ResumeGateDecision::Proceed => rest_resume_passthrough(resume_session_id, launch_intent),
        ResumeGateDecision::BlockedRecovery => rest_resume_blocked(Some(sid), launch_intent),
        ResumeGateDecision::SpawnFresh => {
            // b8ke ext r16 F3: the gate's SpawnFresh verdict REFUSES at the
            // consumer — the minted-fresh fallback fields are dead, so the
            // outcome carries only the stale id (the consumer's typed
            // SESSION_MISSING refusal + the ledger retire).
            RestResumeOutcome {
                resume_session_id: None,
                launch_intent,
                claude_fresh_prealloc: false,
                stale_session_id: Some(sid),
                blocked_recovery: false,
                blocked_session_id: None,
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
/// kata b8ke Task 4: the coordinator's typed owner fields
/// (`ownerKind`/`ownerGeneration`) ride the same additive rule when the
/// coordinator knows the owner. kata b8ke Task 10 (refactor): delegates to
/// the ONE shared `fail_json_conflict_with_owner` envelope so every
/// ownership-conflict door (this rung, the attach/respawn conflicts, the
/// MCP-proxied body) shares one JSON shape.
fn fail_json_restore_unavailable(
    live_sid: &str,
    live_terminal_id: Option<&str>,
    owner: Option<&crate::ownership_lane::TerminalOwnerFields>,
) -> Response {
    crate::fail_json_conflict_with_owner(
        "RESTORE_UNAVAILABLE",
        format!("Session {live_sid} is still running on the server."),
        live_terminal_id,
        owner,
    )
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
    /// kata b8ke Task 4 (round-1 review, single commit authority): `Some`
    /// ONLY when the spawn ran UNDER a handoff ticket — the settle task
    /// skipped its own coordinator commit and the HANDOFF RUNNER (Task 6)
    /// performs the one `commit_live` with this identity. `None` on every
    /// ordinary spawn (the settle task committed itself).
    pub(crate) owner_identity: Option<freshell_ownership::OwnerIdentity>,
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
/// the plugin and merge any user-selected TUI config under the real process
/// env's home. Home resolution mirrors
/// `ClaudeSignalWatcher::default_root` (`claude_signal.rs:52-66`):
/// `%USERPROFILE%` on Windows, `$HOME` otherwise; empty/unset ⇒ `None` ⇒
/// skip injection. Malformed selected config refuses the launch.
fn opencode_rebind_precompute(
    selected: Option<&str>,
    cwd: Option<&str>,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    let base = std::env::var("USERPROFILE").ok();
    #[cfg(not(windows))]
    let base = std::env::var("HOME").ok();
    let Some(base) = base.filter(|base| !base.is_empty()) else {
        return Ok(None);
    };
    let selected = selected.map(|raw| {
        let path = std::path::PathBuf::from(raw);
        if path.is_absolute() {
            path
        } else {
            std::path::Path::new(cwd.unwrap_or(".")).join(path)
        }
    });
    freshell_platform::opencode_plugin::ensure_rebind_plugin_with_user_config(
        std::path::Path::new(&base),
        selected.as_deref(),
    )
    .map(|path| Some(path.display().to_string()))
    .map_err(|error| error.to_string())
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

/// The REST rung's coordinator claim guard (kata b8ke Task 4): wraps the
/// `OperationTicket` granted by the unconditional claim in
/// [`spawn_terminal_pane_with_handoff`]. Drop without [`Self::commit`]
/// performs the coordinator's typed `fail` (RAII, via the ticket), so an
/// aborted handler future or a failed spawn can never wedge the session in
/// `Starting`. The winner path commits through [`Self::commit`] (which also
/// retains the release claim in the registry).
struct RestOwnershipClaim {
    ticket: freshell_ownership::OperationTicket,
    locator: SessionLocator,
}

impl RestOwnershipClaim {
    /// b8ke d4 F4: on `Committed` the ticket is DISARMED — the claim is
    /// consumed, so its Drop must not also perform the typed fail
    /// (`ownership.ticket.dropped_unarmed`/TICKET_DROPPED would misclassify
    /// every successful REST create/resume as an abandoned claim; the Live
    /// record survives the foreign fail, but the diagnostics noise is
    /// false). On `Err` the drop keeps the RAII fail (the claim never
    /// committed).
    fn commit(
        mut self,
        registry: &freshell_terminal::TerminalRegistry,
        terminal_id: &str,
    ) -> Result<(), freshell_ownership::CommitOutcome> {
        let outcome = registry.commit_session_ref_ownership(
            &self.locator,
            self.ticket.operation_id(),
            self.ticket.generation(),
            terminal_id,
        );
        match outcome {
            freshell_ownership::CommitOutcome::Committed => {
                self.ticket.disarm();
                Ok(())
            }
            stale => Err(stale),
        }
    }
}

/// b8ke fence-heal (plan Task 3 / delta round-4 F3, focused review 2
/// rework): the REST rung's commit-to-Live owner-frame construction — the
/// in-crate mirror of freshell-ws's `broadcast_owner_frame` terminal-Live
/// shape (this crate cannot call the freshell-ws helper). Takes the
/// ownership registry so the emission is welded to the REAL coordinator
/// identity (the frame's epoch) AND so the re-observation hazard is
/// genuinely inside the tested unit: a regression that consulted
/// `ownership.observe(...).generation` here would fold the registry's
/// CURRENT generation over the transition's own committed pair — the exact
/// r32 F2 violation. The generation is the caller-supplied COMMITTED pair
/// (the claim ticket's own pair, captured BEFORE the consuming commit —
/// never a re-observed current generation, the shape the WS side's
/// `broadcast_owner_frame_if_authoritative` was rejected for). `None` only
/// on serialization failure (the caller drops the frame silently, same as
/// the WS lane's `unwrap_or_default`).
fn rest_terminal_owner_frame(
    ownership: &freshell_ownership::RuntimeOwnershipRegistry,
    locator: &SessionLocator,
    terminal_id: &str,
    operation_id: &str,
    generation: u64,
) -> Option<String> {
    serde_json::to_string(&ServerMessage::SessionRuntimeOwner(
        freshell_protocol::SessionRuntimeOwner {
            provider: locator.provider.clone(),
            session_id: locator.session_id.clone(),
            epoch: ownership.boot_epoch(),
            generation,
            owner_kind: "terminal".into(),
            previous_kind: None,
            terminal_id: Some(terminal_id.to_string()),
            operation_id: operation_id.to_string(),
            transition: "handoff-committed".into(),
            reason: None,
            fenced: None,
            alias_of: None,
        },
    ))
    .ok()
}

/// The stale-teardown discipline shared by the REST settle's refusal arms
/// (kata b8ke Task 4 review M1 fix): kill the create's own just-spawned
/// child via the registry handle (group-kill discipline), confirm the reap,
/// and force-release the locator. Never leave an unowned writer behind.
async fn teardown_unowned_spawn(
    registry: &freshell_terminal::TerminalRegistry,
    locator: &SessionLocator,
    terminal_id: &str,
) {
    let pid = registry.pid_of(terminal_id);
    registry.kill(terminal_id);
    let confirmed = match pid {
        Some(pid) => confirm_pid_dead_within_500ms(pid).await,
        // No pid handle to probe: the registry kill removed the row;
        // nothing is left to signal, so treat as confirmed.
        None => true,
    };
    if confirmed {
        registry.force_release_after_confirmed_kill(locator);
    }
}

/// A REST-created Codex pane's start in its unit (Task 12): the pane's own
/// base unit registered in the shared [`freshell_containment::UnitDirectory`]
/// and the Codex seed's lifecycle over that entry (each start attempt's unit
/// takes the entry over). Every stop goes through the directory's installed
/// lifecycle — the WebSocket layer's single stop path — which ends the row
/// and the unit at Gone; nothing here waits for Gone. A start dropped
/// without [`Self::commit`] or [`Self::give_up`] is given up (with no
/// claim), so no early return leaves its unit running.
struct RestUnitStart {
    units: std::sync::Arc<freshell_containment::UnitDirectory>,
    containment: freshell_containment::Containment,
    label: freshell_containment::UnitLabel,
    lifecycle: std::sync::Arc<freshell_codex::launch_plan::DirectoryUnitLifecycle>,
    /// The terminal the start spawned, once noted.
    spawned_terminal: Option<String>,
    done: bool,
}

impl RestUnitStart {
    /// Creates the pane's unit (its record written first) and registers the
    /// starting entry. `None` when no single stop path is installed (a state
    /// built without the WebSocket layer): such a create keeps the plain,
    /// unit-less spawn.
    fn begin(
        state: &FreshAgentState,
        mode: &str,
        create_request_id: &str,
        terminal_id: &str,
        session_id: Option<&str>,
    ) -> std::io::Result<Option<Self>> {
        if state.units.lifecycle().is_none() {
            return Ok(None);
        }
        let label = freshell_containment::UnitLabel {
            provider: mode.to_string(),
            session_id: session_id.map(str::to_string),
            terminal_id: Some(terminal_id.to_string()),
            mode: mode.to_string(),
            create_request_id: Some(create_request_id.to_string()),
        };
        let base = state
            .containment
            .create_unit(freshell_containment::UnitId::mint(), label.clone())?;
        state.units.register(freshell_containment::UnitEntry {
            unit: base.clone(),
            provider: mode.to_string(),
            mode: mode.to_string(),
            create_request_id: Some(create_request_id.to_string()),
            terminal_id: None,
        });
        // A kill of this pane that found no start yet (it remembered the
        // create-request id first, then looked for a start) cancels the
        // start registered just now, so it never mints an attempt.
        if state.units.killed_start(create_request_id) {
            state.units.cancel_start(base.id());
        }
        Ok(Some(Self {
            lifecycle: freshell_codex::launch_plan::DirectoryUnitLifecycle::new(
                state.units.clone(),
                base,
            ),
            units: state.units.clone(),
            containment: state.containment.clone(),
            label,
            spawned_terminal: None,
            done: false,
        }))
    }

    /// The Codex seed: one fresh unit per start attempt.
    fn seed(&self) -> freshell_codex::launch_plan::UnitSeed {
        freshell_codex::launch_plan::UnitSeed {
            services: freshell_codex::launch_plan::CodexUnitServices {
                containment: self.containment.clone(),
                lifecycle: self.lifecycle.clone(),
            },
            label: self.label.clone(),
        }
    }

    /// The unit the pane runs in now.
    fn unit(&self) -> freshell_containment::AgentUnit {
        self.lifecycle.current()
    }

    /// Whether the start must be given up: its entry is gone, a stop
    /// cancelled it, or its unit's stop began. The last is checked on its
    /// own because this lane's start settles as soon as its screen's
    /// placement is confirmed, which can come before the create commits,
    /// and a stop never marks a settled start cancelled.
    fn cancelled(&self) -> bool {
        let unit = self.unit();
        self.units.get(unit.id()).is_none()
            || self.units.start_cancelled(unit.id())
            || unit.stop_in_flight().is_some()
    }

    /// The screen `screen_pid` of `terminal_id` started in the unit: it is
    /// pinned by pid AND the start time its row recorded at the spawn (pin
    /// before any placement check, as macOS requires) and its terminal
    /// noted, so every stop from now on ends this row. `false` when the
    /// start must be given up: a stop cancelled it, or already reached Gone
    /// before the row was known to it (the give-up then ends the row).
    fn spawned(
        &mut self,
        registry: &freshell_terminal::TerminalRegistry,
        terminal_id: &str,
        screen_pid: u32,
    ) -> bool {
        let unit = self.unit();
        let pinned = registry
            .screen_start_time(terminal_id)
            .ok_or_else(|| {
                "no start time is recorded for the screen (it already exited)".to_string()
            })
            .and_then(|start| {
                freshell_containment::ProcWatch::open_expecting(screen_pid, start)
                    .map_err(|error| error.to_string())
            });
        match pinned {
            Ok(watch) => unit.set_screen(watch),
            Err(reason) => freshell_containment::events::screen_unpinned(
                &self.log_keys(&unit),
                screen_pid,
                &reason,
            ),
        }
        self.units.note_terminal(unit.id(), terminal_id);
        self.spawned_terminal = Some(terminal_id.to_string());
        let gone = unit
            .stop_in_flight()
            .is_some_and(|handle| handle.try_report().is_some());
        !gone && !self.cancelled()
    }

    /// Binds the unit to its terminal and hands the screen to the
    /// placement settlement (the start settles once it is confirmed).
    fn bind(&self, terminal_id: &str, screen_pid: u32) {
        let unit = self.unit();
        self.units.bind_terminal(unit.id(), terminal_id);
        self.units.settle_start(unit.id(), screen_pid);
    }

    /// The create succeeded: the placement settlement settles the start.
    fn commit(mut self) {
        self.done = true;
    }

    /// The create gives the start up (`initiator` names why): the unit (and
    /// the unused base unit) is stopped through the single stop path, a row
    /// spawned after that stop's Gone is ended, and once the unit is Gone
    /// `claim` — the create's holds on its conversation — is dropped, then
    /// the start is settled and its entry removed. Nothing waits here.
    fn give_up(mut self, initiator: &str, claim: Option<Box<dyn std::any::Any + Send>>) {
        self.give_up_inner(initiator, claim);
    }

    fn give_up_inner(&mut self, initiator: &str, claim: Option<Box<dyn std::any::Any + Send>>) {
        if self.done {
            return;
        }
        self.done = true;
        let unit = self.unit();
        let base = self.lifecycle.base();
        let start = freshell_containment::AbandonedStart {
            entry: freshell_containment::UnitEntry {
                unit: unit.clone(),
                provider: self.label.provider.clone(),
                mode: self.label.mode.clone(),
                create_request_id: self.label.create_request_id.clone(),
                terminal_id: self.spawned_terminal.clone(),
            },
            base: (base.id() != unit.id()).then_some(base),
            initiator: initiator.to_string(),
            claim,
        };
        if let Err(start) = self.units.abandon_start(start) {
            // `begin` requires an installed lifecycle; should it have gone,
            // the units are still stopped (their rows end with their PTYs).
            let start = *start;
            for unit in std::iter::once(start.entry.unit).chain(start.base) {
                let _ = unit.stop(freshell_containment::StopRequest::new(
                    freshell_containment::StopMode::Force,
                    freshell_containment::StopReason::StartCancelled,
                    initiator,
                ));
            }
        }
    }

    /// The unit's log keys (provider, conversation, terminal; no operation).
    fn log_keys(
        &self,
        unit: &freshell_containment::AgentUnit,
    ) -> freshell_containment::events::UnitLogKeys {
        freshell_containment::events::UnitLogKeys {
            unit_id: unit.id().to_string(),
            provider: self.label.provider.clone(),
            session_id: self.label.session_id.clone(),
            terminal_id: self.label.terminal_id.clone(),
            operation_id: None,
        }
    }
}

impl Drop for RestUnitStart {
    fn drop(&mut self) {
        self.give_up_inner("rest-start-dropped", None);
    }
}

/// The REST create's holds on its conversation — its coordinator claim, its
/// sessionRef lease and its start-cancellation witness — handed to a
/// given-up start, which drops them only once its unit is Gone (so the
/// conversation is never released while its Codex may still hold it).
fn take_rest_claims(
    ownership_claim: &mut Option<RestOwnershipClaim>,
    session_ref_lease: &mut Option<RestSessionRefLease>,
    start_cancellation: &mut Option<crate::ownership_lane::StartCancellationGuard>,
) -> Box<dyn std::any::Any + Send> {
    Box::new((
        ownership_claim.take(),
        session_ref_lease.take(),
        start_cancellation.take(),
    ))
}

/// Stamps the create's Starting key with the unit of its spawned row (as
/// the WS create does): a stop of the unit from now on moves the key to
/// Stopping and releases it only at Gone, and the create's commit then
/// answers stale. A start a stop already cancelled is left unstamped: that
/// stop (perhaps Gone already) moved no key of the create's, and the
/// give-up before the commit releases the claim at the unit's Gone.
fn stamp_claim_with_unit(
    state: &FreshAgentState,
    registry: &freshell_terminal::TerminalRegistry,
    start: &RestUnitStart,
    claim: &RestOwnershipClaim,
    terminal_id: &str,
) {
    if start.cancelled() {
        return;
    }
    if let Some(ownership) = state.ownership.as_ref() {
        ownership.register_partial_runtime(
            &claim.locator.provider,
            &claim.locator.session_id,
            claim.ticket.operation_id(),
            claim.ticket.generation(),
            freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                terminal_id: Some(terminal_id.to_string()),
                live_session_key: None,
                pid: registry.pid_of(terminal_id),
                ownership_id: None,
                unit_id: registry.unit_id_for(terminal_id),
                hold: freshell_ownership::HoldKind::Main,
            },
        );
    }
}

/// The spawn "failure" of a managed pane killed while it started (its soul
/// stopped, or never launched): the create's failure cleanup runs, then it
/// is answered as stopped ([`pane_stopped_response`]).
fn pane_stopped_error() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Interrupted, PANE_STOPPED_MESSAGE)
}

fn is_pane_stopped_error(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::Interrupted && err.to_string() == PANE_STOPPED_MESSAGE
}

/// The answer to a create of a pane a kill stopped (the WebSocket create's
/// `INVALID_TERMINAL_ID` refusal, as a REST response).
const PANE_STOPPED_MESSAGE: &str = "this pane was stopped";

fn pane_stopped_response() -> Response {
    fail_json_code(
        StatusCode::CONFLICT,
        "INVALID_TERMINAL_ID",
        PANE_STOPPED_MESSAGE.to_string(),
    )
}

/// Releases a disarmed sessionRef lease (and its retained coordinator
/// claim) when dropped: carried by a given-up start, it runs after the
/// unit's Gone — the confirmed death `force_release_after_confirmed_kill`
/// requires. The lease is released only while this create still holds it:
/// a reopen that took the conversation's lease once it went Vacant keeps it
/// (Task 12 re-review 3, m2).
struct ReleaseLeaseAfterGone {
    registry: freshell_terminal::TerminalRegistry,
    locator: SessionLocator,
    /// The create the lease belongs to.
    holder_create_request_id: String,
}

impl Drop for ReleaseLeaseAfterGone {
    fn drop(&mut self) {
        self.registry.force_release_after_confirmed_kill_for_holder(
            &self.locator,
            &self.holder_create_request_id,
        );
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

/// The handoff runner's spawn token (kata b8ke Task 4, consumed by Task 6):
/// when `Some`, the D8 rung's coordinator claim recognizes the in-flight
/// Handoff (same operation_id, to_kind Terminal) as a Granted continuation
/// instead of a conflict. Round-1 review (single commit authority): the
/// settle task runs UNDER-TICKET — it skips its own coordinator commit and
/// surfaces the terminal's `OwnerIdentity` to the handoff runner, which
/// performs the ONE `commit_live`.
pub(crate) struct HandoffToken {
    pub operation_id: String,
    /// The commit generation the runner performs its one `commit_live`
    /// under (Task 6's consumption; the spawn rung itself only needs the
    /// operation id).
    #[allow(dead_code)] // consumed by Task 6's handoff runner
    pub generation: u64,
    /// Round-3 review I-1 (cancellation-safety, target-spawn window): the
    /// guard-visible watch the settle publishes the spawned terminal into —
    /// an aborted runner's Drop cleanup consumes it to reap the
    /// spawned-but-uncommitted terminal.
    pub watch: HandoffSpawnWatch,
}

/// The handoff runner's guard-visible view of an under-ticket terminal
/// target spawn (kata b8ke Task 6, round-3 review I-1): the settle task
/// publishes the spawned terminal id the moment it exists-and-is-kept (the
/// under-ticket surface point — every earlier failure path tears its own
/// child down) and marks settlement when it finishes, success or failure.
/// An aborted runner's `HandoffGuard` Drop cleanup waits for settlement and
/// reaps the published id, so the target-spawn window can never strand a
/// live unowned writer the coordinator cannot see.
#[derive(Clone)]
pub struct HandoffSpawnWatch {
    inner: std::sync::Arc<HandoffSpawnWatchInner>,
}

struct HandoffSpawnWatchInner {
    terminal_id: std::sync::Mutex<Option<String>>,
    settled: std::sync::atomic::AtomicBool,
    settled_notify: tokio::sync::Notify,
    /// Test seam (rides the constructor like the runner's
    /// `HandoffTestHooks`; `None` in production): park the settle AFTER
    /// publication, before the result surfaces — the deterministic
    /// abort-inside-the-window hold.
    pause_before_surface: Option<std::sync::Arc<tokio::sync::Notify>>,
    /// b8ke ext r10 F3 test seam: park the settle BEFORE the publication
    /// point — the reviewer's exact pre-publication abort window (the
    /// cleanup's settle wait times out while the spawn has not yet
    /// published). `None` in production.
    pause_before_publish: Option<std::sync::Arc<tokio::sync::Notify>>,
    /// b8ke ext r10 F3: the cleanup's bounded settle-wait budget in ms
    /// (default 60s). A test-visible knob so the timeout's fail-closed
    /// path is exercisable without wall-clock waits; production never
    /// touches it.
    settle_wait_budget_ms: std::sync::atomic::AtomicU64,
    /// b8ke ext r10 F3 test proof: set the moment the pre-publication park
    /// engages (the deterministic signal that the settle REACHED the
    /// reviewer's window before the test aborts).
    parked_before_publish: std::sync::atomic::AtomicBool,
    /// b8ke ext r13 F7: the published terminal's recorded PID — captured
    /// at PUBLICATION (while the registry row exists), so an abort
    /// cleanup's reap confirmation can use the PID's OS-level death as
    /// the evidence (the registry removes a row BEFORE its blocking PTY
    /// kill completes, so the ROW's absence is NOT death proof — the
    /// recurring row-absence shortcut).
    published_pid: std::sync::Mutex<Option<u32>>,
}

impl HandoffSpawnWatch {
    pub(crate) fn new(pause_before_surface: Option<std::sync::Arc<tokio::sync::Notify>>) -> Self {
        Self::new_with_before_publish(pause_before_surface, None)
    }

    /// [`Self::new`] plus the pre-publication test seam (b8ke ext r10 F3).
    pub(crate) fn new_with_before_publish(
        pause_before_surface: Option<std::sync::Arc<tokio::sync::Notify>>,
        pause_before_publish: Option<std::sync::Arc<tokio::sync::Notify>>,
    ) -> Self {
        Self {
            inner: std::sync::Arc::new(HandoffSpawnWatchInner {
                terminal_id: std::sync::Mutex::new(None),
                settled: std::sync::atomic::AtomicBool::new(false),
                settled_notify: tokio::sync::Notify::new(),
                pause_before_surface,
                pause_before_publish,
                settle_wait_budget_ms: std::sync::atomic::AtomicU64::new(60_000),
                parked_before_publish: std::sync::atomic::AtomicBool::new(false),
                published_pid: std::sync::Mutex::new(None),
            }),
        }
    }

    /// TEST SEAM (b8ke ext r16 F1): publish a terminal + its recorded PID
    /// and mark the settle finished — the crafted-watch shape the
    /// reconfirmation tests drive (an external live pid over a registry
    /// row a concurrent kill already removed). Never call from production
    /// code.
    #[doc(hidden)]
    pub fn publish_and_settle_for_test(&self, terminal_id: &str, pid: Option<u32>) {
        self.publish(terminal_id, pid);
        self.settle_finished();
    }

    /// TEST KNOB (b8ke ext r10 F3): shrink the cleanup's bounded
    /// settle-wait budget so the timeout's fail-closed path is
    /// deterministic. Never call from production code.
    #[doc(hidden)]
    pub fn set_settle_wait_budget_ms(&self, ms: u64) {
        self.inner
            .settle_wait_budget_ms
            .store(ms, std::sync::atomic::Ordering::Release);
    }

    /// The settle's publication point: the terminal exists and will be kept.
    /// b8ke ext r13 F7: also records the PID (captured while the row
    /// exists — the cleanup's confirmed-reap evidence).
    fn publish(&self, terminal_id: &str, pid: Option<u32>) {
        *self.inner.terminal_id.lock().expect("spawn watch lock") = Some(terminal_id.to_string());
        *self.inner.published_pid.lock().expect("spawn watch lock") = pid;
    }

    /// b8ke ext r13 F7: the published terminal's recorded PID (the
    /// confirmed-reap evidence for the abort cleanup).
    pub(crate) fn published_pid(&self) -> Option<u32> {
        *self.inner.published_pid.lock().expect("spawn watch lock")
    }

    /// The id the settle published, if any — the abort cleanup's reap
    /// target (also the test's observable for "the spawn happened").
    pub(crate) fn published_terminal(&self) -> Option<String> {
        self.inner
            .terminal_id
            .lock()
            .expect("spawn watch lock")
            .clone()
    }

    /// Park the settle after publication when the test seam is armed.
    async fn pause_if_armed(&self) {
        if let Some(pause) = self.inner.pause_before_surface.as_ref() {
            let _ = pause.notified().await;
        }
    }

    /// b8ke ext r10 F3: park the settle BEFORE the publication point when
    /// the pre-publication seam is armed (the reviewer's exact window).
    pub(crate) async fn pause_if_armed_before_publish(&self) {
        if let Some(pause) = self.inner.pause_before_publish.as_ref() {
            self.inner
                .parked_before_publish
                .store(true, std::sync::atomic::Ordering::Release);
            let _ = pause.notified().await;
        }
    }

    /// b8ke ext r10 F3 test proof: whether the pre-publication park has
    /// engaged (the settle reached the window).
    #[doc(hidden)]
    pub fn parked_before_publish(&self) -> bool {
        self.inner
            .parked_before_publish
            .load(std::sync::atomic::Ordering::Acquire)
    }

    /// The settle finished — wake any cleanup waiter. `notify_one` stores a
    /// permit when no waiter is registered yet, so a cleanup that checks
    /// `settled` then awaits still observes the finish.
    fn settle_finished(&self) {
        self.inner
            .settled
            .store(true, std::sync::atomic::Ordering::Release);
        self.inner.settled_notify.notify_one();
    }

    /// Resolve once the settle finished, bounded by the watch's budget.
    /// b8ke ext r10 F3: the timeout result is NO LONGER DISCARDED — the
    /// caller learns whether the settle actually finished. `true` = the
    /// settle finished (or already had); `false` = the budget elapsed
    /// with the spawn still unsettled (pre-r10 the caller then saw no
    /// published terminal, classified NothingToDo, and RELEASED — the
    /// detached spawn could publish a live unowned writer afterwards).
    pub(crate) async fn wait_settled(&self) -> bool {
        if self
            .inner
            .settled
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return true;
        }
        let budget_ms = self
            .inner
            .settle_wait_budget_ms
            .load(std::sync::atomic::Ordering::Acquire);
        tokio::time::timeout(
            std::time::Duration::from_millis(budget_ms),
            self.inner.settled_notify.notified(),
        )
        .await
        .is_ok()
    }

    /// b8ke ext r10 F3: park until the settle finishes — NO budget. The
    /// fence's replacement confirmation watcher uses this: an unsettled
    /// spawn means the target's state is unconfirmed, and the key HOLDS
    /// until the spawn settles (publishes or dies) and the published
    /// terminal is reaped — never release-and-hope.
    pub(crate) async fn wait_settled_unbounded(&self) {
        if self
            .inner
            .settled
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return;
        }
        self.inner.settled_notify.notified().await;
    }
}

/// [`spawn_terminal_pane`], parameterized on an in-flight handoff's spawn
/// token (kata b8ke Task 4): the public entry point delegates with `None`.
pub(crate) async fn spawn_terminal_pane(
    state: &FreshAgentState,
    body: &Value,
    tab_id: &str,
    pane_id: &str,
) -> Result<TerminalSpawnResult, Response> {
    spawn_terminal_pane_with_handoff(state, body, tab_id, pane_id, None).await
}

/// The terminal-mode spawn pipeline (`router.ts:724-793` for create,
/// `router.ts:1326-1369` for split — the original reuses the SAME sequence
/// for both routes, and this port mirrors that reuse): resolve the requested
/// mode against the registered coding-CLI specs, derive the resume identity
/// ([`derive_resume_identity`]), spawn through the shared registry with the
/// SAME argv/env-building pipeline the WS `terminal.create` handler uses (
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
/// kata b8ke Task 6: the handoff runner's spawn entry (under-ticket mode —
/// the settle surfaces the terminal's `OwnerIdentity` instead of committing).
pub(crate) async fn spawn_terminal_pane_with_handoff(
    state: &FreshAgentState,
    body: &Value,
    tab_id: &str,
    pane_id: &str,
    handoff: Option<&HandoffToken>,
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
    // Freeze the launch lane before the coordinator's pre-spawn witness is
    // registered. Its cancel target and the eventual registry row must use
    // the same terminal id even if controller wiring changes while planning.
    let use_managed_runtime = registry.has_managed_controller() && managed_runtime_mode(&mode);

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

    let (mut resume_session_id, accepted_session_ref, session_ref_locator_present) =
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
            validate_rest_resume(
                &mode_for_gate,
                rid,
                intent,
                probe.as_ref(),
                // REST tab/split/respawn requests are user creates. The
                // server-wide managed controller does not prove this request
                // is resurrecting an existing soul; recovery uses its own
                // coordinator path with explicit durable identity.
                freshell_platform::resume_gate::ResumeIntent::UserCreate,
            )
        })
        .await
        .expect("resume validation task panicked")
    };
    let mut resume_session_id = rest_outcome.resume_session_id;
    let launch_intent = rest_outcome.launch_intent;
    if rest_outcome.blocked_recovery {
        let blocked = rest_outcome.blocked_session_id.as_deref().unwrap_or("");
        tracing::warn!(target: "freshell_freshagent::terminal_tabs",
            mode = %mode, session_id = %blocked, pane_id = %pane_id,
            "spawn_refused: managed recovery has no positive native-session evidence"
        );
        let message = if blocked.is_empty() {
            format!("The saved {mode} session could not be verified for recovery.")
        } else {
            format!("The saved {mode} session {blocked} could not be verified for recovery.")
        };
        return Err(crate::fail_json_code(
            StatusCode::CONFLICT,
            "RECOVERY_BLOCKED",
            message,
        ));
    }
    if let Some(stale) = rest_outcome.stale_session_id.as_deref() {
        // b8ke ext r16 F3: a DEFINITIVELY MISSING exact-resume target no
        // longer auto-substitutes a replacement session (the request's
        // non-goal is unqualified — "do not start blank sessions when
        // exact resume fails"; no recovery path changes the session id).
        // The ledger retire marks the row missing (the honest record),
        // then the spawn answers the TYPED SESSION_MISSING refusal —
        // nothing was started, and the only fresh-start path is the
        // explicit operator action on the pane's typed missing card
        // (pre-r16 this arm cleared the stale ref and proceeded to spawn a
        // replacement, recording SESSION_MISSING_RESUMED_FRESH).
        if let Some(cb) = &state.on_stale_resume {
            cb(&mode, stale);
        }
        tracing::warn!(target: "freshell_freshagent::terminal_tabs",
            mode = %mode, session_id = %stale, pane_id = %pane_id,
            "spawn_refused: the requested durable session is definitively \
             missing — the typed SESSION_MISSING refusal, never an automatic \
             fresh substitution"
        );
        return Err(crate::fail_json_code(
            StatusCode::CONFLICT,
            "SESSION_MISSING",
            format!(
                "The durable session {stale} is gone. No replacement was started — \
                 start a fresh conversation explicitly if you want a new session."
            ),
        ));
    }

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
    let under_handoff_ticket = handoff.is_some();
    // b8ke ext r7 F2: the claim locator includes the LEARNED identity —
    // the REST prealloc mint / gate-healed mint / restore-ladder id (the
    // body-only guard_locator is None for these). The DOOR claim uses it
    // so coordinator authority is retained THROUGH the spawn (pre-r7 the
    // learned locator only fed the late claim: the
    // ownership-check-through-spawn interval sat outside the coordinator
    // and a concurrent handoff on the learned key granted from Vacant
    // mid-spawn).
    let learned_claim_locator = guard_locator.clone().or_else(|| {
        resume_session_id
            .as_deref()
            .filter(|sid| {
                // Only DURABLE session ids claim: the mints and ladder
                // resolutions are canonical by construction; the filter
                // keeps an implausible legacy resume id (which the
                // guard_locator's own plausibility gate already rejected)
                // from claiming a junk key.
                !sid.is_empty()
                    && is_session_provider_mode(&mode)
                    && plausible_resume_session_id(&mode, sid)
            })
            .map(|sid| SessionLocator {
                provider: mode.clone(),
                session_id: sid.to_string(),
            })
    });
    // Round-3 review I-1: the token's guard-visible spawn watch — the settle
    // publishes the spawned terminal into it (see the under-ticket surface
    // below); the runner's HandoffGuard holds a clone across the await so
    // an abort's cleanup can wait for settlement and reap the publication.
    let handoff_spawn_watch = handoff.map(|t| t.watch.clone());
    // kata b8ke Task 4: the REST rung's coordinator claim — UNCONDITIONAL
    // (REST callers are programmatic; no capability gate), BEFORE the D7
    // check-then-spawn guard and BEFORE the registry lease, with the body's
    // observed (epoch, generation) pair as the delayed-request fence (the
    // Task 4 REST rung of the lifecycle-message fence audit). A handoff token
    // (Task 6's runner) claims under the in-flight Handoff's operation
    // identity instead of minting a fresh one (the coordinator's
    // same-operation continuation arm grants it). The `Adopt` arm claims
    // nothing: the D7 guard / registry lease below answer a same-kind live
    // terminal (refusal with `liveTerminalId`, or the attach-shaped
    // BoundElsewhere refusal).
    let mut ownership_claim: Option<RestOwnershipClaim> = None;
    // b8ke ext r13 F1: the REST claim's Adopt arm proceeds ONLY under HELD
    // authority — the ext-r12 attach guard arms on the live incumbent's key
    // and is held through the REST spawn + register + settle, so a handoff or
    // stop can NEVER begin and commit inside the create's window (pre-r13
    // the Adopt arm proceeded with NO ticket or guard).
    let mut _rest_adopt_guard: Option<freshell_ownership::AttachGuard> = None;
    // b8ke ext r20 F1: the claim's settlement witness (held to this
    // function's end — its Drop fires the settle) and the pre-minted
    // terminal id threaded to the spawn (the WS cancel-slot discipline).
    let mut _rest_start_cancellation: Option<crate::ownership_lane::StartCancellationGuard> = None;
    let mut ownership_start_terminal_id: Option<String> = None;
    if let Some(locator) = learned_claim_locator.clone() {
        let operation_id = handoff
            .map(|t| t.operation_id.clone())
            .unwrap_or_else(|| format!("rest-create-{create_request_id}"));
        // b8ke delta review F7: a half-fenced body (exactly one of the
        // observed epoch/generation pair) is a TYPED invalid-fence refusal —
        // never a silent legacy downgrade. b8ke focused review FR8: the
        // 400 envelope carries the shared error contract's stable
        // machine-readable code (INVALID_FENCE) — REST and MCP callers
        // reduce it instead of parsing prose.
        let observed = crate::ownership_lane::wire_fence(
            body.get("observedEpoch").and_then(Value::as_u64),
            body.get("observedGeneration").and_then(Value::as_u64),
        )
        .map_err(|err| {
            tracing::warn!(target: "freshell_freshagent::terminal_tabs",
                provider = %locator.provider, session_id = %locator.session_id, pane_id = %pane_id,
                code = err.code(),
                "spawn_refused: the observed fence is half-sent (invalid)");
            crate::fail_json_code(
                StatusCode::BAD_REQUEST,
                err.code(),
                err.message().to_string(),
            )
        })?;
        match crate::ownership_lane::begin_terminal_lane_claim(
            &state.ownership,
            &locator.provider,
            &locator.session_id,
            &operation_id,
            observed,
            "rest",
            now_ms().max(0) as u64,
        ) {
            crate::ownership_lane::TerminalLaneClaim::Granted(ticket) => {
                // b8ke ext r20 F1: WS-path parity — the REST create
                // pipeline registers the PRE-SPAWN
                // cancellation/settlement witness BEFORE any asynchronous
                // work (the managed codex launch planning can take
                // multiple 45-second attempts, enabled by default, while
                // the server sweep declares unwitnessed starts stale at
                // 30s). Pre-r20 the claim armed a Starting record with
                // NO witness and NO runtime identity, so an ordinary slow
                // or failed launch was fenced Fenced{StaleStart}
                // mid-planning — an unprovable fence no probe could
                // clear, wedging the session until restart and
                // stale-rejecting the eventual commit while reaping its
                // child. The witness makes a slow launch a legitimate
                // in-progress start the watchdog does NOT fence, and the
                // failure path settles through the witness typed.
                let registry_handle = registry.clone();
                let cancel_terminal_id = mint_terminal_id(&create_request_id, use_managed_runtime);
                let cancel_id_for_closure = cancel_terminal_id.clone();
                let cancel: std::sync::Arc<dyn Fn() + Send + Sync> =
                    std::sync::Arc::new(move || {
                        tracing::warn!(target: "freshell_freshagent::terminal_tabs",
                            terminal_id = %cancel_id_for_closure,
                            event = "ownership.start.cancel_signal",
                            "the watchdog's REST-start cancellation kills the \
                             terminal's registry row"
                        );
                        registry_handle.kill(&cancel_id_for_closure);
                    });
                let mut registration_ticket = Some(ticket);
                _rest_start_cancellation = Some(
                    crate::ownership_lane::register_start_cancellation_for_ticket(
                        &state.ownership,
                        &locator.provider,
                        &locator.session_id,
                        &registration_ticket,
                        cancel,
                    ),
                );
                // The WS F4 evidence discipline: the claim-time partial
                // runtime with the PRE-MINTED terminal id (the kind-
                // appropriate identity) — a watchdog sweep in the
                // planning window finds ARMED evidence, never fences on
                // nothing.
                if let Some(ownership) = state.ownership.as_ref() {
                    ownership.register_partial_runtime(
                        &locator.provider,
                        &locator.session_id,
                        registration_ticket
                            .as_ref()
                            .expect("the ticket is present on the Granted arm")
                            .operation_id(),
                        registration_ticket
                            .as_ref()
                            .expect("the ticket is present on the Granted arm")
                            .generation(),
                        freshell_ownership::OwnerIdentity {
                            kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                            terminal_id: Some(cancel_terminal_id.clone()),
                            live_session_key: None,
                            pid: None,
                            ownership_id: None,
                            unit_id: None,
                            hold: freshell_ownership::HoldKind::Main,
                        },
                    );
                }
                ownership_start_terminal_id = Some(cancel_terminal_id);
                ownership_claim = Some(RestOwnershipClaim {
                    ticket: registration_ticket
                        .take()
                        .expect("the ticket is present on the Granted arm"),
                    locator,
                });
            }
            crate::ownership_lane::TerminalLaneClaim::Unwired => {}
            crate::ownership_lane::TerminalLaneClaim::Adopt => {
                // b8ke ext r13 F1: Adopt is NOT permission to proceed
                // unguarded — the create proceeds ONLY under the held
                // attach guard (the ext-r10 F2 discipline). A guard
                // refusal (the incumbent entered a transition, or the
                // observed fence is stale) answers the typed refusal and
                // NOTHING spawns.
                // b8ke ext r39 F1: the arm is the ATOMIC ADOPT (the r38
                // primitive) — the request's observed pair (else the
                // arm-time observation) plus the EXPECTED owner KIND (the
                // REST create has no minted terminal id at the adopt —
                // the id exists only post-spawn; the adopt's kind
                // validation closes the cross-kind race: a completed
                // handoff to a Fresh Agent between the claim and this arm
                // answers the typed refusal instead of arming on the new
                // owner and spawning a terminal beside it). The
                // same-kind (terminal) incumbent re-open semantics are
                // unchanged.
                let ownership_ref = state.ownership.as_ref().expect("claimed above");
                let expected_terminal = freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                    terminal_id: None,
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: freshell_ownership::HoldKind::Main,
                };
                let adopt_fence = match observed {
                    Some(fence) => fence,
                    None => {
                        let pair_snap =
                            ownership_ref.observe(&locator.provider, &locator.session_id);
                        freshell_ownership::ObservedFence {
                            epoch: pair_snap.epoch,
                            generation: pair_snap.generation,
                        }
                    }
                };
                match ownership_ref.begin_adopt_guard(
                    &locator.provider,
                    &locator.session_id,
                    &format!("rest-create-adopt-{create_request_id}"),
                    &expected_terminal,
                    adopt_fence,
                    "rest-terminal-create/adopt",
                ) {
                    freshell_ownership::AttachGuardOutcome::Armed(guard) => {
                        _rest_adopt_guard = Some(*guard);
                    }
                    freshell_ownership::AttachGuardOutcome::Refused { .. } => {
                        tracing::warn!(target: "freshell_freshagent::terminal_tabs",
                            provider = %locator.provider, session_id = %locator.session_id,
                            pane_id = %pane_id,
                            "spawn_refused: the Adopt arm's attach guard refused to arm \
                             (a lifecycle transition owns the key) — the create aborts \
                             typed, nothing spawns"
                        );
                        return Err(crate::fail_json_code(
                            StatusCode::CONFLICT,
                            "SESSION_RESERVED",
                            "A lifecycle operation is in flight for this session; retry after it settles"
                                .to_string(),
                        ));
                    }
                    freshell_ownership::AttachGuardOutcome::StaleGeneration { .. } => {
                        tracing::warn!(target: "freshell_freshagent::terminal_tabs",
                            provider = %locator.provider, session_id = %locator.session_id,
                            pane_id = %pane_id,
                            "spawn_refused: the Adopt arm's attach guard refused to arm \
                             (the observed generation is stale) — the create aborts \
                             typed, nothing spawns"
                        );
                        return Err(crate::fail_json_code(
                            StatusCode::CONFLICT,
                            "SESSION_RESERVED",
                            format!(
                                "Session ownership moved on (stale observed generation); \
                                 refresh and retry. (session {})",
                                locator.session_id
                            ),
                        ));
                    }
                }
            }
            crate::ownership_lane::TerminalLaneClaim::Refused(outcome) => {
                tracing::warn!(
                    target: "freshell_freshagent::terminal_tabs",
                    provider = %locator.provider,
                    session_id = %locator.session_id,
                    pane_id = %pane_id,
                    outcome = ?outcome,
                    "spawn_refused: the ownership coordinator refused the claim \
                     (kata b8ke cross-kind authority, REST rung)"
                );
                let owner_fields = crate::ownership_lane::terminal_owner_fields_from_outcome(
                    &state.ownership,
                    &outcome,
                );
                return Err(match &outcome {
                    freshell_ownership::BeginOutcome::OwnedByOtherKind { .. } => {
                        fail_json_restore_unavailable(
                            &locator.session_id,
                            None,
                            owner_fields.as_ref(),
                        )
                    }
                    freshell_ownership::BeginOutcome::Blocked { retry_after_ms, .. } => {
                        let mut body = json!({
                            "status": "error",
                            "code": "SESSION_RESERVED",
                            "message": "Another lifecycle operation for this sessionRef is in flight".to_string(),
                            "retryAfterMs": retry_after_ms,
                        });
                        if let Some(owner) = owner_fields {
                            body["ownerKind"] = json!(owner.owner_kind);
                            body["ownerGeneration"] = json!(owner.owner_generation);
                        }
                        (StatusCode::CONFLICT, Json(body)).into_response()
                    }
                    freshell_ownership::BeginOutcome::StaleGeneration {
                        current_epoch,
                        current_generation,
                    } => {
                        // b8ke ext r15 F2: the stale-generation refusal
                        // rides the shared typed-code envelope
                        // (`fail_json_code`, the established pattern this
                        // file uses for every typed ownership error) so
                        // REST/MCP callers distinguish stale ownership
                        // from other failures — plus the additive
                        // ownerEpoch/ownerGeneration pair the caller
                        // refreshes its fence from.
                        let mut stale_body = json!({
                            "status": "error",
                            "code": "SESSION_RESERVED",
                            "message": "Session ownership moved on (stale observed generation); refresh and retry.",
                        });
                        stale_body["ownerEpoch"] = json!(current_epoch);
                        stale_body["ownerGeneration"] = json!(current_generation);
                        (StatusCode::CONFLICT, Json(stale_body)).into_response()
                    }
                    _ => unreachable!("the refused arms are exhaustive above"),
                });
            }
        }
    }
    // b8ke ext r20 F1 test seam (WS parity): park the REST create INSIDE
    // its held-authority window (after the claim + the witness arms,
    // before the spawn) — the deterministic-race tests prove the
    // witness-backed slow launch is NOT stale-fenced by the watchdog.
    // No-op in production.
    if let Some(pause) = registry.terminal_create_postclaim_pause_hook() {
        pause(&create_request_id).await;
    }
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
            // kata b8ke Task 4: the coordinator's owner fields ride the same
            // envelope when it knows the owner.
            let owner_fields = state.ownership.as_ref().and_then(|ownership| {
                crate::ownership_lane::terminal_owner_fields_from_snapshot(
                    &ownership.observe(&mode, live_sid),
                )
            });
            return Err(fail_json_restore_unavailable(
                live_sid,
                Some(&owner_terminal_id),
                owner_fields.as_ref(),
            ));
        }

        // kata b8ke Task 10 (REST-door D7 parity, the WS door's Task 13b
        // cross-kind live-guard): a live FRESH-AGENT sidecar owning
        // `(provider, S)` is just as much "the one writer on S's JSONL" as
        // a live PTY -- the fresh create lane deliberately never commits
        // coordinator ownership (the canonical durable id only materializes
        // at `sdk.session.init`; the D7 probe backstop covers the residual),
        // so the coordinator GRANTED this claim on a key it cannot see.
        // Consult the SAME sidecar-liveness probe the WS door's D7 join
        // uses (wired in main.rs over the same has_live_session joins) and
        // refuse with the same typed envelope -- never a second writer. No
        // terminal id exists to name, so `liveTerminalId` stays absent (the
        // WS door's cross-kind arm does the same); the coordinator's owner
        // fields ride along when it happens to know the owner.
        if let Some(probe) = &state.sidecar_liveness {
            if probe(&mode, live_sid).await {
                tracing::warn!(
                    target: "freshell_freshagent::terminal_tabs",
                    mode = %mode,
                    session_id = %live_sid,
                    pane_id = %pane_id,
                    "spawn_refused: a live fresh-agent sidecar already owns this session \
                     (D7 cross-kind live-guard, REST rung)"
                );
                let owner_fields = state.ownership.as_ref().and_then(|ownership| {
                    crate::ownership_lane::terminal_owner_fields_from_snapshot(
                        &ownership.observe(&mode, live_sid),
                    )
                });
                return Err(fail_json_restore_unavailable(
                    live_sid,
                    None,
                    owner_fields.as_ref(),
                ));
            }
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
                let owner_fields = state.ownership.as_ref().and_then(|ownership| {
                    crate::ownership_lane::terminal_owner_fields_from_snapshot(
                        &ownership.observe(&mode, live_sid),
                    )
                });
                return Err(fail_json_restore_unavailable(
                    live_sid,
                    Some(&terminal_id),
                    owner_fields.as_ref(),
                ));
            }
            SessionRefClaim::Held { .. } | SessionRefClaim::ExpiredNeedsKill { .. } => {
                tracing::warn!(
                    target: "freshell_freshagent::terminal_tabs",
                    mode = %mode,
                    session_id = %live_sid,
                    pane_id = %pane_id,
                    "spawn_refused: sessionRef lease unavailable (D8, REST rung)"
                );
                let owner_fields = state.ownership.as_ref().and_then(|ownership| {
                    crate::ownership_lane::terminal_owner_fields_from_snapshot(
                        &ownership.observe(&mode, live_sid),
                    )
                });
                return Err(fail_json_restore_unavailable(
                    live_sid,
                    None,
                    owner_fields.as_ref(),
                ));
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
    // b8ke ext r27 F2: the handoff token's SUPPLIED (epoch, generation)
    // pair — the settle's identity registration stamps the terminal
    // target's durable row with it (the delayed-write fence baseline).
    let handoff_observed = handoff.map(|token| {
        (
            state
                .ownership
                .as_ref()
                .map(|registry| registry.boot_epoch())
                .unwrap_or_default(),
            token.generation,
        )
    });
    let inputs = GatedSettleInputs {
        state: state.clone(),
        body: body.clone(),
        tab_id: tab_id.to_string(),
        pane_id: pane_id.to_string(),
        mode,
        shell_str,
        cwd,
        resume_session_id,
        launch_intent,
        accepted_session_ref,
        claude_fresh_prealloc,
        pane_identity: state.pane_identity.clone(),
        create_request_id,
        session_ref_lease,
        ownership_claim,
        claim_locator: learned_claim_locator,
        under_handoff_ticket,
        handoff_spawn_watch,
        handoff_observed,
        registry,
        use_managed_runtime,
        host_os,
        is_wsl,
        amplifier_stub,
        ownership_start_terminal_id,
        adopt_attach_window_op: _rest_adopt_guard
            .as_ref()
            .map(|guard| guard.operation_id().to_string()),
        start_cancellation: _rest_start_cancellation.take(),
    };
    let settle = {
        // Round-3 review I-1: the settle marks settlement (success or
        // failure) on the handoff's spawn watch, waking an aborted runner's
        // Drop cleanup — its only signal that the detached settle is done
        // and the publication (if any) is final.
        let settle_watch = inputs.handoff_spawn_watch.clone();
        tokio::spawn(async move {
            let result = settle_gated_create(inputs).await;
            if let Some(watch) = settle_watch.as_ref() {
                watch.settle_finished();
            }
            result
        })
    };
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
    /// kata b8ke Task 4: the coordinator claim (RAII — drop = typed fail);
    /// committed at the winner-bind site, or surfaced to the handoff runner
    /// when `under_handoff_ticket` is set (single commit authority).
    ownership_claim: Option<RestOwnershipClaim>,
    /// kata b8ke Task 4 review M1 (fix): the locator the DOOR would claim
    /// under (its `guard_locator`) — the settle's late-claim source when
    /// `ownership_claim` is None (the Adopt arm claims nothing; the live
    /// same-kind owner it saw died after the claim, so the create spawned
    /// anyway and the settle must claim for the surviving terminal).
    claim_locator: Option<SessionLocator>,
    under_handoff_ticket: bool,
    /// Round-3 review I-1: the handoff's guard-visible spawn watch — the
    /// settle publishes the spawned terminal id into it (and parks on its
    /// test seam) at the under-ticket surface point.
    handoff_spawn_watch: Option<HandoffSpawnWatch>,
    /// b8ke ext r27 F2: the handoff token's SUPPLIED (epoch, generation)
    /// pair — the settle's identity registration stamps the terminal
    /// target's durable row with it (the delayed-write fence baseline), so
    /// the target row carries the handoff's generation. `None` for every
    /// non-handoff caller (legacy-unfenced).
    handoff_observed: Option<(u64, u64)>,
    registry: freshell_terminal::TerminalRegistry,
    /// Frozen at the REST door so the pre-spawn witness and settled row agree.
    use_managed_runtime: bool,
    /// Hoisted spawn-environment inputs (Task 11): computed ONCE in
    /// [`spawn_terminal_pane`] so the amplifier windows-arm guard there and
    /// the spawn-spec construction here can never disagree.
    host_os: HostOs,
    is_wsl: bool,
    /// b8ke ext r20 F1: the DOOR claim's pre-minted terminal id — the
    /// identity the witness's cancel closure kills, and the id the spawn
    /// uses (`None` for the claim-less paths: the spawn mints as before).
    ownership_start_terminal_id: Option<String>,
    /// Launcher-assigned amplifier identity: the stub [`spawn_terminal_pane`]
    /// pre-created for this create (Task 11) — consumed here for the
    /// spawn-failure GC and the exit hook's never-used-stub GC.
    amplifier_stub: Option<freshell_sessions::amplifier_stub::EnsuredSession>,
    /// b8ke ext r32 F1: the Adopt arm's attach-guard op id — `Some`
    /// while the handler still holds the window (the guard's Drop at
    /// handler scope end), so the settle's LATE claim (the holder's own
    /// acquire over the death-vacated key) can name it and the
    /// coordinator's deferred-acquisition block exempts THIS create
    /// (continuous authority) while competitors answer Blocked.
    adopt_attach_window_op: Option<String>,
    /// b8ke ext r20 F1: the claim's settlement witness, held by the settle
    /// to its end (its Drop fires the settle the watchdog awaits); a
    /// given-up unit start drops it only at its unit's Gone.
    start_cancellation: Option<crate::ownership_lane::StartCancellationGuard>,
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
        accepted_session_ref,
        claude_fresh_prealloc,
        pane_identity,
        create_request_id,
        mut session_ref_lease,
        mut ownership_claim,
        claim_locator,
        under_handoff_ticket,
        handoff_spawn_watch,
        handoff_observed,
        registry,
        use_managed_runtime,
        host_os,
        is_wsl,
        amplifier_stub,
        ownership_start_terminal_id,
        adopt_attach_window_op,
        mut start_cancellation,
    } = inputs;

    // b8ke ext r20 F1: the DOOR claim pre-minted the terminal id when it
    // armed its settlement witness (the cancel-slot identity) — use it so
    // the witness's cancellation kills THIS row. Managed rows use the stable
    // create-request identity both here and at claim time; claim-less local
    // rows retain their fresh UUID behavior.
    let terminal_id = ownership_start_terminal_id
        .unwrap_or_else(|| mint_terminal_id(&create_request_id, use_managed_runtime));
    let stream_id = if use_managed_runtime {
        stable_managed_uuid(&create_request_id, b"stream").to_string()
    } else {
        Uuid::new_v4().to_string()
    };

    let mut cli: Option<CliLaunch> = None;
    let mut mcp_cwd: Option<String> = None;
    // DEV-0006 S4 inc.2: the flag-gated managed codex launch (None for every other
    // mode, and for codex with the flag OFF). Planned inside the non-shell branch;
    // consumed at create-failure (discard) and post-create (adopt) below.
    let mut codex_launch: Option<freshell_codex::launch_lifecycle::CodexTerminalLaunch> = None;
    // The managed Codex pane's start in its unit (None for every other mode,
    // and when no single stop path is installed).
    let mut rest_unit: Option<RestUnitStart> = None;
    let spec: SpawnSpec;
    let child_env: BTreeMap<String, String>;
    // Explicit REST overrides are also copied into ManagedTerminalLaunch so
    // the durable resume spec can preserve provider policy independently of
    // the rendered argv.
    let permission_mode = body
        .get("permissionMode")
        .and_then(Value::as_str)
        .map(str::to_string);
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let effort = body
        .get("effort")
        .and_then(Value::as_str)
        .map(str::to_string);
    let sandbox = body
        .get("sandbox")
        .and_then(Value::as_str)
        .map(str::to_string);

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
        let managed_flag =
            std::env::var(freshell_codex::launch_plan::FRESHELL_CODEX_MANAGED_LAUNCH_ENV).ok();
        let codex_setup = if !use_managed_runtime
            && codex_create_uses_managed_launch(&mode, managed_flag.as_deref())
        {
            Some(
                build_codex_managed_launch_setup(
                    terminal_id.clone(),
                    shell_type,
                    host_os,
                    is_wsl,
                    cwd.as_deref(),
                    Some(&tab_id),
                    Some(&pane_id),
                )
                .map_err(|message| fail_json(StatusCode::BAD_REQUEST, message))?,
            )
        } else {
            None
        };

        // opencode: allocate the loopback control endpoint BEFORE building the
        // launch (mirrors `crates/freshell-ws/src/terminal.rs:802-813`).
        let opencode_endpoint = if mode == "opencode" && use_managed_runtime {
            Some(freshell_opencode::serve::Endpoint {
                hostname: "127.0.0.1".to_string(),
                port: 4096,
            })
        } else if mode == "opencode" {
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
        codex_launch = if let Some(setup) = codex_setup.as_ref() {
            // The pane's unit: its record is written before anything spawns;
            // each start attempt runs in its own unit (the seed).
            rest_unit = RestUnitStart::begin(
                &state,
                &mode,
                &create_request_id,
                &terminal_id,
                resume_session_id.as_deref(),
            )
            .map_err(|error| {
                fail_json(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("codex unit could not be recorded: {error}"),
                )
            })?;
            let input = freshell_codex::launch_plan::CodexLaunchPlanInput {
                cwd: setup.runtime_cwd.as_deref(),
                resume_session_id: resume_session_id.as_deref(),
                model: model.as_deref(),
                sandbox: sandbox.as_deref(),
                approval_policy: permission_mode.as_deref(),
                sidecar_context: setup.sidecar_context.clone(),
                unit_seed: rest_unit.as_ref().map(RestUnitStart::seed),
            };
            match freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                .plan_create_with_retry_uncancellable(
                    &input,
                    freshell_codex::launch_plan::CODEX_INITIAL_LAUNCH_ATTEMPTS,
                    freshell_codex::launch_lifecycle::LaunchClass::Interactive,
                )
                .await
            {
                Ok(launch) => {
                    if let Some(start) = rest_unit.as_ref() {
                        start.lifecycle.finish_planning(launch.unit.clone());
                    }
                    // A kill that cancelled the start while it planned wins.
                    if rest_unit.as_ref().is_some_and(RestUnitStart::cancelled) {
                        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                            .discard_sync(launch);
                        if let Some(start) = rest_unit.take() {
                            start.give_up(
                                "rest-start-cancelled",
                                Some(take_rest_claims(
                                    &mut ownership_claim,
                                    &mut session_ref_lease,
                                    &mut start_cancellation,
                                )),
                            );
                        }
                        return Err(codex_launch_error_response(
                            freshell_codex::launch_lifecycle::CodexLaunchError::Cancelled,
                        ));
                    }
                    Some(launch)
                }
                Err(error) => {
                    if let Some(start) = rest_unit.take() {
                        start.give_up(
                            "rest-start-plan-failed",
                            Some(take_rest_claims(
                                &mut ownership_claim,
                                &mut session_ref_lease,
                                &mut start_cancellation,
                            )),
                        );
                    }
                    return Err(codex_launch_error_response(error));
                }
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

        // The managed setup already rendered the TUI injection and built the
        // terminal environment for this exact id/tab/pane. Non-managed paths
        // retain the existing generic MCP/environment work.
        let (mcp_injection, overrides) = match codex_setup {
            Some(setup) => {
                if setup.terminal_id.as_str() != terminal_id.as_str() {
                    if let Some(launch) = codex_launch.take() {
                        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                            .discard_sync(launch);
                    }
                    if let Some(start) = rest_unit.take() {
                        start.give_up(
                            "rest-start-setup-mismatch",
                            Some(take_rest_claims(
                                &mut ownership_claim,
                                &mut session_ref_lease,
                                &mut start_cancellation,
                            )),
                        );
                    }
                    return Err(fail_json(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "managed Codex terminal setup did not match its spawn id".to_string(),
                    ));
                }
                let CodexManagedLaunchSetup {
                    terminal_id: _,
                    runtime_cwd,
                    tui_mcp_injection,
                    terminal_env,
                    sidecar_context: _,
                } = setup;
                mcp_cwd = runtime_cwd;
                (tui_mcp_injection, terminal_env)
            }
            None => {
                mcp_cwd = resolve_mcp_cwd(cwd.as_deref(), &RealEnv, host_os, is_wsl);
                let mcp_injection = if use_managed_runtime {
                    McpInjection::default()
                } else {
                    match generate_mcp_injection(
                        &RealMcpRuntime,
                        &mode,
                        &terminal_id,
                        mcp_cwd.as_deref(),
                        target,
                    ) {
                        Ok(injection) => injection,
                        Err(error) => {
                            return Err(fail_json(StatusCode::BAD_REQUEST, error.message))
                        }
                    }
                };
                let overrides =
                    build_terminal_base_env(&RealEnv, &terminal_id, Some(&tab_id), Some(&pane_id));
                (mcp_injection, overrides)
            }
        };

        // Freshell opencode TUI rebind plugin: the install (fs I/O) happens
        // HERE at the IO layer; the pure resolver only reads the result from
        // CliLaunchInputs (mcp_injection precedent). Failure must never block
        // the launch.
        let opencode_rebind_tui_config = if mode == "opencode" && !use_managed_runtime {
            let selected = state
                .cli_commands
                .iter()
                .find(|spec| spec.name == "opencode")
                .and_then(|spec| spec.base_env.get("OPENCODE_TUI_CONFIG").cloned())
                .or_else(|| std::env::var("OPENCODE_TUI_CONFIG").ok());
            opencode_rebind_precompute(selected.as_deref(), cwd.as_deref())
                .map_err(|error| fail_json(StatusCode::BAD_REQUEST, error))?
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
            // The legacy web-owned Codex sidecar consumes these through its
            // launch plan. Reasoning effort remains the exact CLI config argv.
            // A Durable Soul's host-owned sidecar also receives the typed
            // fields, so model and reasoning policy survive recovery.
            permission_mode: (!managed_codex)
                .then_some(())
                .and(permission_mode.as_deref()),
            model: (!managed_codex).then_some(()).and(model.as_deref()),
            effort: effort.as_deref(),
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
            Err(e) => {
                // A planned Codex launch dies with the failed create; its
                // unit's start is given up (the claims go at its Gone).
                if let Some(launch) = codex_launch.take() {
                    freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                        .discard_sync(launch);
                }
                if let Some(start) = rest_unit.take() {
                    start.give_up(
                        "rest-start-launch-unresolved",
                        Some(take_rest_claims(
                            &mut ownership_claim,
                            &mut session_ref_lease,
                            &mut start_cancellation,
                        )),
                    );
                }
                return Err(fail_json(StatusCode::BAD_REQUEST, e.message()));
            }
        };

        let effective_shell = resolve_shell(shell_type, host_os, is_wsl);
        let windows_like = is_windows(host_os) || (is_wsl && effective_shell != ShellType::System);

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
        // A unit row's hook is its Gone hook (Stage 2: LB-33): the registry
        // runs it once at Gone, after the unit lifecycle published the exit
        // and finished the Codex launch, so it only tears down.
        let unit_row = rest_unit.is_some();
        Some(Box::new(move |exit_code: i64| {
            cleanup_mcp_config(&RealMcpRuntime, &tid, &cleanup_mode, cleanup_cwd.as_deref());
            if !unit_row {
                registry_for_exit.finish_pty_exit(&tid, exit_code);
                // DEV-0006 S4: tear down this pane's managed codex sidecar + remote proxy
                // (no-op for terminals without a managed launch). Sync-safe: hands the
                // handle to the manager's async teardown worker. Same call as the WS
                // path's on_exit (`crates/freshell-ws/src/terminal.rs`).
                freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                    .notify_terminal_exit(&tid);
            }
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
                    let manager =
                        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global();
                    match rest_unit.take() {
                        Some(start) => {
                            manager.discard_sync(launch);
                            start.give_up(
                                "rest-start-gate-refused",
                                Some(take_rest_claims(
                                    &mut ownership_claim,
                                    &mut session_ref_lease,
                                    &mut start_cancellation,
                                )),
                            );
                        }
                        None => manager.discard(launch).await,
                    }
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
    let mut killed_managed_start: Option<(
        freshell_containment::ManagedStartGuard,
        freshell_containment::ManagedStartOutcome,
    )> = None;
    let create_result = if use_managed_runtime {
        let managed = ManagedTerminalLaunch {
            spec: spec.clone(),
            env: child_env.clone(),
            terminal_id: terminal_id.clone(),
            stream_id: stream_id.clone(),
            mode: mode.clone(),
            resume_session_id: resume_session_id.clone(),
            provider_model: model.clone(),
            provider_reasoning_effort: effort.clone(),
            provider_sandbox: sandbox.clone(),
            provider_permission_mode: permission_mode.clone(),
            view_tab_id: Some(tab_id.clone()),
            view_pane_id: Some(pane_id.clone()),
            create_request_id: Some(create_request_id.clone()),
        };
        // As the WebSocket create: the launch is in flight under the pane's
        // create-request id until it is registered or stopped, so a kill of
        // the starting pane waits for it; a pane killed before or while it
        // launched is stopped (never registered) and answered as stopped,
        // and its outcome reaches the waiting kill once that answer is
        // decided (Stage 2: LB-13).
        let start = state.units.managed_starts().begin(&create_request_id);
        if state.units.killed_start(&create_request_id) {
            killed_managed_start = Some((
                start,
                freshell_containment::ManagedStartOutcome::StoppedVerified,
            ));
            Err(pane_stopped_error())
        } else {
            match registry.launch_managed(managed).await {
                Ok(descriptor) if state.units.killed_start(&create_request_id) => {
                    let stopped = registry.managed_stop_descriptor(descriptor).await;
                    tracing::info!(
                        target: "freshell_freshagent::terminal_tabs",
                        terminal_id = %terminal_id,
                        mode = %mode,
                        stopped = stopped.is_ok(),
                        event = "terminal.create.managed_killed_while_launching",
                        "a managed pane killed while it launched is stopped, not registered"
                    );
                    killed_managed_start = Some((
                        start,
                        match stopped {
                            Ok(()) => freshell_containment::ManagedStartOutcome::StoppedVerified,
                            Err(error) => {
                                freshell_containment::ManagedStartOutcome::StopFailed(error)
                            }
                        },
                    ));
                    Err(pane_stopped_error())
                }
                Ok(descriptor) => {
                    registry.register_managed(descriptor);
                    start.finish(freshell_containment::ManagedStartOutcome::Registered);
                    Ok(None)
                }
                Err(error) => {
                    start.finish(freshell_containment::ManagedStartOutcome::StopFailed(
                        format!("managed runtime launch failed: {error}"),
                    ));
                    Err(std::io::Error::other(format!(
                        "managed runtime launch failed: {error}"
                    )))
                }
            }
        }
    } else {
        // A Codex pane's TUI starts in the pane's unit (its screen); a unit
        // already stopping refuses the placement (the start was cancelled).
        let unit_placement = match rest_unit.as_ref() {
            Some(start) => {
                let unit = start.unit();
                match unit.placement(freshell_containment::MemberRole::Screen) {
                    Ok(placement) => Some(freshell_terminal::UnitPlacement {
                        unit_id: unit.id().to_string(),
                        wrapper: placement.wrapper,
                        env: placement.env,
                        main_is_screen: false,
                    }),
                    Err(_) => {
                        if let Some(launch) = codex_launch.take() {
                            freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                                .discard_sync(launch);
                        }
                        if let Some(start) = rest_unit.take() {
                            start.give_up(
                                "rest-start-cancelled",
                                Some(take_rest_claims(
                                    &mut ownership_claim,
                                    &mut session_ref_lease,
                                    &mut start_cancellation,
                                )),
                            );
                        }
                        cleanup_mcp_config(
                            &RealMcpRuntime,
                            &terminal_id,
                            &mode,
                            mcp_cwd.as_deref(),
                        );
                        return Err(codex_launch_error_response(
                            freshell_codex::launch_lifecycle::CodexLaunchError::Cancelled,
                        ));
                    }
                }
            }
            None => None,
        };
        let spawn_registry = registry.clone();
        let spawn_spec = spec.clone();
        let spawn_terminal_id = terminal_id.clone();
        let spawn_mode = mode.clone();
        let spawn_resume = resume_session_id.clone();
        let spawn_request_id = create_request_id.clone();
        match tokio::task::spawn_blocking(move || match unit_placement {
            Some(placement) => spawn_registry
                .create_in_unit(
                    &spawn_spec,
                    &child_env,
                    spawn_terminal_id,
                    stream_id,
                    &spawn_mode,
                    spawn_resume.as_deref(),
                    Some(spawn_request_id.as_str()),
                    None,
                    on_exit,
                    placement,
                )
                .map(Some),
            None => spawn_registry
                .create(
                    &spawn_spec,
                    &child_env,
                    spawn_terminal_id,
                    stream_id,
                    &spawn_mode,
                    spawn_resume.as_deref(),
                    Some(spawn_request_id.as_str()),
                    None,
                    on_exit,
                )
                .map(|()| None),
        })
        .await
        {
            Ok(result) => result,
            Err(join_err) => Err(std::io::Error::other(format!(
                "terminal spawn task panicked: {join_err}"
            ))),
        }
    };
    let unit_screen_pid = match &create_result {
        Ok(screen_pid) => *screen_pid,
        Err(_) => None,
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
        // A pane in its unit is given up instead (its unit's stop ends the
        // sidecar; nothing waits here).
        if let Some(launch) = codex_launch {
            let manager = freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global();
            match rest_unit.take() {
                Some(start) => {
                    manager.discard_sync(launch);
                    start.give_up(
                        "rest-start-spawn-failed",
                        Some(take_rest_claims(
                            &mut ownership_claim,
                            &mut session_ref_lease,
                            &mut start_cancellation,
                        )),
                    );
                }
                None => manager.discard(launch).await,
            }
        }
        // A managed pane killed while it started is answered as stopped;
        // only then is the kill that waited for it told how it ended.
        if is_pane_stopped_error(&err) {
            let answer = pane_stopped_response();
            if let Some((start, outcome)) = killed_managed_start.take() {
                start.finish(outcome);
            }
            return Err(answer);
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
    // The TUI is the unit's screen: pin it and note the terminal, so every
    // stop from now on ends this row. A start a stop cancelled meanwhile is
    // given up; otherwise the unit is bound and its placement settlement
    // begins (the start settles once the screen is confirmed placed).
    let mut rest_unit_bound: Option<RestUnitStart> = None;
    if let (Some(mut start), Some(screen_pid)) = (rest_unit.take(), unit_screen_pid) {
        if !start.spawned(&registry, &terminal_id, screen_pid) {
            // A stop cancelled the start, or reached Gone before it knew
            // this row: the give-up ends the row and the unit (and the
            // claims go at its Gone).
            if let Some(launch) = codex_launch.take() {
                freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                    .discard_sync(launch);
            }
            start.give_up(
                "rest-start-cancelled",
                Some(take_rest_claims(
                    &mut ownership_claim,
                    &mut session_ref_lease,
                    &mut start_cancellation,
                )),
            );
            return Err(codex_launch_error_response(
                freshell_codex::launch_lifecycle::CodexLaunchError::Cancelled,
            ));
        }
        start.bind(&terminal_id, screen_pid);
        if let Some(claim) = ownership_claim.as_ref() {
            stamp_claim_with_unit(&state, &registry, &start, claim, &terminal_id);
        }
        // Kept for the failure arms below (they stop the unit).
        rest_unit_bound = Some(start);
    }
    if let Some(launch) = codex_launch.take() {
        if let Err(message) = freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
            .adopt(&terminal_id, launch, 0)
            .await
        {
            match rest_unit_bound.take() {
                Some(start) => start.give_up(
                    "rest-adopt-failed",
                    Some(take_rest_claims(
                        &mut ownership_claim,
                        &mut session_ref_lease,
                        &mut start_cancellation,
                    )),
                ),
                None => {
                    registry.kill(&terminal_id);
                }
            }
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
        // b8ke ext r27 F2: the spawning lifecycle operation's observed
        // (epoch, generation) pair rides the registration — a handoff
        // runner's terminal target stamps its durable row with the
        // SUPPLIED handoff pair (the delayed-write fence baseline), so
        // the target row carries the handoff's generation instead of
        // preserving the prior one; every other caller stays
        // legacy-unfenced (None).
        let observed = handoff_observed;
        let registration = tokio::task::spawn_blocking(move || {
            binder.register_create_identity(
                &tid,
                &m,
                sid.as_deref(),
                c.as_deref(),
                Some(&rid),
                observed,
            )
        })
        .await
        .unwrap_or_else(|join_err| {
            // JoinError means the closure panicked
            tracing::warn!(target: "freshell_freshagent::invariants", error = %join_err, "create-identity binder task panicked");
            Ok(())
        });
        if let Err(reg_err) = registration {
            if under_handoff_ticket {
                // b8ke ext r27 F3: the handoff runner's terminal target
                // holds NO typed channel of its own here — the spawn
                // answers the TYPED failure so the runner lands the typed
                // recoverable handoff state (guard fail → the key settles,
                // never a successful owner + Live commit with no
                // recoverable registration). The just-spawned terminal is
                // killed and confirmed first — never a live unowned writer.
                tracing::error!(target: "freshell_freshagent::invariants",
                    terminal_id = %terminal_id, error = %reg_err,
                    "handoff_target_registration_failed: the terminal target's                      durable identity registration failed — the spawned terminal                      is reaped and the handoff fails typed (kata b8ke ext r27 F3)"
                );
                if let Some(start) = rest_unit_bound.take() {
                    start.give_up(
                        "rest-handoff-registration-failed",
                        Some(take_rest_claims(
                            &mut ownership_claim,
                            &mut session_ref_lease,
                            &mut start_cancellation,
                        )),
                    );
                } else {
                    let pid = registry.pid_of(&terminal_id);
                    registry.kill(&terminal_id);
                    let confirmed = match pid {
                        Some(pid) => confirm_pid_dead_within_500ms(pid).await,
                        // No pid handle to probe: the registry kill removed the
                        // row; nothing is left to signal, so treat as confirmed.
                        None => true,
                    };
                    if !confirmed {
                        tracing::error!(target: "invariant",
                            terminal_id = %terminal_id,
                            "handoff_target_registration_failure_kill_unconfirmed: the                          spawned terminal did not confirm dead within budget"
                        );
                    }
                }
                return Err(fail_json_code(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "TARGET_BINDING_FAILED",
                    format!(
                        "the terminal target's durable recovery registration failed; \
                         the spawned terminal was reaped: {reg_err}"
                    ),
                ));
            }
            // The REST create rung keeps its documented degradation policy
            // (a create is never blocked by durability degradation); the
            // handoff arm above is the one caller with a typed channel
            // (through the runner's recoverable failure).
            tracing::warn!(target: "freshell_freshagent::invariants",
                terminal_id = %terminal_id, error = %reg_err,
                "create_identity_registration_failed (REST rung; create proceeds, durability degraded)"
            );
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
        use_managed_runtime || managed_codex,
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
            // never leave an orphan running. A pane in its unit is stopped
            // through the unit; the lease is released at its Gone.
            let confirmed = match rest_unit_bound.take() {
                Some(start) => {
                    start.give_up(
                        "rest-lease-revoked",
                        Some(Box::new((
                            take_rest_claims(
                                &mut ownership_claim,
                                &mut session_ref_lease,
                                &mut start_cancellation,
                            ),
                            ReleaseLeaseAfterGone {
                                registry: registry.clone(),
                                locator: locator.clone(),
                                holder_create_request_id: create_request_id.clone(),
                            },
                        ))),
                    );
                    true
                }
                None => {
                    let pid = registry.pid_of(&terminal_id);
                    registry.kill(&terminal_id);
                    let confirmed = match pid {
                        Some(pid) => confirm_pid_dead_within_500ms(pid).await,
                        // No pid handle to probe: the registry kill removed the
                        // row; nothing is left to signal, so treat as confirmed.
                        None => true,
                    };
                    if confirmed {
                        registry.force_release_after_confirmed_kill(&locator);
                    }
                    confirmed
                }
            };
            if !confirmed {
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

    // kata b8ke Task 4 review M1 (fix): TOTAL coverage — a create that
    // reaches this settle with NO claim (the Adopt arm claims nothing; the
    // live same-kind owner it saw died after the claim but before the D7/
    // lease gates, so this create spawned anyway) claims HERE for the
    // surviving terminal — the same fence discipline as the WS settle: a
    // LATER owner that legitimately claimed while the key was Vacant
    // answers Adopt/OwnedByOtherKind/Blocked instead of Granted, and the
    // just-spawned terminal is torn down per the stale-teardown path (never
    // double-committed, never clobbering the later owner). Skipped under a
    // handoff ticket (single commit authority — the runner performs the one
    // commit_live).
    if ownership_claim.is_none() && !under_handoff_ticket {
        if let Some(locator) = claim_locator.clone() {
            let operation_id = format!("rest-create-late-{create_request_id}");
            // b8ke ext r32 F1: the holder's OWN late claim — when the
            // Adopt arm's attach guard is still held (the incumbent
            // exited mid-window — the exit-during-guard race), the
            // windowed claim names the armed guard's id so the
            // coordinator's deferred-acquisition block exempts THIS
            // create (continuous authority) while every competitor
            // answers the typed Blocked outcome.
            // b8ke ext r32 F1: the holder's OWN late claim — when the
            // Adopt arm's attach guard is still held (the incumbent
            // exited mid-window — the exit-during-guard race), the
            // windowed claim names the armed guard's id so the
            // coordinator's deferred-acquisition block exempts THIS
            // create (continuous authority) while every competitor
            // answers the typed Blocked outcome.
            let claim = match adopt_attach_window_op.as_deref() {
                None => crate::ownership_lane::begin_terminal_lane_claim(
                    &state.ownership,
                    &locator.provider,
                    &locator.session_id,
                    &operation_id,
                    // No observed fence: the create holds no prior observation
                    // to fence against (the Adopt arm claimed nothing).
                    None,
                    "rest",
                    now_ms().max(0) as u64,
                ),
                Some(window_op) => {
                    crate::ownership_lane::begin_terminal_lane_claim_under_attach_window(
                        &state.ownership,
                        &locator.provider,
                        &locator.session_id,
                        &operation_id,
                        None,
                        "rest",
                        now_ms().max(0) as u64,
                        window_op,
                    )
                }
            };
            let refusal = match claim {
                crate::ownership_lane::TerminalLaneClaim::Granted(ticket) => {
                    let claim = RestOwnershipClaim {
                        ticket,
                        locator: locator.clone(),
                    };
                    if let Some(start) = rest_unit_bound.as_ref() {
                        stamp_claim_with_unit(&state, &registry, start, &claim, &terminal_id);
                    }
                    ownership_claim = Some(claim);
                    None
                }
                crate::ownership_lane::TerminalLaneClaim::Unwired => None,
                crate::ownership_lane::TerminalLaneClaim::Adopt => {
                    Some("a live terminal owner holds the key the create settled under".to_string())
                }
                crate::ownership_lane::TerminalLaneClaim::Refused(outcome) => Some(format!(
                    "the coordinator refused the late claim: {outcome:?}"
                )),
            };
            if let Some(reason) = refusal {
                tracing::error!(target: "invariant",
                    terminal_id = %terminal_id,
                    provider = %locator.provider,
                    session_id = %locator.session_id,
                    reason = %reason,
                    "session_ref_ownership_late_claim_refused: the create spawned with no \
                     coordinator claim and the key moved on; killing the unclaimed child \
                     (REST rung)"
                );
                match rest_unit_bound.take() {
                    Some(start) => start.give_up(
                        "rest-ownership-lost",
                        Some(Box::new((
                            take_rest_claims(
                                &mut ownership_claim,
                                &mut session_ref_lease,
                                &mut start_cancellation,
                            ),
                            ReleaseLeaseAfterGone {
                                registry: registry.clone(),
                                locator: locator.clone(),
                                holder_create_request_id: create_request_id.clone(),
                            },
                        ))),
                    ),
                    None => teardown_unowned_spawn(&registry, &locator, &terminal_id).await,
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
    }

    // A start a stop cancelled since its bind is given up before its claim
    // could commit Live for a stopping unit (as the WS create is): the claims
    // go at the unit's Gone.
    if rest_unit_bound
        .as_ref()
        .is_some_and(RestUnitStart::cancelled)
    {
        let start = rest_unit_bound.take().expect("the start is bound");
        let claims = take_rest_claims(
            &mut ownership_claim,
            &mut session_ref_lease,
            &mut start_cancellation,
        );
        start.give_up(
            "rest-start-cancelled",
            Some(match claim_locator.clone() {
                Some(locator) => Box::new((
                    claims,
                    ReleaseLeaseAfterGone {
                        registry: registry.clone(),
                        locator,
                        holder_create_request_id: create_request_id.clone(),
                    },
                )),
                None => claims,
            }),
        );
        return Err(codex_launch_error_response(
            freshell_codex::launch_lifecycle::CodexLaunchError::Cancelled,
        ));
    }

    // kata b8ke Task 4: the REST rung's coordinator winner commit — right
    // after the registry winner-bind. UNDER-TICKET (a handoff runner's
    // spawn): skip the commit (single commit authority — the runner performs
    // the one `commit_live`) and surface the terminal's OwnerIdentity in the
    // result instead. A stale/foreign commit tears our own child down
    // exactly like the revoked-lease arm above.
    let mut surfaced_owner_identity: Option<freshell_ownership::OwnerIdentity> = None;
    if let Some(claim) = ownership_claim.take() {
        if under_handoff_ticket {
            let mut ticket = claim.ticket;
            ticket.disarm();
            // Round-3 review I-1 (cancellation-safety, target-spawn
            // window): publish the spawned terminal into the handoff's
            // guard-visible watch the moment it exists-and-is-kept — an
            // aborted runner's Drop cleanup waits for this settle to
            // finish and reaps the published id, so the uncommitted
            // terminal never survives as a live unowned writer. (Every
            // earlier failure path tore its own child down, so this is
            // the single publication point.)
            if let Some(watch) = handoff_spawn_watch.as_ref() {
                // b8ke ext r10 F3: the PRE-PUBLICATION park runs before the
                // terminal id lands in the watch — the exact window the
                // reviewer flagged (an abort here leaves the cleanup's
                // settle-wait unsettled; the fail-closed path fences).
                watch.pause_if_armed_before_publish().await;
                // b8ke ext r13 F7: capture the PID at publication (while
                // the row exists) — the cleanup's confirmed-reap evidence.
                watch.publish(&terminal_id, registry.pid_of(&terminal_id));
                watch.pause_if_armed().await;
            }
            surfaced_owner_identity = Some(freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                terminal_id: Some(terminal_id.clone()),
                live_session_key: None,
                pid: registry.pid_of(&terminal_id),
                ownership_id: None,
                unit_id: None,
                hold: freshell_ownership::HoldKind::Main,
            });
        } else {
            let claim_locator = claim.locator.clone();
            // b8ke fence-heal (plan Task 3), r32 F2: capture the claim
            // ticket's OWN pair BEFORE the consuming commit — the broadcast
            // below carries THIS pair, never a re-observed current
            // generation.
            let owner_operation_id = claim.ticket.operation_id().to_string();
            let owner_generation = claim.ticket.generation();
            match claim.commit(&registry, &terminal_id) {
                Ok(()) => {
                    tracing::info!(
                        target: "freshell_freshagent::terminal_tabs",
                        terminal_id = %terminal_id,
                        "session_ref.ownership_committed (REST rung)"
                    );
                    // b8ke fence-heal (plan Task 3): the REST rung's
                    // commit-to-Live broadcasts its own committed pair
                    // (r29 F1 invariant / r32 F2 pair) through
                    // rest_terminal_owner_frame — the pure in-crate
                    // mirror of broadcast_owner_frame's terminal-Live
                    // shape (this crate cannot call the freshell-ws
                    // helper; delta round-4 F3 + focused review 2 weld
                    // the registry into the seam so the supplied-pair
                    // contract is pinned against a re-observing
                    // implementation by its own discriminator test).
                    // `owner_operation_id`/`owner_generation` are the
                    // claim ticket's OWN pair, captured above BEFORE the
                    // consuming commit — never a re-observed current
                    // generation. The claim mint implies the coordinator
                    // is wired.
                    if let Some(frame) = rest_terminal_owner_frame(
                        state.ownership.as_ref().expect("coordinator wired"),
                        &claim_locator,
                        &terminal_id,
                        &owner_operation_id,
                        owner_generation,
                    ) {
                        let _ = state.broadcast_tx.send(frame);
                    }
                }
                Err(outcome) => {
                    tracing::error!(target: "invariant",
                        terminal_id = %terminal_id,
                        outcome = ?outcome,
                        "session_ref_ownership_commit_stale: the coordinator moved on while \
                         the REST create spawned; killing the unowned child"
                    );
                    let locator = claim_locator;
                    match rest_unit_bound.take() {
                        Some(start) => start.give_up(
                            "rest-ownership-lost",
                            Some(Box::new((
                                take_rest_claims(
                                    &mut ownership_claim,
                                    &mut session_ref_lease,
                                    &mut start_cancellation,
                                ),
                                ReleaseLeaseAfterGone {
                                    registry: registry.clone(),
                                    locator: locator.clone(),
                                    holder_create_request_id: create_request_id.clone(),
                                },
                            ))),
                        ),
                        None => teardown_unowned_spawn(&registry, &locator, &terminal_id).await,
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
        }
    }

    // The create succeeded: the placement settlement settles its start.
    if let Some(start) = rest_unit_bound.take() {
        start.commit();
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
    // Door 3 (resume-validation) note: the gate-fired stale-resume arm
    // REFUSES upstream (b8ke ext r16 F3 — the typed SESSION_MISSING
    // refusal, never an automatic substitution), so no stale-gate notice
    // or substitution record reaches this content build.
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

    // Unified agent names (Task 2): the REST CLI create's naming admission.
    // A scoped mode gets its pre-durable handle (the caller-supplied
    // `namingHandle`, else a server-minted one) ensured BEFORE the
    // tab.create broadcast, stashed by TERMINAL id (the CLI identity binds
    // by terminal in the locator lanes), and carried in the paneContent so
    // the client's pane state can target pre-identity renames. A resume
    // create names through the durable session's own record instead (the
    // hook receives that nameRef). Unwired sinks proceed unnamed.
    let (mut naming_handle, mut naming_name_ref) = (None, None);
    if let Some(provider) = crate::naming::named_provider_for(Some(mode.as_str()), None) {
        if let Some(sink) = state.naming() {
            match accepted_session_ref
                .as_ref()
                .filter(|sref| sref.provider == provider.as_str())
                .map(|sref| sref.session_id.clone())
            {
                Some(session_id) => {
                    naming_name_ref =
                        Some(freshell_protocol::session_names::SessionNameRef::Session {
                            provider,
                            session_id,
                        });
                }
                None => {
                    let handle = body
                        .get("namingHandle")
                        .and_then(Value::as_str)
                        .filter(|h| !h.trim().is_empty())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("nh-{}", Uuid::new_v4().simple()));
                    let pending = freshell_protocol::session_names::SessionNameRef::Pending {
                        id: handle.clone(),
                    };
                    match sink
                        .ensure_pending(crate::naming::PendingNameInput {
                            handle: handle.clone(),
                            provider,
                            cwd: spec.cwd.clone(),
                        })
                        .await
                    {
                        Ok(update) => {
                            state.stash_naming_handle(&terminal_id, &handle);
                            pane_content["namingHandle"] = json!(handle);
                            naming_handle = Some(handle);
                            // Task 8 acceptance (WS parity): report the
                            // Pending binding as the row's name_ref too —
                            // `freshell-server`'s hook wiring writes it onto
                            // the shared identity registry, where the 2s
                            // tick's `pending_naming_binds()` lane reads it.
                            // Without it, a REST-created scoped pane's
                            // record can never transfer at materialization
                            // (the WS door's `admit_create_naming` stamps
                            // exactly this).
                            naming_name_ref = Some(pending.clone());
                            // Unified agent names (Task 2 review, I3): the
                            // CLI-supplied `name` seeds the admitted record
                            // with the SAME intent default as the fresh-agent
                            // create lane (`lib.rs` `create_tab`'s seed —
                            // automatic: an agent/API suggestion never
                            // acquires a user rename's permanence), so the
                            // saved name agrees with the layout title.
                            // Logged, never blocking.
                            if let Some(seed) = body
                                .get("name")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                            {
                                if let Err(error) = sink
                                    .rename(crate::naming::RenameNameInput {
                                        target: pending,
                                        name: seed.to_string(),
                                        intent:
                                            freshell_protocol::session_names::NameIntent::Automatic,
                                        if_revision: None,
                                    })
                                    .await
                                {
                                    crate::naming::log_name_error(
                                        "rename",
                                        &update.record.name_ref,
                                        &error,
                                    );
                                }
                            }
                        }
                        Err(error) => {
                            crate::naming::log_name_error("ensure_pending", &pending, &error);
                        }
                    }
                }
            }
        }
    }

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
            naming_handle: naming_handle.clone(),
            name_ref: naming_name_ref.clone(),
        });
    }

    Ok(TerminalSpawnResult {
        pane_content,
        terminal_id,
        mode,
        shell: shell_str,
        cwd,
        owner_identity: surfaced_owner_identity,
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
        owner_identity: _,
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

    #[test]
    fn managed_rest_terminal_id_is_stable_for_claim_witness_and_settle() {
        let request_id = "rest-managed-create-1";
        let claim_id = mint_terminal_id(request_id, true);
        let settled_id = mint_terminal_id(request_id, true);
        assert_eq!(claim_id, settled_id);
        assert_eq!(claim_id.len(), 32, "managed terminal id is a simple UUID");
        assert_ne!(claim_id, mint_terminal_id("rest-managed-create-2", true));
        assert_ne!(
            claim_id,
            stable_managed_uuid(request_id, b"stream").to_string()
        );
        assert_eq!(mint_terminal_id(request_id, false).len(), 36);
    }

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

    /// The hook is optional wiring (the Option-until-wired convention):
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

    #[tokio::test]
    async fn create_host_stats_tab_attaches_host_stats_pane_content_and_no_terminal() {
        let state = state_with_registry();
        let registry = state.terminal_registry.clone().unwrap();
        assert!(registry.inventory().is_empty());
        let mut rx = state.broadcast_tx.subscribe();

        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({ "hostStats": true }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["data"]["tabId"].as_str().is_some());
        let pane_id = body["data"]["paneId"].as_str().expect("created pane id");
        assert!(body["data"].get("terminalId").is_none());
        assert!(registry.inventory().is_empty());

        let pane = state
            .layout
            .get_pane_snapshot(pane_id)
            .expect("stored pane");
        assert_eq!(pane.kind.as_deref(), Some("host-stats"));
        assert!(pane.terminal_id.is_none());

        let frame = rx.recv().await.expect("ui.command frame broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(msg["command"], json!("tab.create"));
        assert_eq!(msg["payload"]["paneContent"]["kind"], json!("host-stats"));
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
            effort_args: None,
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

    const SYNTHETIC_FRESHELL_TOKEN: &str = "synthetic-rest-managed-codex-token";
    const FRESHELL_CONTEXT_ENV_KEYS: [&str; 6] = [
        "FRESHELL",
        "FRESHELL_URL",
        "FRESHELL_TOKEN",
        "FRESHELL_TERMINAL_ID",
        "FRESHELL_TAB_ID",
        "FRESHELL_PANE_ID",
    ];

    /// The real dispatcher and committed fake app-server capture only these
    /// allowlisted fields. Never derive Debug for this fixture: assertion
    /// messages must not surface context values.
    #[derive(serde::Deserialize)]
    struct CapturedCodexProcess {
        argv: Vec<String>,
        env: BTreeMap<String, String>,
    }

    /// Snapshot values so the synthetic real-process fixture cannot leak a
    /// test environment into another test. The values themselves are never
    /// formatted or logged.
    struct TestEnvRestore {
        values: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl TestEnvRestore {
        fn capture(keys: &[&'static str]) -> Self {
            Self {
                values: keys
                    .iter()
                    .map(|key| (*key, std::env::var_os(key)))
                    .collect(),
            }
        }
    }

    impl Drop for TestEnvRestore {
        fn drop(&mut self) {
            for (key, value) in self.values.drain(..) {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    fn managed_codex_cli_spec() -> freshell_platform::CliCommandSpec {
        freshell_platform::CliCommandSpec {
            name: "codex".to_string(),
            label: "Codex CLI".to_string(),
            env_var: Some("CODEX_CMD".to_string()),
            default_cmd: "codex".to_string(),
            resume_args: Some(vec!["resume".to_string(), "{{sessionId}}".to_string()]),
            model_args: Some(vec!["--model".to_string(), "{{model}}".to_string()]),
            effort_args: None,
            sandbox_args: Some(vec!["--sandbox".to_string(), "{{sandbox}}".to_string()]),
            ..Default::default()
        }
    }

    fn managed_codex_dispatcher() -> std::path::PathBuf {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
            .canonicalize()
            .expect("fake app-server fixture exists");
        let dispatcher = std::env::temp_dir().join(format!(
            "freshell-rest-managed-codex-dispatcher-{}-{}.mjs",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let script = format!(
            r#"#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
if (args.includes('app-server')) {{
  await import('file://{fixture}')
}} else {{
  fs.writeFileSync(process.env.CODEX_ARGV_CAPTURE_PATH, JSON.stringify({{
    argv: args,
    env: {{
      FRESHELL: process.env.FRESHELL,
      FRESHELL_URL: process.env.FRESHELL_URL,
      FRESHELL_TOKEN: process.env.FRESHELL_TOKEN,
      FRESHELL_TERMINAL_ID: process.env.FRESHELL_TERMINAL_ID,
      FRESHELL_TAB_ID: process.env.FRESHELL_TAB_ID,
      FRESHELL_PANE_ID: process.env.FRESHELL_PANE_ID,
    }},
  }}))
  setInterval(() => undefined, 1000)
}}
"#,
            fixture = fixture.display()
        );
        std::fs::write(&dispatcher, script).expect("write dispatcher");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&dispatcher).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&dispatcher, permissions).unwrap();
        }
        dispatcher
    }

    async fn wait_for_captured_codex_process(path: &std::path::Path) -> CapturedCodexProcess {
        for _ in 0..200 {
            if let Ok(content) = std::fs::read_to_string(path) {
                if !content.is_empty() {
                    return serde_json::from_str(&content).expect("captured process is JSON");
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("spawned codex child did not write its allowlisted capture")
    }

    fn freshell_mcp_pairs(argv: &[String]) -> Vec<(String, String)> {
        argv.windows(2)
            .filter(|pair| pair[0] == "-c" && pair[1].starts_with("mcp_servers.freshell."))
            .map(|pair| (pair[0].clone(), pair[1].clone()))
            .collect()
    }

    fn managed_env_vars_config() -> String {
        let names = freshell_platform::mcp_inject::FRESHELL_MCP_CONTEXT_ENV_VARS
            .iter()
            .map(|name| format!("{name:?}"))
            .collect::<Vec<_>>()
            .join(", ");
        format!("mcp_servers.freshell.env_vars=[{names}]")
    }

    fn mcp_recipe_pairs(pairs: &[(String, String)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .filter(|(_, value)| {
                value.starts_with("mcp_servers.freshell.command=")
                    || value.starts_with("mcp_servers.freshell.args=")
            })
            .cloned()
            .collect()
    }

    #[tokio::test]
    async fn managed_codex_terminal_tab_supplies_sidecar_context() {
        // This is a real TUI + app-server pair, serialized with the crate's
        // other Codex process fixtures. The local guard additionally restores
        // the terminal-context inputs that its synthetic environment owns.
        let _codex_environment = crate::codex::tests::ENV_LOCK.lock().await;
        let _environment = TestEnvRestore::capture(&[
            "AUTH_TOKEN",
            "CODEX_ARGV_CAPTURE_PATH",
            "CODEX_CMD",
            "FAKE_CODEX_APP_SERVER_ARG_LOG",
            "FRESHELL_CODEX_MANAGED_LAUNCH",
            "FRESHELL_URL",
            "PORT",
        ]);
        let dispatcher = managed_codex_dispatcher();
        let tui_capture = unique_argv_file("managed-codex-tui");
        let sidecar_capture = unique_argv_file("managed-codex-sidecar");
        std::env::set_var("CODEX_CMD", &dispatcher);
        std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &tui_capture);
        std::env::set_var("FAKE_CODEX_APP_SERVER_ARG_LOG", &sidecar_capture);
        std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "1");
        std::env::set_var("PORT", "23126");
        std::env::set_var("FRESHELL_URL", "http://127.0.0.1:23126");
        std::env::set_var("AUTH_TOKEN", SYNTHETIC_FRESHELL_TOKEN);

        let state =
            state_with_registry().with_cli_commands(Arc::new(vec![managed_codex_cli_spec()]));
        let registry = state.terminal_registry.clone().expect("registry wired");
        let cwd = std::env::temp_dir();
        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({ "mode": "codex", "cwd": cwd.to_string_lossy() }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "managed terminal tab must create");
        let terminal_id = body["data"]["terminalId"]
            .as_str()
            .expect("terminal id")
            .to_string();
        let tab_id = body["data"]["tabId"].as_str().expect("tab id").to_string();
        let pane_id = body["data"]["paneId"]
            .as_str()
            .expect("pane id")
            .to_string();
        let tui = wait_for_captured_codex_process(&tui_capture).await;
        let sidecar = wait_for_captured_codex_process(&sidecar_capture).await;

        // Collect evidence before cleanup; a failed assertion must never
        // strand the real test fixture's PTY or its sidecar.
        let tui_pairs = freshell_mcp_pairs(&tui.argv);
        let sidecar_pairs = freshell_mcp_pairs(&sidecar.argv);
        let expected_env_vars = managed_env_vars_config();
        let tui_recipe = mcp_recipe_pairs(&tui_pairs);
        let sidecar_recipe = mcp_recipe_pairs(&sidecar_pairs);
        let sidecar_app_server_index = sidecar.argv.iter().position(|arg| arg == "app-server");
        let sidecar_config_before_app_server = sidecar_app_server_index.is_some_and(|index| {
            sidecar
                .argv
                .windows(2)
                .enumerate()
                .filter(|(_, pair)| pair[0] == "-c")
                .all(|(pair_index, _)| pair_index < index)
        });
        let equal_context = tui.env == sidecar.env
            && tui.env.len() == FRESHELL_CONTEXT_ENV_KEYS.len()
            && FRESHELL_CONTEXT_ENV_KEYS
                .iter()
                .all(|key| tui.env.contains_key(*key))
            && tui
                .env
                .get("FRESHELL_TERMINAL_ID")
                .is_some_and(|value| value == &terminal_id)
            && tui
                .env
                .get("FRESHELL_TAB_ID")
                .is_some_and(|value| value == &tab_id)
            && tui
                .env
                .get("FRESHELL_PANE_ID")
                .is_some_and(|value| value == &pane_id);
        let no_token_in_argv = [&tui.argv, &sidecar.argv].into_iter().all(|argv| {
            !argv
                .iter()
                .any(|arg| arg.contains(SYNTHETIC_FRESHELL_TOKEN))
        });
        registry.kill(&terminal_id);
        let _ = std::fs::remove_file(&tui_capture);
        let _ = std::fs::remove_file(&sidecar_capture);
        let _ = std::fs::remove_file(&dispatcher);

        for pairs in [&tui_pairs, &sidecar_pairs] {
            assert!(
                pairs
                    .iter()
                    .any(|(flag, value)| flag == "-c" && value == &expected_env_vars),
                "managed TUI and sidecar each need the exact static Freshell env_vars declaration"
            );
        }
        assert!(
            !tui_recipe.is_empty() && tui_recipe == sidecar_recipe,
            "managed terminal-tab pair must receive the same Freshell MCP command recipe"
        );
        assert!(
            sidecar_config_before_app_server,
            "all sidecar configuration pairs must precede app-server"
        );
        assert!(
            equal_context,
            "managed terminal-tab TUI and sidecar must receive one equal six-key Freshell context"
        );
        assert!(
            no_token_in_argv,
            "synthetic Freshell token must never be serialized into argv"
        );
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

    /// Unified agent names (Task 2 review, I3): the REST/CLI terminal-create
    /// lane seeds the CLI-supplied `name` into the admitted pending record
    /// with the automatic intent — mirroring `lib.rs::create_tab`'s
    /// fresh-agent seed, so a scoped terminal pane's saved name agrees with
    /// its layout title instead of silently regressing to the
    /// directory-basename fallback once the client prefers the session
    /// record.
    #[tokio::test]
    async fn rest_cli_terminal_create_seeds_the_requested_name_into_the_pending_record() {
        use crate::naming::SessionNaming as _;
        use freshell_protocol::session_names::{NameIntent, SessionNameRef};

        let argv_file = unique_argv_file("opencode-name-seed");
        let state =
            state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
                "opencode", &argv_file,
            )]));
        let sink = crate::naming::test_support::RecordingSink::new();
        state.set_session_naming(sink.clone());
        let tmp = std::env::temp_dir();

        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({
                "mode": "opencode",
                "name": "Research Spike",
                "cwd": tmp.to_string_lossy(),
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();

        // The CLI-supplied name landed on the pending record with the
        // automatic intent (an agent suggestion never acquires a user
        // rename's permanence).
        let renames = sink.renames.lock().unwrap().clone();
        assert_eq!(
            renames.len(),
            1,
            "the create must seed the CLI-supplied name exactly once: {renames:?}"
        );
        assert_eq!(renames[0].name, "Research Spike");
        assert_eq!(renames[0].intent, NameIntent::Automatic);
        assert!(
            matches!(renames[0].target, SessionNameRef::Pending { .. }),
            "the seed targets the pane's pre-durable record: {renames:?}"
        );

        // The record ANSWERS through the pending handle the create stashed.
        let handle = state
            .peek_naming_handle(&terminal_id)
            .expect("the create stashed its pending handle by terminal id");
        let got = sink
            .get(vec![SessionNameRef::Pending { id: handle }])
            .await
            .expect("get the seeded record");
        assert_eq!(got[0].record.name, "Research Spike");

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
        let _ = std::fs::remove_file(&argv_file);
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

    /// Unified agent names (Task 8 acceptance): a fresh REST claude create
    /// must hand the terminal-created hook the SAME pre-bind binding the
    /// WS door stamps — `name_ref` = the Pending handle (WS parity:
    /// `admit_create_naming`'s `set_name_binding(terminal_id, Pending,
    /// handle)`). `freshell-server`'s hook wiring writes that name_ref onto
    /// the shared identity registry, where the 2s tick's
    /// `pending_naming_binds()` lane reads it — without it, a REST-created
    /// claude pane's pending record can never transfer at materialization.
    #[tokio::test]
    async fn create_fresh_claude_tab_reports_the_pending_binding_through_the_hook() {
        use freshell_protocol::session_names::SessionNameRef;

        let (state, registry, argv_capture_path) =
            state_with_claude_capture_spec("claude-hook-nameref");
        let sink = crate::naming::test_support::RecordingSink::new();
        state.set_session_naming(sink.clone());
        let captured: Arc<std::sync::Mutex<Vec<crate::TerminalCreatedEvent>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let hook_captured = Arc::clone(&captured);
        let state = state.with_terminal_created_hook(Arc::new(move |event| {
            hook_captured.lock().unwrap().push(event);
        }));

        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            serde_json::json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
            }),
            true,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "create failed: {body}");
        let terminal_id = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();

        let events = captured.lock().unwrap();
        assert_eq!(events.len(), 1, "exactly one hook call per create");
        let event = &events[0];
        // The pending handle the admission minted (also the paneContent's
        // namingHandle + the create-lane stash entry).
        let handle = state
            .peek_naming_handle(&terminal_id)
            .expect("the create stashed its pending handle");
        assert_eq!(event.naming_handle.as_deref(), Some(handle.as_str()));
        // THE parity gap under test: the row's name_ref must be the SAME
        // Pending binding, not None.
        assert_eq!(
            event.name_ref,
            Some(SessionNameRef::Pending { id: handle.clone() }),
            "the hook must carry the Pending name_ref so the identity row enters the bind lane"
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
            observed: Option<(u64, u64)>,
        ) -> Result<(), std::io::Error> {
            self.events.lock().unwrap().push(format!(
                "register:{terminal_id}:{mode}:{}",
                resume_session_id.unwrap_or("-")
            ));
            let (epoch, generation) = observed.unwrap_or((0, 0));
            self.events
                .lock()
                .unwrap()
                .push(format!("register-observed:{epoch}:{generation}"));
            Ok(())
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
        // b8ke ext r27 F2: the NON-handoff REST rung stays legacy-unfenced
        // (no observed pair threads into the registration).
        assert!(
            events.contains(&"register-observed:0:0".to_string()),
            "the non-handoff REST registration carries NO observed pair: {events:?}"
        );

        registry.kill(&tid);
        let _ = std::fs::remove_file(&_capture);
    }

    /// b8ke ext r27 F2 (the terminal target arm): a handoff runner's
    /// terminal-target spawn registers the durable identity carrying the
    /// SUPPLIED handoff (epoch, generation) pair — pre-r27 the
    /// registration was legacy-unfenced, so the target row preserved the
    /// PRIOR generation and a delayed prior-generation write could pass
    /// the ledger's comparison and replace the new owner's recovery
    /// metadata.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_handoff_terminal_target_registration_carries_the_handoff_generation() {
        let binder = std::sync::Arc::new(RecordingBinder::default());
        let (state, registry, capture) = state_with_claude_capture_spec("binder-r27-f2");
        let ownership = std::sync::Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let state = state
            .with_ownership(std::sync::Arc::clone(&ownership))
            .with_pane_identity_binder(binder.clone());

        const S: &str = "29a53649-3333-4444-8555-666677778888";
        // The runner's entered handoff (the token's claim context): the
        // key sits in Handoff under the runner's operation id.
        let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_handoff(
            "claude",
            S,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "handoff-op-r27-term",
            None,
            "test",
            crate::session_lease::now_epoch_ms(),
        ) else {
            panic!("the handoff enter must grant")
        };
        let token = HandoffToken {
            operation_id: "handoff-op-r27-term".to_string(),
            generation,
            watch: HandoffSpawnWatch::new(None),
        };

        let spawned = spawn_terminal_pane_with_handoff(
            &state,
            &serde_json::json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": {"provider": "claude", "sessionId": S},
            }),
            "tab-r27-f2",
            "pane-r27-f2",
            Some(&token),
        )
        .await
        .expect("the under-ticket spawn succeeds");

        let tid = spawned.terminal_id.clone();
        let events = binder.events();
        assert!(
            events.contains(&format!("register:{tid}:claude:{S}")),
            "the identity registration ran: {events:?}"
        );
        let expected = format!("register-observed:{}:{generation}", ownership.boot_epoch());
        assert!(
            events.contains(&expected),
            "the registration carries the SUPPLIED handoff (epoch, generation) pair \
             (expected {expected}): {events:?}"
        );

        registry.kill(&tid);
        let _ = std::fs::remove_file(&capture);
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

    #[tokio::test]
    async fn rest_codex_effort_uses_exact_reasoning_config_argv() {
        let _codex_environment = crate::codex::tests::ENV_LOCK.lock().await;
        let _environment = TestEnvRestore::capture(&["FRESHELL_CODEX_MANAGED_LAUNCH"]);
        std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
        let argv_file = unique_argv_file("codex-effort");
        let mut cli = recording_cli_spec("codex", &argv_file);
        cli.effort_args = Some(vec![
            "-c".to_string(),
            "model_reasoning_effort=\"{{effort}}\"".to_string(),
        ]);
        let state = state_with_registry().with_cli_commands(Arc::new(vec![cli]));
        let registry = state.terminal_registry.clone().unwrap();
        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "codex",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "effort": "minimal"
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let terminal_id = body["data"]["terminalId"].as_str().unwrap();
        let argv = read_argv_file_eventually(&argv_file).await;
        assert!(
            argv.lines()
                .any(|arg| arg == "model_reasoning_effort=\"minimal\""),
            "codex argv did not preserve exact effort config: {argv}"
        );
        registry.kill(terminal_id);
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
        let _codex_environment = crate::codex::tests::ENV_LOCK.lock().await;
        let _environment = TestEnvRestore::capture(&["FRESHELL_CODEX_MANAGED_LAUNCH"]);
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

    struct UnusedManagedController;

    impl freshell_terminal::registry::ManagedTerminalController for UnusedManagedController {
        fn lookup_terminal<'a>(
            &'a self,
            _: &'a str,
            _: Option<String>,
        ) -> freshell_terminal::registry::ManagedTerminalFuture<
            'a,
            Result<Option<freshell_terminal::registry::ManagedTerminalDescriptor>, String>,
        > {
            Box::pin(async { Err("unexpected managed lookup".into()) })
        }

        fn launch<'a>(
            &'a self,
            _: freshell_terminal::registry::ManagedTerminalLaunch,
        ) -> freshell_terminal::registry::ManagedTerminalFuture<
            'a,
            Result<freshell_terminal::registry::ManagedTerminalDescriptor, String>,
        > {
            Box::pin(async { Err("unexpected managed launch".into()) })
        }

        fn input<'a>(
            &'a self,
            _: freshell_terminal::registry::ManagedTerminalDescriptor,
            _: String,
        ) -> freshell_terminal::registry::ManagedTerminalFuture<'a, Result<(), String>> {
            Box::pin(async { Err("unexpected managed input".into()) })
        }

        fn resize<'a>(
            &'a self,
            _: freshell_terminal::registry::ManagedTerminalDescriptor,
            _: u16,
            _: u16,
        ) -> freshell_terminal::registry::ManagedTerminalFuture<'a, Result<(), String>> {
            Box::pin(async { Err("unexpected managed resize".into()) })
        }

        fn stop<'a>(
            &'a self,
            _: freshell_terminal::registry::ManagedTerminalDescriptor,
        ) -> freshell_terminal::registry::ManagedTerminalFuture<'a, Result<(), String>> {
            Box::pin(async { Err("unexpected managed stop".into()) })
        }

        fn read_output<'a>(
            &'a self,
            _: freshell_terminal::registry::ManagedTerminalDescriptor,
            _: i64,
            _: u64,
        ) -> freshell_terminal::registry::ManagedTerminalFuture<
            'a,
            Result<freshell_terminal::registry::ManagedOutputRead, String>,
        > {
            Box::pin(async { Err("unexpected managed output read".into()) })
        }
    }

    /// A supervisor whose `launch` waits on a gate (and records the launch)
    /// and whose `stop` records what it was asked to stop.
    #[derive(Default)]
    struct GatedSupervisor {
        gate: tokio::sync::Notify,
        launched: std::sync::Mutex<Vec<String>>,
        stopped: std::sync::Mutex<Vec<freshell_terminal::registry::ManagedTerminalDescriptor>>,
    }

    impl freshell_terminal::registry::ManagedTerminalController for GatedSupervisor {
        fn lookup_terminal<'a>(
            &'a self,
            _: &'a str,
            _: Option<String>,
        ) -> freshell_terminal::registry::ManagedTerminalFuture<
            'a,
            Result<Option<freshell_terminal::registry::ManagedTerminalDescriptor>, String>,
        > {
            Box::pin(async { Ok(None) })
        }

        fn launch<'a>(
            &'a self,
            request: freshell_terminal::registry::ManagedTerminalLaunch,
        ) -> freshell_terminal::registry::ManagedTerminalFuture<
            'a,
            Result<freshell_terminal::registry::ManagedTerminalDescriptor, String>,
        > {
            Box::pin(async move {
                self.launched
                    .lock()
                    .unwrap()
                    .push(request.terminal_id.clone());
                self.gate.notified().await;
                Ok(freshell_terminal::registry::ManagedTerminalDescriptor {
                    soul_id: "soul-rest".into(),
                    incarnation_id: "incarnation-1".into(),
                    terminal_id: request.terminal_id,
                    stream_id: request.stream_id,
                    mode: request.mode,
                    cwd: "/workspace".into(),
                    resume_session_id: None,
                    create_request_id: request.create_request_id,
                })
            })
        }

        fn input<'a>(
            &'a self,
            _: freshell_terminal::registry::ManagedTerminalDescriptor,
            _: String,
        ) -> freshell_terminal::registry::ManagedTerminalFuture<'a, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }

        fn resize<'a>(
            &'a self,
            _: freshell_terminal::registry::ManagedTerminalDescriptor,
            _: u16,
            _: u16,
        ) -> freshell_terminal::registry::ManagedTerminalFuture<'a, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }

        fn stop<'a>(
            &'a self,
            terminal: freshell_terminal::registry::ManagedTerminalDescriptor,
        ) -> freshell_terminal::registry::ManagedTerminalFuture<'a, Result<(), String>> {
            self.stopped.lock().unwrap().push(terminal);
            Box::pin(async { Ok(()) })
        }

        fn read_output<'a>(
            &'a self,
            _: freshell_terminal::registry::ManagedTerminalDescriptor,
            _: i64,
            _: u64,
        ) -> freshell_terminal::registry::ManagedTerminalFuture<
            'a,
            Result<freshell_terminal::registry::ManagedOutputRead, String>,
        > {
            Box::pin(async { Err("not needed".into()) })
        }
    }

    /// The REST lane's managed launch follows the WebSocket create's rule
    /// (Task 13, LB-13): while it launches it is in flight under its
    /// create-request id (a kill waits for it); a pane killed while it
    /// launched is stopped through the supervisor and never registered, the
    /// create is answered as stopped, and the waiting kill learns the stop
    /// was verified.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_rest_managed_pane_killed_while_it_launches_is_stopped_not_registered() {
        let state = state_with_registry();
        let registry = state.terminal_registry.clone().expect("registry wired");
        let supervisor = Arc::new(GatedSupervisor::default());
        registry.set_managed_controller(Some(supervisor.clone()));
        let units = state.units.clone();

        let creating = tokio::spawn(post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "shell",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "createRequestId": "crq-rest-m",
            }),
            true,
        ));
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while units.managed_starts().settled("crq-rest-m").is_none() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the managed launch is in flight"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let waiting_kill = units
            .managed_starts()
            .settled("crq-rest-m")
            .expect("in flight");
        // The kill: the pane's create-request id is remembered as killed.
        units.remember_killed_start("crq-rest-m");
        supervisor.gate.notify_one();

        let (status, body) = tokio::time::timeout(std::time::Duration::from_secs(10), creating)
            .await
            .expect("the create answers")
            .unwrap();
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], json!("INVALID_TERMINAL_ID"), "{body}");
        assert_eq!(
            waiting_kill.await,
            freshell_containment::ManagedStartOutcome::StoppedVerified
        );
        let launched = supervisor.launched.lock().unwrap().clone();
        let stopped = supervisor.stopped.lock().unwrap().clone();
        assert_eq!(stopped.len(), 1, "the launched soul was stopped");
        assert_eq!(launched, vec![stopped[0].terminal_id.clone()]);
        assert!(
            !registry.is_managed(&stopped[0].terminal_id),
            "no facade was registered"
        );
    }

    #[tokio::test]
    async fn rest_user_create_remains_user_create_when_managed_controller_is_installed() {
        use freshell_platform::resume_gate::ResumeExistence;
        let (stale_count, on_stale) = counting_on_stale_resume();
        let state = state_with_registry()
            .with_cli_commands(Arc::new(vec![recording_cli_spec(
                "opencode",
                &unique_argv_file("rest-managed-controller-gate"),
            )]))
            .with_resume_probe(probe_answering(ResumeExistence::Absent, true))
            .with_on_stale_resume(on_stale);
        let registry = state.terminal_registry.clone().expect("registry wired");
        registry.set_managed_controller(Some(Arc::new(UnusedManagedController)));

        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "opencode",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "opencode", "sessionId": "ses_missing" },
            }),
            true,
        )
        .await;

        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], json!("SESSION_MISSING"), "{body}");
        assert_eq!(
            stale_count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "ordinary REST creates retain the missing-session ledger transition"
        );
        assert!(registry.directory().is_empty(), "nothing was launched");
    }

    #[test]
    fn rest_managed_recovery_without_native_evidence_cannot_pass_resume_through() {
        use freshell_platform::resume_gate::{ResumeExistence, ResumeIntent};
        for existence in [ResumeExistence::Absent, ResumeExistence::Unknown] {
            let probe = probe_answering(existence, true);
            let out = validate_rest_resume(
                "claude",
                Some("saved-session".into()),
                LaunchIntent::Resume,
                Some(&probe),
                ResumeIntent::ManagedRecovery,
            );
            assert!(out.resume_session_id.is_none());
            assert!(out.stale_session_id.is_none());
            assert!(out.blocked_recovery);
            assert_eq!(out.blocked_session_id.as_deref(), Some("saved-session"));
        }
        for (mode, session_id, probe) in [
            ("claude", Some("saved-session".into()), None),
            (
                "claude",
                None,
                Some(probe_answering(ResumeExistence::Present, true)),
            ),
            (
                "unsupported-provider",
                Some("saved-session".into()),
                Some(probe_answering(ResumeExistence::Present, true)),
            ),
        ] {
            let out = validate_rest_resume(
                mode,
                session_id,
                LaunchIntent::Resume,
                probe.as_ref(),
                ResumeIntent::ManagedRecovery,
            );
            assert!(out.blocked_recovery, "{mode} without recovery evidence");
            assert!(out.resume_session_id.is_none());
            assert!(out.stale_session_id.is_none());
        }
    }

    #[test]
    fn rest_resume_amplifier_absent_answers_the_missing_verdict() {
        use freshell_platform::resume_gate::ResumeExistence;
        let probe = probe_answering(ResumeExistence::Absent, true);
        let out = validate_rest_resume(
            "amplifier",
            Some("stale-amp".into()),
            LaunchIntent::Resume,
            Some(&probe),
            freshell_platform::resume_gate::ResumeIntent::UserCreate,
        );
        // b8ke ext r16 F3: the SpawnFresh verdict carries ONLY the stale id
        // — the consumer refuses (no minted replacement).
        assert!(out.resume_session_id.is_none());
        assert_eq!(out.stale_session_id.as_deref(), Some("stale-amp"));
    }

    #[test]
    fn rest_resume_without_probe_is_passthrough() {
        let out = validate_rest_resume(
            "amplifier",
            Some("anything".into()),
            LaunchIntent::Resume,
            None,
            freshell_platform::resume_gate::ResumeIntent::UserCreate,
        );
        assert_eq!(out.resume_session_id.as_deref(), Some("anything"));
        assert!(out.stale_session_id.is_none());
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
                freshell_platform::resume_gate::ResumeIntent::UserCreate,
            );
            assert_eq!(out.resume_session_id.as_deref(), Some("ses_x"));
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
            freshell_platform::resume_gate::ResumeIntent::UserCreate,
        );
        assert!(out.resume_session_id.is_none());
        assert_eq!(out.stale_session_id.as_deref(), Some("stale-cx"));
    }

    #[test]
    fn rest_resume_claude_absent_answers_the_missing_verdict() {
        // b8ke ext r16 F3: the gate's SpawnFresh verdict carries ONLY the
        // stale id for claude too — no minted replacement (the pre-r16
        // V9 v4-mint pin tested the substitution path this removes).
        use freshell_platform::resume_gate::ResumeExistence;
        let probe = probe_answering(ResumeExistence::Absent, true);
        let out = validate_rest_resume(
            "claude",
            Some("stale-cl".into()),
            LaunchIntent::Resume,
            Some(&probe),
            freshell_platform::resume_gate::ResumeIntent::UserCreate,
        );
        assert!(out.resume_session_id.is_none());
        assert_eq!(out.stale_session_id.as_deref(), Some("stale-cl"));
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

    /// Gate fires (claude, positive absence) — reshaped (b8ke ext r16
    /// F3): the spawn answers the TYPED SESSION_MISSING refusal — nothing
    /// was started, no replacement session minted, no paneContent stamped
    /// (pre-r16 the gate-fired create spawned a fresh replacement and
    /// healed the paneContent ref). The ledger retire callback still
    /// fires exactly once (the honest SessionMissing record), and the
    /// stale id never reaches any argv.
    #[tokio::test]
    async fn rest_gate_fire_answers_the_typed_missing_refusal() {
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
        // THE TYPED REFUSAL: nothing was started.
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["status"], json!("error"), "{body}");
        assert_eq!(body["code"], json!("SESSION_MISSING"), "{body}");
        assert!(
            body["message"].as_str().unwrap_or_default().contains(STALE),
            "the refusal names the stale id: {body}"
        );
        assert_eq!(
            stale_count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "on_stale_resume (the ledger retire) invoked exactly once"
        );
        // No CLI was ever spawned: the argv file stays empty.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(
            !std::path::Path::new(&argv_file).exists()
                || std::fs::read_to_string(&argv_file)
                    .unwrap_or_default()
                    .is_empty(),
            "no CLI argv was ever written: nothing spawned"
        );
        registry.kill_all();
        let _ = std::fs::remove_file(&argv_file);
    }

    /// Gate-fired claude + the #584 seam — reshaped (b8ke ext r16 F3):
    /// the gate-fired create REFUSES (SESSION_MISSING), so no binder
    /// events and no argv: nothing was preallocated because nothing was
    /// started (the pre-r16 test asserted the gate-minted fresh pane's
    /// PIN 2 pre-spawn write — the substitution path this finding
    /// removes; natural fresh claude creates keep the PIN 2 write,
    /// pinned by their own tests).
    #[tokio::test(flavor = "multi_thread")]
    async fn rest_gate_fired_claude_fallback_preallocates_nothing_because_nothing_started() {
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
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], json!("SESSION_MISSING"), "{body}");
        assert_eq!(
            stale_count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "precondition: the gate fired (the ledger retire)"
        );
        // Nothing was started: no binder events, no argv.
        assert!(
            binder.events().is_empty(),
            "no identity writes: nothing spawned"
        );
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(
            !std::path::Path::new(&argv_file).exists()
                || std::fs::read_to_string(&argv_file)
                    .unwrap_or_default()
                    .is_empty(),
            "no CLI argv was ever written: nothing spawned"
        );
        registry.kill_all();
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
    /// arm is dropped, so it cannot pin it. The gate must SKIP the live
    /// candidate (`on_stale_resume` never invoked, no notice, no fresh-mint
    /// spawn) — and since kata b8ke Task 10 the create then answers the
    /// cross-kind D7 REST refusal (the same typed RESTORE_UNAVAILABLE the WS
    /// door's Task 13b arm emits), never a second writer onto the sidecar's
    /// session. The gate-skip itself is pinned by the refusal: a gate fire
    /// would have REPLACED the resume id (guard locator gone, no D7 arm) and
    /// answered 200 with a fresh-minted id.
    #[tokio::test]
    async fn rest_gate_skips_sidecar_live_candidate_then_d7_refuses() {
        // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
        // plain-CLI codex path (recording CLI spec, no app-server), so pin OFF.
        let _codex_environment = crate::codex::tests::ENV_LOCK.lock().await;
        let _environment = TestEnvRestore::capture(&["FRESHELL_CODEX_MANAGED_LAUNCH"]);
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
        let rows_before = registry.identity_probe_rows().len();

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
        // kata b8ke Task 10 (REST-door D7 parity): the sidecar is the one
        // writer — the typed refusal, never a second spawn.
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");
        assert!(
            body["message"]
                .as_str()
                .is_some_and(|m| m.contains(SIDECAR_LIVE)),
            "message names the live session: {body}"
        );
        // The gate never fired (the liveness precondition held): no stale
        // callback, no fresh-mint spawn.
        assert_eq!(
            stale_count.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "on_stale_resume must never fire for a sidecar-live session"
        );
        assert_eq!(
            registry.identity_probe_rows().len(),
            rows_before,
            "no new terminal (no gate-fired fresh spawn, no second writer)"
        );

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

    /// b8ke focused review FR8: the REST terminal-create repair's half-fence
    /// refusal carries the shared error contract's stable machine-readable
    /// code in the 400 envelope — REST and MCP callers reduce
    /// `INVALID_FENCE` instead of parsing prose. Pre-fix the envelope was
    /// the untyped `{status, message}` shape.
    #[tokio::test]
    async fn half_fenced_rest_create_answers_the_typed_invalid_fence_code() {
        let state = state_with_registry();
        // A sessionRef-carrying body (the fence rung only arms for a
        // locator); exactly ONE of the observed pair is sent. Mode "shell"
        // is always a known launch target, and the sessionRef's provider
        // matches it so the wire ref arms the guard locator.
        let mut body = json!({
            "mode": "shell",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "shell", "sessionId": "ses_fr8_half_fenced" },
            "observedEpoch": 7u64,
        });
        let (status, resp) = post(app(state), "/api/tabs", body.clone(), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{resp}");
        assert_eq!(resp["status"], json!("error"));
        assert_eq!(
            resp["code"],
            json!("INVALID_FENCE"),
            "the typed code must ride the 400 envelope: {resp}"
        );
        assert!(
            resp["message"]
                .as_str()
                .is_some_and(|m| m.contains("together")),
            "the message names the pair rule: {resp}"
        );

        // The other half-fence combination refuses identically.
        body["observedEpoch"] = Value::Null;
        body["observedGeneration"] = json!(11u64);
        let (status, resp) = post(app(state_with_registry()), "/api/tabs", body, true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{resp}");
        assert_eq!(resp["code"], json!("INVALID_FENCE"), "{resp}");
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
        let _codex_environment = crate::codex::tests::ENV_LOCK.lock().await;
        let _environment = TestEnvRestore::capture(&["FRESHELL_CODEX_MANAGED_LAUNCH"]);
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

    #[tokio::test]
    async fn capture_layout_synced_legacy_fresh_agent_pane_is_422() {
        // Mirrors the e2e kata scenario
        // (test/e2e-browser/specs/fresh-agent-centralization-smoke.spec.ts:402-424):
        // a legacy `agent-chat` pane arrives through the layout sync path, is
        // normalized to `fresh-agent` by the layout store's migration, and
        // exists in NO runtime pane map.
        let state = state_with_registry();
        state.layout.update_from_ui(
            &serde_json::from_value::<freshell_protocol::UiLayoutSync>(json!({
                "tabs": [{ "id": "t1" }],
                "activeTabId": "t1",
                "layouts": {
                    "t1": {
                        "type": "leaf",
                        "id": "pane-legacy-agent",
                        "content": {
                            "kind": "agent-chat",
                            "provider": "claude",
                            "resumeSessionId": "11111111-1111-4111-8111-111111111111"
                        }
                    }
                },
                "activePane": { "t1": "pane-legacy-agent" },
                "timestamp": 1
            }))
            .expect("UiLayoutSync parses"),
            "conn-1",
        );
        let router = app(state);

        let (status, body) = get(router, "/api/panes/pane-legacy-agent/capture", true).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            body["message"],
            json!("pane kind \"fresh-agent\" does not support capture-pane; use screenshot-pane")
        );
    }

    #[tokio::test]
    async fn capture_unknown_pane_still_404s_pane_not_found() {
        // Guard: no layout sync, no runtime maps — the pre-existing unknown-pane
        // answer is unchanged by the layout consult.
        let state = state_with_registry();
        let (status, body) = get(app(state), "/api/panes/nope/capture", true).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["message"], json!("pane not found"));
    }

    // ── kata b8ke Task 4 review M1 (fix): REST rung settle coverage ────────

    /// M1 shape 1, REST rung: the same-kind Adopt→death→acquire interleaving.
    /// The REST claim's Adopt arm claims nothing; when the live same-kind
    /// owner dies after the claim but before the D7/lease gates, the create
    /// spawns anyway and the settle previously skipped the coordinator
    /// commit (`ownership_claim` None) — a live writer with a Vacant key.
    /// The settle must late-claim + commit for the surviving terminal.
    /// Determinism: the phantom owner's "death" (its fenced release) is
    /// injected through the registry activity tap's Created event, which
    /// fires inside the spawn's blocking task — after the door's claim,
    /// strictly before the settle's commit site.
    #[tokio::test]
    async fn rest_adopt_death_acquire_settle_commits_the_surviving_terminal() {
        let _ = isolate_amplifier_home();
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let registry =
            freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
        let sid = format!("rest-adopt-gap-{}", Uuid::new_v4());

        // The pre-existing same-kind writer the Adopt arm will see.
        let phantom_op = "op-rest-adopt-gap-phantom";
        let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
            "claude",
            &sid,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            phantom_op,
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        let phantom = freshell_ownership::OwnerIdentity {
            kind: freshell_ownership::RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-rest-adopt-gap-phantom".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: freshell_ownership::HoldKind::Main,
        };
        assert_eq!(
            ownership.commit_live("claude", &sid, phantom_op, generation, phantom.clone()),
            freshell_ownership::CommitOutcome::Committed
        );
        let mut stored_phantom = phantom.clone();
        stored_phantom.ownership_id = Some(phantom_op.to_string());

        // The mid-spawn death: when the create's real spawn inserts the new
        // terminal row (Created), release the phantom exactly as its exit
        // watcher would — the key is Vacant by the settle.
        {
            let ownership = Arc::clone(&ownership);
            let sid = sid.clone();
            registry.set_activity_observer(Arc::new(move |event| {
                if let freshell_terminal::registry::ActivityEvent::Created {
                    mode,
                    resume_session_id,
                    ..
                } = &event
                {
                    if mode == "claude" && resume_session_id.as_deref() == Some(sid.as_str()) {
                        ownership.release(
                            "claude",
                            &sid,
                            &freshell_ownership::ReleaseClaim {
                                operation_id: phantom_op.to_string(),
                                generation,
                                runtime: Some(stored_phantom.clone()),
                            },
                            "test/rest-adopt-gap",
                        );
                    }
                }
            }));
        }

        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let state = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
            .with_terminal_registry(registry.clone())
            .with_cli_commands(Arc::new(vec![recording_cli_spec(
                "claude",
                &unique_argv_file("adopt-gap"),
            )]))
            .with_ownership(Arc::clone(&ownership));
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": tmp.to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": sid },
            }),
            true,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "the gap create must succeed: {body}"
        );
        let survivor = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();

        match ownership.observe("claude", &sid).state {
            freshell_ownership::OwnershipState::Live { owner, .. } => {
                assert_eq!(
                    owner.terminal_id.as_deref(),
                    Some(survivor.as_str()),
                    "the REST settle must commit the SURVIVING terminal, not the dead phantom"
                );
            }
            other => panic!(
                "the REST settle must record the surviving terminal's ownership, got {other:?}"
            ),
        }
        // Cross-kind protection is restored with it.
        assert!(matches!(
            ownership.begin_start(
                "claude",
                &sid,
                freshell_ownership::RuntimeOwnerKind::FreshAgent,
                "op-after-rest-adopt-gap",
                None,
                "test",
                2_000,
            ),
            freshell_ownership::BeginOutcome::OwnedByOtherKind { .. }
        ));
    }

    /// b8ke fence-heal (delta round-4 F3, focused review 2 rework): the
    /// emission-time committed-pair discriminator for the REST owner
    /// frame — the in-crate mirror of the WS-side
    /// `a_broadcast_owner_frame_carries_the_committed_pair_not_the_current_generation`
    /// (identity_ownership.rs). The seam takes the REAL ownership registry
    /// (the epoch source, and the re-observation hazard surface), so the
    /// fixture's divergent observed generation is genuinely consultable: a
    /// regression that built the frame from `ownership.observe(...).generation`
    /// would emit the registry's CURRENT generation and fail the pinned
    /// supplied pair.
    ///
    /// Why the discrimination lives HERE, not in the end-to-end settle
    /// test (the reviewer's preferred interleave is genuinely not stageable
    /// through the REST handler's public surface): a transition that moves
    /// the observed generation between the claim and the commit turns the
    /// commit stale (`commit_live`'s `generation != record.generation`
    /// invariant, freshell-ownership/src/lib.rs) — the rung takes the
    /// stale-teardown path and NEVER broadcasts, so there is no frame to
    /// assert; and between the consuming commit and the frame construction
    /// there is no await point (the same synchronous handler turn), so no
    /// task can interleave a transition into the window. The committed pair
    /// and an emission-time observe() are therefore value-identical in
    /// every deterministically reachable REST-settle state — the
    /// end-to-end test cannot discriminate the regression; this seam test
    /// can and does.
    ///
    /// The fixture stages the divergence through PUBLIC registry
    /// transitions only: a REAL claim granted at generation 1 commits Live
    /// (the pair the rung captures from its ticket), then a LATER
    /// lifecycle — the durable-stop release and a second begin — advances
    /// the observed generation. The frame must carry the FIRST
    /// transition's own committed pair, never the post-hoc observed one
    /// (the r32 F2 hazard: a re-observing emission would let an older
    /// transition's frame claim the newer lifecycle's generation).
    #[test]
    fn rest_terminal_owner_frame_carries_the_supplied_pair_not_the_observed_generation() {
        let ownership = freshell_ownership::RuntimeOwnershipRegistry::new();
        let sid = format!("rest-frame-f3-{}", Uuid::new_v4());

        // The rung's own claim: a real begin grant — the committed pair the
        // emission must carry.
        let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
            "codex",
            &sid,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-rest-frame-f3",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        let runtime = freshell_ownership::OwnerIdentity {
            kind: freshell_ownership::RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-rest-frame-f3-observed".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: freshell_ownership::HoldKind::Main,
        };
        assert_eq!(
            ownership.commit_live(
                "codex",
                &sid,
                "op-rest-frame-f3",
                generation,
                runtime.clone(),
            ),
            freshell_ownership::CommitOutcome::Committed
        );
        let committed_generation = generation;

        // The LATER lifecycle (public transitions): the durable stop
        // releases the Live owner, then a second begin advances the record
        // — the registry's observed generation now genuinely DIVERGES from
        // the first transition's committed pair.
        assert!(ownership.release(
            "codex",
            &sid,
            &freshell_ownership::ReleaseClaim {
                operation_id: "op-rest-frame-f3".into(),
                generation,
                runtime: Some(runtime),
            },
            "test/rest-frame-f3",
        ));
        let freshell_ownership::BeginOutcome::Granted {
            generation: later_generation,
        } = ownership.begin_start(
            "codex",
            &sid,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-rest-frame-f3-later",
            None,
            "test",
            1_000,
        )
        else {
            panic!("expected Granted for the later lifecycle")
        };
        assert!(later_generation > committed_generation);
        assert_eq!(
            ownership.observe("codex", &sid).generation,
            later_generation,
            "fixture: the registry's observed generation genuinely diverges from \
             the committed pair"
        );

        // THE CONTRACT: the frame serializes the SUPPLIED committed pair —
        // never the registry's current observation.
        let locator = SessionLocator {
            provider: "codex".into(),
            session_id: sid.clone(),
        };
        let frame = rest_terminal_owner_frame(
            &ownership,
            &locator,
            "t-rest-frame-f3-supplied",
            "op-rest-frame-f3",
            committed_generation,
        )
        .expect("serialized frame");
        let value: Value = serde_json::from_str(&frame).expect("json frame");
        assert_eq!(value["type"], "session.runtimeOwner");
        assert_eq!(
            value["generation"],
            json!(committed_generation),
            "the REST owner frame carries the SUPPLIED committed pair's generation, \
             never the re-observed current generation ({later_generation}): {value}"
        );
        assert_eq!(
            value["epoch"],
            json!(ownership.boot_epoch()),
            "the REST owner frame carries the emitting coordinator's boot epoch: {value}"
        );
        assert_eq!(value["provider"], json!("codex"));
        assert_eq!(value["sessionId"], json!(sid));
        assert_eq!(value["ownerKind"], "terminal");
        assert_eq!(value["terminalId"], "t-rest-frame-f3-supplied");
        assert_eq!(value["transition"], "handoff-committed");
        assert_eq!(value["operationId"], "op-rest-frame-f3");
    }

    /// b8ke fence-heal (plan Task 3): the REST rung's commit-to-Live
    /// BROADCASTS its own committed (epoch, generation) pair (the r29 F1
    /// "every ownership transition broadcasts" invariant; r32 F2: the pair
    /// captured from the claim ticket BEFORE the consuming commit) — the
    /// same terminal-Live frame shape freshell-ws's `broadcast_owner_frame`
    /// emits, constructed in-crate because this crate cannot call the
    /// freshell-ws helper. Pre-Task-3 the REST settle committed Live with
    /// NO broadcast, so clients never learned the REST-created terminal's
    /// fence until an unrelated transition or a reload supplied one.
    ///
    /// Focused review 2 note: this end-to-end run CANNOT stage the
    /// divergent interleave (a later transition moving the observed
    /// generation between the claim and the emission) — such a transition
    /// turns the consuming commit stale (the `commit_live`
    /// stale-generation invariant), so the rung tears down and never
    /// broadcasts, and the commit-to-broadcast window is synchronous
    /// (no await point). The re-observation discrimination therefore lives
    /// in the seam's own registry-wired unit test,
    /// `rest_terminal_owner_frame_carries_the_supplied_pair_not_the_observed_generation`.
    #[tokio::test]
    async fn a_rest_rung_commit_broadcasts_its_committed_owner_pair() {
        let _ = isolate_amplifier_home();
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let registry =
            freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
        let sid = format!("rest-rung-bcast-{}", Uuid::new_v4());
        // The broadcast receiver subscribed BEFORE the create (the shared
        // bus every connected client folds owner frames from).
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let state = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
            .with_terminal_registry(registry.clone())
            .with_cli_commands(Arc::new(vec![recording_cli_spec(
                "claude",
                &unique_argv_file("rest-rung-bcast"),
            )]))
            .with_ownership(Arc::clone(&ownership));
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": tmp.to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": sid },
            }),
            true,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "the REST create must succeed: {body}"
        );
        let terminal_id = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();

        // The committed pair the frame must carry — the A-PRIORI
        // expectation, never a post-hoc observe() (delta round-4 F3): the
        // create's single door claim on a MISSING key grants generation 1
        // (begin's `record.generation += 1` from the 0 default), so the
        // settle's commit — and the frame riding it — carry exactly 1.
        // The observe-based expectation this replaces would pass even an
        // implementation that re-observed the current generation at
        // emission time (the forbidden r32 F2 shape); the divergent-pair
        // discrimination itself is pinned by
        // `rest_terminal_owner_frame_carries_the_supplied_pair_not_the_observed_generation`.
        let committed_generation = 1u64;

        // THE CONTRACT: the commit's own pair rode the bus — same drain
        // discipline as the fresh-agent lane's r29 F1 precedent
        // (`a_normal_create_broadcasts_the_committed_owner_record`).
        let mut owner_frame = None;
        while let Ok(raw) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&raw).expect("bus json");
            if frame["type"] == "session.runtimeOwner" && frame["sessionId"] == json!(sid) {
                owner_frame = Some(frame);
            }
        }
        let frame = owner_frame.expect("the REST rung's commit broadcast its committed owner pair");
        assert_eq!(frame["ownerKind"], json!("terminal"));
        assert_eq!(frame["transition"], json!("handoff-committed"));
        assert_eq!(frame["generation"], json!(committed_generation));
        assert_eq!(frame["epoch"], json!(ownership.boot_epoch()));
        assert_eq!(frame["terminalId"], json!(terminal_id));
        registry.kill(&terminal_id);
    }

    /// b8ke d4 F4: the dropped-ticket diagnostics capture for the REST
    /// claim tests — thread-local `set_default` (the plain `#[tokio::test]`
    /// current-thread runtime polls the REST handler on this thread, so it
    /// observes the default; the crate convention from claude.rs's
    /// `info_capture_for_test`).
    mod ticket_capture_for_test {
        use std::collections::BTreeMap;
        use std::sync::{Arc, Mutex};
        use tracing::field::{Field, Visit};
        use tracing::{Event, Subscriber};
        use tracing_subscriber::layer::{Context, SubscriberExt};
        use tracing_subscriber::Layer;

        #[derive(Default)]
        struct FieldVisitor {
            event: String,
            fields: BTreeMap<String, String>,
        }
        impl Visit for FieldVisitor {
            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                let rendered = format!("{value:?}");
                if field.name() == "event" {
                    self.event = rendered;
                } else {
                    self.fields.insert(field.name().to_string(), rendered);
                }
            }

            fn record_str(&mut self, field: &Field, value: &str) {
                if field.name() == "event" {
                    self.event = value.to_string();
                } else {
                    self.fields
                        .insert(field.name().to_string(), value.to_string());
                }
            }
        }

        #[derive(Clone, Debug)]
        pub struct Captured {
            pub event: String,
            pub fields: BTreeMap<String, String>,
        }

        struct CaptureLayer {
            events: Arc<Mutex<Vec<Captured>>>,
        }
        impl<S: Subscriber> Layer<S> for CaptureLayer {
            fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
                let mut visitor = FieldVisitor::default();
                event.record(&mut visitor);
                self.events.lock().expect("capture lock").push(Captured {
                    event: visitor.event,
                    fields: visitor.fields,
                });
            }
        }

        pub fn capture() -> (Arc<Mutex<Vec<Captured>>>, tracing::subscriber::DefaultGuard) {
            let events = Arc::new(Mutex::new(Vec::new()));
            let layer = CaptureLayer {
                events: Arc::clone(&events),
            };
            let subscriber = tracing_subscriber::registry().with(layer);
            (events, tracing::subscriber::set_default(subscriber))
        }
    }

    /// b8ke d4 F4: a successful REST claim commit consumes its
    /// OperationTicket — the ticket's Drop must not emit
    /// `ownership.ticket.dropped_unarmed`/TICKET_DROPPED for the resumed
    /// session (pre-d4 the un-disarmed drop misclassified every successful
    /// REST create/resume as an abandoned claim in the diagnostics; the
    /// Live record survived only because the post-commit fail reads as
    /// foreign). Determinism: the commit and the ticket drop are
    /// synchronous inside the request future, so the 200 response means
    /// the drop already fired.
    #[tokio::test]
    async fn successful_rest_claim_commit_does_not_drop_its_ticket_unarmed() {
        let _ = isolate_amplifier_home();
        let (events, _capture_guard) = ticket_capture_for_test::capture();
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let registry =
            freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
        let sid = format!("rest-ticket-{}", Uuid::new_v4());

        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let state = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
            .with_terminal_registry(registry.clone())
            .with_cli_commands(Arc::new(vec![recording_cli_spec(
                "claude",
                &unique_argv_file("rest-ticket"),
            )]))
            .with_ownership(Arc::clone(&ownership));
        let tmp = std::env::temp_dir();
        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": tmp.to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": sid },
            }),
            true,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "the REST resume create must succeed: {body}"
        );
        let tid = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();
        match ownership.observe("claude", &sid).state {
            freshell_ownership::OwnershipState::Live { owner, .. } => {
                assert_eq!(
                    owner.terminal_id.as_deref(),
                    Some(tid.as_str()),
                    "the REST settle must commit the resumed terminal's ownership"
                );
            }
            other => panic!("the REST settle must commit Live, got {other:?}"),
        }

        // THE FIX'S ASSERTION: the Live commit consumed the claim — no
        // dropped_unarmed names this session.
        let events = events.lock().expect("capture lock").clone();
        let dropped: Vec<_> = events
            .iter()
            .filter(|e| {
                e.event == "ownership.ticket.dropped_unarmed"
                    && e.fields.get("session_id").map(String::as_str) == Some(sid.as_str())
            })
            .collect();
        assert!(
            dropped.is_empty(),
            "a successful REST claim commit must not classify its own ticket \
             as abandoned: {dropped:?}"
        );

        // Cleanup: reap the surviving replacement PTY.
        registry.kill(&tid);
    }

    /// b8ke ext r16 F3: a REST resume to a DEFINITIVELY MISSING session
    /// answers the TYPED SESSION_MISSING refusal — nothing was started, no
    /// b8ke ext r20 F1 (b): the launch-FAILURE path settles through the
    /// witness typed — the create fails, the witness guard's Drop fires
    /// the settle, and the RAII ticket fail releases the Starting claim:
    /// the key ends VACANT (its correct typed end state), never a
    /// fence no probe can clear (pre-r20 an unwitnessed launch failure
    /// left a fence the probes could not prove safe to clear).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_failing_rest_create_settles_through_the_witness_to_vacant() {
        let _ = isolate_amplifier_home();
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let registry =
            freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        // A CLI spec whose binary does not exist: the spawn fails after
        // the claim — the post-claim failure path.
        let broken_spec = freshell_platform::CliCommandSpec {
            name: "claude".to_string(),
            label: "claude-broken".to_string(),
            env_var: None,
            default_cmd: "/nonexistent/freshell-r20-f1/cli".to_string(),
            base_args: vec![],
            base_env: std::collections::BTreeMap::new(),
            resume_args: Some(vec!["--resume".to_string(), "{{sessionId}}".to_string()]),
            create_session_args: Some(vec![
                "--session-id".to_string(),
                "{{sessionId}}".to_string(),
            ]),
            model_args: None,
            effort_args: None,
            sandbox_args: None,
            permission_mode_args: None,
        };
        let state = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
            .with_terminal_registry(registry.clone())
            .with_cli_commands(Arc::new(vec![broken_spec]))
            .with_ownership(Arc::clone(&ownership));
        let tmp = std::env::temp_dir();

        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": tmp.to_string_lossy(),
            }),
            true,
        )
        .await;
        assert_ne!(
            status,
            StatusCode::OK,
            "the broken-CLI create fails: {body}"
        );

        // THE TYPED END STATE: the failure settled through the witness +
        // the RAII ticket fail — the minted key ends VACANT (never a
        // StaleStart fence, never Stopping).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let mut mint: Option<String> = None;
            for row in registry.identity_probe_rows() {
                // The failure may or may not have minted the row — find
                // any claude row created by this request; if none, the
                // key never existed and the assertion is trivially true.
                if row.mode == "claude" {
                    mint = row.resume_session_id.clone();
                }
            }
            let Some(mint) = mint else { break };
            let state_now = ownership.observe("claude", &mint).state;
            match state_now {
                freshell_ownership::OwnershipState::Vacant => break,
                freshell_ownership::OwnershipState::Starting { .. } => {
                    // The witness guard may still be dropping — bounded.
                    assert!(
                        std::time::Instant::now() < deadline,
                        "the failed create's Starting claim never released — state: {state_now:?}"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                other => panic!("the failed create's key must end Vacant — got {other:?}"),
            }
        }
    }

    /// b8ke ext r20 F1: a REST create parked INSIDE its held-authority
    /// window (after the claim, before the spawn — the managed-launch
    /// planning shape) survives an over-age watchdog sweep: the pre-spawn
    /// settlement witness registered at the claim makes the sweep SKIP
    /// the witnessed live start, and the released create commits
    /// Live{Terminal} — the commit WINS because the record was never
    /// taken (pre-r20 the claim armed Starting with NO witness: the
    /// sweep fenced Fenced{StaleStart} mid-planning, stale-rejected the
    /// eventual commit, reaped its child, and wedged the session until
    /// restart).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_witnessed_rest_create_survives_the_stale_start_sweep_and_commits() {
        let _ = isolate_amplifier_home();
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let registry =
            freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let state = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
            .with_terminal_registry(registry.clone())
            .with_cli_commands(Arc::new(vec![claude_prealloc_recording_cli_spec(
                &unique_argv_file("rest-r20-witness"),
            )]))
            .with_ownership(Arc::clone(&ownership));
        let tmp = std::env::temp_dir();

        // Park the REST create INSIDE its held-authority window (the
        // postclaim seam — the WS-parity park point this pipeline now
        // shares).
        let entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let entered_for_hook = Arc::clone(&entered);
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let release_rx = std::sync::Mutex::new(Some(release_rx));
        registry.set_terminal_create_postclaim_pause_for_tests(Arc::new(
            move |request_id: &str| {
                let entered = Arc::clone(&entered_for_hook);
                let release_rx = release_rx.lock().expect("release rx lock").take();
                let request_id = request_id.to_string();
                Box::pin(async move {
                    let _ = request_id;
                    entered.store(true, std::sync::atomic::Ordering::SeqCst);
                    if let Some(release_rx) = release_rx {
                        let _ = release_rx.await;
                    }
                })
            },
        ));
        let state_for_task = state.clone();
        let spawn_task = tokio::spawn(async move {
            spawn_terminal_pane(
                &state_for_task,
                &json!({
                    "mode": "claude",
                    "cwd": tmp.to_string_lossy(),
                }),
                "tab-r20",
                "pane-r20",
            )
            .await
        });
        // Park proof: the create reached its window holding the claim.
        {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !entered.load(std::sync::atomic::Ordering::SeqCst) {
                assert!(
                    std::time::Instant::now() < deadline,
                    "the REST create never reached its postclaim window"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }

        // THE OVER-AGE SWEEP (the managed-launch shape: the create is
        // parked well past the 30s threshold — modeled with a now far
        // past the claim's real since_ms): the witnessed live start is
        // SKIPPED (pre-r20: converted + fenced).
        let sweep_now = freshell_ownership::now_epoch_ms().saturating_add(60_000);
        let recovered = ownership.recover_stale_starts(sweep_now, 30_000);
        assert!(
            recovered.is_empty(),
            "the witnessed REST create is NOT swept mid-planning — got {} ops",
            recovered
                .iter()
                .map(|rec| rec.operation_id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
        // Release the create: it completes and commits Live{Terminal}
        // under the minted key — the commit WINS.
        let _ = release_tx.send(());
        let result = spawn_task.await.expect("the REST create task");
        let spawned = result.expect("the witnessed REST create succeeds");
        let mint = registry
            .identity_probe_rows()
            .iter()
            .find(|r| r.terminal_id == spawned.terminal_id)
            .expect("the row")
            .resume_session_id
            .clone()
            .expect("the preallocated id");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if matches!(
                ownership.observe("claude", &mint).state,
                freshell_ownership::OwnershipState::Live { owner, .. }
                    if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
            ) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the witnessed REST create never committed Live — state: {:?}",
                ownership.observe("claude", &mint).state
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        registry.kill(&spawned.terminal_id);
        registry.clear_terminal_create_postclaim_pause_for_tests();
    }

    /// session id changed, no substitution record (pre-r16 the REST door
    /// auto-substituted a replacement session and recorded
    /// SESSION_MISSING_RESUMED_FRESH on the paneContent). The separate
    /// operator-initiated fresh start (a NEW tab create with NO
    /// sessionRef) is the ONLY fresh path.
    #[tokio::test]
    async fn a_rest_resume_to_a_missing_session_answers_the_typed_missing_refusal() {
        use freshell_platform::resume_gate::ResumeExistence;
        let _ = isolate_amplifier_home();
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let registry =
            freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let state = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
            .with_terminal_registry(registry.clone())
            .with_cli_commands(Arc::new(vec![claude_prealloc_recording_cli_spec(
                &unique_argv_file("rest-r16-typed"),
            )]))
            .with_ownership(Arc::clone(&ownership))
            .with_resume_probe(probe_answering(ResumeExistence::Absent, true));
        let tmp = std::env::temp_dir();

        let missing_sid = uuid::Uuid::new_v4().to_string();
        let (status, body) = post(
            app(state.clone()),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": tmp.to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": missing_sid },
            }),
            true,
        )
        .await;
        // THE TYPED REFUSAL: 409 SESSION_MISSING, nothing started.
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["status"], json!("error"), "{body}");
        assert_eq!(body["code"], json!("SESSION_MISSING"), "{body}");
        assert!(
            body["message"]
                .as_str()
                .unwrap_or_default()
                .contains("gone"),
            "the refusal names the missing state: {body}"
        );
        assert!(
            matches!(
                ownership.observe("claude", &missing_sid).state,
                freshell_ownership::OwnershipState::Vacant
            ),
            "nothing was started for the missing session"
        );

        // THE OPERATOR-INITIATED FRESH START: a brand-new tab create with
        // NO sessionRef — the only new-session path.
        let mut frames = state.broadcast_tx.subscribe();
        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": tmp.to_string_lossy(),
            }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let pane_content = loop {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(5), frames.recv())
                .await
                .expect("a broadcast frame within budget")
                .expect("the broadcast channel stays open");
            let value: serde_json::Value =
                serde_json::from_str(&frame).expect("the broadcast frame is JSON");
            if value["command"] == "tab.create" {
                break value["payload"]["paneContent"].clone();
            }
        };
        let mint = pane_content["sessionRef"]["sessionId"]
            .as_str()
            .expect("the fresh create mints its own sessionRef")
            .to_string();
        assert_ne!(mint, missing_sid);
        let terminal_id = pane_content["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();
        registry.kill(&terminal_id);
    }

    /// b8ke ext r6 F1: a fresh-claude PREALLOCATION create through the REST
    /// door commits Live{Terminal} under the MINTED key — pre-r6 the REST
    /// late claim carried only the body-derived guard_locator, so the
    /// REST-minted prealloc session bypassed the coordinator (a direct
    /// handoff entered from Vacant and started a second writer on the
    /// same durable session).
    #[tokio::test]
    async fn a_rest_fresh_claude_prealloc_create_commits_live_under_the_minted_key() {
        let _ = isolate_amplifier_home();
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let registry =
            freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let state = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
            .with_terminal_registry(registry.clone())
            .with_cli_commands(Arc::new(vec![claude_prealloc_recording_cli_spec(
                &unique_argv_file("rest-r6-prealloc"),
            )]))
            .with_ownership(Arc::clone(&ownership));
        let tmp = std::env::temp_dir();

        let (status, body) = post(
            app(state),
            "/api/tabs",
            json!({
                "mode": "claude",
                "cwd": tmp.to_string_lossy(),
            }),
            true,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "the fresh REST claude create must succeed: {body}"
        );
        // The REST HTTP body carries ONLY {tabId, paneId, terminalId} — the
        // preallocated sessionRef rides the registry row (the
        // rest_claude_identity.rs `identity_probe_rows` shape).
        let terminal_id = body["data"]["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();
        let mint = registry
            .identity_probe_rows()
            .iter()
            .find(|r| r.terminal_id == terminal_id)
            .unwrap_or_else(|| panic!("registry row for {terminal_id}"))
            .resume_session_id
            .clone()
            .expect("the fresh REST claude row carries the preallocated id");

        // THE CONTRACT: the minted session commits Live{Terminal} under the
        // MINTED key (pre-r6: the key stayed Vacant).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if matches!(
                ownership.observe("claude", &mint).state,
                freshell_ownership::OwnershipState::Live { .. }
            ) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the REST fresh-claude prealloc session never committed Live \
                 under its minted key — state: {:?}",
                ownership.observe("claude", &mint).state
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        match ownership.observe("claude", &mint).state {
            freshell_ownership::OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.terminal_id.as_deref(), Some(terminal_id.as_str()));
            }
            other => panic!("the minted key must be Live — got {other:?}"),
        }

        // Cleanup: reap the spawned terminal.
        registry.kill(&terminal_id);
    }
}

#[cfg(test)]
#[path = "terminal_tabs_unit_tests.rs"]
mod unit_tests;
