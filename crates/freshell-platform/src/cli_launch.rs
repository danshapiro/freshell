//! Coding-CLI launch resolution — the deterministic argv core of
//! `resolveCodingCliCommand` (`server/terminal-registry.ts:274-375`), per
//! `port/machine/specs/cli-argv-fidelity.md` §3.1.
//!
//! Pure: all IO (MCP config file writes, port allocation) lives in
//! [`crate::mcp_inject`] and the ws layer; results arrive through
//! [`CliLaunchInputs`]. The §4 golden argv tests live in
//! `cli_launch_goldens.rs` (`#[cfg(test)]` submodule).

use std::collections::BTreeMap;

use crate::Env;

// ===========================================================================
// Coding-CLI launch (mode != 'shell') — the deterministic base-command slice of
// `resolveCodingCliCommand`/`buildSpawnSpec` (`terminal-registry.ts:274-320,
// 1256-1266`).
// ===========================================================================

/// A registered coding-CLI's command resolution inputs — the full
/// `CodingCliCommandSpec` (`terminal-registry.ts:77-90`), populated from the
/// extension registry's `cli` block (`freshell.json`) as compiled by
/// `server/index.ts:231-255`.
///
/// The `*_args` fields are the manifest **arg templates** (e.g.
/// `["--resume", "{{sessionId}}"]`). Template substitution semantics differ
/// WITHIN the reference (spec `cli-argv-fidelity.md` §3.1 rev 2.1 pin):
/// `compileArgTemplate` uses `replaceAll` for model/sandbox/permissionMode/
/// createSession (`index.ts:100`), but `resumeArgs` uses first-occurrence-only
/// `.replace` (`index.ts:250-251`) — see [`resolve_coding_cli_command`].
///
/// `permissionModeEnvVar`/`permissionModeEnvValues` are NOT modeled: no shipped
/// manifest sets them, so `terminal-registry.ts:355-367` is inert (spec §2.1(6)).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CliCommandSpec {
    /// The terminal mode / provider name (`claude` | `codex` | `opencode` | ...).
    pub name: String,
    /// `spec.label` (`manifest.label`, e.g. `"Claude CLI"`) — used for the
    /// terminal title (`getModeLabel`) and the start-intent throw message.
    pub label: String,
    /// The env var that overrides the command (`spec.envVar`); `None` = no override.
    pub env_var: Option<String>,
    /// `spec.defaultCommand` — the executable to run when no override is set.
    pub default_cmd: String,
    /// `spec.args` (`cli.args` — empty for every shipped manifest).
    pub base_args: Vec<String>,
    /// `spec.env` (`cli.env` — empty for every shipped manifest).
    pub base_env: BTreeMap<String, String>,
    /// `resumeArgs` template (`"{{sessionId}}"`, first-occurrence substitution).
    pub resume_args: Option<Vec<String>>,
    /// `createSessionArgs` template (`"{{sessionId}}"`, replace-all).
    pub create_session_args: Option<Vec<String>>,
    /// `modelArgs` template (`"{{model}}"`, replace-all).
    pub model_args: Option<Vec<String>>,
    /// `sandboxArgs` template (`"{{sandbox}}"`, replace-all).
    pub sandbox_args: Option<Vec<String>>,
    /// `permissionModeArgs` template (`"{{permissionMode}}"`, replace-all).
    pub permission_mode_args: Option<Vec<String>>,
}

/// A resolved coding-CLI launch (`resolveCodingCliCommand` return).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliLaunch {
    /// `cli.command` — `(env[spec.envVar] || spec.defaultCommand)`.
    pub command: String,
    /// `cli.args` — `[...remoteArgs, ...providerArgs, ...baseArgs, ...settingsArgs, ...resumeArgs]`.
    pub args: Vec<String>,
    /// `cli.env` — `{ ...spec.env, ...notification.env, [opencode overrides] }`.
    pub env: BTreeMap<String, String>,
    /// `cli.label` — `spec.label` (the terminal title source).
    pub label: String,
}

/// The provider launch target (`ProviderTarget` — `terminal-registry.ts:199`).
/// `Windows` only on the native `cmd`/`powershell` branches (`tr:1204,1237`);
/// the WSL-from-Windows branch and the non-Windows tail use `Unix` (`tr:1165,1262`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderTarget {
    Unix,
    Windows,
}

/// `ProviderLaunchIntent` (`terminal-registry.ts:75`). `Start` only for
/// `mode === 'claude' && sessionBindingReason === 'start'` (`tr:1570-1571`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchIntent {
    Start,
    Resume,
}

/// `McpInjection` (`server/mcp/config-writer.ts:247-250`) — the per-mode MCP
/// config injection result, precomputed by the IO layer
/// ([`crate::mcp_inject::generate_mcp_injection`]) and consumed by
/// [`resolve_coding_cli_command`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct McpInjection {
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// The inputs to [`resolve_coding_cli_command`], mirroring `ProviderSettings` +
/// the `resolveCodingCliCommand` call-site params (`terminal-registry.ts:274-282`,
/// `ws-handler.ts:2461-2493`). `mcp_injection` is precomputed by the §3.2 IO layer
/// (the reference computes it inline via `providerNotificationArgs`, `tr:207`).
#[derive(Debug, Clone)]
pub struct CliLaunchInputs<'a> {
    pub mode: &'a str,
    pub target: ProviderTarget,
    /// `normalizeResumeForSpawn` output (identity for non-empty, `tr:382-385`).
    pub resume_session_id: Option<&'a str>,
    pub launch_intent: LaunchIntent,
    /// `providerSettings.permissionMode` (claude/opencode pass-through; codex
    /// stripped on the live path, `ws:2464-2465`).
    pub permission_mode: Option<&'a str>,
    pub model: Option<&'a str>,
    pub sandbox: Option<&'a str>,
    /// `providerSettings.codexAppServer.wsUrl` (always present on the live codex
    /// path; `None` only for direct/unit callers — spec §2.2(1) / UNCERTAIN U2).
    pub codex_remote_ws_url: Option<&'a str>,
    /// `providerSettings.opencodeServer` — `(hostname, port)`. Port is `i64` so
    /// the reference's `port > 65535` throw condition is representable (G-O4).
    pub opencode_server: Option<(&'a str, i64)>,
    pub mcp_injection: McpInjection,
}

/// The `resolveCodingCliCommand` throw conditions as typed errors with
/// reference-exact messages (`terminal-registry.ts:297-313,324-332`). The ws
/// layer maps these to an `error` frame (`PTY_SPAWN_FAILED` — the generic tail of
/// `ws-handler.ts:2606-2614`) and never falls back to a bare-command launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliLaunchError {
    /// `new URL(wsUrl)` threw (`tr:298-302`).
    CodexInvalidWsUrl,
    /// Parsed but `protocol !== 'ws:' || hostname !== '127.0.0.1'` (`tr:303-305`).
    CodexNonLoopbackWsUrl,
    /// Missing/invalid opencode loopback endpoint (`tr:324-332`).
    OpencodeEndpoint,
    /// `launchIntent === 'start'` without `createSessionArgs` (`tr:310-313`).
    StartIntentUnsupported { label: String },
}

impl CliLaunchError {
    /// The reference-exact `Error.message` bytes.
    pub fn message(&self) -> String {
        match self {
            CliLaunchError::CodexInvalidWsUrl => {
                "Codex launch requires a valid loopback app-server websocket URL.".to_string()
            }
            CliLaunchError::CodexNonLoopbackWsUrl => {
                "Codex launch requires a loopback app-server websocket URL.".to_string()
            }
            CliLaunchError::OpencodeEndpoint => {
                "OpenCode launch requires an allocated localhost control endpoint.".to_string()
            }
            CliLaunchError::StartIntentUnsupported { label } => {
                format!("Fresh {label} launch requires createSessionArgs support.")
            }
        }
    }
}

impl std::fmt::Display for CliLaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for CliLaunchError {}

/// `CODEX_MANAGED_REMOTE_CONFIG_ARGS` (`server/coding-cli/codex-managed-config.ts:1-4`).
pub const CODEX_MANAGED_REMOTE_CONFIG_ARGS: &[&str] = &["-c", "features.apps=false"];

/// The codex turn-complete notification pair (`terminal-registry.ts:211`) — the
/// second value is ONE argv element containing single quotes + brackets verbatim.
pub const CODEX_TUI_NOTIFICATION_ARGS: &[&str] = &[
    "-c",
    "tui.notification_method=bel",
    "-c",
    "tui.notifications=['agent-turn-complete']",
];

/// The claude unix bell command (`terminal-registry.ts:219`, runtime bytes —
/// the source's `printf '\\a'` template-unescapes to a literal backslash-`a`).
/// U3 (spec §5): pinned by executing the reference's own source lines.
pub const CLAUDE_BELL_COMMAND_UNIX: &str =
    "sh -lc \"printf '\\a' > /dev/tty 2>/dev/null || true\"";

/// The claude windows bell command (`terminal-registry.ts:218`, runtime bytes —
/// `'\\\\.\\CONOUT$'` unescapes to `\\.\CONOUT$`, the Win32 console device path).
pub const CLAUDE_BELL_COMMAND_WINDOWS: &str = "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"$bell=[char]7; $ok=$false; try {[System.IO.File]::AppendAllText('\\\\.\\CONOUT$', [string]$bell); $ok=$true} catch {}; if (-not $ok) { try {[Console]::Out.Write($bell); $ok=$true} catch {} }; if (-not $ok) { try {[Console]::Error.Write($bell)} catch {} }\"";

/// `JSON.stringify`-compatible string escaping (the subset JSON.stringify
/// performs: `\` `"` and control chars; the bell payloads only contain the
/// first two, but the helper is complete for safety).
fn json_escape_into(out: &mut String, s: &str) {
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
}

/// The claude `--settings` payload: compact `JSON.stringify` of the Stop-hook
/// settings object (`terminal-registry.ts:216-238`) —
/// `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"<bell>"}]}]}}`.
/// Exact bytes pinned by the §4 goldens (`CLAUDE_SETTINGS_UNIX`/`_WIN`) and
/// verified against the live original.
pub fn claude_settings_json(target: ProviderTarget) -> String {
    let bell = match target {
        ProviderTarget::Windows => CLAUDE_BELL_COMMAND_WINDOWS,
        ProviderTarget::Unix => CLAUDE_BELL_COMMAND_UNIX,
    };
    let mut out =
        String::from("{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"");
    json_escape_into(&mut out, bell);
    out.push_str("\"}]}]}}");
    out
}

/// Truthy env lookup (JS `env.X` truthiness: unset and `''` are both falsy).
fn env_truthy(env: &dyn Env, key: &str) -> Option<String> {
    env.get(key).filter(|v| !v.is_empty())
}

/// Truthy lookup over the merged `{ ...process.env, ...commandEnv }` view
/// (`terminal-registry.ts:293,343` — `commandEnv` wins).
fn merged_env_truthy(
    parent: &dyn Env,
    command_env: &BTreeMap<String, String>,
    key: &str,
) -> Option<String> {
    if let Some(v) = command_env.get(key) {
        // JS spread: a present-but-empty commandEnv value SHADOWS process.env
        // (`{...a,...b}` with `b.K=''` yields `''`, which is falsy).
        return if v.is_empty() { None } else { Some(v.clone()) };
    }
    env_truthy(parent, key)
}

/// `resolveGoogleApiKey` (`server/opencode-launch.ts:7-9`):
/// `GOOGLE_GENERATIVE_AI_API_KEY || GEMINI_API_KEY || GOOGLE_API_KEY`.
fn resolve_google_api_key(
    parent: &dyn Env,
    command_env: &BTreeMap<String, String>,
) -> Option<String> {
    merged_env_truthy(parent, command_env, "GOOGLE_GENERATIVE_AI_API_KEY")
        .or_else(|| merged_env_truthy(parent, command_env, "GEMINI_API_KEY"))
        .or_else(|| merged_env_truthy(parent, command_env, "GOOGLE_API_KEY"))
}

/// `getOpencodeEnvOverrides` (`server/opencode-launch.ts:11-18`) over the merged
/// `{ ...process.env, ...commandEnv }` env source (`terminal-registry.ts:293`).
pub fn get_opencode_env_overrides(
    parent: &dyn Env,
    command_env: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut overrides = BTreeMap::new();
    if let Some(key) = resolve_google_api_key(parent, command_env) {
        if merged_env_truthy(parent, command_env, "GOOGLE_GENERATIVE_AI_API_KEY").is_none() {
            overrides.insert("GOOGLE_GENERATIVE_AI_API_KEY".to_string(), key);
        }
    }
    overrides
}

/// `resolveOpencodeLaunchModel` (`server/opencode-launch.ts:20-29`).
pub fn resolve_opencode_launch_model(
    explicit_model: Option<&str>,
    parent: &dyn Env,
    command_env: &BTreeMap<String, String>,
) -> Option<String> {
    if let Some(m) = explicit_model.filter(|m| !m.is_empty()) {
        return Some(m.to_string());
    }
    if resolve_google_api_key(parent, command_env).is_some() {
        return Some("google/gemini-3-pro-preview".to_string());
    }
    if merged_env_truthy(parent, command_env, "OPENAI_API_KEY").is_some() {
        return Some("openai/gpt-5".to_string());
    }
    if merged_env_truthy(parent, command_env, "ANTHROPIC_API_KEY").is_some() {
        return Some("anthropic/claude-sonnet-4-5".to_string());
    }
    None
}

/// A minimal `new URL(wsUrl)` stand-in for the codex `--remote` validation
/// (`terminal-registry.ts:297-305`): returns `(protocol_with_colon, hostname)`
/// or `None` when the parse would throw. Faithful for every live input (the
/// server itself builds `ws://127.0.0.1:<port>/<path>`) and the G-W2 goldens;
/// not a full WHATWG parser (e.g. scheme-relative special-scheme forms like
/// `ws:host/x` are rejected here where WHATWG would normalize them — both
/// still produce an error, with the parse-vs-loopback message differing in
/// that unreachable corner).
fn parse_url_protocol_host(url: &str) -> Option<(String, String)> {
    let colon = url.find(':')?;
    let scheme = &url[..colon];
    if scheme.is_empty()
        || !scheme.chars().next().unwrap().is_ascii_alphabetic()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    let rest = &url[colon + 1..];
    let hostname = if let Some(after) = rest.strip_prefix("//") {
        let end = after
            .find(|c| matches!(c, '/' | ':' | '?' | '#'))
            .unwrap_or(after.len());
        let host = &after[..end];
        if host.is_empty() {
            return None; // `new URL('ws://')` throws for special schemes
        }
        host.to_ascii_lowercase()
    } else {
        String::new() // opaque path (e.g. mailto:) — parses with empty hostname
    };
    Some((format!("{}:", scheme.to_ascii_lowercase()), hostname))
}

/// Apply an arg template: replace-all (`compileArgTemplate`, `index.ts:100`).
fn apply_template_all(template: &[String], placeholder: &str, value: &str) -> Vec<String> {
    template
        .iter()
        .map(|arg| arg.replace(placeholder, value))
        .collect()
}

/// Apply the RESUME arg template: first-occurrence-only per element
/// (`index.ts:250-251` uses `.replace`, not `.replaceAll` — rev 2.1 pin).
fn apply_resume_template(template: &[String], value: &str) -> Vec<String> {
    template
        .iter()
        .map(|arg| arg.replacen("{{sessionId}}", value, 1))
        .collect()
}

/// The full `resolveCodingCliCommand` (`terminal-registry.ts:274-375`).
///
/// Returns `Ok(None)` for `mode == 'shell'` or an unregistered mode (the caller
/// decides between the shell fallback and the reference's
/// `UnknownTerminalModeError` — `tr:1073-1074`); `Err` for the reference's four
/// throw conditions ([`CliLaunchError`], reference-exact messages).
///
/// Segment order is enforced by construction:
/// `[remote, provider, base, settings, resume]` (`tr:371`).
///
/// The MCP injection (`generateMcpInjection`, `tr:207`) is precomputed by the
/// IO layer ([`crate::mcp_inject`]) and passed in `inputs.mcp_injection` — this
/// keeps the resolver pure (spec §3.1 "keep IO out").
pub fn resolve_coding_cli_command(
    specs: &[CliCommandSpec],
    inputs: &CliLaunchInputs<'_>,
    env: &dyn Env,
) -> Result<Option<CliLaunch>, CliLaunchError> {
    if inputs.mode == "shell" {
        return Ok(None);
    }
    let Some(spec) = specs.iter().find(|s| s.name == inputs.mode) else {
        return Ok(None);
    };
    // `command = (spec.envVar && process.env[spec.envVar]) || spec.defaultCommand`.
    let command = spec
        .env_var
        .as_deref()
        .and_then(|var| env_truthy(env, var))
        .unwrap_or_else(|| spec.default_cmd.clone());

    // `providerNotificationArgs` (`tr:201-241`): notification args + MCP injection.
    let injection = &inputs.mcp_injection;
    let provider_args: Vec<String> = if inputs.mode == "codex" {
        CODEX_TUI_NOTIFICATION_ARGS
            .iter()
            .map(|s| s.to_string())
            .chain(injection.args.iter().cloned())
            .collect()
    } else if inputs.mode == "claude" {
        ["--settings".to_string(), claude_settings_json(inputs.target)]
            .into_iter()
            .chain(injection.args.iter().cloned())
            .collect()
    } else {
        injection.args.clone()
    };

    let base_args = spec.base_args.clone();

    // `commandEnv = { ...spec.env, ...notification.env }` (`tr:290`).
    let mut command_env: BTreeMap<String, String> = spec.base_env.clone();
    for (k, v) in &injection.env {
        command_env.insert(k.clone(), v.clone());
    }

    let mut remote_args: Vec<String> = Vec::new();
    if inputs.mode == "opencode" {
        // `Object.assign(commandEnv, getOpencodeEnvOverrides({...process.env, ...commandEnv}))`.
        let overrides = get_opencode_env_overrides(env, &command_env);
        for (k, v) in overrides {
            command_env.insert(k, v);
        }
    }
    if inputs.mode == "codex" {
        if let Some(ws_url) = inputs.codex_remote_ws_url {
            let Some((protocol, hostname)) = parse_url_protocol_host(ws_url) else {
                return Err(CliLaunchError::CodexInvalidWsUrl);
            };
            if protocol != "ws:" || hostname != "127.0.0.1" {
                return Err(CliLaunchError::CodexNonLoopbackWsUrl);
            }
            remote_args.push("--remote".to_string());
            remote_args.push(ws_url.to_string());
            remote_args.extend(CODEX_MANAGED_REMOTE_CONFIG_ARGS.iter().map(|s| s.to_string()));
        }
    }

    // Resume / create-session (`tr:308-320`).
    let mut resume_args: Vec<String> = Vec::new();
    if let Some(session_id) = inputs.resume_session_id.filter(|s| !s.is_empty()) {
        if inputs.launch_intent == LaunchIntent::Start {
            let Some(template) = &spec.create_session_args else {
                return Err(CliLaunchError::StartIntentUnsupported {
                    label: spec.label.clone(),
                });
            };
            resume_args = apply_template_all(template, "{{sessionId}}", session_id);
        } else if let Some(template) = &spec.resume_args {
            resume_args = apply_resume_template(template, session_id);
        }
        // else: reference logs a warning and launches with no resume args.
    }

    // Settings args (`tr:321-368`): opencode endpoint, then model, sandbox,
    // permission mode.
    let mut settings_args: Vec<String> = Vec::new();
    if inputs.mode == "opencode" {
        let valid = matches!(
            inputs.opencode_server,
            Some((hostname, port)) if hostname == "127.0.0.1" && port > 0 && port <= 65535
        );
        if !valid {
            return Err(CliLaunchError::OpencodeEndpoint);
        }
        let (hostname, port) = inputs.opencode_server.unwrap();
        settings_args.push("--hostname".to_string());
        settings_args.push(hostname.to_string());
        settings_args.push("--port".to_string());
        settings_args.push(port.to_string());
    }
    let effective_model: Option<String> = if inputs.mode == "opencode" {
        if inputs.resume_session_id.filter(|s| !s.is_empty()).is_some() {
            None
        } else {
            resolve_opencode_launch_model(inputs.model, env, &command_env)
        }
    } else {
        inputs.model.filter(|m| !m.is_empty()).map(str::to_string)
    };
    if let (Some(model), Some(template)) = (&effective_model, &spec.model_args) {
        settings_args.extend(apply_template_all(template, "{{model}}", model));
    }
    if let (Some(sandbox), Some(template)) = (
        inputs.sandbox.filter(|s| !s.is_empty()),
        &spec.sandbox_args,
    ) {
        settings_args.extend(apply_template_all(template, "{{sandbox}}", sandbox));
    }
    if let Some(pm) = inputs.permission_mode.filter(|s| !s.is_empty() && *s != "default") {
        if let Some(template) = &spec.permission_mode_args {
            settings_args.extend(apply_template_all(template, "{{permissionMode}}", pm));
        }
        // `permissionModeEnvVar` is unset for every shipped manifest (`tr:355-367` inert).
    }

    let mut args = remote_args;
    args.extend(provider_args);
    args.extend(base_args);
    args.extend(settings_args);
    args.extend(resume_args);

    Ok(Some(CliLaunch {
        command,
        args,
        env: command_env,
        label: spec.label.clone(),
    }))
}

/// `resolveCodingCliCommand(mode, ...)` base-command slice
/// (`terminal-registry.ts:283-286`): look up the spec for `mode`, then resolve
/// `command = (env[spec.envVar] || spec.defaultCommand)`. Returns `None` for
/// `mode == 'shell'` or an unregistered mode.
///
/// Superseded by [`resolve_coding_cli_command`] (the full resolver per
/// `port/machine/specs/cli-argv-fidelity.md`); retained for callers that only
/// need the base command (e.g. availability detection).
pub fn resolve_cli_launch(
    specs: &[CliCommandSpec],
    mode: &str,
    env: &dyn Env,
) -> Option<CliLaunch> {
    if mode == "shell" {
        return None;
    }
    let spec = specs.iter().find(|s| s.name == mode)?;
    let command = spec
        .env_var
        .as_deref()
        .and_then(|var| env.get(var))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| spec.default_cmd.clone());
    Some(CliLaunch {
        command,
        args: Vec::new(),
        env: BTreeMap::new(),
        label: spec.label.clone(),
    })
}
// §4 golden argv tests (split to keep this file within the campaign's
// ≤1K-lines-per-file limit).
#[cfg(test)]
#[path = "cli_launch_goldens.rs"]
mod cli_argv_goldens_file;
