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
//! The [`SessionNameGenerator`] supplies generation EXECUTION to the Task 3
//! native worker's ONE owned serial loop ([`crate::session_name_native::
//! SessionNameWorker::start`]) under the shared `.session-names-worker.lock`
//! guard; it never spawns another loop. Claim/fold run through the name
//! document (short current-document transactions; the Gemini call itself
//! happens OUTSIDE them); clock injection for the document's retry
//! arithmetic is the store's data-dir-keyed test hook. A disabled naming
//! toggle or a missing OneCLI/direct credential route pauses the work without
//! consumption — the
//! worker's ≤500ms poll re-evaluates capability, so a pause is discovered
//! and resumed within one poll of the capability arriving. The ONE
//! explicit wake caller today is the scoped compatibility route
//! ([`Self::notify_capability_change`], `sessions.rs`'s generate-title
//! arm); the settings PATCH path does NOT wake (the key cell is a bare
//! RwLock with no notify), and `Notify::notify_waiters` is lossy (no
//! permit) — the wake is a latency hint, never a correctness mechanism.
//!
//! Jobs capture the target, series id and input fingerprint; before folding
//! a completion the store compares the captured fingerprint against the
//! persisted series (a re-armed series keeps its series id, so a late answer
//! generated from older input must not be accepted). Only the committed
//! winner publishes; the structured start/retry/exhausted/stale/paused/
//! accepted decisions log severity, operation, name reference, series,
//! attempt and failure class — never prompts, credentials, or payloads.

use std::sync::Arc;
use std::time::Duration;

use uuid::Uuid;

use freshell_protocol::session_names::SessionNameRef;

use crate::ai_title::{self, GeminiSessionNameAuth, GeminiTransport};
use crate::session_names::{SessionNames, MAX_GENERATION_STARTS};
use crate::settings_store::SettingsStore;

#[cfg(test)]
#[path = "session_name_generation_tests.rs"]
mod tests;

/// The per-request bound for one generation attempt ("each request bounded
/// to 20 seconds"). A timeout consumes the attempt exactly once (the start
/// was already persisted by the claim) and schedules the remaining retry
/// delay; it does not cancel anything the provider may still answer late —
/// a late answer folds through the same series/fingerprint guards.
pub const GENERATION_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

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
/// attempt); `Failed` carries the request's failure class.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum GenerationOutcome {
    Answer(String),
    Empty,
    Failed(String),
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
/// already-held background guard. Capability (the naming toggle and the
/// OneCLI/direct credential route) is checked by the worker BEFORE selection,
/// so disabled naming or missing credentials pauses the work without consuming anything and
/// without monopolizing the worker; the worker's ≤500ms poll re-evaluates
/// capability, so a pause is discovered and resumed within one poll of the
/// capability arriving. The ONE explicit wake caller today is the scoped
/// compatibility route (`sessions.rs`'s generate-title arm calls
/// [`Self::notify_capability_change`]); the settings PATCH path does NOT
/// wake, and the wake itself is a lossy latency hint, never a correctness
/// mechanism.
pub struct SessionNameGenerator {
    settings: SettingsStore,
    auth: GeminiSessionNameAuth,
    transport: Arc<dyn GeminiTransport>,
    wake: Arc<tokio::sync::Notify>,
}

impl SessionNameGenerator {
    pub fn new(
        settings: SettingsStore,
        auth: GeminiSessionNameAuth,
        transport: Arc<dyn GeminiTransport>,
    ) -> Self {
        Self {
            settings,
            auth,
            transport,
            wake: Arc::new(tokio::sync::Notify::new()),
        }
    }

    /// Whether generation may run right now: session naming has an applicable
    /// OneCLI route or a direct key AND the user's `sidebar.autoGenerateTitles`
    /// setting is on. A `false`
    /// answer is a capability pause — the armed series keeps its whole
    /// allowance and stays discoverable; nothing is consumed.
    pub async fn capability_ready(&self) -> bool {
        if !self.auth.enabled() {
            return false;
        }
        self.settings.get().await.sidebar.auto_generate_titles
    }

    /// Wake capability-paused remaining work: a settings/key capability
    /// change makes the next poll re-evaluate immediately. Never replenishes
    /// exhausted attempts (the claim enforces the cap regardless).
    pub fn notify_capability_change(&self) {
        self.wake.notify_waiters();
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
            let call = ai_title::generate_ai_session_title(
                self.transport.as_ref(),
                &excerpt,
                custom_prompt.as_deref(),
            );
            match tokio::time::timeout(GENERATION_REQUEST_TIMEOUT, call).await {
                Ok(Ok(Some(title))) => GenerationOutcome::Answer(title),
                Ok(Ok(None)) => GenerationOutcome::Empty,
                Ok(Err(reason)) => GenerationOutcome::Failed(reason),
                Err(_) => GenerationOutcome::Failed(
                    "the generation request exceeded the 20-second bound".to_string(),
                ),
            }
        };
        if let GenerationOutcome::Failed(reason) = &outcome {
            tracing::warn!(
                target: "freshell_server::session_name_generation",
                op = "generation_attempt",
                name_ref = %freshell_freshagent::naming::name_ref_debug_key(&claim.target),
                series = %claim.series_id,
                attempt = %claim.attempt_id,
                consumed = claim.consumed,
                class = "failed",
                "session_names.generation_failed: {reason}"
            );
        }
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
                let class = if claim.consumed >= MAX_GENERATION_STARTS {
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
}
