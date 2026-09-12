//! Codex launch-planning DECISION layer (DEV-0006 S3) — PURE functions, no IO.
//!
//! Faithful port of the legacy codex launch decision logic:
//!
//! | Item | Legacy source |
//! |---|---|
//! | [`get_codex_session_binding_reason`] | `server/coding-cli/codex-launch-config.ts:22-28` |
//! | [`normalize_codex_sandbox_setting`] + [`CodexLaunchConfigError`] | `codex-launch-config.ts:5-20` |
//! | [`plan_codex_launch`] (decision in → plan out) | `ws-handler.ts:928-950` input build + `launch-planner.ts:125-163` fresh/resume knobs |
//! | [`codex_remote_args`] (TUI argv shape) | `terminal-registry.ts:295-307` + `codex-managed-config.ts:1-4` |
//! | [`codex_sidecar_spawn_spec`] (app-server argv + env) | `freshell-freshagent/src/codex.rs::spawn_sidecar` ⇐ `runtime.ts:1246-1261` |
//! | [`plan_codex_launch_retry`] (retry schedule decision) | `launch-retry.ts:16-50` |
//!
//! This module is the DECISION half only. Its plans are consumed by
//! `launch_lifecycle` (in-crate) and the two terminal-create paths
//! (`freshell-ws/src/terminal.rs`, `freshell-freshagent/src/terminal_tabs.rs`).
//! The restore-decision table that once lived here was deleted as dead code
//! (zero non-test callers); the future restore path will be built against the
//! server-side pane-identity ledger, not this module.
//!
//! TS-truthiness parity notes (pinned by tests):
//! - `requestedResumeSessionId ? 'resume' : 'start'` — the EMPTY STRING is falsy, so
//!   `Some("")` plans a FRESH launch with binding reason `start`.
//! - `if (!sandbox) return undefined` — `Some("")` normalizes to `None`, not an error.

use crate::durability::CODEX_SIDECAR_OWNERSHIP_ENV;
use std::collections::BTreeMap;
use std::fmt;

// ─── constants ──────────────────────────────────────────────────────────────────────────

/// `CODEX_MANAGED_REMOTE_CONFIG_ARGS` (`codex-managed-config.ts:1-4`): the config pair
/// every managed codex launch forces onto the TUI argv (and the sidecar spawn).
pub const CODEX_MANAGED_REMOTE_CONFIG_ARGS: [&str; 2] = ["-c", "features.apps=false"];

/// `CODEX_INITIAL_LAUNCH_ATTEMPTS` (`launch-retry.ts:5`).
pub const CODEX_INITIAL_LAUNCH_ATTEMPTS: u32 = 5;

/// `CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS` (`launch-retry.ts:6`).
pub const CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS: u64 = 100;

/// `terminal-registry.ts:301` — `new URL(wsUrl)` threw.
pub const CODEX_REMOTE_INVALID_URL_MESSAGE: &str =
    "Codex launch requires a valid loopback app-server websocket URL.";

/// `terminal-registry.ts:304` — parsed, but not `ws:` + `127.0.0.1`.
pub const CODEX_REMOTE_NON_LOOPBACK_MESSAGE: &str =
    "Codex launch requires a loopback app-server websocket URL.";

// ─── S4 flag gate (council fence) ────────────────────────────────────────────────────────────────

/// The env var that opts a server process OUT of DEV-0006's managed codex
/// terminal launches. S5.e (2026-07-30): the default flipped ON — S5's
/// consumers (proxy-event drain → identity/activity tails, candidate-
/// persistence gate) are live, closing DEV-0006/DEV-0008. D-C-REVISIT: RESOLVED
/// before this flip (sidecar planning budget + REST acquire move;
/// docs/plans/2026-07-27-rest-spawn-gate.md §D-C addendum). The fail-fast
/// half of that resolution was later superseded for the Restore class
/// (graceful restore/resume S1, §D-C ADDENDUM 2).
pub const FRESHELL_CODEX_MANAGED_LAUNCH_ENV: &str = "FRESHELL_CODEX_MANAGED_LAUNCH";

/// Whether the managed-launch flag value enables the wiring. S5.e default ON:
/// only the exact string "0" disables; unset/anything else plans managed codex
/// launches (goldens G-X1/G-X2 pin the live-path argv).
pub fn codex_managed_launch_enabled(value: Option<&str>) -> bool {
    value != Some("0")
}

// ─── CodexLaunchConfigError (codex-launch-config.ts:5-10) ───────────────────────────────

/// `CodexLaunchConfigError` — a NON-RETRYABLE launch-configuration error. The retry
/// policy ([`plan_codex_launch_retry`]) gives up immediately on these
/// (`launch-retry.ts:35`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexLaunchConfigError {
    pub message: String,
}

impl fmt::Display for CodexLaunchConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CodexLaunchConfigError {}

// ─── sandbox normalization (codex-launch-config.ts:12-20) ───────────────────────────────

/// `CodexSandboxMode` (`codex-launch-config.ts:3`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexSandboxMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

impl CodexSandboxMode {
    /// The wire string legacy passes through verbatim.
    pub fn as_str(self) -> &'static str {
        match self {
            CodexSandboxMode::ReadOnly => "read-only",
            CodexSandboxMode::WorkspaceWrite => "workspace-write",
            CodexSandboxMode::DangerFullAccess => "danger-full-access",
        }
    }
}

/// `normalizeCodexSandboxSetting` (`codex-launch-config.ts:12-20`). TS-falsy inputs
/// (`None`, `Some("")`) normalize to `None`; anything else must be one of the three
/// modes or the call fails with the exact legacy message.
pub fn normalize_codex_sandbox_setting(
    sandbox: Option<&str>,
) -> Result<Option<CodexSandboxMode>, CodexLaunchConfigError> {
    let Some(sandbox) = sandbox else {
        return Ok(None);
    };
    if sandbox.is_empty() {
        return Ok(None);
    }
    match sandbox {
        "read-only" => Ok(Some(CodexSandboxMode::ReadOnly)),
        "workspace-write" => Ok(Some(CodexSandboxMode::WorkspaceWrite)),
        "danger-full-access" => Ok(Some(CodexSandboxMode::DangerFullAccess)),
        other => Err(CodexLaunchConfigError {
            message: format!(
                "Invalid Codex sandbox setting \"{other}\". Expected read-only, workspace-write, or danger-full-access."
            ),
        }),
    }
}

// ─── session binding reason (codex-launch-config.ts:22-28) ──────────────────────────────

/// The codex-producible subset of `SessionBindingReason`
/// (`terminal-stream/registry-events.ts:3` also carries `'association'`, which
/// [`get_codex_session_binding_reason`] can never return).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexSessionBindingReason {
    Start,
    Resume,
}

impl CodexSessionBindingReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CodexSessionBindingReason::Start => "start",
            CodexSessionBindingReason::Resume => "resume",
        }
    }
}

/// `getCodexSessionBindingReason` (`codex-launch-config.ts:22-28`):
/// `mode !== 'codex' → undefined`; else `requestedResumeSessionId ? 'resume' : 'start'`
/// (TS truthiness: the empty string yields `start`).
pub fn get_codex_session_binding_reason(
    mode: &str,
    requested_resume_session_id: Option<&str>,
) -> Option<CodexSessionBindingReason> {
    if mode != "codex" {
        return None;
    }
    Some(match requested_resume_session_id {
        Some(id) if !id.is_empty() => CodexSessionBindingReason::Resume,
        _ => CodexSessionBindingReason::Start,
    })
}

// ─── launch plan (ws-handler.ts:928-950 + launch-planner.ts:125-163) ────────────────────

/// Input to [`plan_codex_launch`], mirroring the object `planCodexLaunch` builds at
/// `ws-handler.ts:937-943` (`sandbox` raw — normalized here, exactly as `:941` does).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexLaunchPlanInput<'a> {
    pub cwd: Option<&'a str>,
    pub resume_session_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub sandbox: Option<&'a str>,
    pub approval_policy: Option<&'a str>,
    /// Spawn-only configuration/context for a newly created app-server. A
    /// claimed survivor deliberately does not consume this new context.
    pub sidecar_context: CodexSidecarLaunchContext,
}

/// The pure launch PLAN: every decision `planCreate` (`launch-planner.ts:125-163`)
/// makes, minus the IO it performs (runtime readiness, proxy start — S4's job).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexLaunchPlan {
    /// `plan.sessionId` — set ONLY on resume (`launch-planner.ts:145`; fresh plans
    /// leave it unset, `:158-163`).
    pub session_id: Option<String>,
    /// `getCodexSessionBindingReason('codex', resume)` (`ws-handler.ts:2496-2498`).
    /// S5.d.3 DECISION (2026-07-30, recorded — spec S5.d.3): computed for plan
    /// parity and the wire-string pin test, then deliberately DROPPED at
    /// `CodexTerminalLaunchManager::adopt`. The Rust registry has no
    /// sessionBindingReason consumer; the adoption tail (`codex_identity.rs`)
    /// has its own adopt/rebind vocabulary. Do not wire without a new decision.
    pub binding_reason: CodexSessionBindingReason,
    /// Codex terminal mode ALWAYS launches managed — both `planCreate` branches spin
    /// up runtime + proxy (spec §1.1); there is no unmanaged branch.
    pub proxy_required: bool,
    /// Proxy knob: `requireCandidatePersistence` — `false` on resume
    /// (`launch-planner.ts:140`), proxy-default `true` on fresh (`:154`).
    pub require_candidate_persistence: bool,
    /// `runtime.ensureReady(cwd)` receives the create cwd in BOTH branches
    /// (`launch-planner.ts:137,153`).
    pub runtime_cwd: Option<String>,
    pub model: Option<String>,
    pub sandbox: Option<CodexSandboxMode>,
    pub approval_policy: Option<String>,
    /// The immutable context a newly spawned runtime carries across retries.
    /// Environment values are never persisted into sidecar records.
    pub sidecar_context: CodexSidecarLaunchContext,
}

/// The `planCodexLaunch` decision tree (`ws-handler.ts:928-950` →
/// `launch-planner.ts:125-163`) as a pure function: decision in → plan out.
///
/// Fresh vs resume tunes exactly two knobs (`session_id`,
/// `require_candidate_persistence`) plus the binding reason — it NEVER makes the launch
/// unmanaged (`proxy_required` is unconditionally true). An invalid sandbox fails with
/// [`CodexLaunchConfigError`] before any plan exists, which the retry policy treats as
/// non-retryable. TS truthiness: an empty-string resume id plans a FRESH launch.
pub fn plan_codex_launch(
    input: &CodexLaunchPlanInput<'_>,
) -> Result<CodexLaunchPlan, CodexLaunchConfigError> {
    let sandbox = normalize_codex_sandbox_setting(input.sandbox)?;
    let resume_session_id = input.resume_session_id.filter(|id| !id.is_empty());
    let binding_reason = match resume_session_id {
        Some(_) => CodexSessionBindingReason::Resume,
        None => CodexSessionBindingReason::Start,
    };
    Ok(CodexLaunchPlan {
        session_id: resume_session_id.map(str::to_string),
        binding_reason,
        proxy_required: true,
        require_candidate_persistence: resume_session_id.is_none(),
        runtime_cwd: input.cwd.map(str::to_string),
        model: input.model.map(str::to_string),
        sandbox,
        approval_policy: input.approval_policy.map(str::to_string),
        sidecar_context: input.sidecar_context.clone(),
    })
}

// ─── TUI remote argv shape (terminal-registry.ts:295-307) ───────────────────────────────

/// Why [`codex_remote_args`] rejected a proxy URL, with the exact legacy messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexRemoteArgsError {
    /// `new URL(wsUrl)` threw (`terminal-registry.ts:298-302`).
    InvalidUrl,
    /// Parsed, but `protocol !== 'ws:' || hostname !== '127.0.0.1'` (`:303-305`).
    NonLoopback,
}

impl CodexRemoteArgsError {
    pub fn message(self) -> &'static str {
        match self {
            CodexRemoteArgsError::InvalidUrl => CODEX_REMOTE_INVALID_URL_MESSAGE,
            CodexRemoteArgsError::NonLoopback => CODEX_REMOTE_NON_LOOPBACK_MESSAGE,
        }
    }
}

/// The managed-codex TUI argv prefix (`terminal-registry.ts:295-307`): validate the
/// proxy URL is loopback plain-WS, then emit
/// `["--remote", <wsUrl>, "-c", "features.apps=false"]` — the first four tokens of
/// every managed codex terminal launch (DEV-0006 live capture; goldens G-X1/G-X2).
///
/// The URL check mirrors the legacy two-stage gate: unparseable → [`CodexRemoteArgsError::InvalidUrl`];
/// parseable but not `ws://127.0.0.1[:port]` → [`CodexRemoteArgsError::NonLoopback`].
/// The URL is passed through VERBATIM (no normalization), exactly as legacy pushes the
/// original `wsUrl` string, not the parsed form.
pub fn codex_remote_args(proxy_ws_url: &str) -> Result<[String; 4], CodexRemoteArgsError> {
    let (scheme, rest) = proxy_ws_url
        .split_once("://")
        .ok_or(CodexRemoteArgsError::InvalidUrl)?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    {
        return Err(CodexRemoteArgsError::InvalidUrl);
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() {
        // `new URL('ws://')` throws in JS.
        return Err(CodexRemoteArgsError::InvalidUrl);
    }
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, hp)| hp);
    let (hostname, port) = match host_port.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (host_port, None),
    };
    if hostname.is_empty() {
        return Err(CodexRemoteArgsError::InvalidUrl);
    }
    if let Some(port) = port {
        // A non-numeric or out-of-range port makes `new URL` throw.
        if !port.is_empty()
            && (!port.chars().all(|c| c.is_ascii_digit())
                || port.parse::<u32>().is_err()
                || port.parse::<u32>().is_ok_and(|p| p > 65535))
        {
            return Err(CodexRemoteArgsError::InvalidUrl);
        }
    }
    if !scheme.eq_ignore_ascii_case("ws") || hostname != "127.0.0.1" {
        return Err(CodexRemoteArgsError::NonLoopback);
    }
    let [c_flag, apps_off] = CODEX_MANAGED_REMOTE_CONFIG_ARGS;
    Ok([
        "--remote".to_string(),
        proxy_ws_url.to_string(),
        c_flag.to_string(),
        apps_off.to_string(),
    ])
}

// ─── app-server sidecar spawn spec (codex.rs::spawn_sidecar ⇐ runtime.ts:1246-1261) ─────

/// The value-safe, immutable configuration a newly spawned managed app-server receives.
/// The `config_args` are static configuration pairs; environment values remain only in the
/// child process environment and are intentionally redacted from [`fmt::Debug`].
#[derive(Clone, PartialEq, Eq, Default)]
pub struct CodexSidecarLaunchContext {
    pub config_args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

impl fmt::Debug for CodexSidecarLaunchContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CodexSidecarLaunchContext")
            .field("config_args", &self.config_args)
            .field("env_keys", &self.env.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// The argv (after the `codex` program token) + env a managed app-server sidecar spawn
/// carries. Pure description only — S4 owns the actual spawn. Environment values are
/// deliberately redacted from [`fmt::Debug`].
#[derive(Clone, PartialEq, Eq)]
pub struct CodexSidecarSpawnSpec {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl fmt::Debug for CodexSidecarSpawnSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut env_keys = self.env.iter().map(|(key, _)| key).collect::<Vec<_>>();
        env_keys.sort_unstable();
        f.debug_struct("CodexSidecarSpawnSpec")
            .field("args", &self.args)
            .field("env_keys", &env_keys)
            .finish()
    }
}

/// `codex -c features.apps=false <context config> app-server --listen <ws_url>` with the
/// ownership tag the `/proc` reaper keys on. Context environment values stay in the spawned
/// process environment; the ownership tag is inserted after context merge so it wins on a
/// collision. This is the shared shape terminal runtimes and fresh-agent use.
pub fn codex_sidecar_spawn_spec(
    listen_ws_url: &str,
    ownership_id: &str,
    context: &CodexSidecarLaunchContext,
) -> CodexSidecarSpawnSpec {
    let mut args: Vec<String> = CODEX_MANAGED_REMOTE_CONFIG_ARGS
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.extend(context.config_args.iter().cloned());
    args.extend([
        "app-server".to_string(),
        "--listen".to_string(),
        listen_ws_url.to_string(),
    ]);
    let mut env = context.env.clone();
    env.insert(
        CODEX_SIDECAR_OWNERSHIP_ENV.to_string(),
        ownership_id.to_string(),
    );
    CodexSidecarSpawnSpec {
        args,
        env: env.into_iter().collect(),
    }
}

// ─── retry schedule decision (launch-retry.ts:16-50) ────────────────────────────────────

/// What `planCodexLaunchWithRetry` decides after a failed attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexLaunchRetryDecision {
    /// Retry after a linear-backoff delay (`delayMs = retryDelayMs * attempt`,
    /// `launch-retry.ts:37`).
    Retry { delay_ms: u64 },
    /// Give up: configuration errors are never retried, and the attempt budget is
    /// exhausted at `attempt >= attempts` (`launch-retry.ts:35`).
    GiveUp,
}

/// The pure retry decision from `planCodexLaunchWithRetry` (`launch-retry.ts:30-47`):
/// after failing `attempt` (1-based) of `attempts`, retry with linear backoff unless
/// the error was a [`CodexLaunchConfigError`] or the budget is spent. The delay
/// multiplication saturates rather than panicking on absurd inputs.
pub fn plan_codex_launch_retry(
    attempt: u32,
    attempts: u32,
    retry_delay_ms: u64,
    is_config_error: bool,
) -> CodexLaunchRetryDecision {
    if is_config_error || attempt >= attempts {
        return CodexLaunchRetryDecision::GiveUp;
    }
    CodexLaunchRetryDecision::Retry {
        delay_ms: retry_delay_ms.saturating_mul(u64::from(attempt)),
    }
}

// ─── tests ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── getCodexSessionBindingReason (codex-launch-config.ts:22-28; branches from source,
    //    no dedicated legacy unit test exists) ──

    #[test]
    fn binding_reason_is_none_for_non_codex_modes() {
        assert_eq!(get_codex_session_binding_reason("shell", None), None);
        assert_eq!(
            get_codex_session_binding_reason("claude", Some("sess-1")),
            None
        );
    }

    #[test]
    fn binding_reason_is_start_for_fresh_codex() {
        assert_eq!(
            get_codex_session_binding_reason("codex", None),
            Some(CodexSessionBindingReason::Start)
        );
    }

    #[test]
    fn binding_reason_is_resume_for_codex_with_resume_id() {
        assert_eq!(
            get_codex_session_binding_reason("codex", Some("thread-1")),
            Some(CodexSessionBindingReason::Resume)
        );
    }

    #[test]
    fn binding_reason_treats_empty_resume_id_as_start_like_ts_falsiness() {
        assert_eq!(
            get_codex_session_binding_reason("codex", Some("")),
            Some(CodexSessionBindingReason::Start)
        );
    }

    #[test]
    fn binding_reason_wire_strings_match_registry_events() {
        assert_eq!(CodexSessionBindingReason::Start.as_str(), "start");
        assert_eq!(CodexSessionBindingReason::Resume.as_str(), "resume");
    }

    // ── normalizeCodexSandboxSetting (codex-launch-config.ts:12-20) ──

    #[test]
    fn sandbox_normalizes_ts_falsy_inputs_to_none() {
        assert_eq!(normalize_codex_sandbox_setting(None), Ok(None));
        assert_eq!(normalize_codex_sandbox_setting(Some("")), Ok(None));
    }

    #[test]
    fn sandbox_accepts_the_three_valid_modes() {
        assert_eq!(
            normalize_codex_sandbox_setting(Some("read-only")),
            Ok(Some(CodexSandboxMode::ReadOnly))
        );
        assert_eq!(
            normalize_codex_sandbox_setting(Some("workspace-write")),
            Ok(Some(CodexSandboxMode::WorkspaceWrite))
        );
        assert_eq!(
            normalize_codex_sandbox_setting(Some("danger-full-access")),
            Ok(Some(CodexSandboxMode::DangerFullAccess))
        );
    }

    #[test]
    fn sandbox_rejects_unknown_values_with_the_exact_legacy_message() {
        let err = normalize_codex_sandbox_setting(Some("yolo")).unwrap_err();
        assert_eq!(
            err.message,
            "Invalid Codex sandbox setting \"yolo\". Expected read-only, workspace-write, or danger-full-access."
        );
    }

    #[test]
    fn sandbox_wire_strings_round_trip() {
        for mode in [
            CodexSandboxMode::ReadOnly,
            CodexSandboxMode::WorkspaceWrite,
            CodexSandboxMode::DangerFullAccess,
        ] {
            assert_eq!(
                normalize_codex_sandbox_setting(Some(mode.as_str())),
                Ok(Some(mode))
            );
        }
    }

    // ── plan_codex_launch — PLAN-struct goldens (decision knobs from
    //    launch-planner.test.ts fresh/resume vectors) ──

    #[test]
    fn fresh_launch_plan_golden() {
        // launch-planner.test.ts:144-157: fresh → sessionId undefined; FakeProxy
        // requireCandidatePersistence defaults true (:98); ensureReady gets the cwd.
        assert_eq!(
            plan_codex_launch(&CodexLaunchPlanInput {
                cwd: Some("/repo/one"),
                ..Default::default()
            }),
            Ok(CodexLaunchPlan {
                session_id: None,
                binding_reason: CodexSessionBindingReason::Start,
                proxy_required: true,
                require_candidate_persistence: true,
                runtime_cwd: Some("/repo/one".to_string()),
                model: None,
                sandbox: None,
                approval_policy: None,
                sidecar_context: CodexSidecarLaunchContext::default(),
            })
        );
    }

    #[test]
    fn resume_launch_plan_golden() {
        // launch-planner.test.ts:397-419: resume → sessionId set, cwd passed to
        // readiness; launch-planner.ts:140 → requireCandidatePersistence false.
        assert_eq!(
            plan_codex_launch(&CodexLaunchPlanInput {
                cwd: Some("/repo/resume"),
                resume_session_id: Some("thread-ready"),
                ..Default::default()
            }),
            Ok(CodexLaunchPlan {
                session_id: Some("thread-ready".to_string()),
                binding_reason: CodexSessionBindingReason::Resume,
                proxy_required: true,
                require_candidate_persistence: false,
                runtime_cwd: Some("/repo/resume".to_string()),
                model: None,
                sandbox: None,
                approval_policy: None,
                sidecar_context: CodexSidecarLaunchContext::default(),
            })
        );
    }

    #[test]
    fn launch_plan_passes_provider_settings_through_normalized() {
        // ws-handler.ts:937-943: model/approvalPolicy verbatim, sandbox normalized.
        assert_eq!(
            plan_codex_launch(&CodexLaunchPlanInput {
                cwd: Some("/repo/settings"),
                resume_session_id: Some("thread-s"),
                model: Some("gpt-5.2-codex"),
                sandbox: Some("workspace-write"),
                approval_policy: Some("on-request"),
                sidecar_context: CodexSidecarLaunchContext::default(),
            }),
            Ok(CodexLaunchPlan {
                session_id: Some("thread-s".to_string()),
                binding_reason: CodexSessionBindingReason::Resume,
                proxy_required: true,
                require_candidate_persistence: false,
                runtime_cwd: Some("/repo/settings".to_string()),
                model: Some("gpt-5.2-codex".to_string()),
                sandbox: Some(CodexSandboxMode::WorkspaceWrite),
                approval_policy: Some("on-request".to_string()),
                sidecar_context: CodexSidecarLaunchContext::default(),
            })
        );
    }

    #[test]
    fn empty_resume_session_id_plans_a_fresh_launch_like_ts_falsiness() {
        // launch-planner.ts:136 `if (input.resumeSessionId)` — '' is falsy.
        let plan = plan_codex_launch(&CodexLaunchPlanInput {
            resume_session_id: Some(""),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(plan.session_id, None);
        assert_eq!(plan.binding_reason, CodexSessionBindingReason::Start);
        assert!(plan.require_candidate_persistence);
    }

    #[test]
    fn invalid_sandbox_fails_the_plan_with_a_config_error() {
        let err = plan_codex_launch(&CodexLaunchPlanInput {
            sandbox: Some("full-yolo"),
            ..Default::default()
        })
        .unwrap_err();
        assert_eq!(
            err.message,
            "Invalid Codex sandbox setting \"full-yolo\". Expected read-only, workspace-write, or danger-full-access."
        );
    }

    #[test]
    fn every_codex_launch_plan_requires_the_proxy() {
        // Spec §1.1: no unmanaged branch — fresh AND resume both launch managed.
        for resume in [None, Some("thread-x")] {
            let plan = plan_codex_launch(&CodexLaunchPlanInput {
                resume_session_id: resume,
                ..Default::default()
            })
            .unwrap();
            assert!(plan.proxy_required);
        }
    }

    // ── codex_remote_args (terminal-registry.ts:295-307; shape from the DEV-0006 live
    //    capture ~/freshell-scratch-006/orig-codex.json and golden G-X1) ──

    #[test]
    fn remote_args_emit_the_managed_four_tuple_for_a_loopback_ws_url() {
        assert_eq!(
            codex_remote_args("ws://127.0.0.1:40781"),
            Ok([
                "--remote".to_string(),
                "ws://127.0.0.1:40781".to_string(),
                "-c".to_string(),
                "features.apps=false".to_string(),
            ])
        );
    }

    #[test]
    fn remote_args_accept_a_loopback_ws_url_without_a_port() {
        // `new URL('ws://127.0.0.1')` parses with hostname 127.0.0.1 → legacy accepts.
        assert!(codex_remote_args("ws://127.0.0.1").is_ok());
    }

    #[test]
    fn remote_args_reject_non_ws_schemes_as_non_loopback() {
        for url in ["wss://127.0.0.1:4000", "http://127.0.0.1:4000"] {
            assert_eq!(
                codex_remote_args(url),
                Err(CodexRemoteArgsError::NonLoopback),
                "{url}"
            );
        }
    }

    #[test]
    fn remote_args_reject_non_loopback_hosts() {
        for url in [
            "ws://localhost:4000",
            "ws://192.168.1.5:4000",
            "ws://0.0.0.0:4000",
            "ws://example.com:4000",
        ] {
            assert_eq!(
                codex_remote_args(url),
                Err(CodexRemoteArgsError::NonLoopback),
                "{url}"
            );
        }
    }

    #[test]
    fn remote_args_reject_unparseable_urls_as_invalid() {
        for url in [
            "",
            "not a url",
            "ws://",
            "ws://127.0.0.1:not-a-port",
            "127.0.0.1:4000",
        ] {
            assert_eq!(
                codex_remote_args(url),
                Err(CodexRemoteArgsError::InvalidUrl),
                "{url:?}"
            );
        }
    }

    #[test]
    fn remote_args_never_panic_on_malformed_input() {
        for url in [
            "ws://\u{0}:1",
            "ws://127.0.0.1:99999999999999999999",
            "ws://@@@",
            "☃://127.0.0.1:1",
            "ws://user:pass@127.0.0.1:4000/path?q=1#frag",
        ] {
            let _ = codex_remote_args(url);
        }
    }

    #[test]
    fn remote_args_error_messages_match_terminal_registry() {
        assert_eq!(
            CodexRemoteArgsError::InvalidUrl.message(),
            "Codex launch requires a valid loopback app-server websocket URL."
        );
        assert_eq!(
            CodexRemoteArgsError::NonLoopback.message(),
            "Codex launch requires a loopback app-server websocket URL."
        );
    }

    // ── codex_sidecar_spawn_spec (codex.rs::spawn_sidecar ⇐ runtime.ts:1246-1261) ──

    #[test]
    fn sidecar_spawn_spec_golden() {
        assert_eq!(
            codex_sidecar_spawn_spec(
                "ws://127.0.0.1:41234",
                "codex-sidecar-abc",
                &CodexSidecarLaunchContext::default(),
            ),
            CodexSidecarSpawnSpec {
                args: vec![
                    "-c".to_string(),
                    "features.apps=false".to_string(),
                    "app-server".to_string(),
                    "--listen".to_string(),
                    "ws://127.0.0.1:41234".to_string(),
                ],
                env: vec![(
                    "FRESHELL_CODEX_SIDECAR_ID".to_string(),
                    "codex-sidecar-abc".to_string(),
                )],
            }
        );
    }

    #[test]
    fn sidecar_spawn_spec_places_context_before_app_server_and_redacts_values() {
        let context = CodexSidecarLaunchContext {
            config_args: vec![
                "-c".to_string(),
                "mcp_servers.freshell.command=\"node\"".to_string(),
                "-c".to_string(),
                "mcp_servers.freshell.env_vars=[\"FRESHELL_TOKEN\"]".to_string(),
            ],
            env: std::collections::BTreeMap::from([
                (
                    CODEX_SIDECAR_OWNERSHIP_ENV.to_string(),
                    "context-must-not-win".to_string(),
                ),
                (
                    "FRESHELL_PANE_ID".to_string(),
                    "pane-context-test".to_string(),
                ),
                ("FRESHELL_TOKEN".to_string(), "not-visible".to_string()),
            ]),
        };

        let spec =
            codex_sidecar_spawn_spec("ws://127.0.0.1:41234", "sidecar-ownership-wins", &context);

        assert_eq!(
            spec.args,
            vec![
                "-c",
                "features.apps=false",
                "-c",
                "mcp_servers.freshell.command=\"node\"",
                "-c",
                "mcp_servers.freshell.env_vars=[\"FRESHELL_TOKEN\"]",
                "app-server",
                "--listen",
                "ws://127.0.0.1:41234",
            ]
        );
        assert_eq!(
            spec.env,
            vec![
                (
                    CODEX_SIDECAR_OWNERSHIP_ENV.to_string(),
                    "sidecar-ownership-wins".to_string(),
                ),
                ("FRESHELL_PANE_ID".to_string(), "pane-context-test".to_string()),
                ("FRESHELL_TOKEN".to_string(), "not-visible".to_string()),
            ],
            "a BTreeMap makes process environment ordering deterministic and the ownership tag wins"
        );

        let context_debug = format!("{context:?}");
        let spec_debug = format!("{spec:?}");
        for rendered in [&context_debug, &spec_debug] {
            assert!(rendered.contains("FRESHELL_TOKEN"));
            assert!(rendered.contains(CODEX_SIDECAR_OWNERSHIP_ENV));
            for value in [
                "not-visible",
                "context-must-not-win",
                "sidecar-ownership-wins",
                "pane-context-test",
            ] {
                assert!(
                    !rendered.contains(value),
                    "Debug output must expose environment names, never values"
                );
            }
        }
    }

    // ── plan_codex_launch_retry — vectors ported from
    //    test/unit/server/coding-cli/codex-app-server/launch-retry.test.ts ──

    #[test]
    fn retry_uses_linear_backoff_for_transient_failures() {
        // launch-retry.test.ts:7-37: base 1ms → attempt 1 delays 1, attempt 2 delays 2.
        assert_eq!(
            plan_codex_launch_retry(1, 5, 1, false),
            CodexLaunchRetryDecision::Retry { delay_ms: 1 }
        );
        assert_eq!(
            plan_codex_launch_retry(2, 5, 1, false),
            CodexLaunchRetryDecision::Retry { delay_ms: 2 }
        );
    }

    #[test]
    fn retry_never_retries_configuration_errors() {
        // launch-retry.test.ts:39-51.
        assert_eq!(
            plan_codex_launch_retry(1, 5, 100, true),
            CodexLaunchRetryDecision::GiveUp
        );
    }

    #[test]
    fn retry_gives_up_when_attempts_are_exhausted() {
        // launch-retry.test.ts:53-66 (attempts: 2 → second failure is final).
        assert_eq!(
            plan_codex_launch_retry(2, 2, 1, false),
            CodexLaunchRetryDecision::GiveUp
        );
        assert_eq!(
            plan_codex_launch_retry(
                CODEX_INITIAL_LAUNCH_ATTEMPTS,
                CODEX_INITIAL_LAUNCH_ATTEMPTS,
                CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS,
                false
            ),
            CodexLaunchRetryDecision::GiveUp
        );
    }

    #[test]
    fn retry_defaults_match_launch_retry_ts() {
        assert_eq!(CODEX_INITIAL_LAUNCH_ATTEMPTS, 5);
        assert_eq!(CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS, 100);
        // Default schedule: 100, 200, 300, 400 then give up on the fifth failure.
        for (attempt, expected) in [(1u32, 100u64), (2, 200), (3, 300), (4, 400)] {
            assert_eq!(
                plan_codex_launch_retry(
                    attempt,
                    CODEX_INITIAL_LAUNCH_ATTEMPTS,
                    CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS,
                    false
                ),
                CodexLaunchRetryDecision::Retry { delay_ms: expected }
            );
        }
    }

    #[test]
    fn retry_delay_saturates_instead_of_panicking() {
        assert_eq!(
            plan_codex_launch_retry(3, 5, u64::MAX, false),
            CodexLaunchRetryDecision::Retry { delay_ms: u64::MAX }
        );
    }

    // ── S5.e flag gate (default ON; only the exact string "0" opts out) ──

    #[test]
    fn managed_launch_defaults_on_and_only_zero_disables() {
        assert!(codex_managed_launch_enabled(None)); // S5.e: default ON
        assert!(codex_managed_launch_enabled(Some("1")));
        assert!(codex_managed_launch_enabled(Some("")));
        assert!(codex_managed_launch_enabled(Some("true")));
        assert!(!codex_managed_launch_enabled(Some("0"))); // the only opt-out
    }

    #[test]
    fn managed_launch_env_name_is_pinned() {
        assert_eq!(
            FRESHELL_CODEX_MANAGED_LAUNCH_ENV,
            "FRESHELL_CODEX_MANAGED_LAUNCH"
        );
    }

    // ── constants ──

    #[test]
    fn managed_remote_config_args_match_codex_managed_config_ts() {
        assert_eq!(
            CODEX_MANAGED_REMOTE_CONFIG_ARGS,
            ["-c", "features.apps=false"]
        );
    }
}
