//! Name-reliability Task 6: which credential AI naming uses, and the pause
//! that keeps a refused credential from using up anything.
//!
//! **Route by credential (D5 as amended), decided per attempt from the live
//! key cell:**
//! 1. A key is configured (`GOOGLE_GENERATIVE_AI_API_KEY`, else
//!    `settings.ai.geminiApiKey`; a Settings save takes effect at the next
//!    attempt) → the [`NamingRoute::Key`] route: the key is always sent. When
//!    the ambient proxy for the Gemini URL carries the OneCLI marker, the
//!    keyed request goes DIRECT ([`KeyRouteTransport::Direct`]): OneCLI is
//!    the launching agent's credential broker, its token may not outlive that
//!    agent, and direct was proven on this host. Any other ambient proxy is
//!    honored ([`KeyRouteTransport::AmbientProxy`]), so hosts whose only way
//!    out is an ordinary proxy keep working.
//! 2. Else the ambient proxy is OneCLI's → [`NamingRoute::InheritedOneCli`]:
//!    no key is sent and the server borrows the launching shell's OneCLI
//!    identity (one boot WARN says so).
//! 3. Else [`NamingRoute::Unavailable`]: no claims.
//!
//! One request per attempt; there is no fallback between routes.
//!
//! **The pause ([`CapabilityLatch`]).** A capability failure (credential,
//! permission, proxy, certificate) pauses AI naming until a re-probe time
//! (15 minutes; Rust-only test seam `FRESHELL_NAMING_CAPABILITY_REPROBE_MS`)
//! or a key change; a quota answer pauses with a shorter, growing re-probe
//! (60 s doubling per consecutive throttled probe, capped at 15 minutes;
//! test seam `FRESHELL_NAMING_THROTTLE_REPROBE_MS` sets the base). While
//! paused the worker claims nothing; one probe runs per window. Both kinds
//! refund the attempt, so a paused series keeps its allowance and its
//! naming input.

use std::sync::Mutex;
use std::time::Duration;

use tokio::time::Instant;

use crate::ai_title::{AiKeyCell, BoxFuture, GeminiProxyEnvironment};
use crate::gemini_failure::{GeminiFailure, GeminiFailureClass};

/// The session-name provider call: one prompt in, the answer text or a
/// classified failure out.
pub trait SessionNameTransport: Send + Sync {
    fn generate_content(
        &self,
        prompt: String,
        max_output_tokens: u32,
    ) -> BoxFuture<Result<String, GeminiFailure>>;
}

/// How a keyed request leaves the host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyRouteTransport {
    /// A client that ignores the ambient proxy (the ambient proxy is OneCLI's).
    Direct,
    /// The normal client, which honors `HTTPS_PROXY`/`NO_PROXY`.
    AmbientProxy,
}

impl KeyRouteTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::AmbientProxy => "ambient_proxy",
        }
    }
}

/// The credential route of one naming attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NamingRoute {
    Key(KeyRouteTransport),
    InheritedOneCli,
    Unavailable,
}

impl NamingRoute {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Key(_) => "key",
            Self::InheritedOneCli => "inherited_onecli",
            Self::Unavailable => "unavailable",
        }
    }

    pub fn is_available(self) -> bool {
        self != Self::Unavailable
    }

    /// Whether a request on this route traverses a proxy.
    pub fn request_via_proxy(self, facts: ProxyFacts) -> bool {
        match self {
            Self::Key(KeyRouteTransport::Direct) | Self::Unavailable => false,
            Self::Key(KeyRouteTransport::AmbientProxy) | Self::InheritedOneCli => facts.via_proxy,
        }
    }
}

/// What the ambient proxy environment does to the Gemini URL, computed once
/// at construction (the environment is read once, as reqwest does). Only
/// booleans: proxy URLs can carry credentials and never leave this check.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProxyFacts {
    /// A proxy applies to the Gemini URL.
    pub via_proxy: bool,
    /// That proxy carries OneCLI's authorization marker.
    pub onecli_marker: bool,
}

impl ProxyFacts {
    /// How a keyed request would leave the host under these facts.
    pub fn key_route_transport(self) -> KeyRouteTransport {
        if self.onecli_marker {
            KeyRouteTransport::Direct
        } else {
            KeyRouteTransport::AmbientProxy
        }
    }
}

/// The proxy facts for `url` under `proxy_env` (the effective proxy reqwest
/// would use, NO_PROXY applied).
pub fn proxy_facts(proxy_env: &GeminiProxyEnvironment, url: &str) -> ProxyFacts {
    let proxy = proxy_env.proxy_for_url(url);
    ProxyFacts {
        via_proxy: proxy.is_some(),
        onecli_marker: proxy.is_some_and(crate::ai_title::has_onecli_authorization),
    }
}

/// The route of the next attempt (see the module doc).
pub fn select_naming_route(key_cell: &AiKeyCell, facts: ProxyFacts) -> NamingRoute {
    if key_cell.enabled() {
        NamingRoute::Key(facts.key_route_transport())
    } else if facts.onecli_marker {
        NamingRoute::InheritedOneCli
    } else {
        NamingRoute::Unavailable
    }
}

// ---------------------------------------------------------------------------
// The pause
// ---------------------------------------------------------------------------

/// Default re-probe after a capability failure.
pub const DEFAULT_CAPABILITY_REPROBE: Duration = Duration::from_secs(15 * 60);
/// Default first re-probe after a quota answer.
pub const DEFAULT_THROTTLE_REPROBE: Duration = Duration::from_secs(60);
/// The longest throttle re-probe.
pub const THROTTLE_REPROBE_CAP: Duration = Duration::from_secs(15 * 60);

const CAPABILITY_REPROBE_ENV: &str = "FRESHELL_NAMING_CAPABILITY_REPROBE_MS";
const THROTTLE_REPROBE_ENV: &str = "FRESHELL_NAMING_THROTTLE_REPROBE_MS";

/// The two re-probe windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LatchWindows {
    pub capability: Duration,
    pub throttle_base: Duration,
}

impl Default for LatchWindows {
    fn default() -> Self {
        Self {
            capability: DEFAULT_CAPABILITY_REPROBE,
            throttle_base: DEFAULT_THROTTLE_REPROBE,
        }
    }
}

impl LatchWindows {
    /// The windows from the Rust-only test seams (read once, at boot).
    pub fn from_environment() -> Self {
        Self::from_values(
            std::env::var(CAPABILITY_REPROBE_ENV).ok().as_deref(),
            std::env::var(THROTTLE_REPROBE_ENV).ok().as_deref(),
        )
    }

    /// Parse the seam values: a positive millisecond count, else the default.
    pub fn from_values(capability_ms: Option<&str>, throttle_ms: Option<&str>) -> Self {
        fn millis(value: Option<&str>) -> Option<Duration> {
            value
                .and_then(|value| value.trim().parse::<u64>().ok())
                .filter(|ms| *ms > 0)
                .map(Duration::from_millis)
        }
        let defaults = Self::default();
        Self {
            capability: millis(capability_ms).unwrap_or(defaults.capability),
            throttle_base: millis(throttle_ms).unwrap_or(defaults.throttle_base),
        }
    }
}

/// What kind of pause is in force.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PauseKind {
    Capability,
    Throttled,
}

/// What one recorded outcome did to the pause (the caller logs it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LatchTransition {
    /// Nothing a log needs to say.
    Unchanged,
    /// Naming is newly paused, or paused for a different reason.
    Paused { kind: PauseKind, code: String },
    /// A probe reached the provider: naming runs again.
    Restored,
}

/// The in-memory naming pause (see the module doc). Tokio's clock, so the
/// worker's sleeps and the windows agree.
pub struct CapabilityLatch {
    windows: LatchWindows,
    state: Mutex<LatchState>,
}

#[derive(Default)]
struct LatchState {
    pause: Option<Pause>,
    /// Consecutive throttled outcomes (sets the next throttle window).
    throttle_streak: u32,
}

struct Pause {
    kind: PauseKind,
    code: String,
    window: Duration,
    until: Instant,
}

impl CapabilityLatch {
    pub fn new(windows: LatchWindows) -> Self {
        Self {
            windows,
            state: Mutex::new(LatchState::default()),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, LatchState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Whether an attempt may run now: no pause, or its re-probe time came.
    pub fn ready(&self, now: Instant) -> bool {
        self.state()
            .pause
            .as_ref()
            .is_none_or(|pause| now >= pause.until)
    }

    /// Time left until the re-probe, when paused.
    pub fn reprobe_in(&self, now: Instant) -> Option<Duration> {
        self.state()
            .pause
            .as_ref()
            .map(|pause| pause.until.saturating_duration_since(now))
    }

    /// The pause in force, if any.
    #[cfg(test)]
    pub fn pause_kind(&self) -> Option<PauseKind> {
        self.state().pause.as_ref().map(|pause| pause.kind)
    }

    /// Record a failed attempt. A capability failure pauses for the
    /// capability window; a quota answer pauses for the throttle window,
    /// doubling per consecutive throttled outcome up to the cap. A failure
    /// that still got an HTTP answer reached the provider and restores
    /// naming; one with no answer (a timeout, a broken connection) proves
    /// nothing and only re-arms a pause already in force.
    pub fn record_failure(&self, failure: &GeminiFailure, now: Instant) -> LatchTransition {
        let mut state = self.state();
        match failure.class {
            GeminiFailureClass::Capability => {
                state.throttle_streak = 0;
                Self::pause(
                    &mut state,
                    PauseKind::Capability,
                    failure.code(),
                    self.windows.capability,
                    now,
                )
            }
            GeminiFailureClass::Throttled => {
                state.throttle_streak = state.throttle_streak.saturating_add(1);
                let doublings = state.throttle_streak.saturating_sub(1).min(31);
                let window = self
                    .windows
                    .throttle_base
                    .saturating_mul(1u32 << doublings)
                    .min(THROTTLE_REPROBE_CAP);
                Self::pause(
                    &mut state,
                    PauseKind::Throttled,
                    failure.code(),
                    window,
                    now,
                )
            }
            GeminiFailureClass::Transient | GeminiFailureClass::Invalid => {
                if failure.status.is_some() {
                    return Self::restore(&mut state);
                }
                if let Some(pause) = state.pause.as_mut() {
                    pause.until = now + pause.window;
                }
                LatchTransition::Unchanged
            }
        }
    }

    /// Record an attempt whose request reached the provider and was not
    /// refused (an answer, an empty answer).
    pub fn record_reachable(&self) -> LatchTransition {
        Self::restore(&mut self.state())
    }

    /// A key change: clear both pauses. `true` when one was in force.
    pub fn clear(&self) -> bool {
        let mut state = self.state();
        state.throttle_streak = 0;
        state.pause.take().is_some()
    }

    fn pause(
        state: &mut LatchState,
        kind: PauseKind,
        code: String,
        window: Duration,
        now: Instant,
    ) -> LatchTransition {
        let same = state
            .pause
            .as_ref()
            .is_some_and(|pause| pause.kind == kind && pause.code == code);
        state.pause = Some(Pause {
            kind,
            code: code.clone(),
            window,
            until: now + window,
        });
        if same {
            LatchTransition::Unchanged
        } else {
            LatchTransition::Paused { kind, code }
        }
    }

    fn restore(state: &mut LatchState) -> LatchTransition {
        state.throttle_streak = 0;
        if state.pause.take().is_some() {
            LatchTransition::Restored
        } else {
            LatchTransition::Unchanged
        }
    }
}

// ---------------------------------------------------------------------------
// A key saved in Settings
// ---------------------------------------------------------------------------

/// The Settings save path for the Gemini key (blank never clears the cell).
/// The saved value joins the log writer's live secrets before anything can
/// log, and a CHANGED key tells the naming generator, which clears both
/// pauses and wakes the worker (an unchanged re-save, which every Settings
/// save performs, changes nothing). `true` when the key changed.
pub fn apply_saved_gemini_key(
    key_cell: &AiKeyCell,
    log_secrets: &freshell_runtime_observability::LiveSecrets,
    generator: Option<&crate::session_name_generation::SessionNameGenerator>,
    saved: Option<&str>,
) -> bool {
    let Some(saved) = saved.filter(|key| !key.is_empty()) else {
        return false;
    };
    log_secrets.insert(saved);
    let changed = key_cell.get().as_deref() != Some(saved);
    key_cell.apply_settings_key_forced(Some(saved));
    if changed {
        if let Some(generator) = generator {
            generator.notify_capability_change();
        }
    }
    changed
}

#[cfg(test)]
#[path = "session_name_capability_tests.rs"]
pub(crate) mod tests;
