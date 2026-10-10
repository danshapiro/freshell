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
use freshell_containment::{
    AgentUnit, Containment, StopHandle, StopMode, StopReason, StopRequest, UnitDirectory,
    UnitEntry, UnitId, UnitLabel,
};
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

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
    /// The pane's containment seed: each start attempt mints its own unit
    /// from it. `None` (the managed session host, which runs inside its own
    /// container) keeps the unit-less spawn.
    pub unit_seed: Option<UnitSeed>,
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
    /// The pane's containment seed ([`CodexLaunchPlanInput::unit_seed`]).
    pub unit_seed: Option<UnitSeed>,
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
        unit_seed: input.unit_seed.clone(),
    })
}

// ─── the pane's containment seed (one unit per start attempt) ──────────────────────────

/// The ONE stop path for every containment unit the Codex crate touches. From
/// Task 12 on, `freshell-ws`'s unit lifecycle implements it over the owner
/// registry (`begin_unit_stop` → `unit.stop` → `commit_unit_stop` at Gone);
/// nothing in this crate calls [`AgentUnit::stop`] itself.
pub trait CodexUnitLifecycle: Send + Sync {
    /// The pane's create path learns each start attempt's unit (a Shift-X
    /// during the start then stops the current attempt). It does not stamp
    /// the conversation's key: only the attempt that succeeds does.
    fn attempt_started(&self, unit: &AgentUnit);
    /// True once a kill cancelled this pane's start.
    fn start_cancelled(&self) -> bool;
    /// Starts (or joins) the unit's stop and returns its handle without
    /// waiting.
    fn stop(
        &self,
        unit: &AgentUnit,
        mode: StopMode,
        reason: StopReason,
        initiator: &str,
    ) -> StopHandle;
    /// A stop of this unit has begun. Kill-versus-retain is decided by this,
    /// never by the unit's private latch.
    fn is_stopping(&self, unit: &AgentUnit) -> bool;
}

/// The lifecycle for units no registry key names (true until Task 12, and
/// in this crate's tests): the stop goes straight to the unit.
pub struct RegistryFreeUnitLifecycle;

impl CodexUnitLifecycle for RegistryFreeUnitLifecycle {
    fn attempt_started(&self, _unit: &AgentUnit) {}

    fn start_cancelled(&self) -> bool {
        false
    }

    fn stop(
        &self,
        unit: &AgentUnit,
        mode: StopMode,
        reason: StopReason,
        initiator: &str,
    ) -> StopHandle {
        unit.stop(StopRequest::new(mode, reason, initiator))
    }

    fn is_stopping(&self, unit: &AgentUnit) -> bool {
        unit.stop_in_flight().is_some()
    }
}

/// A pane start's lifecycle over its entry in the shared
/// [`UnitDirectory`] (Task 12): the start registered its own base unit, and
/// each start attempt's unit takes over the start's entry while it runs, so a
/// kill by terminal or create-request id always reaches the attempt that is
/// running. Every stop goes through the directory's installed
/// [`UnitLifecycle`] (the WebSocket layer's single stop path); without one
/// (tests) it goes straight to the unit.
///
/// While the plan runs, a stop of the current attempt's unit is the
/// attempt's own (a failed start attempt, an unusable reattach): the start's
/// entry goes back to its base unit first, so that stop never cancels the
/// pane's start and the plan may retry. [`Self::finish_planning`] ends the
/// plan: the entry then names the launch's unit, the base unit (unused) is
/// stopped, and later stops are the pane's own.
pub struct DirectoryUnitLifecycle {
    directory: Arc<UnitDirectory>,
    base: AgentUnit,
    provider: String,
    mode: String,
    current: std::sync::Mutex<AgentUnit>,
    planning: std::sync::atomic::AtomicBool,
}

impl DirectoryUnitLifecycle {
    /// The lifecycle of the start whose entry names `base`.
    pub fn new(directory: Arc<UnitDirectory>, base: AgentUnit) -> Arc<Self> {
        let (provider, mode) = match directory.get(base.id()) {
            Some(entry) => (entry.provider, entry.mode),
            None => {
                let label = base.label();
                (label.provider, label.mode)
            }
        };
        Arc::new(Self {
            directory,
            current: std::sync::Mutex::new(base.clone()),
            base,
            provider,
            mode,
            planning: std::sync::atomic::AtomicBool::new(true),
        })
    }

    /// The unit the start's entry names now.
    pub fn current(&self) -> AgentUnit {
        self.lock_current().clone()
    }

    /// The start's own base unit.
    pub fn base(&self) -> AgentUnit {
        self.base.clone()
    }

    /// The plan ended with `launch_unit`: the start's entry names it from now
    /// on, and the base unit (unused) is stopped. Stops after this are the
    /// pane's.
    pub fn finish_planning(&self, launch_unit: Option<AgentUnit>) {
        self.planning
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let Some(launch_unit) = launch_unit else {
            return;
        };
        let previous = std::mem::replace(&mut *self.lock_current(), launch_unit.clone());
        if previous.id() != launch_unit.id() {
            let _ = self
                .directory
                .replace_unit(previous.id(), launch_unit.clone());
        }
        if self.base.id() != launch_unit.id() {
            let _ = self.stop_entry(
                &self.detached(&self.base),
                StopMode::Force,
                StopReason::StartCancelled,
                "codex-start-base-unused",
            );
        }
    }

    fn lock_current(&self) -> std::sync::MutexGuard<'_, AgentUnit> {
        self.current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// An entry for a unit that is not (or no longer) the start's: no
    /// terminal and no create-request id, so its stop ends no row and
    /// cancels no start.
    fn detached(&self, unit: &AgentUnit) -> UnitEntry {
        UnitEntry {
            unit: unit.clone(),
            provider: self.provider.clone(),
            mode: self.mode.clone(),
            create_request_id: None,
            terminal_id: None,
        }
    }

    fn stop_entry(
        &self,
        entry: &UnitEntry,
        mode: StopMode,
        reason: StopReason,
        initiator: &str,
    ) -> StopHandle {
        match self.directory.lifecycle() {
            Some(lifecycle) => lifecycle.stop(entry, mode, reason, initiator),
            None => entry.unit.stop(StopRequest::new(mode, reason, initiator)),
        }
    }
}

impl CodexUnitLifecycle for DirectoryUnitLifecycle {
    fn attempt_started(&self, unit: &AgentUnit) {
        let previous = std::mem::replace(&mut *self.lock_current(), unit.clone());
        let _ = self.directory.replace_unit(previous.id(), unit.clone());
        // Between attempts the entry names the base unit (see `stop`); an
        // earlier attempt still named here was never stopped by its plan,
        // so it is stopped now rather than left running unrecorded.
        if previous.id() != self.base.id() && previous.id() != unit.id() {
            let _ = self.stop_entry(
                &self.detached(&previous),
                StopMode::Force,
                StopReason::StartCancelled,
                "codex-start-attempt-replaced",
            );
        }
    }

    fn start_cancelled(&self) -> bool {
        let current = self.current();
        self.directory.get(current.id()).is_none() || self.directory.start_cancelled(current.id())
    }

    fn stop(
        &self,
        unit: &AgentUnit,
        mode: StopMode,
        reason: StopReason,
        initiator: &str,
    ) -> StopHandle {
        let planning = self.planning.load(std::sync::atomic::Ordering::SeqCst);
        if planning && unit.id() != self.base.id() {
            let was_current = {
                let mut current = self.lock_current();
                let was_current = current.id() == unit.id();
                if was_current {
                    *current = self.base.clone();
                }
                was_current
            };
            if was_current {
                let _ = self.directory.replace_unit(unit.id(), self.base.clone());
            }
            return self.stop_entry(&self.detached(unit), mode, reason, initiator);
        }
        let entry = self
            .directory
            .get(unit.id())
            .unwrap_or_else(|| self.detached(unit));
        self.stop_entry(&entry, mode, reason, initiator)
    }

    fn is_stopping(&self, unit: &AgentUnit) -> bool {
        match self.directory.lifecycle() {
            Some(lifecycle) => lifecycle.is_stopping(unit),
            None => unit.stop_in_flight().is_some(),
        }
    }
}

/// What a pane's Codex sidecar needs from containment: where units are made
/// and the one stop path.
#[derive(Clone)]
pub struct CodexUnitServices {
    pub containment: Containment,
    pub lifecycle: Arc<dyn CodexUnitLifecycle>,
}

impl CodexUnitServices {
    /// Services whose stops go straight to the unit
    /// ([`RegistryFreeUnitLifecycle`]).
    pub fn registry_free(containment: Containment) -> Self {
        Self {
            containment,
            lifecycle: Arc::new(RegistryFreeUnitLifecycle),
        }
    }
}

/// What the create path passes instead of a pre-made unit: every start
/// attempt mints its own unit from it (one unit reused across attempts
/// would be stopped by attempt 1's failure and then refuse later attempts).
#[derive(Clone)]
pub struct UnitSeed {
    pub services: CodexUnitServices,
    pub label: UnitLabel,
}

impl fmt::Debug for UnitSeed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UnitSeed")
            .field("label", &self.label)
            .finish_non_exhaustive()
    }
}

impl PartialEq for UnitSeed {
    fn eq(&self, other: &Self) -> bool {
        self.label == other.label
    }
}

impl Eq for UnitSeed {}

/// [`UnitSeed::mint_attempt`]'s refusal of a start a kill cancelled.
pub const CODEX_START_CANCELLED_MESSAGE: &str = "codex start cancelled";

impl UnitSeed {
    /// One start attempt's own unit. Its Running record is written before
    /// anything spawns (a store failure is a start failure). A start a kill
    /// cancelled is refused, also when the kill raced the mint: the new,
    /// memberless unit is then stopped through the lifecycle.
    pub fn mint_attempt(&self) -> Result<AgentUnit, String> {
        if self.start_cancelled() {
            return Err(CODEX_START_CANCELLED_MESSAGE.to_string());
        }
        let unit = self
            .services
            .containment
            .create_unit(UnitId::mint(), self.label.clone())
            .map_err(|error| format!("codex unit could not be recorded: {error}"))?;
        self.services.lifecycle.attempt_started(&unit);
        if self.start_cancelled() {
            let _ = self.stop(
                &unit,
                StopMode::Force,
                StopReason::StartCancelled,
                "codex-start-cancelled",
            );
            return Err(CODEX_START_CANCELLED_MESSAGE.to_string());
        }
        Ok(unit)
    }

    /// Starts (or joins) `unit`'s stop through the lifecycle.
    pub fn stop(
        &self,
        unit: &AgentUnit,
        mode: StopMode,
        reason: StopReason,
        initiator: &str,
    ) -> StopHandle {
        self.services.lifecycle.stop(unit, mode, reason, initiator)
    }

    /// Whether a stop of `unit` has begun (the lifecycle's answer).
    pub fn is_stopping(&self, unit: &AgentUnit) -> bool {
        self.services.lifecycle.is_stopping(unit)
    }

    /// Whether a kill cancelled this pane's start.
    pub fn start_cancelled(&self) -> bool {
        self.services.lifecycle.start_cancelled()
    }
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
                unit_seed: None,
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
                unit_seed: None,
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
                unit_seed: None,
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
                unit_seed: None,
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

    // ── the containment seed: one unit per attempt, refused once a kill cancelled the start ──

    /// A lifecycle whose start cancellation the test controls; it can cancel
    /// the start as an attempt's unit is announced (a kill racing the mint).
    #[derive(Default)]
    struct CancellingLifecycle {
        cancelled: std::sync::atomic::AtomicBool,
        cancel_on_attempt: bool,
        attempts: std::sync::Mutex<Vec<AgentUnit>>,
    }

    impl CodexUnitLifecycle for CancellingLifecycle {
        fn attempt_started(&self, unit: &AgentUnit) {
            self.attempts.lock().unwrap().push(unit.clone());
            if self.cancel_on_attempt {
                self.cancelled
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }

        fn start_cancelled(&self) -> bool {
            self.cancelled.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn stop(
            &self,
            unit: &AgentUnit,
            mode: StopMode,
            reason: StopReason,
            initiator: &str,
        ) -> StopHandle {
            unit.stop(StopRequest::new(mode, reason, initiator))
        }

        fn is_stopping(&self, unit: &AgentUnit) -> bool {
            unit.stop_in_flight().is_some()
        }
    }

    fn seed_with(lifecycle: Arc<CancellingLifecycle>) -> UnitSeed {
        UnitSeed {
            // An empty state root keeps the unit records in memory.
            services: CodexUnitServices {
                containment: Containment::tag_backend(Default::default()),
                lifecycle,
            },
            label: UnitLabel {
                provider: "codex".to_string(),
                mode: "codex".to_string(),
                ..Default::default()
            },
        }
    }

    #[tokio::test]
    async fn each_mint_is_a_new_unit_announced_to_the_lifecycle() {
        let lifecycle = Arc::new(CancellingLifecycle::default());
        let seed = seed_with(lifecycle.clone());
        let first = seed.mint_attempt().expect("first attempt");
        let second = seed.mint_attempt().expect("second attempt");
        assert_ne!(first.id(), second.id(), "one unit per attempt");
        let announced: Vec<_> = lifecycle
            .attempts
            .lock()
            .unwrap()
            .iter()
            .map(|unit| unit.id().clone())
            .collect();
        assert_eq!(announced, vec![first.id().clone(), second.id().clone()]);
    }

    #[tokio::test]
    async fn a_cancelled_start_mints_no_unit() {
        let lifecycle = Arc::new(CancellingLifecycle::default());
        lifecycle
            .cancelled
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let seed = seed_with(lifecycle.clone());
        assert_eq!(
            seed.mint_attempt().map(|unit| unit.id().clone()),
            Err(CODEX_START_CANCELLED_MESSAGE.to_string())
        );
        assert!(lifecycle.attempts.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_kill_racing_the_mint_stops_the_new_unit_and_refuses_the_attempt() {
        let lifecycle = Arc::new(CancellingLifecycle {
            cancel_on_attempt: true,
            ..Default::default()
        });
        let seed = seed_with(lifecycle.clone());
        assert_eq!(
            seed.mint_attempt().map(|unit| unit.id().clone()),
            Err(CODEX_START_CANCELLED_MESSAGE.to_string())
        );
        let minted = lifecycle.attempts.lock().unwrap().clone();
        assert_eq!(minted.len(), 1, "the racing kill saw the minted unit");
        let stop = minted[0]
            .stop_in_flight()
            .expect("the memberless unit is stopped through the lifecycle");
        let report = stop.wait().await;
        assert_eq!(report.reason, "start-cancelled");
    }

    // ── the directory-backed lifecycle: a pane start's attempts in its directory entry ──

    /// A pane start registered the way the unit lifecycle registers one: its
    /// own base unit, a create-request id and no terminal yet.
    fn registered_start(directory: &Arc<UnitDirectory>) -> (Containment, AgentUnit) {
        let containment = Containment::tag_backend(Default::default());
        let base = containment
            .create_unit(UnitId::mint(), UnitLabel::default())
            .expect("base unit");
        directory.register(UnitEntry {
            unit: base.clone(),
            provider: "codex".into(),
            mode: "codex".into(),
            create_request_id: Some("crq-dir".into()),
            terminal_id: None,
        });
        (containment, base)
    }

    fn directory_seed(
        containment: Containment,
        lifecycle: Arc<DirectoryUnitLifecycle>,
    ) -> UnitSeed {
        UnitSeed {
            services: CodexUnitServices {
                containment,
                lifecycle,
            },
            label: UnitLabel {
                provider: "codex".to_string(),
                mode: "codex".to_string(),
                ..Default::default()
            },
        }
    }

    #[tokio::test]
    async fn each_attempt_takes_over_the_starts_directory_entry() {
        let directory = UnitDirectory::new();
        let (containment, base) = registered_start(&directory);
        let lifecycle = DirectoryUnitLifecycle::new(directory.clone(), base.clone());
        let seed = directory_seed(containment, lifecycle.clone());

        let attempt = seed.mint_attempt().expect("attempt");
        assert_eq!(
            directory.by_create_request("crq-dir").unwrap().unit.id(),
            attempt.id(),
            "a kill by create-request id now reaches the attempt's unit"
        );
        assert_eq!(lifecycle.current().id(), attempt.id());
        assert!(
            base.stop_in_flight().is_none(),
            "the base unit waits for the plan's end"
        );
    }

    #[tokio::test]
    async fn a_failed_attempts_stop_never_cancels_the_start() {
        let directory = UnitDirectory::new();
        let (containment, base) = registered_start(&directory);
        let lifecycle = DirectoryUnitLifecycle::new(directory.clone(), base.clone());
        let seed = directory_seed(containment, lifecycle.clone());

        let failed = seed.mint_attempt().expect("first attempt");
        let report = seed
            .stop(
                &failed,
                StopMode::Force,
                StopReason::StartCancelled,
                "codex-sidecar-start-failed",
            )
            .wait()
            .await;
        assert_eq!(report.reason, "start-cancelled");
        assert!(!seed.start_cancelled(), "the plan may retry");
        assert_eq!(
            directory.by_create_request("crq-dir").unwrap().unit.id(),
            base.id(),
            "between attempts the start's entry names its base unit again"
        );
        let retry = seed.mint_attempt().expect("the retry is allowed");
        assert_eq!(
            directory.by_create_request("crq-dir").unwrap().unit.id(),
            retry.id()
        );
    }

    #[tokio::test]
    async fn a_kill_between_attempts_cancels_the_start_and_refuses_the_next() {
        let directory = UnitDirectory::new();
        let (containment, base) = registered_start(&directory);
        let lifecycle = DirectoryUnitLifecycle::new(directory.clone(), base.clone());
        let seed = directory_seed(containment, lifecycle.clone());

        let attempt = seed.mint_attempt().expect("attempt");
        // The user's kill finds the start by its create-request id.
        let entry = directory.by_create_request("crq-dir").unwrap();
        assert!(directory.cancel_start(entry.unit.id()));
        seed.stop(
            &attempt,
            StopMode::Force,
            StopReason::StartCancelled,
            "codex-sidecar-start-failed",
        )
        .wait()
        .await;
        assert!(seed.start_cancelled(), "the cancellation follows the start");
        assert_eq!(
            seed.mint_attempt().map(|unit| unit.id().clone()),
            Err(CODEX_START_CANCELLED_MESSAGE.to_string())
        );
    }

    #[tokio::test]
    async fn the_plans_end_stops_the_unused_base_and_later_stops_use_the_entry() {
        let directory = UnitDirectory::new();
        let (containment, base) = registered_start(&directory);
        let lifecycle = DirectoryUnitLifecycle::new(directory.clone(), base.clone());
        let seed = directory_seed(containment, lifecycle.clone());

        let launched = seed.mint_attempt().expect("attempt");
        lifecycle.finish_planning(Some(launched.clone()));
        let base_stop = base
            .stop_in_flight()
            .expect("the unused base unit is stopped at the plan's end");
        assert_eq!(base_stop.wait().await.reason, "start-cancelled");
        assert_eq!(
            directory.by_create_request("crq-dir").unwrap().unit.id(),
            launched.id()
        );

        // A pane stop (no lifecycle installed: straight to the unit) leaves
        // the entry in place for the stop's own Gone publication.
        seed.stop(
            &launched,
            StopMode::Force,
            StopReason::ServerShutdown,
            "server-shutdown",
        )
        .wait()
        .await;
        assert_eq!(
            directory.by_create_request("crq-dir").unwrap().unit.id(),
            launched.id(),
            "after the plan a stop is the pane's stop, not an attempt's"
        );
        assert!(seed.is_stopping(&launched));
    }

    #[tokio::test]
    async fn a_removed_start_counts_as_cancelled() {
        let directory = UnitDirectory::new();
        let (containment, base) = registered_start(&directory);
        let lifecycle = DirectoryUnitLifecycle::new(directory.clone(), base.clone());
        let seed = directory_seed(containment, lifecycle);
        directory.remove(base.id());
        assert!(
            seed.start_cancelled(),
            "a start whose entry is gone is over"
        );
    }
}
