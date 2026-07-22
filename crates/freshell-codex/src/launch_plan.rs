//! Codex launch-planning DECISION layer (DEV-0006 S3) — PURE functions, no IO.
//!
//! Faithful port of the legacy codex launch decision logic:
//!
//! | Item | Legacy source |
//! |---|---|
//! | [`get_codex_session_binding_reason`] | `server/coding-cli/codex-launch-config.ts:22-28` |
//! | [`normalize_codex_sandbox_setting`] + [`CodexLaunchConfigError`] | `codex-launch-config.ts:5-20` |
//! | [`plan_codex_create_restore_decision`] (full decision table) | `server/coding-cli/codex-app-server/restore-decision.ts:32-65` |
//! | [`is_exact_live_codex_candidate`] | `restore-decision.ts:87-94` |
//! | [`plan_codex_launch`] (decision in → plan out) | `ws-handler.ts:928-950` input build + `launch-planner.ts:125-163` fresh/resume knobs |
//! | [`codex_remote_args`] (TUI argv shape) | `terminal-registry.ts:295-307` + `codex-managed-config.ts:1-4` |
//! | [`codex_sidecar_spawn_spec`] (app-server argv + env) | `freshell-freshagent/src/codex.rs::spawn_sidecar` ⇐ `runtime.ts:1246-1261` |
//! | [`plan_codex_launch_retry`] (retry schedule decision) | `launch-retry.ts:16-50` |
//!
//! This module is the DECISION half only: S4 (wiring into the two terminal-create paths)
//! and S5 (durability binding, DEV-0008) consume these plans later. Nothing outside this
//! crate's tests calls into this module yet — that is by design (spec §5, slice ordering).
//!
//! TS-truthiness parity notes (pinned by tests):
//! - `requestedResumeSessionId ? 'resume' : 'start'` — the EMPTY STRING is falsy, so
//!   `Some("")` plans a FRESH launch with binding reason `start`.
//! - `if (!sandbox) return undefined` — `Some("")` normalizes to `None`, not an error.
//! - `hasRawLegacyResume` requires `length > 0` — an empty legacy resume id is NOT raw.

use crate::durability::CODEX_SIDECAR_OWNERSHIP_ENV;
use std::fmt;

// ─── constants ──────────────────────────────────────────────────────────────────────────

/// `INVALID_RAW_CODEX_RESUME_MESSAGE` (`restore-decision.ts:27-28`), byte-identical.
pub const INVALID_RAW_CODEX_RESUME_MESSAGE: &str =
    "Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.";

/// `MISSING_CODEX_SESSION_REF_MESSAGE` (`restore-decision.ts:30`), byte-identical.
pub const MISSING_CODEX_SESSION_REF_MESSAGE: &str =
    "Restore requires a canonical session reference.";

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

/// The env var that opts a server process into DEV-0006 S4's managed codex terminal
/// launches. Council fence: S4's wiring is FLAG-GATED, default OFF — legacy's proxy path
/// exists to feed durability binding (S5), so the launch mechanism ships dark until S5's
/// consumers land; S5 + the flag-default flip land together.
pub const FRESHELL_CODEX_MANAGED_LAUNCH_ENV: &str = "FRESHELL_CODEX_MANAGED_LAUNCH";

/// Whether the managed-launch flag value enables the S4 wiring. Only the exact string
/// `"1"` enables; unset/anything else keeps today's plain-CLI codex behavior
/// byte-identical (golden G-X0 stays the live shape while OFF).
pub fn codex_managed_launch_enabled(value: Option<&str>) -> bool {
    value == Some("1")
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

// ─── restore decision (restore-decision.ts) ─────────────────────────────────────────────

/// A canonical session reference (`shared/session-contract.ts` `SessionRef` shape:
/// provider + sessionId).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRefInput<'a> {
    pub provider: &'a str,
    pub session_id: &'a str,
}

/// The exact-live-candidate identity pair (`CodexCandidateIdentity`
/// `candidateThreadId` + `rolloutPath`, `restore-decision.ts:89`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexCandidateIdentity<'a> {
    pub candidate_thread_id: &'a str,
    pub rollout_path: &'a str,
}

/// Codex durability evidence as the decision input carries it. The decision table
/// IGNORES this entirely (`planCodexCreateRestoreDecision` never reads
/// `input.codexDurability`) — it is present so the ported legacy test vectors can prove
/// that ignoring, and so [`is_exact_live_codex_candidate`] has a candidate to match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexDurabilityEvidence<'a> {
    /// `state: 'durability_unproven_after_completion'`-style candidate evidence.
    Candidate(CodexCandidateIdentity<'a>),
    /// `state: 'durable'` evidence (durable thread id only, no candidate).
    Durable { durable_thread_id: &'a str },
}

/// Input to [`plan_codex_create_restore_decision`] (`restore-decision.ts:32-37`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexRestoreDecisionInput<'a> {
    pub restore_requested: bool,
    pub legacy_resume_session_id: Option<&'a str>,
    pub session_ref: Option<SessionRefInput<'a>>,
    pub codex_durability: Option<CodexDurabilityEvidence<'a>>,
}

/// `RejectCodexCreateRestoreDecision['kind']` (`restore-decision.ts:14`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexRestoreRejectKind {
    InvalidRawCodexResumeRequest,
    MissingCodexSessionRef,
}

/// `RejectCodexCreateRestoreDecision['code']` (`restore-decision.ts:15`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexRestoreRejectCode {
    InvalidMessage,
    RestoreUnavailable,
}

impl CodexRestoreRejectCode {
    pub fn as_str(self) -> &'static str {
        match self {
            CodexRestoreRejectCode::InvalidMessage => "INVALID_MESSAGE",
            CodexRestoreRejectCode::RestoreUnavailable => "RESTORE_UNAVAILABLE",
        }
    }
}

/// `CodexCreateRestorePlan` (`restore-decision.ts:19-22`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexCreateRestorePlan {
    Reject {
        kind: CodexRestoreRejectKind,
        code: CodexRestoreRejectCode,
        message: &'static str,
    },
    FreshCodexLaunch,
    DurableSessionRefResume {
        session_id: String,
    },
}

/// `planCodexCreateRestoreDecision` (`restore-decision.ts:32-65`) — the FULL decision
/// table, in legacy evaluation order:
///
/// 1. A `sessionRef` counts only when `provider === 'codex'` (`:38,79-81`).
/// 2. Raw legacy `resumeSessionId` (non-empty, `:83-85`) with NO codex sessionRef →
///    reject `INVALID_MESSAGE` (`:40-46`) — restore-requested or not.
/// 3. A codex sessionRef → `durable_session_ref_resume` (`:48-54`), raw id ignored.
/// 4. Otherwise, `restoreRequested` → reject `RESTORE_UNAVAILABLE` (`:56-62`) —
///    durability evidence alone (candidate OR durable) never substitutes for the ref.
/// 5. Otherwise → `fresh_codex_launch` (`:64`).
pub fn plan_codex_create_restore_decision(
    input: &CodexRestoreDecisionInput<'_>,
) -> CodexCreateRestorePlan {
    let codex_session_ref = input
        .session_ref
        .as_ref()
        .filter(|session_ref| session_ref.provider == "codex");

    let has_raw_legacy_resume = input
        .legacy_resume_session_id
        .is_some_and(|id| !id.is_empty());

    if has_raw_legacy_resume && codex_session_ref.is_none() {
        return CodexCreateRestorePlan::Reject {
            kind: CodexRestoreRejectKind::InvalidRawCodexResumeRequest,
            code: CodexRestoreRejectCode::InvalidMessage,
            message: INVALID_RAW_CODEX_RESUME_MESSAGE,
        };
    }

    if let Some(session_ref) = codex_session_ref {
        return CodexCreateRestorePlan::DurableSessionRefResume {
            session_id: session_ref.session_id.to_string(),
        };
    }

    if input.restore_requested {
        return CodexCreateRestorePlan::Reject {
            kind: CodexRestoreRejectKind::MissingCodexSessionRef,
            code: CodexRestoreRejectCode::RestoreUnavailable,
            message: MISSING_CODEX_SESSION_REF_MESSAGE,
        };
    }

    CodexCreateRestorePlan::FreshCodexLaunch
}

/// `isExactLiveCodexCandidate` (`restore-decision.ts:87-94`): a live terminal matches a
/// candidate only when BOTH `candidateThreadId` and `rolloutPath` are equal. A terminal
/// whose durability carries no candidate (absent, or durable-state) never matches.
pub fn is_exact_live_codex_candidate(
    live_candidate: Option<&CodexCandidateIdentity<'_>>,
    candidate: &CodexCandidateIdentity<'_>,
) -> bool {
    live_candidate.is_some_and(|live| {
        live.candidate_thread_id == candidate.candidate_thread_id
            && live.rollout_path == candidate.rollout_path
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
}

/// The pure launch PLAN: every decision `planCreate` (`launch-planner.ts:125-163`)
/// makes, minus the IO it performs (runtime readiness, proxy start — S4's job).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexLaunchPlan {
    /// `plan.sessionId` — set ONLY on resume (`launch-planner.ts:145`; fresh plans
    /// leave it unset, `:158-163`).
    pub session_id: Option<String>,
    /// `getCodexSessionBindingReason('codex', resume)` (`ws-handler.ts:2496-2498`).
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

/// The argv (after the `codex` program token) + env a managed app-server sidecar spawn
/// carries. Pure description only — S4 owns the actual spawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexSidecarSpawnSpec {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// `codex -c features.apps=false app-server --listen <ws_url>` with the ownership tag
/// env (`FRESHELL_CODEX_SIDECAR_ID=<ownership_id>`) the `/proc` reaper keys on —
/// exactly the shape `freshell-freshagent/src/codex.rs::spawn_sidecar` (⇐
/// `runtime.ts:1246-1261`) builds today.
pub fn codex_sidecar_spawn_spec(listen_ws_url: &str, ownership_id: &str) -> CodexSidecarSpawnSpec {
    let mut args: Vec<String> = CODEX_MANAGED_REMOTE_CONFIG_ARGS
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.extend([
        "app-server".to_string(),
        "--listen".to_string(),
        listen_ws_url.to_string(),
    ]);
    CodexSidecarSpawnSpec {
        args,
        env: vec![(
            CODEX_SIDECAR_OWNERSHIP_ENV.to_string(),
            ownership_id.to_string(),
        )],
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

    // ── planCodexCreateRestoreDecision — vectors ported from
    //    test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts ──

    fn candidate_evidence() -> CodexDurabilityEvidence<'static> {
        // `candidateDurability` fixture (restore-decision.test.ts:12-23).
        CodexDurabilityEvidence::Candidate(CodexCandidateIdentity {
            candidate_thread_id: "thread-candidate",
            rollout_path: "/tmp/freshell-codex/rollout.jsonl",
        })
    }

    fn durable_evidence() -> CodexDurabilityEvidence<'static> {
        // `durableDurability` fixture (restore-decision.test.ts:25-30).
        CodexDurabilityEvidence::Durable {
            durable_thread_id: "thread-durable",
        }
    }

    #[test]
    fn rejects_restore_requests_that_only_provide_a_raw_legacy_resume_id() {
        // restore-decision.test.ts:33-42
        assert_eq!(
            plan_codex_create_restore_decision(&CodexRestoreDecisionInput {
                restore_requested: true,
                legacy_resume_session_id: Some("thread-raw"),
                ..Default::default()
            }),
            CodexCreateRestorePlan::Reject {
                kind: CodexRestoreRejectKind::InvalidRawCodexResumeRequest,
                code: CodexRestoreRejectCode::InvalidMessage,
                message: INVALID_RAW_CODEX_RESUME_MESSAGE,
            }
        );
    }

    #[test]
    fn rejects_non_restore_creates_that_provide_a_raw_legacy_resume_id() {
        // restore-decision.test.ts:44-52
        assert_eq!(
            plan_codex_create_restore_decision(&CodexRestoreDecisionInput {
                legacy_resume_session_id: Some("thread-raw"),
                ..Default::default()
            }),
            CodexCreateRestorePlan::Reject {
                kind: CodexRestoreRejectKind::InvalidRawCodexResumeRequest,
                code: CodexRestoreRejectCode::InvalidMessage,
                message: INVALID_RAW_CODEX_RESUME_MESSAGE,
            }
        );
    }

    #[test]
    fn requires_a_canonical_session_ref_for_codex_restore() {
        // restore-decision.test.ts:54-60
        assert_eq!(
            plan_codex_create_restore_decision(&CodexRestoreDecisionInput {
                restore_requested: true,
                ..Default::default()
            }),
            CodexCreateRestorePlan::Reject {
                kind: CodexRestoreRejectKind::MissingCodexSessionRef,
                code: CodexRestoreRejectCode::RestoreUnavailable,
                message: MISSING_CODEX_SESSION_REF_MESSAGE,
            }
        );
    }

    #[test]
    fn routes_canonical_session_ref_restores_directly() {
        // restore-decision.test.ts:62-78
        assert_eq!(
            plan_codex_create_restore_decision(&CodexRestoreDecisionInput {
                restore_requested: true,
                session_ref: Some(SessionRefInput {
                    provider: "codex",
                    session_id: "thread-durable",
                }),
                codex_durability: Some(candidate_evidence()),
                ..Default::default()
            }),
            CodexCreateRestorePlan::DurableSessionRefResume {
                session_id: "thread-durable".to_string(),
            }
        );
    }

    #[test]
    fn ignores_durable_codex_durability_without_a_canonical_session_ref() {
        // restore-decision.test.ts:80-89
        assert_eq!(
            plan_codex_create_restore_decision(&CodexRestoreDecisionInput {
                restore_requested: true,
                codex_durability: Some(durable_evidence()),
                ..Default::default()
            }),
            CodexCreateRestorePlan::Reject {
                kind: CodexRestoreRejectKind::MissingCodexSessionRef,
                code: CodexRestoreRejectCode::RestoreUnavailable,
                message: MISSING_CODEX_SESSION_REF_MESSAGE,
            }
        );
    }

    #[test]
    fn ignores_candidate_codex_durability_without_a_canonical_session_ref() {
        // restore-decision.test.ts:91-106
        assert_eq!(
            plan_codex_create_restore_decision(&CodexRestoreDecisionInput {
                restore_requested: true,
                codex_durability: Some(candidate_evidence()),
                ..Default::default()
            }),
            CodexCreateRestorePlan::Reject {
                kind: CodexRestoreRejectKind::MissingCodexSessionRef,
                code: CodexRestoreRejectCode::RestoreUnavailable,
                message: MISSING_CODEX_SESSION_REF_MESSAGE,
            }
        );
    }

    #[test]
    fn uses_explicit_session_ref_before_any_durability_evidence() {
        // restore-decision.test.ts:108-118
        assert_eq!(
            plan_codex_create_restore_decision(&CodexRestoreDecisionInput {
                restore_requested: true,
                session_ref: Some(SessionRefInput {
                    provider: "codex",
                    session_id: "thread-explicit",
                }),
                codex_durability: Some(durable_evidence()),
                ..Default::default()
            }),
            CodexCreateRestorePlan::DurableSessionRefResume {
                session_id: "thread-explicit".to_string(),
            }
        );
    }

    #[test]
    fn fresh_creates_when_restore_is_not_requested_even_if_durability_is_present() {
        // restore-decision.test.ts:120-134
        for evidence in [candidate_evidence(), durable_evidence()] {
            assert_eq!(
                plan_codex_create_restore_decision(&CodexRestoreDecisionInput {
                    restore_requested: false,
                    codex_durability: Some(evidence),
                    ..Default::default()
                }),
                CodexCreateRestorePlan::FreshCodexLaunch
            );
        }
    }

    // ── decision-table edges from the source (restore-decision.ts:38,48,79-85) ──

    #[test]
    fn non_codex_session_ref_never_counts_as_restore_identity() {
        // isCodexSessionRef (restore-decision.ts:79-81): provider must be 'codex'.
        assert_eq!(
            plan_codex_create_restore_decision(&CodexRestoreDecisionInput {
                restore_requested: true,
                legacy_resume_session_id: Some("thread-raw"),
                session_ref: Some(SessionRefInput {
                    provider: "claude",
                    session_id: "sess-claude",
                }),
                ..Default::default()
            }),
            CodexCreateRestorePlan::Reject {
                kind: CodexRestoreRejectKind::InvalidRawCodexResumeRequest,
                code: CodexRestoreRejectCode::InvalidMessage,
                message: INVALID_RAW_CODEX_RESUME_MESSAGE,
            }
        );
        assert_eq!(
            plan_codex_create_restore_decision(&CodexRestoreDecisionInput {
                restore_requested: true,
                session_ref: Some(SessionRefInput {
                    provider: "claude",
                    session_id: "sess-claude",
                }),
                ..Default::default()
            }),
            CodexCreateRestorePlan::Reject {
                kind: CodexRestoreRejectKind::MissingCodexSessionRef,
                code: CodexRestoreRejectCode::RestoreUnavailable,
                message: MISSING_CODEX_SESSION_REF_MESSAGE,
            }
        );
    }

    #[test]
    fn codex_session_ref_wins_over_a_raw_legacy_resume_id() {
        // Decision order restore-decision.ts:40-54: raw-reject requires NO codex ref.
        assert_eq!(
            plan_codex_create_restore_decision(&CodexRestoreDecisionInput {
                legacy_resume_session_id: Some("thread-raw"),
                session_ref: Some(SessionRefInput {
                    provider: "codex",
                    session_id: "thread-durable",
                }),
                ..Default::default()
            }),
            CodexCreateRestorePlan::DurableSessionRefResume {
                session_id: "thread-durable".to_string(),
            }
        );
    }

    #[test]
    fn empty_legacy_resume_id_is_not_raw_and_plans_fresh() {
        // hasRawLegacyResume requires length > 0 (restore-decision.ts:83-85).
        assert_eq!(
            plan_codex_create_restore_decision(&CodexRestoreDecisionInput {
                legacy_resume_session_id: Some(""),
                ..Default::default()
            }),
            CodexCreateRestorePlan::FreshCodexLaunch
        );
    }

    #[test]
    fn plain_create_with_no_identity_plans_fresh() {
        assert_eq!(
            plan_codex_create_restore_decision(&CodexRestoreDecisionInput::default()),
            CodexCreateRestorePlan::FreshCodexLaunch
        );
    }

    #[test]
    fn reject_code_wire_strings_match_legacy() {
        assert_eq!(
            CodexRestoreRejectCode::InvalidMessage.as_str(),
            "INVALID_MESSAGE"
        );
        assert_eq!(
            CodexRestoreRejectCode::RestoreUnavailable.as_str(),
            "RESTORE_UNAVAILABLE"
        );
    }

    // ── isExactLiveCodexCandidate (restore-decision.test.ts:136-152) ──

    #[test]
    fn matches_exact_live_candidates_only_by_rollout_path_and_candidate_thread_id() {
        let live = CodexCandidateIdentity {
            candidate_thread_id: "thread-candidate",
            rollout_path: "/tmp/freshell-codex/rollout.jsonl",
        };
        assert!(is_exact_live_codex_candidate(
            Some(&live),
            &CodexCandidateIdentity {
                candidate_thread_id: "thread-candidate",
                rollout_path: "/tmp/freshell-codex/rollout.jsonl",
            }
        ));
        assert!(!is_exact_live_codex_candidate(
            Some(&live),
            &CodexCandidateIdentity {
                candidate_thread_id: "thread-other",
                rollout_path: "/tmp/freshell-codex/rollout.jsonl",
            }
        ));
        assert!(!is_exact_live_codex_candidate(
            Some(&live),
            &CodexCandidateIdentity {
                candidate_thread_id: "thread-candidate",
                rollout_path: "/tmp/elsewhere/rollout.jsonl",
            }
        ));
    }

    #[test]
    fn a_terminal_without_a_live_candidate_never_matches() {
        // terminal.codexDurability?.candidate absent → undefined comparisons → false.
        assert!(!is_exact_live_codex_candidate(
            None,
            &CodexCandidateIdentity {
                candidate_thread_id: "thread-candidate",
                rollout_path: "/tmp/freshell-codex/rollout.jsonl",
            }
        ));
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
            codex_sidecar_spawn_spec("ws://127.0.0.1:41234", "codex-sidecar-abc"),
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

    // ── S4 flag gate (council fence: managed launch is FLAG-GATED, default OFF) ──

    #[test]
    fn managed_launch_flag_defaults_off() {
        // Unset env → OFF: today's plain-CLI codex behavior stays byte-identical.
        assert!(!codex_managed_launch_enabled(None));
    }

    #[test]
    fn managed_launch_flag_enables_only_on_exactly_1() {
        assert!(codex_managed_launch_enabled(Some("1")));
        for value in ["", "0", "true", "yes", "on", " 1", "1 ", "2"] {
            assert!(!codex_managed_launch_enabled(Some(value)), "{value:?}");
        }
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

    #[test]
    fn restore_messages_match_restore_decision_ts() {
        assert_eq!(
            INVALID_RAW_CODEX_RESUME_MESSAGE,
            "Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."
        );
        assert_eq!(
            MISSING_CODEX_SESSION_REF_MESSAGE,
            "Restore requires a canonical session reference."
        );
    }
}
