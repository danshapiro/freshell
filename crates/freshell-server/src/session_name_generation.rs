//! Reliable server-driven automatic session-name generation (unified-agent-
//! names plan, Task 4).
//!
//! Generation is ACTIVITY-DRIVEN and durable: the naming document's
//! per-record generation series (Task 1's `generation` section — status,
//! series id, input fingerprint, bounded excerpt, persisted attempt
//! identities/start times, consumed count, nextDue, exhaustion time) is the
//! one scheduling authority. First eligibility is immediately ready; after
//! failure 1 the retry becomes due in 30 seconds, after failure 2 in five
//! minutes, and each request is bounded to 20 seconds
//! ([`GENERATION_REQUEST_TIMEOUT`]). Empty/invalid answers and interrupted
//! starts consume an attempt; the start is persisted before dispatch
//! ([`SessionNames::claim_generation_start`]); an interrupted start is
//! recovered once as failed at recovery time
//! ([`SessionNames::recover_interrupted_generation`], discovered while the
//! worker holds the shared background guard — only a guard-holder ever
//! dispatches, so an in-flight series seen under the guard is provably
//! dead). At three consumed starts the series stays exhausted across
//! messages, opens, reconnects, title changes and restarts — there is no
//! automatic rearm and no daily-budget subsystem.
//!
//! Name-reliability Task 6: a credential, permission, proxy or quota failure
//! is not a consumed attempt. The fold REFUNDS it (the series keeps its
//! allowance and its naming input, and waits behind the series already
//! due, so the probe after the pause tries another session first) and the
//! in-memory pause ([`crate::session_name_capability::CapabilityLatch`])
//! stops claims until a re-probe time or a key change; exhaustion moved
//! from the claim to the fold, so a refunded third start keeps the series.
//!
//! The [`SessionNameGenerator`] supplies generation EXECUTION to the Task 3
//! native worker's ONE owned serial loop ([`crate::session_name_native::
//! SessionNameWorker::start`]) under the shared `.session-names-worker.lock`
//! guard; it never spawns another loop. Claim/fold run through the name
//! document (short current-document transactions; the Gemini call itself
//! happens OUTSIDE them); clock injection for the document's retry
//! arithmetic is the store's data-dir-keyed test hook. A disabled naming
//! toggle, no credential route, or the naming pause stops the work without
//! consumption — the worker's ≤500ms poll (shortened to the pause's
//! re-probe time) re-evaluates capability. A key saved in Settings calls
//! [`SessionNameGenerator::notify_capability_change`] (clears the pause and
//! wakes the worker); the scoped generate-title compatibility route calls
//! [`SessionNameGenerator::wake`]. `Notify::notify_waiters` is lossy (no
//! permit) — the wake is a latency hint, never a correctness mechanism.
//!
//! Jobs capture the target, series id and input fingerprint; before folding
//! a completion the store compares the captured fingerprint against the
//! persisted series (a re-armed series keeps its series id, so a late answer
//! generated from older input must not be accepted, though the start it was
//! charged still settles — refunded, or counted toward exhaustion). A key
//! change starts a new pause epoch, so a refusal of the old key that lands
//! afterwards is refunded without pausing naming. Only the committed
//! winner publishes; the structured start/retry/exhausted/stale/paused/
//! accepted decisions log severity, operation, name reference, series,
//! attempt and failure class — never prompts, credentials, or payloads.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use uuid::Uuid;

use freshell_protocol::session_names::SessionNameRef;

use crate::ai_title::{self, GeminiSessionNameAuth};
use crate::gemini_failure::{GeminiFailure, GeminiFailureClass};
use crate::session_name_capability::{
    CapabilityLatch, LatchEpoch, LatchTransition, LatchWindows, NamingRoute, SessionNameTransport,
};
use crate::session_names::{SessionNames, MAX_GENERATION_STARTS};
use crate::settings_store::SettingsStore;

#[cfg(test)]
#[path = "session_name_generation_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "session_name_generation_capability_tests.rs"]
mod capability_tests;

#[cfg(test)]
#[path = "session_name_generation_pause_tests.rs"]
mod pause_tests;

/// The per-request bound for one generation attempt ("each request bounded
/// to 20 seconds"). A timeout consumes the attempt exactly once (the start
/// was already persisted by the claim) and schedules the remaining retry
/// delay; it does not cancel anything the provider may still answer late —
/// a late answer folds through the same series/fingerprint guards.
pub const GENERATION_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

// A dropped connect must fail as a connect error (a pause that uses no
// attempt) before this bound charges the attempt as a timeout.
const _: () = assert!(
    ai_title::SESSION_NAME_CONNECT_TIMEOUT.as_millis() < GENERATION_REQUEST_TIMEOUT.as_millis()
);

// ---------------------------------------------------------------------------
// Store-facing work shapes (produced/consumed by the session_names seams)
// ---------------------------------------------------------------------------

/// One armed generation series discovered by
/// [`SessionNames::generation_work_snapshot`]: only Eligible, due, unexhausted
/// series on records whose accepted source is below Freshell AI reach the
/// scheduler.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GenerationWorkItem {
    pub target: SessionNameRef,
    pub series_id: String,
    pub input_fingerprint: String,
    pub excerpt: Option<String>,
    pub consumed: u32,
    pub next_due: Option<i64>,
}

/// The charged attempt returned by [`SessionNames::claim_generation_start`]:
/// everything the dispatch needs (the bounded excerpt is the generation
/// input; the series id and input fingerprint ride every fold so a
/// re-armed or superseded series rejects the late answer).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GenerationClaim {
    pub target: SessionNameRef,
    pub series_id: String,
    pub input_fingerprint: String,
    pub excerpt: Option<String>,
    pub attempt_id: String,
    pub consumed: u32,
}

/// One classified generation outcome folded back into the durable series.
/// `Answer` carries a non-empty candidate (validation and acceptance are
/// the store's); `Empty` is an empty/invalid answer (it consumes the
/// attempt); `Failed` carries the request's failure class (it consumes).
/// `CapabilityUnavailable` and `Throttled` (name-reliability Task 6) are
/// refunded: the claimed start identified by `attempt_id` is given back and
/// the series is Eligible again with its input.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum GenerationOutcome {
    Answer(String),
    Empty,
    Failed(String),
    CapabilityUnavailable { attempt_id: String },
    Throttled { attempt_id: String },
}

/// Hydration input for one index-observed scoped CLI session
/// ([`SessionNames::hydrate_indexed`]): the free fallback inputs — a
/// provider-authored title, the first user message, and the session cwd.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct IndexedNameInput {
    pub provider: freshell_protocol::session_names::NamedProvider,
    pub session_id: String,
    pub cwd: Option<String>,
    pub first_user_message: Option<String>,
    pub provider_title: Option<String>,
}

// ---------------------------------------------------------------------------
// The generator (execution only — the worker owns the loop and the guard)
// ---------------------------------------------------------------------------

/// Generation execution for the shared serial worker. Constructed once in
/// `main` and handed to [`crate::session_name_native::SessionNameWorker::start`];
/// [`Self::run_due_attempt`] performs one claimed attempt under the worker's
/// already-held background guard. Capability (the naming toggle, the
/// credential route, and the naming pause) is checked by the worker BEFORE
/// selection, so disabled naming, missing credentials or a refused
/// credential pause the work without consuming anything and without
/// monopolizing the worker. A key saved in Settings calls
/// [`Self::notify_capability_change`]; the scoped generate-title
/// compatibility route calls [`Self::wake`]; both wakes are lossy latency
/// hints, never correctness mechanisms.
pub struct SessionNameGenerator {
    settings: SettingsStore,
    auth: GeminiSessionNameAuth,
    transport: Arc<dyn SessionNameTransport>,
    latch: CapabilityLatch,
    /// The inherited-identity WARN is said once per process.
    inherited_route_warned: AtomicBool,
    wake: Arc<tokio::sync::Notify>,
}

impl SessionNameGenerator {
    /// The pause windows come from the Rust-only test seams
    /// (`FRESHELL_NAMING_CAPABILITY_REPROBE_MS`,
    /// `FRESHELL_NAMING_THROTTLE_REPROBE_MS`), else the defaults.
    pub fn new(
        settings: SettingsStore,
        auth: GeminiSessionNameAuth,
        transport: Arc<dyn SessionNameTransport>,
    ) -> Self {
        Self {
            settings,
            auth,
            transport,
            latch: CapabilityLatch::new(LatchWindows::from_environment()),
            inherited_route_warned: AtomicBool::new(false),
            wake: Arc::new(tokio::sync::Notify::new()),
        }
    }

    /// Replace the pause windows (tests).
    #[cfg(test)]
    pub(crate) fn with_latch_windows(mut self, windows: LatchWindows) -> Self {
        self.latch = CapabilityLatch::new(windows);
        self
    }

    #[cfg(test)]
    pub(crate) fn latch(&self) -> &CapabilityLatch {
        &self.latch
    }

    /// Whether generation may run right now: a credential route exists,
    /// naming is not paused (or its re-probe time came), AND the user's
    /// `sidebar.autoGenerateTitles` setting is on. A `false` answer pauses
    /// without consuming anything: armed series keep their whole allowance
    /// and stay discoverable.
    pub async fn capability_ready(&self) -> bool {
        if !self.auth.route().is_available() {
            return false;
        }
        if !self.latch.ready(tokio::time::Instant::now()) {
            return false;
        }
        self.settings.get().await.sidebar.auto_generate_titles
    }

    /// How long the idle worker may sleep: its poll, shortened so a paused
    /// series is re-probed when its window ends (an already-due re-probe
    /// keeps the plain poll, so an idle worker never spins).
    pub(crate) fn idle_poll(&self, poll: Duration) -> Duration {
        match self.latch.reprobe_in(tokio::time::Instant::now()) {
            Some(left) if !left.is_zero() => left.min(poll),
            _ => poll,
        }
    }

    /// The saved Gemini key changed: clear both pauses (the route is chosen
    /// per attempt from the key cell, so the next attempt already uses the
    /// new key), say which route naming now uses, and wake the worker.
    /// Never replenishes exhausted attempts (the claim enforces the cap
    /// regardless).
    pub fn notify_capability_change(&self) {
        let cleared = self.latch.clear();
        self.log_route_selected("key_change", cleared);
        self.wake.notify_waiters();
    }

    /// Wake the worker so already-eligible work runs at once (a latency
    /// hint: it clears no pause and replenishes nothing).
    pub fn wake(&self) {
        self.wake.notify_waiters();
    }

    /// The boot line: which route AI naming uses, and (only on the
    /// inherited OneCLI route) the WARN that the server borrows the
    /// launching shell's OneCLI identity.
    pub fn log_boot_route(&self) {
        self.log_route_selected("boot", false);
    }

    fn log_route_selected(&self, reason: &'static str, pause_cleared: bool) {
        let route = self.auth.route();
        let facts = self.auth.facts();
        tracing::info!(
            target: "freshell_server::session_name_generation",
            op = "generation_route",
            reason,
            route = route.as_str(),
            onecli_marker = facts.onecli_marker,
            key_configured = self.auth.key_configured(),
            key_route_transport = facts.key_route_transport().as_str(),
            pause_cleared,
            "session_names.generation_route_selected: AI naming uses the {} route",
            route.as_str()
        );
        if route == NamingRoute::InheritedOneCli
            && !self.inherited_route_warned.swap(true, Ordering::SeqCst)
        {
            tracing::warn!(
                target: "freshell_server::session_name_generation",
                op = "generation_route",
                route = route.as_str(),
                "session_names.generation_route_inherited_identity: no Gemini key is configured, so AI naming borrows the OneCLI identity of the shell that launched the server; enter a key in Settings to stop depending on it"
            );
        }
    }

    /// The capability-change listener the worker selects alongside its poll.
    pub(crate) fn wake_notify(&self) -> &tokio::sync::Notify {
        &self.wake
    }

    /// Drive ONE due attempt: claim the start (persisted before dispatch —
    /// the claim is the transaction), call Gemini outside any document
    /// transaction under the 20-second request bound, then fold the
    /// classified outcome back through the document with the captured
    /// series id and input fingerprint. Only the committed winner
    /// publishes (the store's fold decides); this side logs the structured
    /// start/retry/exhausted/stale/accepted decisions.
    pub(crate) async fn run_due_attempt(
        &self,
        names: &Arc<SessionNames>,
        item: &GenerationWorkItem,
    ) {
        let attempt_id = Uuid::new_v4().to_string();
        let Ok(claim) = names
            .claim_generation_start(item.target.clone(), attempt_id)
            .await
        else {
            return; // the store logs its own failure classes
        };
        let Some(claim) = claim else {
            tracing::debug!(
                target: "freshell_server::session_name_generation",
                op = "generation_claim",
                name_ref = %freshell_freshagent::naming::name_ref_debug_key(&item.target),
                series = %item.series_id,
                class = "stale",
                "session_names.generation_stale: the series moved before the claim"
            );
            return;
        };
        tracing::info!(
            target: "freshell_server::session_name_generation",
            op = "generation_start",
            name_ref = %freshell_freshagent::naming::name_ref_debug_key(&claim.target),
            series = %claim.series_id,
            attempt = %claim.attempt_id,
            consumed = claim.consumed,
            class = "started",
            "session_names.generation_started: attempt {} of the bounded series",
            claim.consumed
        );
        self.dispatch_claimed_attempt(names, &claim).await;
    }

    /// Dispatch ONE claimed attempt: re-check the winner, call the provider
    /// outside any document transaction under the 20-second request bound,
    /// then fold the classified outcome back through the document with the
    /// captured series id and input fingerprint. Split from
    /// [`Self::run_due_attempt`] so the claim→dispatch window is testable
    /// (the materialization race below).
    pub(crate) async fn dispatch_claimed_attempt(
        &self,
        names: &Arc<SessionNames>,
        claim: &GenerationClaim,
    ) {
        // The materialization race: a MANUAL pending winner can bind
        // between the claim and the dispatch (the sweep armed the durable
        // session's series before the naming bind transferred the pending
        // record). A protected winner stops generation — re-check before
        // paying the provider call; the fold's protected arm then closes
        // the series without a retry.
        if names.generation_blocked_by_protected_winner(&claim.target) {
            tracing::info!(
                target: "freshell_server::session_name_generation",
                op = "generation_superseded",
                name_ref = %freshell_freshagent::naming::name_ref_debug_key(&claim.target),
                series = %claim.series_id,
                attempt = %claim.attempt_id,
                consumed = claim.consumed,
                class = "superseded",
                "session_names.generation_superseded: a protected winner landed after the claim; the call is skipped"
            );
            let _ = names
                .fold_generation_outcome(
                    claim.target.clone(),
                    claim.series_id.clone(),
                    claim.input_fingerprint.clone(),
                    GenerationOutcome::Empty,
                )
                .await;
            return;
        }
        let excerpt = claim.excerpt.clone().unwrap_or_default();
        let outcome = if excerpt.trim().is_empty() {
            // An armed series always carries an excerpt; an empty one is an
            // invalid answer — it consumes the attempt like any other.
            GenerationOutcome::Empty
        } else {
            let custom_prompt = self.settings.get().await.ai.title_prompt;
            // Read before the transport picks the key: a key saved while
            // this request is in flight makes its outcome stale.
            let began = self.latch.epoch();
            let call =
                generate_session_name(self.transport.as_ref(), &excerpt, custom_prompt.as_deref());
            let result = tokio::time::timeout(GENERATION_REQUEST_TIMEOUT, call)
                .await
                .unwrap_or_else(|_| Err(GeminiFailure::request_timed_out()));
            self.attempt_outcome(claim, began, result)
        };
        let refunded = matches!(
            outcome,
            GenerationOutcome::CapabilityUnavailable { .. } | GenerationOutcome::Throttled { .. }
        );
        match names
            .fold_generation_outcome(
                claim.target.clone(),
                claim.series_id.clone(),
                claim.input_fingerprint.clone(),
                outcome,
            )
            .await
        {
            Ok(update) if update.changed => {
                tracing::info!(
                    target: "freshell_server::session_name_generation",
                    op = "generation_accepted",
                    name_ref = %freshell_freshagent::naming::name_ref_debug_key(&update.record.name_ref),
                    series = %claim.series_id,
                    attempt = %claim.attempt_id,
                    revision = update.record.revision,
                    class = "accepted",
                    "session_names.generation_accepted: the committed winner published"
                );
            }
            Ok(update) => {
                let class = if refunded {
                    "refunded"
                } else if claim.consumed >= MAX_GENERATION_STARTS {
                    "exhausted"
                } else {
                    "retry_scheduled"
                };
                tracing::info!(
                    target: "freshell_server::session_name_generation",
                    op = "generation_fold",
                    name_ref = %freshell_freshagent::naming::name_ref_debug_key(&update.record.name_ref),
                    series = %claim.series_id,
                    attempt = %claim.attempt_id,
                    revision = update.record.revision,
                    class = class,
                    "session_names.generation_folded: the attempt resolved without a new winner"
                );
            }
            Err(error) => {
                tracing::warn!(
                    target: "freshell_server::session_name_generation",
                    op = "fold_generation_outcome",
                    name_ref = %freshell_freshagent::naming::name_ref_debug_key(&claim.target),
                    series = %claim.series_id,
                    revision = error.log_revision(),
                    class = %error.code(),
                    "session_names.operation_failed: {error}"
                );
            }
        }
    }

    /// Map one finished request to the outcome the store folds, recording it
    /// on the naming pause and logging what a reader needs once: a pause
    /// transition (WARN), a restore (INFO), an outcome the pause ignores
    /// because the key changed after the request began (INFO), or a
    /// consumed failure (WARN with its status and provider code). `began` is
    /// the latch epoch read before the request was built. Never a key, URL
    /// or prompt.
    fn attempt_outcome(
        &self,
        claim: &GenerationClaim,
        began: LatchEpoch,
        result: Result<Option<String>, GeminiFailure>,
    ) -> GenerationOutcome {
        let failure = match result {
            Ok(answer) => {
                self.log_latch_transition(&self.latch.record_reachable(began), None);
                return match answer {
                    Some(title) => GenerationOutcome::Answer(title),
                    None => GenerationOutcome::Empty,
                };
            }
            Err(failure) => failure,
        };
        let transition = self
            .latch
            .record_failure(&failure, tokio::time::Instant::now(), began);
        self.log_latch_transition(&transition, Some(&failure));
        let attempt_id = claim.attempt_id.clone();
        if failure.pauses_naming() {
            tracing::debug!(
                target: "freshell_server::session_name_generation",
                op = "generation_attempt",
                name_ref = %freshell_freshagent::naming::name_ref_debug_key(&claim.target),
                series = %claim.series_id,
                attempt = %claim.attempt_id,
                code = %failure.code(),
                status = failure.status,
                class = if transition == LatchTransition::Superseded {
                    "superseded"
                } else {
                    "paused"
                },
                "session_names.generation_paused: {failure}; the attempt is refunded"
            );
            return if failure.class == GeminiFailureClass::Throttled {
                GenerationOutcome::Throttled { attempt_id }
            } else {
                GenerationOutcome::CapabilityUnavailable { attempt_id }
            };
        }
        tracing::warn!(
            target: "freshell_server::session_name_generation",
            op = "generation_attempt",
            name_ref = %freshell_freshagent::naming::name_ref_debug_key(&claim.target),
            series = %claim.series_id,
            attempt = %claim.attempt_id,
            consumed = claim.consumed,
            status = failure.status,
            provider_code = failure.provider_code.as_deref(),
            class = "failed",
            "session_names.generation_failed: {failure}"
        );
        GenerationOutcome::Failed(failure.to_string())
    }

    fn log_latch_transition(&self, transition: &LatchTransition, failure: Option<&GeminiFailure>) {
        match transition {
            LatchTransition::Unchanged => {}
            LatchTransition::Superseded => {
                tracing::info!(
                    target: "freshell_server::session_name_generation",
                    op = "generation_capability",
                    code = failure.map(GeminiFailure::code).as_deref(),
                    status = failure.and_then(|failure| failure.status),
                    route = self.auth.route().as_str(),
                    "session_names.generation_outcome_superseded: this attempt began before the Gemini key changed, so its result does not pause or restore AI naming"
                );
            }
            LatchTransition::Paused { kind, code } => {
                tracing::warn!(
                    target: "freshell_server::session_name_generation",
                    op = "generation_capability",
                    code = %code,
                    kind = ?kind,
                    status = failure.and_then(|failure| failure.status),
                    route = self.auth.route().as_str(),
                    "session_names.generation_capability_unavailable: AI naming is paused ({code}); nothing is consumed, and it tries again later or when a Gemini key is saved"
                );
            }
            LatchTransition::Restored => {
                tracing::info!(
                    target: "freshell_server::session_name_generation",
                    op = "generation_capability",
                    route = self.auth.route().as_str(),
                    "session_names.generation_capability_restored: AI naming reached the provider again"
                );
            }
        }
    }
}

/// One session-name request: the title prompt for `excerpt`, the answer
/// trimmed and capped, an empty answer `None`.
async fn generate_session_name(
    transport: &dyn SessionNameTransport,
    excerpt: &str,
    custom_prompt: Option<&str>,
) -> Result<Option<String>, GeminiFailure> {
    let prompt = ai_title::build_session_title_prompt(excerpt, custom_prompt);
    let text = transport
        .generate_content(prompt, ai_title::SESSION_TITLE_MAX_OUTPUT_TOKENS)
        .await?;
    Ok(ai_title::finalize_session_title(&text))
}
