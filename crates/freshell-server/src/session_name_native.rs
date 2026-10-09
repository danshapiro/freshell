//! Native provider name synchronization (unified-agent-names plan, Task 3).
//!
//! Writeback is a PROJECTION of an already-committed canonical name, never
//! another authority: only accepted `manual` and `freshell_ai` names are
//! written back, through the provider's supported metadata APIs only. Each
//! eligible desired canonical revision gets a finite native series of at
//! most three cycles (immediately ready, then ≥5s after a cycle-1 failure,
//! then ≥30s after a cycle-2 failure). A cycle permits one current-target
//! read before any retry/reconciliation, at most one write, and one
//! confirming read afterward — at most three writes and six reads per
//! desired revision, each request bounded to 20 seconds (the codex metadata
//! read carries its own dedicated 20s bound —
//! [`freshell_codex::app_server::NATIVE_METADATA_READ_TIMEOUT_MS`] — rather
//! than the 30s full-thread snapshot budget). The cycle/start and every
//! read are charged before dispatch; no location change, reconnect,
//! observation, restart or repeated capability check replenishes these
//! counters. Only a current-revision readback within that allowance can
//! establish the target as synchronized; an old acknowledgement alone
//! cannot. Exhaustion is final for the revision.
//!
//! A pre-write read that answers `None` reports an EXISTING target holding
//! no title yet — divergence, and exactly the state the writeback exists to
//! fill. A missing/archived target is a DIAGNOSED capability failure that
//! arrives through the adapter's error paths (`Unsupported`), never as a
//! `None` readback.
//!
//! An initially absent route or CAPABILITY pauses the series before
//! consuming a cycle: the worker probes [`NativeNameBackend::route_available`]
//! before claiming, so a closed session's pane (no live provider
//! connection), a degraded boot (no wired adapter), or a missing helper
//! keeps the series `pending` with its whole allowance intact, and work
//! proceeds once the capability arrives — a refusal rotates the series
//! out of the selector for a bounded re-probe window, so a paused head
//! can never starve the armed series behind it.
//!
//! The [`SessionNameWorker`] owns the serial dispatch loop under the shared
//! `.session-names-worker.lock` background guard (acquire worker then
//! document, never the reverse; retry delays hold neither lock; the guard is
//! retained through the actual local operation and its owned-helper cleanup,
//! then released despite external ambiguity). Task 4 adds generation to this
//! same owned loop and selector.
//!
//! Provider adapters implement [`NativeNameBackend`]: the Codex app-server
//! client (`thread/name/set` + direct `thread/read` on a root-matched
//! connection), the OpenCode serve PATCH (`update_session_title` with the
//! effective-database context check), and the Claude `session-names.mjs` SDK
//! helper (one JSON line in, one structured line out; Rust owns the timeout
//! and the kill/wait cleanup of the dedicated helper child — never a shared
//! runtime or conversation).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use freshell_freshagent::naming::SessionNaming;
use freshell_protocol::native_location::{
    NativeAcquisition, NativeEvidenceKind, NativeLocation, NativePersistence,
};
use freshell_protocol::session_names::{NameRevision, NameSource, SessionNameRef};
use uuid::Uuid;

use crate::session_names::SessionNames;

#[cfg(test)]
#[path = "session_name_native_tests.rs"]
mod tests;

/// The per-request bound for every native read/write ("each request bounded
/// to 20 seconds"). The Claude helper's process timeout uses this same bound.
pub const NATIVE_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// The worker's work-discovery poll cadence: a cheap in-memory view read.
/// Eligibility delays (the 5s/30s retry floors) govern readiness; this poll
/// is only discovery latency.
const WORKER_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// The bounded window a capability-refused series rotates out of the
/// worker's selection: the next poll selects the next available armed
/// series instead of re-probing the same paused head forever, and the
/// refused series re-probes once the window expires — capability arrival is
/// discovered within one window. Strictly longer than
/// [`WORKER_POLL_INTERVAL`] so lower-priority armed series actually receive
/// slots between re-probes; the series itself is untouched — pending,
/// discoverable, allowance intact.
const CAPABILITY_REPROBE_DELAY: Duration = Duration::from_secs(2);

/// The bounded window a FAILED on-demand route discovery backs the series
/// off for: a permanently-missing transcript (deleted after indexing, an
/// off-machine session id) otherwise re-walks the whole projects tree every
/// [`WORKER_POLL_INTERVAL`] poll, per series, for the process lifetime — a
/// bounded rate over an unbounded duration. The window is worker-local and
/// keyed by the stable name-ref key (route acquisition is
/// revision-independent): a fresh rename on the same series never re-arms
/// the walk early, the series re-attempts once the window expires, and one
/// that acquires its route by another path simply leaves the paused set
/// (its stale entry is harmless and bounded by the paused-set size).
const DISCOVERY_RETRY_WINDOW: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Backend contract
// ---------------------------------------------------------------------------

/// One classified native call outcome. `Confirmed` carries the response
/// value; `Undelivered` is a known-no-effect failure (the request provably
/// never took effect — a connect refusal or a definitive rejection);
/// `Ambiguous` is a possibly-applied failure (timeout, mid-flight drop,
/// post-send error); `Unsupported` is a diagnosed capability failure
/// (unsupported/archived/ephemeral/missing). Native error classification is
/// preserved here — never reduced to a generic timeout.
#[derive(Clone, Debug, PartialEq)]
pub enum NativeCallResult<T> {
    Confirmed(T),
    Undelivered(String),
    Ambiguous(String),
    Unsupported(String),
}

/// A classified non-confirmed outcome of a native operation, T-free so a
/// shared read/write policy helper can classify once and the caller lifts
/// it into the operation's own `NativeCallResult<T>`.
#[derive(Clone, Debug, PartialEq)]
pub enum NativeClassified {
    Undelivered(String),
    Ambiguous(String),
    Unsupported(String),
}

impl NativeClassified {
    fn into_call<T>(self) -> NativeCallResult<T> {
        match self {
            Self::Undelivered(reason) => NativeCallResult::Undelivered(reason),
            Self::Ambiguous(reason) => NativeCallResult::Ambiguous(reason),
            Self::Unsupported(reason) => NativeCallResult::Unsupported(reason),
        }
    }
}

/// The native routing target for one operation: the naming ref (pending or
/// durable — a pending name may target an acquired live native ID without
/// declaring durable restore identity), the provider location to address,
/// and the location revision the evidence was captured at.
#[derive(Clone, Debug, PartialEq)]
pub struct NativeNameTarget {
    pub name_ref: SessionNameRef,
    pub location: NativeLocation,
    pub location_revision: NameRevision,
}

/// One charged native write attempt: the target, the desired canonical name
/// revision the write projects, the title to set, the source of the desired
/// name, the unique own-write receipt persisted before dispatch, and the
/// cycle number within the finite series (1..=3).
#[derive(Clone, Debug, PartialEq)]
pub struct NativeNameAttempt {
    pub target: NativeNameTarget,
    pub desired_revision: NameRevision,
    pub title: String,
    pub source: NameSource,
    pub receipt_id: String,
    pub cycle: u32,
}

/// The current native title observed at a target (the backend read answer).
/// `None` = the target EXISTS and currently holds no native title —
/// divergence, and exactly the state the writeback fills. A missing/archived
/// target is a diagnosed capability failure that arrives through the
/// adapter's ERROR paths (`Unsupported`), never this shape: the adapters can
/// only produce a `Confirmed { title: None }` for an existing untitled
/// target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeNameReadback {
    pub title: Option<String>,
}

/// The owned boxed `Send` future every backend call resolves to (the
/// `NativeCallResult` is the direct output — no outer `Result`).
pub type NativeFuture<T> =
    Pin<Box<dyn std::future::Future<Output = NativeCallResult<T>> + Send + 'static>>;

/// The owned boxed `Send` future the capability probe resolves to (a plain
/// bool — a probe is not an operation and classifies nothing).
pub type NativeProbeFuture = Pin<Box<dyn std::future::Future<Output = bool> + Send + 'static>>;

/// The provider-adapter seam. `read` returns the current native title at the
/// target; `write` sets the attempted title. Both preserve the provider's
/// own error classification. `route_available` answers whether the backend
/// can ATTEMPT an operation for this target right now — the serial worker
/// probes it before claiming a cycle so an initially absent route or
/// capability (no live provider connection, no wired adapter, an unspawnable
/// helper) pauses the series as `pending` without consuming any allowance,
/// and a refusal rotates the series out of the selector for a bounded
/// re-probe window; a `true` answer is not a health guarantee, the attempt
/// itself still classifies its own outcome.
pub trait NativeNameBackend: Send + Sync {
    fn read(&self, target: NativeNameTarget) -> NativeFuture<NativeNameReadback>;
    fn write(&self, attempt: NativeNameAttempt) -> NativeFuture<()>;
    fn route_available(&self, target: NativeNameTarget) -> NativeProbeFuture;
}

// ---------------------------------------------------------------------------
// Store-facing work shapes (consumed by the session_names seams)
// ---------------------------------------------------------------------------

/// One armed native series discovered by [`SessionNames::native_work_snapshot`].
#[derive(Clone, Debug, PartialEq)]
pub struct NativeWorkItem {
    pub target: SessionNameRef,
    pub location: NativeLocation,
    pub location_revision: NameRevision,
    pub desired_revision: NameRevision,
    pub desired_name: String,
    pub desired_source: NameSource,
    pub cycles_consumed: u32,
    /// Delta-review round 3, finding 4: the series' next-due time, carried so
    /// the selector orders due work "then earliest nextDue/reference key" as
    /// the plan and the worker's own doc comment state. `None` is an unarmed
    /// immediately-ready series (the select_generation convention).
    pub next_due: Option<i64>,
}

/// The charged attempt returned by [`SessionNames::claim_native_cycle`].
#[derive(Clone, Debug, PartialEq)]
pub struct NativeCycleClaim {
    pub target: SessionNameRef,
    pub location: NativeLocation,
    pub location_revision: NameRevision,
    pub desired_revision: NameRevision,
    /// The series identity this cycle was dispatched under (the arming
    /// revision stamped at the series' last reset): every fold and read
    /// charge the cycle makes carries it, so a series superseded by a newer
    /// name decision treats this cycle's late operations as provenance
    /// only — never a state change, never a charged allowance.
    pub series_epoch: NameRevision,
    pub title: String,
    pub source: NameSource,
    pub receipt_id: String,
    pub cycle: u32,
}

impl NativeCycleClaim {
    /// The write attempt shape for the backend.
    pub fn attempt(&self) -> NativeNameAttempt {
        NativeNameAttempt {
            target: NativeNameTarget {
                name_ref: self.target.clone(),
                location: self.location.clone(),
                location_revision: self.location_revision,
            },
            desired_revision: self.desired_revision,
            title: self.title.clone(),
            source: self.source,
            receipt_id: self.receipt_id.clone(),
            cycle: self.cycle,
        }
    }
}

/// One classified outcome folded back into the durable series.
#[derive(Clone, Debug, PartialEq)]
pub enum NativeOutcomeFold {
    /// A current-target read result (the cycle's pre-write check when it
    /// resolves the cycle, or the confirming readback after a write).
    Read {
        observed: Option<String>,
        receipt: Option<String>,
    },
    /// A confirmed write acknowledgement — never sufficient alone; the
    /// confirming readback decides synchronization.
    WriteAcknowledged { receipt: String },
    /// A known-no-effect failure.
    Undelivered { reason: String },
    /// A possibly-applied failure — the receipt stays provenance, and a later
    /// matching readback records `observedCurrent` without ever establishing
    /// `synced` for this revision.
    Ambiguous { reason: String },
    /// A diagnosed capability failure (unsupported/archived/ephemeral/missing).
    Unsupported { reason: String },
}

// ---------------------------------------------------------------------------
// The serial native worker
// ---------------------------------------------------------------------------

/// The shared serial native worker: selects armed native series from the
/// adopted document and drives their finite cycles under the shared
/// background guard. Exactly one owned worker task exists per process,
/// coordinated across cooperating same-home processes by the OS guard.
///
/// Ordering (the persisted fair-scheduling policy): ready manual-name
/// projection first, then earliest-due, then the stable name-reference key —
/// manual projection traffic can starve nothing because every cycle is
/// bounded, a capability-paused series rotates out of selection for only a
/// bounded re-probe window, and generation (Task 4) alternates on this same
/// selector ([`select_work`]: a persisted alternating class cursor when
/// both classes have ready work).
pub struct SessionNameWorker;

impl SessionNameWorker {
    /// Spawn the worker task. The handle is detached by design (main owns the
    /// process lifetime); the loop ends when the store's `Arc` drops.
    pub fn start(
        names: Arc<SessionNames>,
        native: Arc<dyn NativeNameBackend>,
        generator: Arc<crate::session_name_generation::SessionNameGenerator>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            run(names, native, generator).await;
        })
    }
}

/// One selected dispatch: a native cycle or a generation attempt.
#[derive(Clone, Debug)]
pub(crate) enum WorkSelection {
    Native(NativeWorkItem),
    Generation(crate::session_name_generation::GenerationWorkItem),
}

/// The generation half of the fair selection: earliest nextDue (an
/// unarmed `None` due is immediately ready), then the stable
/// name-reference key.
pub(crate) fn select_generation(
    items: &[crate::session_name_generation::GenerationWorkItem],
) -> Option<crate::session_name_generation::GenerationWorkItem> {
    items
        .iter()
        .min_by(|a, b| {
            a.next_due
                .unwrap_or(0)
                .cmp(&b.next_due.unwrap_or(0))
                .then_with(|| {
                    freshell_freshagent::naming::name_ref_debug_key(&a.target)
                        .cmp(&freshell_freshagent::naming::name_ref_debug_key(&b.target))
                })
        })
        .cloned()
}

/// The class selector: when BOTH classes have ready work, the persisted
/// alternating class cursor (stamped by each claim) picks the OTHER class;
/// a single ready class serves itself regardless of the cursor.
pub(crate) fn select_work(
    native_items: &[NativeWorkItem],
    generation_items: &[crate::session_name_generation::GenerationWorkItem],
    last_class: Option<&str>,
    probe_backoff: &mut HashMap<(String, NameRevision), tokio::time::Instant>,
) -> Option<WorkSelection> {
    let native_pick = select_next(native_items, probe_backoff);
    let generation_pick = select_generation(generation_items);
    match (native_pick, generation_pick) {
        (Some(native), Some(generation)) => {
            if last_class == Some("native") {
                Some(WorkSelection::Generation(generation))
            } else {
                Some(WorkSelection::Native(native))
            }
        }
        (Some(native), None) => Some(WorkSelection::Native(native)),
        (None, Some(generation)) => Some(WorkSelection::Generation(generation)),
        (None, None) => None,
    }
}

/// Unified agent names (Task 8 acceptance): on-demand route discovery for
/// an ARMED claude native series with no location — the index-adopted
/// flow (the auto-title sweep's hydration creates the record; nothing
/// attaches a location until a pane's runtime lane runs, so a session
/// renamed from the sidebar/history would otherwise pause its native
/// writeback forever — the native smoke's live-observed gap). Resolves the
/// transcript by session id through `locate_transcript_selected`'s ordered
/// candidates (the same evidence definition the attach arm trusts) and
/// attaches the acquisition. `true` when the acquisition landed.
pub(crate) async fn discover_claude_route(
    names: &Arc<SessionNames>,
    target: &SessionNameRef,
) -> bool {
    let SessionNameRef::Session {
        provider: freshell_protocol::session_names::NamedProvider::Claude,
        session_id,
    } = target
    else {
        return false;
    };
    let session_id = session_id.to_string();
    let selected = tokio::task::spawn_blocking(move || {
        freshell_freshagent::locate_transcript_selected(&session_id)
    })
    .await
    .ok()
    .flatten();
    let Some(selected) = selected else {
        return false;
    };
    if selected
        .transcript_cwd
        .as_deref()
        .filter(|cwd| !cwd.is_empty())
        .is_none()
    {
        // The claude adapter's helper validates the request's `dir`
        // against the transcript's original cwd — a cwd-less transcript
        // (the fixture's create-time touch, a crash window's partial
        // write) cannot route.
        return false;
    }
    let location = NativeLocation::Claude {
        config_root: selected.config_root.display().to_string(),
        transcript_path: Some(selected.transcript_path.display().to_string()),
        project_directory_key: None,
        transcript_cwd: selected.transcript_cwd.clone(),
        effective_project_key_override: None,
    };
    names
        .record_acquisition(
            target.clone(),
            NativeAcquisition {
                location,
                evidence: NativeEvidenceKind::PersistedMetadata,
                persistence: NativePersistence::Verified,
            },
        )
        .await
        .is_ok()
}

/// One on-demand discovery pass for index-adopted claude series (the
/// sweep's hydration attaches no location): resolves at most one NEW route
/// per pass — a found acquisition unpauses the series for the NEXT
/// snapshot. `backoff` is the worker-local map of failed-discovery windows
/// keyed by the stable name-ref key (route acquisition is
/// revision-independent). Returns the number of discovery attempts made
/// this pass.
async fn discover_paused_claude_routes(
    names: &Arc<SessionNames>,
    backoff: &mut HashMap<String, tokio::time::Instant>,
) -> usize {
    let mut attempted = 0;
    for target in names.paused_claude_series_without_route() {
        let key = crate::session_names::name_ref_key(&target);
        // A window recorded by a previous failed attempt suppresses the
        // rescan for this pass; the series re-attempts once it expires.
        if backoff
            .get(&key)
            .is_some_and(|until| *until > tokio::time::Instant::now())
        {
            continue;
        }
        attempted += 1;
        if discover_claude_route(names, &target).await {
            backoff.remove(&key);
            break;
        }
        backoff.insert(key, tokio::time::Instant::now() + DISCOVERY_RETRY_WINDOW);
    }
    attempted
}

async fn run(
    names: Arc<SessionNames>,
    native: Arc<dyn NativeNameBackend>,
    generator: Arc<crate::session_name_generation::SessionNameGenerator>,
) {
    // The transient per-series re-probe backoff: a capability refusal
    // rotates THAT series out of selection for a bounded window instead of
    // re-selecting the same paused head every poll. Keyed by the stable
    // series identity (name-ref key + desired revision) so a fresh name
    // decision is probed promptly, never penalized by the superseded
    // series' window. Worker-local by design: the refusal consumed
    // nothing, so the durable series keeps no trace of it — it stays
    // pending and discoverable, and the capability is rediscovered within
    // one window of its arrival.
    let mut probe_backoff: HashMap<(String, NameRevision), tokio::time::Instant> = HashMap::new();
    // The transient per-series route-discovery backoff (see
    // [`discover_paused_claude_routes`]).
    let mut discovery_backoff: HashMap<String, tokio::time::Instant> = HashMap::new();
    loop {
        // Capability is checked BEFORE selection: disabled naming or a
        // missing key pauses the generation class without consuming
        // anything and without ever reaching the guard (a paused contender
        // cannot monopolize the worker).
        let generation_items = if generator.capability_ready().await {
            names.generation_work_snapshot()
        } else {
            Vec::new()
        };
        // On-demand route discovery for index-adopted claude series (the
        // sweep's hydration attaches no location): at most one NEW route
        // per pass, with a per-series backoff on failed attempts.
        discover_paused_claude_routes(&names, &mut discovery_backoff).await;
        let native_items = names.native_work_snapshot();
        let selection = select_work(
            &native_items,
            &generation_items,
            names.scheduling_cursor_last_class().as_deref(),
            &mut probe_backoff,
        );
        let Some(work) = selection else {
            // Review I1: an interrupted series is INVISIBLE to selection
            // (InFlight is filtered from `generation_work_snapshot`), so
            // when it is the only naming/native work the dispatch
            // branches below never run and their piggybacked recovery
            // never fires. The idle path checks for interrupted starts
            // itself: acquire the guard (the holder exclusivity keeps
            // "InFlight under the guard is provably dead" true), fold
            // them once as failed, and re-poll. A recovery fold consumes
            // nothing, so this runs regardless of capability — and a
            // guard held by a cooperating process simply retries next
            // poll.
            if names.interrupted_generation_count() > 0 {
                if let Some(guard) = acquire_worker_guard(&names, "-") {
                    recover_interrupted_starts(&names).await;
                    drop(guard);
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(WORKER_POLL_INTERVAL) => {}
                // A settings/key capability change wakes the poll
                // immediately; the next pass re-evaluates capability.
                _ = generator.wake_notify().notified() => {}
            }
            continue;
        };
        // Acquire the shared worker guard for the actual local operation
        // (worker THEN document, never the reverse). Another cooperating
        // process holding it means ITS worker drives this work now — ours
        // polls again later. Retry delays hold neither lock.
        let item_key = match &work {
            WorkSelection::Native(item) => {
                freshell_freshagent::naming::name_ref_debug_key(&item.target)
            }
            WorkSelection::Generation(item) => {
                freshell_freshagent::naming::name_ref_debug_key(&item.target)
            }
        };
        let Some(guard) = acquire_worker_guard(&names, &item_key) else {
            tokio::time::sleep(WORKER_POLL_INTERVAL).await;
            continue;
        };
        match work {
            WorkSelection::Native(item) => {
                // The capability probe: "initially missing location/capability
                // pauses before consuming a cycle". An absent route/capability
                // consumes NOTHING — the series stays `pending` with its full
                // allowance, the rotation below moves it out of the selector
                // for a bounded window so lower-priority armed series keep
                // receiving slots, and it re-probes once that window expires.
                if !native
                    .route_available(NativeNameTarget {
                        name_ref: item.target.clone(),
                        location: item.location.clone(),
                        location_revision: item.location_revision,
                    })
                    .await
                {
                    tracing::debug!(
                        target: "freshell_server::session_name_native",
                        op = "route_available",
                        name_ref = %freshell_freshagent::naming::name_ref_debug_key(&item.target),
                        revision = item.desired_revision,
                        class = "capability_absent",
                        "session_names.native_route_unavailable: capability paused before claiming a cycle"
                    );
                    probe_backoff.insert(
                        (
                            freshell_freshagent::naming::name_ref_debug_key(&item.target),
                            item.desired_revision,
                        ),
                        tokio::time::Instant::now() + CAPABILITY_REPROBE_DELAY,
                    );
                    drop(guard);
                    tokio::time::sleep(WORKER_POLL_INTERVAL).await;
                    continue;
                }
                // Recover any interrupted generation start while holding the
                // guard (only a guard-holder dispatches, so an InFlight series
                // seen here is provably dead).
                recover_interrupted_starts(&names).await;
                // The guard is retained through the cycle's actual local work
                // (the provider calls and any owned-helper cleanup) and
                // released right after the fold — external ambiguity never
                // retains it.
                run_cycle(&names, native.as_ref(), &item.target).await;
                drop(guard);
            }
            WorkSelection::Generation(item) => {
                // A capability pause consumed nothing (the pre-selection gate
                // and the claim's own guards hold); re-checking here covers
                // the race where capability vanished between selection and
                // the guard.
                if !generator.capability_ready().await {
                    tracing::debug!(
                        target: "freshell_server::session_name_generation",
                        op = "capability_pause",
                        name_ref = %freshell_freshagent::naming::name_ref_debug_key(&item.target),
                        series = %item.series_id,
                        revision = 0,
                        class = "paused",
                        "session_names.generation_paused: capability absent before the claim"
                    );
                    drop(guard);
                    tokio::time::sleep(WORKER_POLL_INTERVAL).await;
                    continue;
                }
                recover_interrupted_starts(&names).await;
                generator.run_due_attempt(&names, &item).await;
                drop(guard);
            }
        }
    }
}

/// Acquire the shared background worker guard, logging the structured
/// failure when the guard machinery itself errors (a plain `None` —
/// another cooperating process holds it — stays silent: that process's
/// worker drives the work and ours simply polls again).
fn acquire_worker_guard(
    names: &Arc<SessionNames>,
    item_key: &str,
) -> Option<crate::session_names::BackgroundGuard> {
    names.try_background_guard().unwrap_or_else(|error| {
        tracing::warn!(
            target: "freshell_server::session_name_native",
            op = "try_background_guard",
            name_ref = %item_key,
            revision = 0,
            class = %error.code(),
            "session_names.operation_failed: {error}"
        );
        None
    })
}

/// Recover any interrupted generation starts while holding the shared
/// background guard (only a guard-holder ever dispatches, so an InFlight
/// series seen under the guard is provably dead). A recovery fold
/// consumes nothing — the claim already charged the attempt; the fold
/// schedules the remaining retry delay from recovery time. Runs from
/// every dispatch arm AND the idle path (review I1: an interrupted
/// series is invisible to selection, so when it is the only work the
/// idle path is the sole trigger).
async fn recover_interrupted_starts(names: &Arc<SessionNames>) {
    if names.interrupted_generation_count() == 0 {
        return;
    }
    match names.recover_interrupted_generation().await {
        Ok(count) if count > 0 => {
            tracing::info!(
                target: "freshell_server::session_name_generation",
                op = "recover_interrupted",
                name_ref = "-",
                revision = 0,
                class = "recovered",
                "session_names.generation_recovered: {count} interrupted start(s) folded as failed"
            );
        }
        Err(error) => {
            tracing::warn!(
                target: "freshell_server::session_name_generation",
                op = "recover_interrupted",
                name_ref = "-",
                revision = 0,
                class = %error.code(),
                "session_names.operation_failed: {error}"
            );
        }
        _ => {}
    }
}

/// The selection order: manual-name projection first, then earliest
/// nextDue (an unarmed `None` due is immediately ready, the
/// [`select_generation`] convention), equal-due falling back to the stable
/// name-reference key — the plan's "then earliest nextDue/reference key".
/// Delta-review round 3, finding 4: the former key-first (then
/// cycles-consumed) ordering deviated from this stated policy and let a
/// persistently early-keyed series be served ahead of an earlier-due one.
/// A series whose capability probe was refused is skipped until its bounded
/// re-probe window expires (expired backoff entries are pruned as part of
/// every selection), so a paused head can never starve the armed series
/// behind it.
fn select_next(
    items: &[NativeWorkItem],
    probe_backoff: &mut HashMap<(String, NameRevision), tokio::time::Instant>,
) -> Option<NativeWorkItem> {
    let now = tokio::time::Instant::now();
    probe_backoff.retain(|_, until| *until > now);
    items
        .iter()
        .filter(|item| {
            !probe_backoff.contains_key(&(
                freshell_freshagent::naming::name_ref_debug_key(&item.target),
                item.desired_revision,
            ))
        })
        .min_by(|a, b| {
            let manual = match (
                a.desired_source == NameSource::Manual,
                b.desired_source == NameSource::Manual,
            ) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            };
            manual
                .then_with(|| a.next_due.unwrap_or(0).cmp(&b.next_due.unwrap_or(0)))
                .then_with(|| {
                    freshell_freshagent::naming::name_ref_debug_key(&a.target)
                        .cmp(&freshell_freshagent::naming::name_ref_debug_key(&b.target))
                })
        })
        .cloned()
}

/// Drive ONE finite cycle for `target`: claim (charged), one current-target
/// read, at most one write, one confirming read — folding every classified
/// outcome into the durable series. A late/ambiguous acknowledgement can
/// never synchronize a newer revision or a relocated target (the fold guards
/// enforce that against the current document).
async fn run_cycle(
    names: &Arc<SessionNames>,
    native: &dyn NativeNameBackend,
    target: &SessionNameRef,
) {
    let receipt = Uuid::new_v4().to_string();
    let Some(claim) = names
        .claim_native_cycle(target.clone(), receipt)
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(
                target: "freshell_server::session_name_native",
                op = "claim_native_cycle",
                name_ref = %freshell_freshagent::naming::name_ref_debug_key(target),
                revision = error.log_revision(),
                class = %error.code(),
                "session_names.operation_failed: {error}"
            );
            None
        })
    else {
        return;
    };
    let claim_target = claim.target.clone();
    let location_revision = claim.location_revision;
    let series_epoch = claim.series_epoch;

    // 1. One current-target read before any retry/reconciliation. Matching
    //    titles synchronize immediately (the native already holds the exact
    //    desired value); a readback of `None` reports an EXISTING target
    //    holding no title yet — divergence the write below reconciles.
    if !names
        .charge_native_read(claim_target.clone(), series_epoch)
        .await
        .unwrap_or(false)
    {
        // Read allowance exhausted (or the series superseded) before the
        // cycle could even read: the series retains its incomplete status
        // and stops repair.
        let _ = names
            .fold_native_outcome(
                claim_target.clone(),
                location_revision,
                series_epoch,
                NativeOutcomeFold::Undelivered {
                    reason: "native read allowance exhausted".to_string(),
                },
            )
            .await;
        return;
    }
    let observed = match native
        .read(NativeNameTarget {
            name_ref: claim_target.clone(),
            location: claim.location.clone(),
            location_revision,
        })
        .await
    {
        NativeCallResult::Confirmed(readback) => readback.title,
        NativeCallResult::Undelivered(reason) => {
            fold(
                names,
                &claim_target,
                location_revision,
                series_epoch,
                NativeOutcomeFold::Undelivered { reason },
            )
            .await;
            return;
        }
        NativeCallResult::Ambiguous(reason) => {
            fold(
                names,
                &claim_target,
                location_revision,
                series_epoch,
                NativeOutcomeFold::Ambiguous { reason },
            )
            .await;
            return;
        }
        NativeCallResult::Unsupported(reason) => {
            fold(
                names,
                &claim_target,
                location_revision,
                series_epoch,
                NativeOutcomeFold::Unsupported { reason },
            )
            .await;
            return;
        }
    };
    if observed.as_deref() == Some(claim.title.as_str()) {
        // The native already holds the exact desired name: a
        // current-revision readback synchronizes this exact revision.
        fold(
            names,
            &claim_target,
            location_revision,
            series_epoch,
            NativeOutcomeFold::Read {
                observed,
                receipt: Some(claim.receipt_id.clone()),
            },
        )
        .await;
        return;
    }
    // Divergent title (including `None` — an existing target with no title
    // yet, exactly the state the writeback exists to fill): the write below
    // reconciles. A missing target can never reach here — the adapters
    // diagnose it through their error paths as an explicit native failure.
    // 2. At most one write per cycle, bounded to 20 seconds by the adapter.
    match native.write(claim.attempt()).await {
        NativeCallResult::Confirmed(()) => {
            fold(
                names,
                &claim_target,
                location_revision,
                series_epoch,
                NativeOutcomeFold::WriteAcknowledged {
                    receipt: claim.receipt_id.clone(),
                },
            )
            .await;
        }
        NativeCallResult::Undelivered(reason) => {
            fold(
                names,
                &claim_target,
                location_revision,
                series_epoch,
                NativeOutcomeFold::Undelivered { reason },
            )
            .await;
            return;
        }
        NativeCallResult::Ambiguous(reason) => {
            fold(
                names,
                &claim_target,
                location_revision,
                series_epoch,
                NativeOutcomeFold::Ambiguous { reason },
            )
            .await;
            return;
        }
        NativeCallResult::Unsupported(reason) => {
            fold(
                names,
                &claim_target,
                location_revision,
                series_epoch,
                NativeOutcomeFold::Unsupported { reason },
            )
            .await;
            return;
        }
    }

    // 3. One confirming read afterward — only a current-revision readback can
    //    establish the target as synchronized.
    if !names
        .charge_native_read(claim_target.clone(), series_epoch)
        .await
        .unwrap_or(false)
    {
        let _ = names
            .fold_native_outcome(
                claim_target.clone(),
                location_revision,
                series_epoch,
                NativeOutcomeFold::Undelivered {
                    reason: "native read allowance exhausted before the confirming readback"
                        .to_string(),
                },
            )
            .await;
        return;
    }
    match native
        .read(NativeNameTarget {
            name_ref: claim_target.clone(),
            location: claim.location.clone(),
            location_revision,
        })
        .await
    {
        NativeCallResult::Confirmed(readback) => {
            fold(
                names,
                &claim_target,
                location_revision,
                series_epoch,
                NativeOutcomeFold::Read {
                    observed: readback.title,
                    receipt: Some(claim.receipt_id.clone()),
                },
            )
            .await;
        }
        NativeCallResult::Undelivered(reason) => {
            fold(
                names,
                &claim_target,
                location_revision,
                series_epoch,
                NativeOutcomeFold::Undelivered { reason },
            )
            .await;
        }
        NativeCallResult::Ambiguous(reason) => {
            fold(
                names,
                &claim_target,
                location_revision,
                series_epoch,
                NativeOutcomeFold::Ambiguous { reason },
            )
            .await;
        }
        NativeCallResult::Unsupported(reason) => {
            fold(
                names,
                &claim_target,
                location_revision,
                series_epoch,
                NativeOutcomeFold::Unsupported { reason },
            )
            .await;
        }
    }
}

async fn fold(
    names: &Arc<SessionNames>,
    target: &SessionNameRef,
    location_revision: NameRevision,
    series_epoch: NameRevision,
    outcome: NativeOutcomeFold,
) {
    if let Err(error) = names
        .fold_native_outcome(target.clone(), location_revision, series_epoch, outcome)
        .await
    {
        tracing::warn!(
            target: "freshell_server::session_name_native",
            op = "fold_native_outcome",
            name_ref = %freshell_freshagent::naming::name_ref_debug_key(target),
            revision = error.log_revision(),
            class = %error.code(),
            "session_names.operation_failed: {error}"
        );
    }
}

// ---------------------------------------------------------------------------
// Production provider adapters
// ---------------------------------------------------------------------------

/// The deliberate set-or-remove decision for the helper child's effective
/// project-key override: a non-empty location override SETS the env key; an
/// absent/empty one REMOVES it, so an inactive ambient override can never
/// hijack the project key. Returns the env key and its value (`None` =
/// remove).
fn project_key_child_env(override_value: Option<&str>) -> (&'static str, Option<String>) {
    const KEY: &str = "CLAUDE_CODE_PROJECT_DIR_NAME";
    match override_value.filter(|value| !value.is_empty()) {
        Some(value) => (KEY, Some(value.to_string())),
        None => (KEY, None),
    }
}

/// The Claude `session-names.mjs` adapter: spawns the DEDICATED helper child
/// per operation (one JSON line in, one structured line out), with a
/// child-only absolute `CLAUDE_CONFIG_DIR` from the selected location and a
/// deliberately set/unset `CLAUDE_CODE_PROJECT_DIR_NAME` override. Rust owns
/// the timeout and the kill/wait cleanup of this helper child — never a
/// shared runtime or conversation. The filesystem path uses only the
/// location's original transcript cwd (`transcript_cwd`) as `dir`.
pub struct ClaudeNativeNameAdapter {
    node: String,
    helper_path: std::path::PathBuf,
}

impl ClaudeNativeNameAdapter {
    /// The production adapter: node from `FRESHELL_CLAUDE_NODE` (default
    /// `node`), the helper at `FRESHELL_CLAUDE_SESSION_NAMES` (default the
    /// staged sidecar's `session-names.mjs` beside `index.mjs`).
    ///
    /// Path resolution order: an explicit `FRESHELL_CLAUDE_SESSION_NAMES`
    /// wins; otherwise, when `FRESHELL_CLAUDE_SIDECAR` is set (the packaged
    /// desktop app spawns the server with the STAGED sidecar entry), the
    /// helper is derived from its SIBLING directory — the Electron runtime
    /// stages `session-names.mjs` right beside `index.mjs`, and the
    /// build-time `CARGO_MANIFEST_DIR` default points at a nonexistent
    /// build-machine source path in a packaged install. Without either
    /// override the build-tree default beside the sidecar source applies.
    pub fn from_env() -> Self {
        let helper = std::env::var("FRESHELL_CLAUDE_SESSION_NAMES")
            .ok()
            .filter(|p| !p.is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var("FRESHELL_CLAUDE_SIDECAR")
                    .ok()
                    .filter(|p| !p.is_empty())
                    .map(std::path::PathBuf::from)
                    .and_then(|sidecar| sidecar.parent().map(|dir| dir.to_path_buf()))
                    .map(|dir| dir.join("session-names.mjs"))
            })
            .unwrap_or_else(|| {
                std::path::PathBuf::from(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../freshell-claude-sidecar/session-names.mjs"
                ))
            });
        let node = std::env::var("FRESHELL_CLAUDE_NODE")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "node".to_string());
        Self {
            node,
            helper_path: helper,
        }
    }

    async fn spawn_helper(
        &self,
        location: &NativeLocation,
        request: &serde_json::Value,
    ) -> Result<tokio::process::Child, String> {
        let NativeLocation::Claude {
            config_root,
            transcript_cwd,
            effective_project_key_override,
            ..
        } = location
        else {
            return Err("the claude adapter requires a claude location".to_string());
        };
        // The request's `dir` comes from the location's original transcript
        // cwd (validated per-request by the helper itself).
        transcript_cwd
            .as_deref()
            .filter(|d| !d.is_empty())
            .ok_or_else(|| "the claude location carries no original transcript cwd".to_string())?;
        let mut command = tokio::process::Command::new(&self.node);
        command.arg(&self.helper_path);
        // Child-ONLY absolute config root (never inherited): the selected
        // NativeLocation's root, and never an auth bootstrap of any kind.
        command.env("CLAUDE_CONFIG_DIR", config_root);
        // Deliberately set or REMOVE the effective project-key override so an
        // inactive ambient override cannot hijack the project key.
        match project_key_child_env(effective_project_key_override.as_deref()) {
            (key, Some(value)) => {
                command.env(key, value);
            }
            (key, None) => {
                command.env_remove(key);
            }
        }
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true); // leak-safety backstop; the explicit kill/wait below still owns cleanup
        let mut child = command.spawn().map_err(|e| {
            format!(
                "claude session-names helper spawn failed ({} {}): {e}",
                self.node,
                self.helper_path.display()
            )
        })?;
        // No open-file reset (`freshell_platform::child_nofile`): the helper
        // is always Node, which raises its own soft limit to the hard limit
        // at start, and a reset landing after that check would pin it lower.
        use tokio::io::AsyncWriteExt;
        if let Some(stdin) = child.stdin.as_mut() {
            let mut line = request.to_string();
            line.push('\n');
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| format!("helper stdin write failed: {e}"))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| format!("helper stdin shutdown failed: {e}"))?;
        }
        Ok(child)
    }

    /// Run one helper exchange end-to-end: spawn, write the request line,
    /// read the structured answer under the 20-second bound, and ALWAYS
    /// kill+wait the dedicated child (owned by THIS operation — never a
    /// shared runtime). A timeout resolves Ambiguous: the timeout does not
    /// cancel a provider mutation the child may still complete.
    async fn exchange(
        self: Arc<Self>,
        location: NativeLocation,
        request: serde_json::Value,
    ) -> NativeCallResult<serde_json::Value> {
        let mut child = match self.spawn_helper(&location, &request).await {
            Ok(child) => child,
            Err(reason) => return NativeCallResult::Undelivered(reason),
        };
        let read_answer = async {
            use tokio::io::AsyncBufReadExt;
            let stdout = child.stdout.take()?;
            let mut lines = tokio::io::BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                return serde_json::from_str::<serde_json::Value>(trimmed).ok();
            }
            None
        };
        let answer = match tokio::time::timeout(NATIVE_REQUEST_TIMEOUT, read_answer).await {
            Ok(Some(answer)) => answer,
            Ok(None) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return NativeCallResult::Ambiguous(
                    "the claude session-names helper exited without an answer".to_string(),
                );
            }
            Err(_) => {
                // Timeout: kill/wait the dedicated helper; the mutation may
                // still have applied — ambiguous, never undelivered.
                let _ = child.start_kill();
                let _ = child.wait().await;
                return NativeCallResult::Ambiguous(
                    "the claude session-names helper exceeded the request bound".to_string(),
                );
            }
        };
        // Owned cleanup completes BEFORE the guard is released.
        let _ = child.start_kill();
        let _ = child.wait().await;
        if answer.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
            return NativeCallResult::Confirmed(answer);
        }
        let class = answer
            .get("class")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("error");
        let message = answer
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("claude session-names helper refused the operation");
        match class {
            "not-found" | "ambiguous" => {
                NativeCallResult::Unsupported(format!("{class}: {message}"))
            }
            "invalid" => NativeCallResult::Undelivered(format!("{class}: {message}")),
            _ => NativeCallResult::Ambiguous(format!("{class}: {message}")),
        }
    }
}

impl ClaudeNativeNameAdapter {
    fn dir_of(location: &NativeLocation) -> Option<&str> {
        match location {
            NativeLocation::Claude { transcript_cwd, .. } => transcript_cwd.as_deref(),
            _ => None,
        }
    }
}

impl NativeNameBackend for ClaudeNativeNameAdapter {
    fn read(&self, target: NativeNameTarget) -> NativeFuture<NativeNameReadback> {
        let session_id = session_id_of(&target.name_ref);
        if session_id.is_empty() {
            return Box::pin(async move {
                NativeCallResult::Unsupported(
                    "a pending claude name has no durable session to address".to_string(),
                )
            });
        }
        let request = serde_json::json!({
            "op": "read",
            "sessionId": session_id,
            "dir": Self::dir_of(&target.location),
        });
        let adapter = Arc::new(Self {
            node: self.node.clone(),
            helper_path: self.helper_path.clone(),
        });
        Box::pin(async move {
            match adapter.exchange(target.location, request).await {
                NativeCallResult::Confirmed(answer) => {
                    let title = answer
                        .get("customTitle")
                        .and_then(serde_json::Value::as_str)
                        .filter(|t| !t.trim().is_empty())
                        .map(|title| title.to_string());
                    NativeCallResult::Confirmed(NativeNameReadback { title })
                }
                NativeCallResult::Undelivered(reason) => NativeCallResult::Undelivered(reason),
                NativeCallResult::Ambiguous(reason) => NativeCallResult::Ambiguous(reason),
                NativeCallResult::Unsupported(reason) => NativeCallResult::Unsupported(reason),
            }
        })
    }

    fn write(&self, attempt: NativeNameAttempt) -> NativeFuture<()> {
        let session_id = session_id_of(&attempt.target.name_ref);
        if session_id.is_empty() {
            return Box::pin(async move {
                NativeCallResult::Unsupported(
                    "a pending claude name has no durable session to address".to_string(),
                )
            });
        }
        let request = serde_json::json!({
            "op": "rename",
            "sessionId": session_id,
            "title": attempt.title,
            "dir": Self::dir_of(&attempt.target.location),
        });
        let adapter = Arc::new(Self {
            node: self.node.clone(),
            helper_path: self.helper_path.clone(),
        });
        Box::pin(async move {
            match adapter.exchange(attempt.target.location, request).await {
                NativeCallResult::Confirmed(_) => NativeCallResult::Confirmed(()),
                NativeCallResult::Undelivered(reason) => NativeCallResult::Undelivered(reason),
                NativeCallResult::Ambiguous(reason) => NativeCallResult::Ambiguous(reason),
                NativeCallResult::Unsupported(reason) => NativeCallResult::Unsupported(reason),
            }
        })
    }

    fn route_available(&self, target: NativeNameTarget) -> NativeProbeFuture {
        // A pending claude name has no durable session to address (the claude
        // location carries no native session id) — the series pauses until
        // the bind, and the staged helper must exist for any attempt.
        let session_ok = !session_id_of(&target.name_ref).is_empty();
        let helper_exists = self.helper_path.exists();
        Box::pin(async move { session_ok && helper_exists })
    }
}

/// The session id of a naming target — pending targets address the acquired
/// live native id the location carries; durable targets address their own
/// session id.
fn session_id_of(name_ref: &SessionNameRef) -> String {
    match name_ref {
        SessionNameRef::Pending { .. } => String::new(),
        SessionNameRef::Session { session_id, .. } => session_id.clone(),
    }
}

/// The Codex adapter: direct metadata management on a LIVE app-server
/// connection whose initialized root matches the retained location — never
/// the cold `FreshCodexState::get_snapshot`, never a resume/unarchive, never
/// a conversation lease. The root-matched client comes from the injected
/// resolver (main wires the fresh-codex live-session clients; a proxied
/// CLI pane's thread is named through its own TUI, not through us).
/// Resolves the LIVE root-matched codex management client for a retained
/// `codex_home` (None = no live connection was initialized for that root).
pub type CodexRootClientResolver = Arc<
    dyn Fn(
            String,
        ) -> Pin<
            Box<
                dyn Future<Output = Option<Arc<freshell_codex::app_server::CodexAppServerClient>>>
                    + Send,
            >,
        > + Send
        + Sync,
>;

pub struct CodexNativeNameAdapter {
    client_for_root: CodexRootClientResolver,
}

impl CodexNativeNameAdapter {
    pub fn new(client_for_root: CodexRootClientResolver) -> Self {
        Self { client_for_root }
    }
}

/// Resolve the codex root-matched LIVE management connection and the
/// native thread id for one operation — the shared read/write policy:
/// direct metadata on a connection whose initialized root matches the
/// retained location (never the cold snapshot, a resume, an unarchive, or
/// a lease).
async fn codex_root_matched_thread(
    resolver: &CodexRootClientResolver,
    target: &NativeNameTarget,
) -> Result<
    (
        Arc<freshell_codex::app_server::CodexAppServerClient>,
        String,
    ),
    NativeClassified,
> {
    let NativeLocation::Codex {
        codex_home,
        native_thread_id,
        ..
    } = &target.location
    else {
        return Err(NativeClassified::Unsupported(
            "the codex adapter requires a codex location".to_string(),
        ));
    };
    let fallback_id = session_id_of(&target.name_ref);
    let thread_id = native_thread_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .or_else(|| (!fallback_id.is_empty()).then_some(fallback_id.as_str()))
        .ok_or_else(|| {
            NativeClassified::Unsupported(
                "the codex location carries no native thread id".to_string(),
            )
        })?
        .to_string();
    let client = resolver(codex_home.clone()).await.ok_or_else(|| {
        NativeClassified::Unsupported(format!(
            "no live codex app-server connection matches the initialized root {codex_home}"
        ))
    })?;
    Ok((client, thread_id))
}

/// Whether an ANSWERED JSON-RPC error diagnoses the native target as
/// missing or the API as unsupported — a settled capability failure.
/// Best-effort on the provider's own message/code vocabulary: an answered
/// rejection we cannot positively diagnose is a definitive no-effect
/// failure (`Undelivered`, retryable within the allowance), never a blanket
/// capability failure.
fn rpc_diagnoses_missing_target(error: &freshell_codex::protocol::RpcError) -> bool {
    // JSON-RPC "method not found": the app-server lacks the management API.
    if error.code == -32601 {
        return true;
    }
    let message = error.message.to_ascii_lowercase();
    [
        "not found",
        "not_found",
        "no such",
        "unknown thread",
        "unknown session",
        "unsupported",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

/// Classify a codex app-server RPC failure, preserving the four-way
/// contract: a timeout, a MID-FLIGHT DROP (the connection closed before the
/// answer), or an unparseable answer is AMBIGUOUS (the call may have
/// applied); a transport send refusal is UNDELIVERED (provably never
/// dispatched); an answered JSON-RPC rejection is a definitive no-effect
/// failure (retryable) UNLESS it diagnoses the target as missing or the API
/// as unsupported (a settled capability failure). Never reduced to a
/// generic timeout or a blanket unsupported.
fn classify_codex_error(
    error: freshell_codex::app_server::CodexAppServerError,
    what: &str,
) -> NativeClassified {
    match error {
        freshell_codex::app_server::CodexAppServerError::Timeout { .. } => {
            NativeClassified::Ambiguous(format!("codex {what} timed out"))
        }
        freshell_codex::app_server::CodexAppServerError::Closed { .. } => {
            NativeClassified::Ambiguous(format!(
                "codex {what} dropped mid-flight (the connection closed before the answer)"
            ))
        }
        freshell_codex::app_server::CodexAppServerError::InvalidResponse { detail, .. } => {
            NativeClassified::Ambiguous(format!(
                "codex {what} answered an unparseable payload: {detail}"
            ))
        }
        freshell_codex::app_server::CodexAppServerError::Transport { message, .. } => {
            NativeClassified::Undelivered(format!(
                "codex transport refused before dispatch: {message}"
            ))
        }
        freshell_codex::app_server::CodexAppServerError::Rpc { error, .. } => {
            if rpc_diagnoses_missing_target(&error) {
                NativeClassified::Unsupported(format!("codex {what} diagnosed: {error}"))
            } else {
                NativeClassified::Undelivered(format!(
                    "codex {what} answered a definitive rejection: {error}"
                ))
            }
        }
    }
}

impl NativeNameBackend for CodexNativeNameAdapter {
    fn read(&self, target: NativeNameTarget) -> NativeFuture<NativeNameReadback> {
        let resolver = Arc::clone(&self.client_for_root);
        Box::pin(async move {
            let (client, thread_id) = match codex_root_matched_thread(&resolver, &target).await {
                Ok(pair) => pair,
                Err(classified) => return classified.into_call(),
            };
            // The metadata read rides its OWN 20-second native request bound
            // (the plan's per-request budget) — not the 30s snapshot budget a
            // full-thread `thread/read` rides.
            match client.read_thread_metadata(&thread_id).await {
                Ok(result) => NativeCallResult::Confirmed(NativeNameReadback {
                    title: freshell_codex::protocol::thread_name_from_result(&result),
                }),
                Err(error) => classify_codex_error(error, "thread/read").into_call(),
            }
        })
    }

    fn write(&self, attempt: NativeNameAttempt) -> NativeFuture<()> {
        let resolver = Arc::clone(&self.client_for_root);
        Box::pin(async move {
            let (client, thread_id) =
                match codex_root_matched_thread(&resolver, &attempt.target).await {
                    Ok(pair) => pair,
                    Err(classified) => return classified.into_call(),
                };
            match client.set_thread_name(&thread_id, &attempt.title).await {
                Ok(()) => NativeCallResult::Confirmed(()),
                Err(error) => classify_codex_error(error, "thread/name/set").into_call(),
            }
        })
    }

    fn route_available(&self, target: NativeNameTarget) -> NativeProbeFuture {
        // A fresh-codex session renamed while its pane is closed, or a CLI
        // codex pane (which never has a management connection here), has no
        // LIVE root-matched app-server connection — the series pauses until
        // one exists, consuming nothing.
        let resolver = Arc::clone(&self.client_for_root);
        Box::pin(async move { codex_root_matched_thread(&resolver, &target).await.is_ok() })
    }
}

/// The shared serve-manager cell owned by the fresh-agent state: `None`
/// until the first freshopencode pane's lane runs `ensure_manager`, then
/// `Some` for the rest of the process lifetime. The naming adapter holds
/// this handle and resolves the CURRENT manager per operation — the worker
/// outlives the cell's lazy creation, so a boot-time snapshot would freeze
/// the `None` and pause every opencode native series forever.
pub type SharedOpencodeManager =
    std::sync::Arc<tokio::sync::Mutex<Option<freshell_opencode::OpencodeServeManager>>>;

/// The OpenCode adapter: the supported PATCH `update_session_title` route
/// through the shared fresh-agent serve manager, gated by the
/// effective-database context check BEFORE dispatch. A `:memory:` route or a
/// database mismatch fails diagnostically (Unsupported) — never a silent
/// write into the wrong store, never the directory as a store selector.
pub struct OpencodeNativeNameAdapter {
    shared: SharedOpencodeManager,
}

impl OpencodeNativeNameAdapter {
    pub fn new(shared: SharedOpencodeManager) -> Self {
        Self { shared }
    }

    fn session_id_of_target(name_ref: &SessionNameRef, location: &NativeLocation) -> String {
        let native = match location {
            NativeLocation::Opencode {
                native_session_id, ..
            } => native_session_id.as_deref().filter(|id| !id.is_empty()),
            _ => None,
        };
        native
            .map(|id| id.to_string())
            .unwrap_or_else(|| session_id_of(name_ref))
    }

    fn route_of(location: &NativeLocation) -> freshell_opencode::Route {
        match location {
            NativeLocation::Opencode {
                original_directory, ..
            } => original_directory
                .as_ref()
                .filter(|d| !d.trim().is_empty())
                .map(|d| d.to_string()),
            _ => None,
        }
    }

    fn database_of(location: &NativeLocation) -> Option<std::path::PathBuf> {
        match location {
            NativeLocation::Opencode { database_path, .. } => {
                Some(std::path::PathBuf::from(database_path))
            }
            _ => None,
        }
    }
}

/// Classify an opencode serve failure for a native-name operation,
/// preserving the crate's own delivery taxonomy: a provable connect-phase
/// refusal (`ServeError::Undelivered`) is the ONLY known-no-effect failure; a
/// timeout or post-dispatch transport error is AMBIGUOUS; a definitive
/// 404/405 answers that the target/management API is missing (a settled
/// capability failure); any other HTTP answer AFTER dispatch — a 5xx in
/// particular — is not provably effect-free, so it is AMBIGUOUS; and a
/// definitive 4xx rejection is a known-no-effect retryable failure.
fn classify_opencode_error(error: freshell_opencode::ServeError, what: &str) -> NativeClassified {
    match error {
        freshell_opencode::ServeError::Undelivered(reason) => NativeClassified::Undelivered(reason),
        freshell_opencode::ServeError::RequestTimeout { .. } => {
            NativeClassified::Ambiguous(format!("opencode {what} timed out"))
        }
        freshell_opencode::ServeError::Transport(reason) => NativeClassified::Ambiguous(reason),
        freshell_opencode::ServeError::Http { status, body, .. }
            if status == 404 || status == 405 =>
        {
            NativeClassified::Unsupported(format!("opencode answered {status}: {body}"))
        }
        freshell_opencode::ServeError::Http { status, body, .. } if status >= 500 => {
            // Delivered and answered — not provably effect-free: the crate's
            // own contract reserves "provably never dispatched" for
            // `ServeError::Undelivered` alone.
            NativeClassified::Ambiguous(format!(
                "opencode answered {status} after dispatch: {body}"
            ))
        }
        error => NativeClassified::Undelivered(error.to_string()),
    }
}

impl NativeNameBackend for OpencodeNativeNameAdapter {
    fn read(&self, target: NativeNameTarget) -> NativeFuture<NativeNameReadback> {
        let shared = Arc::clone(&self.shared);
        Box::pin(async move {
            let Some(manager) = shared.lock().await.clone() else {
                return NativeCallResult::Undelivered(
                    "the shared opencode serve is not running".to_string(),
                );
            };
            let session_id = Self::session_id_of_target(&target.name_ref, &target.location);
            if session_id.is_empty() {
                return NativeCallResult::Unsupported(
                    "the opencode location carries no native session id".to_string(),
                );
            }
            // Effective-database context BEFORE dispatch, BOTH directions
            // (the write's gate): a mismatched serve must never answer a
            // read either — a wrong-store observation or a burned cycle
            // before the write's gate rejects.
            if let Some(database) = Self::database_of(&target.location) {
                if let Err(rejection) = manager.check_database_context(&database) {
                    return NativeCallResult::Unsupported(rejection.to_string());
                }
            }
            let route = Self::route_of(&target.location);
            match manager.get_session(&session_id, &route).await {
                Ok(session) => NativeCallResult::Confirmed(NativeNameReadback {
                    title: session
                        .get("title")
                        .and_then(serde_json::Value::as_str)
                        .filter(|t| !t.trim().is_empty())
                        .map(|title| title.to_string()),
                }),
                Err(error) => classify_opencode_error(error, "GET").into_call(),
            }
        })
    }

    fn write(&self, attempt: NativeNameAttempt) -> NativeFuture<()> {
        let shared = Arc::clone(&self.shared);
        Box::pin(async move {
            let Some(manager) = shared.lock().await.clone() else {
                return NativeCallResult::Undelivered(
                    "the shared opencode serve is not running".to_string(),
                );
            };
            let session_id =
                Self::session_id_of_target(&attempt.target.name_ref, &attempt.target.location);
            if session_id.is_empty() {
                return NativeCallResult::Unsupported(
                    "the opencode location carries no native session id".to_string(),
                );
            }
            let route = Self::route_of(&attempt.target.location);
            // Effective-database context BEFORE dispatch: `:memory:` and
            // mismatched pins fail diagnostically without a request.
            if let Some(database) = Self::database_of(&attempt.target.location) {
                if let Err(rejection) = manager.check_database_context(&database) {
                    return NativeCallResult::Unsupported(rejection.to_string());
                }
            }
            match manager
                .update_session_title(&session_id, &attempt.title, &route)
                .await
            {
                Ok(_) => NativeCallResult::Confirmed(()),
                Err(error) => classify_opencode_error(error, "PATCH").into_call(),
            }
        })
    }

    fn route_available(&self, target: NativeNameTarget) -> NativeProbeFuture {
        // A serve is startable on demand (`ensure_started`), so a wired
        // adapter with a resolvable session id can always attempt once the
        // SHARED manager exists; a mismatched database context is a
        // DIAGNOSED provider failure the dispatch itself reports, not an
        // absent capability. The shared serve must EXIST though — before
        // the first freshopencode pane's lane runs `ensure_manager` the
        // capability is absent (the adapter never spawns a serve just to
        // check a name), and the CURRENT cell is resolved per probe so the
        // lazy creation un-pauses armed series within one re-probe window.
        let resolvable = !Self::session_id_of_target(&target.name_ref, &target.location).is_empty();
        let shared = Arc::clone(&self.shared);
        Box::pin(async move { resolvable && shared.lock().await.is_some() })
    }
}

/// The provider dispatch: routes one native operation to its provider adapter
/// by the retained location's variant. `None` for a provider whose adapter is
/// not wired (a degraded boot still serves the other providers).
pub struct NativeNameDispatch {
    claude: Option<ClaudeNativeNameAdapter>,
    codex: Option<CodexNativeNameAdapter>,
    opencode: Option<OpencodeNativeNameAdapter>,
}

impl NativeNameDispatch {
    pub fn new(
        claude: Option<ClaudeNativeNameAdapter>,
        codex: Option<CodexNativeNameAdapter>,
        opencode: Option<OpencodeNativeNameAdapter>,
    ) -> Self {
        Self {
            claude,
            codex,
            opencode,
        }
    }

    fn backend_for(&self, location: &NativeLocation) -> Option<&dyn NativeNameBackend> {
        match location {
            NativeLocation::Claude { .. } => {
                self.claude.as_ref().map(|a| a as &dyn NativeNameBackend)
            }
            NativeLocation::Codex { .. } => {
                self.codex.as_ref().map(|a| a as &dyn NativeNameBackend)
            }
            NativeLocation::Opencode { .. } => {
                self.opencode.as_ref().map(|a| a as &dyn NativeNameBackend)
            }
        }
    }
}

impl NativeNameBackend for NativeNameDispatch {
    fn read(&self, target: NativeNameTarget) -> NativeFuture<NativeNameReadback> {
        match self.backend_for(&target.location) {
            Some(backend) => backend.read(target),
            None => Box::pin(async move {
                NativeCallResult::Unsupported(
                    "no native adapter is wired for this provider".to_string(),
                )
            }),
        }
    }

    fn write(&self, attempt: NativeNameAttempt) -> NativeFuture<()> {
        match self.backend_for(&attempt.target.location) {
            Some(backend) => backend.write(attempt),
            None => Box::pin(async move {
                NativeCallResult::Unsupported(
                    "no native adapter is wired for this provider".to_string(),
                )
            }),
        }
    }

    fn route_available(&self, target: NativeNameTarget) -> NativeProbeFuture {
        match self.backend_for(&target.location) {
            Some(backend) => backend.route_available(target),
            // No adapter wired (a degraded boot): the capability is absent —
            // the series pauses as pending, never a burned cycle.
            None => Box::pin(async move { false }),
        }
    }
}
