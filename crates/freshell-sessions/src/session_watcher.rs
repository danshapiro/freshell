//! Session watcher: inotify-based file watching that feeds dirty-path
//! notifications to [`SessionIndex`]. Replaces the continuous 1s-TTL
//! polling that burned 50-90% of a CPU core.
//!
//! Architecture:
//! - Literally one `notify::RecommendedWatcher` (one inotify fd) per provider;
//!   watch lifetimes are explicit (`watch_path` to arm, `unwatch_tolerated`
//!   to drop). Claude/codex/opencode arm their [`ProviderLayout`] watch bases
//!   (recursive tree / single db dir); the AMPLIFIER provider instead arms a
//!   MANAGED watch set (kata v0h9 follow-up): the pure planner
//!   [`crate::watch_plan`] enumerates the desired set (projects root,
//!   per-project sessions dirs or stand-ins, root-classified session dirs),
//!   and the free arm helpers below apply it kind-aware with
//!   watch-then-scan, stand-in swap, absence tracking, and bounded backoff
//!   retry — all bookkeeping in [`ManagedBook`], all marks routed through
//!   [`ArmOutcome`] so every bulk batch is `spawn_blocking`-safe.
//! - Raw events flow through a coalescing `HashMap<PathBuf, Instant>` that
//!   collapses ~35 events/s (measured 24h observer) to ~0.09 net changes/s.
//!   Amplifier events are routed by DEPTH below the projects root:
//!   structural create-ish kinds at depths 1–3 arm/cascade/swap, structural
//!   remove-ish kinds at depths 0–3 tear the target's bookkeeping down
//!   (idempotently — a rename's untracked duplicate `Name(From)` is a clean
//!   no-op), a paired `Name(Both)` splits into its remove + create
//!   endpoints, and depth-3 subagent-pattern mkdirs first take the D4-1
//!   drift-rescue content probe (stat+parse the one metadata.json — never
//!   a watch; positive root content arms via the self-correction channel's
//!   own helper, metadata-absent parks a bounded per-flush re-probe) and
//!   only otherwise escalate to an immediate provider-dirty mark on
//!   declared interest. Event-time work is
//!   SPLIT by class: single-target arms/marks run inline on the loop, while
//!   cascade-class routes (a project move-in / `sessions/` appearance — a
//!   readdir plus a batch of arms) run as ONE `spawn_blocking` batch per
//!   event (the design's bulk arm rule). Depth-4 file events fold
//!   onto scoped `metadata.json` marks
//!   (a depth-4 folder create is dropped), and anything not routed is
//!   dropped by default — amplifier events never take the legacy
//!   pending-map escalation path. Two resource alarms guard the accepted
//!   unbounded root-session watch growth: an edge-triggered WARN at >25%
//!   of the kernel inotify watch limit (checked after every arm batch) and
//!   a daily-bucketed WARN on unknown-format arm drift. A one-way
//!   refresh→watcher self-correction channel closes the loop the name
//!   classifier cannot: each full amplifier discover reports its
//!   content-verified root session dirs (parsed `parent_id` absent), and
//!   the loop arms any the basename classifier missed — never bypassing
//!   arm-failure retry backoff.
//! - Debounced flush (200ms quiet gap, capped at 2s from a burst's first
//!   event so sustained sub-gap streams can't starve it) delivers dirty
//!   paths to `SessionIndex::mark_dirty`. An amplifier rescan
//!   (need_rescan / queue overflow) additionally runs a full watch-set
//!   REPLAN (strict plan → kind-tagged diff → kind-correct arm/unwatch)
//!   inside one `spawn_blocking` batch; other providers keep the legacy
//!   provider-dirty path.
//! - Late-root handling: legacy providers watch the nearest existing ancestor
//!   when the provider root doesn't exist yet. The amplifier projects root
//!   absence-tracks in the managed book AND keeps the pre-change parity
//!   (delta review D2-2): while the root is absent the nearest existing
//!   ancestor (bounded at the provider home) is armed NonRecursive so the
//!   root's `Create(<projects>)` is observed the moment it happens and
//!   answered with the full plan + return cascade; the rearm tick's absent
//!   re-check (the same full cascade) is the safety net only. The 15-minute
//!   TTL reconciliation covers providers whose root never appears during
//!   the watcher's lifetime.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use notify::Watcher;
use tokio::sync::mpsc;

use crate::directory_index::SessionIndex;
use crate::provider_layout::{ProviderLayout, WatchChangeScope, WatchMode};
use crate::watch_plan::{
    classify_arm_error, classify_basename, diff_armed, is_watch_target, plan_amplifier_targets,
    ArmErr, ArmKind, BasenameClass, PlanTargets,
};

/// Debounce window: coalesced events are flushed to SessionIndex after
/// this much quiet time. 200ms matches the observer's findings and is
/// well under human-perceptible latency.
const DEBOUNCE_MS: u64 = 200;

/// Max deferral cap (design value): a burst's flush deadline is additionally
/// bounded at this offset from the FIRST event of the burst, so a sustained
/// stream of sub-quiet-gap events can never starve the flush (the plain
/// quiet-gap rule resets the deadline per event, so such a stream would).
const MAX_FLUSH_DEFERRAL: Duration = Duration::from_secs(2);

/// How often (seconds) to re-check absent providers whose roots didn't
/// exist at startup (or whose watchers failed to arm). When a provider's
/// root appears, a watcher is armed for it. Also detects ancestor
/// watchers that should be replaced by precise-root watchers.
const REARM_INTERVAL_SECS: u64 = 60;

/// A coarse, provider-agnostic classification of one notify event. The
/// amplifier managed engine consumes it; the legacy providers' flush
/// ignores it. `CreateFolder` deliberately preserves the
/// `CreateKind::Folder` distinction: depth-4 routing drops a
/// folder creation (`context-intelligence/` mkdir) while scoped-marking
/// a file creation, and structural depths treat
/// `CreateFolder` as create-ish because a mkdir IS a `Create(Folder)`
/// under inotify. `Remove` deliberately does NOT carry the notify
/// dir-vs-file tag: a directly-armed directory's self-delete surfaces as
/// `Remove(File)`, NOT `Remove(Folder)` (the kernel does not set ISDIR
/// on IN_DELETE_SELF — LB-01 probe), so remove routing by path depth
/// must dispatch on the `Remove` kind WITHOUT filtering on the
/// dir-vs-file tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WatchKind {
    Create,
    CreateFolder,
    Remove,
    NameFrom,
    NameTo,
    NameBoth,
    Modify,
    Other,
}

fn kind_of(event: &notify::Event) -> WatchKind {
    use notify::event::{CreateKind, ModifyKind, RenameMode};
    match event.kind {
        notify::EventKind::Create(CreateKind::Folder) => WatchKind::CreateFolder,
        notify::EventKind::Create(_) => WatchKind::Create,
        notify::EventKind::Remove(_) => WatchKind::Remove,
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)) => WatchKind::NameFrom,
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)) => WatchKind::NameTo,
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => WatchKind::NameBoth,
        notify::EventKind::Modify(_) => WatchKind::Modify,
        _ => WatchKind::Other,
    }
}

/// Events from watcher callbacks, carrying provider identity so the
/// flush logic can scope dirty marks to the correct provider. Crate-visible
/// because the `#[cfg(test)]` event-injection seam types it over the
/// channel halves.
pub(crate) enum WatchEvent {
    /// One notify event's full path set (one FileChanged message per
    /// notify event). Rename vocabulary as observed by the LB-01
    /// real-notify probe (notify 6.1.1, kernel 6.6.87.2-WSL2, ext4): an
    /// intra-`sessions/` rename emits THREE events sharing one tracker
    /// cookie — `Name(From)` with paths [from], `Name(To)` with paths
    /// [to], and `Name(Both)` carrying paths [from, to] — so a rename
    /// surfaces as three FileChanged messages and the dispatch handles
    /// both the From/To pair shape and the paired Both shape.
    FileChanged {
        paths: Vec<PathBuf>,
        kind: WatchKind,
        provider: String,
    },
    /// This provider needs a full re-discovery (direct-listed db change,
    /// `need_rescan()` flag, or watcher error).
    ProviderRescan { provider: String },
}

/// A configured provider with its resolved home directory.
pub struct WatchedProvider {
    pub layout: Box<dyn ProviderLayout>,
    pub home: PathBuf,
}

/// One notify watcher per provider armed on many paths. Watch lifetimes
/// are explicit (`watch_path`/`unwatch_tolerated`); dropping the loop's
/// `ProviderWatch` drops every remaining watch with the watcher.
struct ProviderWatch {
    watcher: notify::RecommendedWatcher,
    /// legacy per-base bookkeeping mirroring the former per-target record:
    targets: Vec<ArmedTarget>,
}

struct ArmedTarget {
    requested_base: PathBuf,
    actual_target: PathBuf,
}

/// The session-directory file watcher.
pub struct SessionWatcher {
    index: Arc<SessionIndex>,
    providers: Vec<WatchedProvider>,
    stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
    rearm_interval_secs: u64,
    /// Some iff a provider with `layout.name() == "amplifier"` is
    /// configured: the managed watch-set bookkeeping, shared with the
    /// watcher loop which clones the Arc at `start`.
    amplifier_book: Option<Arc<std::sync::Mutex<ManagedBook>>>,
    /// Connected subagent interest count (see `with_subagent_interest`).
    subagent_interest: Arc<std::sync::atomic::AtomicUsize>,
    /// The event channel, allocated at CONSTRUCTION (not in `start`):
    /// watcher callbacks clone the sender exactly as before; `start`
    /// `take()`s the receiver into the loop unchanged. Tests can inject
    /// events BEFORE start via `test_event_tx`.
    event_tx: mpsc::UnboundedSender<WatchEvent>,
    event_rx: Option<mpsc::UnboundedReceiver<WatchEvent>>,
    /// The startup watcher-ready barrier (amplifier watch-reduction Task 9):
    /// the `watch::channel(false)` pair is created ONCE at construction and
    /// BOTH ends stored. Consumers subscribe via `startup_ready()` — a CLONE
    /// of the retained receiver (any number of consumers, before or after
    /// `start()`, identically) — and `start()` moves ONLY the sender into
    /// the loop. `watch`, not a bare `Notify`: the sender may fire BEFORE
    /// any awaiter exists and `Notify::notify_waiters` loses such signals;
    /// the watch receiver's `wait_for(|done| *done)` returns immediately
    /// once the value is set, whenever it subscribed.
    startup_ready_tx: Option<tokio::sync::watch::Sender<bool>>,
    startup_ready_rx: tokio::sync::watch::Receiver<bool>,
}

/// Retire inode-bound Codex watches when a root changes. The permanent
/// home watch is distinct from child roots, so retiring a child never
/// accidentally removes the home arm that observes its replacement.
fn retire_codex_root_targets(
    watched: &mut ProviderWatch,
    absent: &mut Vec<(usize, PathBuf)>,
    provider_index: usize,
    root: &Path,
) {
    let ProviderWatch { watcher, targets } = watched;
    targets.retain(|target| {
        if !target.requested_base.starts_with(root) {
            return true;
        }
        tracing::info!(
            provider = "codex",
            path = %target.requested_base.display(),
            "session-watcher: root changed, tracking for re-arm",
        );
        unwatch_tolerated(watcher, "codex", &target.actual_target);
        if !absent
            .iter()
            .any(|(index, base)| *index == provider_index && base == &target.requested_base)
        {
            absent.push((provider_index, target.requested_base.clone()));
        }
        false
    });
}

/// Event filter: same logic as `activity.rs::fs_event_is_relevant` —
/// data-mutation kinds only, plus the Rescan miss-recovery override.
fn is_relevant(event: &notify::Event) -> bool {
    event.need_rescan()
        || matches!(
            event.kind,
            notify::EventKind::Modify(notify::event::ModifyKind::Data(_))
                | notify::EventKind::Modify(notify::event::ModifyKind::Any)
                | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                | notify::EventKind::Create(_)
                | notify::EventKind::Remove(_)
                | notify::EventKind::Any
        )
}

/// Build a watcher callback that sends events to the given channel,
/// tagged with the provider's identity. Shared by initial arming and
/// re-arming.
fn make_watcher_callback(
    tx: mpsc::UnboundedSender<WatchEvent>,
    provider_name: String,
    is_direct: bool,
) -> impl Fn(Result<notify::Event, notify::Error>) + Send {
    move |res: Result<notify::Event, _>| match res {
        Ok(event) => {
            if !is_relevant(&event) {
                return;
            }
            let rescan = is_direct || event.need_rescan();
            if rescan {
                let _ = tx.send(WatchEvent::ProviderRescan {
                    provider: provider_name.clone(),
                });
            } else {
                let _ = tx.send(WatchEvent::FileChanged {
                    paths: event.paths.clone(),
                    kind: kind_of(&event),
                    provider: provider_name.clone(),
                });
            }
        }
        Err(e) => {
            tracing::warn!(
                provider = %provider_name, error = %e,
                "session-watcher: watcher error"
            );
            let _ = tx.send(WatchEvent::ProviderRescan {
                provider: provider_name.clone(),
            });
        }
    }
}

/// Create THE provider's watcher. One watcher == one inotify fd per
/// provider (PR #655's per-target model would mint ~4.4K watchers on the
/// managed set — a `max_user_instances` (1024) violation).
fn create_provider_watcher(
    tx: &mpsc::UnboundedSender<WatchEvent>,
    provider_name: &str,
    is_direct: bool,
) -> Option<notify::RecommendedWatcher> {
    let cb = make_watcher_callback(tx.clone(), provider_name.to_owned(), is_direct);
    match notify::recommended_watcher(cb) {
        Ok(watcher) => Some(watcher),
        Err(e) => {
            tracing::warn!(
                provider = %provider_name,
                error = %e,
                "session-watcher: failed to create watcher",
            );
            None
        }
    }
}

/// Arm one path on the provider's shared watcher. Errors propagate (the
/// caller decides absent-vs-retry policy); failures are logged here.
fn watch_path(
    watcher: &mut notify::RecommendedWatcher,
    provider_name: &str,
    target: &Path,
    mode: notify::RecursiveMode,
) -> Result<(), notify::Error> {
    if let Err(e) = watcher.watch(target, mode) {
        tracing::warn!(
            provider = %provider_name,
            path = %target.display(),
            error = %e,
            "session-watcher: failed to arm watch",
        );
        return Err(e);
    }
    Ok(())
}

/// Explicit unwatch. IN_IGNORED on delete means the kernel already
/// dropped the watch, so WatchNotFound-class errors are tolerated at
/// debug (design: "explicit unwatch tolerates WatchNotFound").
fn unwatch_tolerated(watcher: &mut notify::RecommendedWatcher, provider_name: &str, target: &Path) {
    match watcher.unwatch(target) {
        Ok(()) => {}
        Err(e) if matches!(&e.kind, notify::ErrorKind::WatchNotFound) => {
            tracing::debug!(
                provider = %provider_name,
                path = %target.display(),
                "session-watcher: unwatch of already-dropped watch (tolerated)",
            );
        }
        Err(e) => {
            tracing::warn!(
                provider = %provider_name,
                path = %target.display(),
                error = %e,
                "session-watcher: unwatch failed",
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Amplifier managed watch set (kata v0h9 follow-up; design
// docs/superpowers/plans/2026-08-17-amplifier-watch-reduction.md). The
// planner (`crate::watch_plan`) owns "what SHOULD be armed"; this engine
// owns arming. The arm helpers are FREE FUNCTIONS (not SessionWatcher
// methods): the recv loop calls them with ITS watcher + locked book + a
// fresh ArmOutcome, and tests drive the identical helpers directly on a
// locally-constructed watcher + a fresh book, with no spawned loop.
// ---------------------------------------------------------------------------

/// Bookkeeping for the amplifier managed watch set (design "Watch set" +
/// "Absence/retry"). Owned by the watcher task; an Arc clone is held by
/// SessionWatcher so tests can observe armed state without racing the loop.
#[derive(Debug, Default)]
pub(crate) struct ManagedBook {
    /// Every armed path (projects root, sessions dirs, stand-ins, root
    /// session dirs).
    armed: std::collections::HashSet<PathBuf>,
    /// Structural targets whose path is currently absent: the projects root
    /// (re-checked by the rearm tick, with its late-root ancestor fast path)
    /// and sessions dirs whose arm caught ENOENT/ENOTDIR in the scan→arm
    /// window (delta D2-1 — their PROJECT's armed stand-in owns reappearance
    /// detection; the absence entry clears on the successful re-arm).
    /// Session dirs are never absence-tracked (design).
    absent: std::collections::HashSet<PathBuf>,
    /// Transient arm failures under bounded exponential backoff
    /// (retry_backoff doubling to its 60s cap, RETRY_CAP entries).
    retry: HashMap<PathBuf, RetryEntry>,
    /// Edge state of the 25%-of-kernel-limit watch-budget WARN: true while
    /// the armed set sits above the quarter. Re-evaluated after every arm
    /// batch via `check_watch_budget`.
    budget_warned: bool,
    /// Daily-bucketed count of unknown-format session-dir arms — the
    /// naming-drift alarm's input.
    drift: DailyCounter,
    /// Count of APPLIED replans (observability): a planner-Err abort is not
    /// an applied replan, so the abort path leaves this untouched.
    replans: usize,
    /// The late-root ancestor fast path (delta D2-2 — the pre-change
    /// recursive engine armed the nearest existing ancestor for exactly
    /// this, so the managed engine owes the parity): while the projects
    /// root sits in `absent`, the NEAREST EXISTING ancestor (bounded at the
    /// provider home — the pre-change late-root rule for the recursive
    /// providers) is armed NonRecursive so the root's creation is observed
    /// the moment it happens; the rearm tick stays the safety net only.
    /// Managed by
    /// `sync_ancestor_watch` and kept OUT of `armed`: the replan diff and
    /// the prefix-based subtree cleanups operate on the managed set, and
    /// the ancestor is a PREFIX of every managed path — booking it there
    /// would let a diff-unwatch cascade wipe the whole set.
    ancestor: Option<PathBuf>,
    /// Delta D4-1 deferred drift-rescue probes: subagent-NAMED session dirs
    /// whose mkdir-time content probe found NO `metadata.json` yet
    /// (amplifier creates the dir before writing it — the design's known
    /// emit order). Re-probed on every flush while any entry lives (the
    /// flush scheduler folds this set into its deadline), each entry
    /// expiring after [`DEFERRED_ROOT_PROBE_TTL`]; the set is capped at
    /// [`DEFERRED_ROOT_PROBE_CAP`]. An evicted (overflow/expiry) or
    /// declined candidate drops to the self-correction channel / cadence /
    /// reconcile per the accepted residuals — a deferred dir is never
    /// WATCHED, only stat+parse-probed, and never armed without positive
    /// root content.
    deferred: HashMap<PathBuf, Instant>,
}

/// D4-1: bound on the deferred drift-rescue probe set (one stat+small-read
/// per entry per flush, so the bound caps the per-flush probe cost of a
/// subagent mkdir storm). Overflow drops the NEW candidate with a WARN to
/// the self-correction channel — the accepted-residual backstop.
const DEFERRED_ROOT_PROBE_CAP: usize = 64;
/// D4-1: how long a metadata-absent drift candidate is re-probed before
/// dropping to the channel/cadence/reconcile — sized so the real
/// create-then-write gap (~ms) wins the prompt arm with a wide margin.
const DEFERRED_ROOT_PROBE_TTL: Duration = Duration::from_secs(5);

/// A transient arm failure awaiting the rearm tick; `kind` is retained so
/// the retry drain re-arms with the SAME behavior as first-line arming
/// (a `SessionsDir` re-arm cascades its children, a `Standin` re-arm
/// performs the swap, never a flattened bare path).
#[derive(Debug)]
struct RetryEntry {
    failures: u32,
    next_attempt: Instant,
    kind: ArmKind,
}

/// Bound on the retry set; eviction logs a warn and drops (latency-only
/// degradation — the 15-minute reconcile owns evicted targets).
const RETRY_CAP: usize = 256;

/// Exponential backoff schedule for transient arm failures: 1,2,4,…,60s,
/// expressed as a pure fn so tests pin the schedule without sleeping.
fn retry_backoff(failures: u32) -> Duration {
    let step = 2u64.checked_pow(failures.min(6)).unwrap_or(64);
    Duration::from_secs(step.min(60))
}

/// Read the kernel inotify watch limit (Linux). `None` elsewhere — the
/// 25% WARN simply stays off (design line 160 budgets against it).
fn read_max_user_watches() -> Option<usize> {
    std::fs::read_to_string("/proc/sys/fs/inotify/max_user_watches")
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// WARN when total armed watches exceed 25% of the kernel limit.
fn watch_budget_warn_needed(armed: usize, max_user_watches: usize) -> bool {
    armed > max_user_watches / 4
}

/// Edge-triggered budget state transition: (new warned state, emit WARN
/// now). The edge fires on the ≤25% → >25% CROSSING only — already-warned
/// growth stays silent (no per-arm spam), and falling back below the
/// threshold silently re-arms the edge so the NEXT crossing warns again.
/// `max_user_watches` is a parameter so tests inject the limit.
fn watch_budget_edge(warned: bool, armed: usize, max_user_watches: usize) -> (bool, bool) {
    let over = watch_budget_warn_needed(armed, max_user_watches);
    match (warned, over) {
        (false, true) => (true, true),   // crossing: warn once
        (true, false) => (false, false), // recovered: re-arm the edge
        (w, _) => (w, false),
    }
}

/// The watch-budget check shared by every arm-batch application — startup
/// apply, the structural-create cascade dispatch (once per batch, not per
/// arm), the retry-drain batch, the absent-root-return cascade, and the
/// replan apply. The armed set grows
/// unboundedly at RUNTIME (the accepted ~31K/yr accrual), so a
/// startup-only check would sleep through a runtime crossing. `None`
/// off-Linux/parse failure no-ops with the edge state untouched.
fn check_watch_budget(book: &mut ManagedBook) {
    let Some(max) = read_max_user_watches() else {
        return;
    };
    let (warned, emit) = watch_budget_edge(book.budget_warned, book.armed.len(), max);
    book.budget_warned = warned;
    if emit {
        tracing::warn!(
            armed = book.armed.len(),
            max_user_watches = max,
            "session-watcher: armed inotify watches exceed 25% of the kernel watch limit",
        );
    }
}

/// Daily-bucketed counter for unknown-format (non-UUID, non-subagent)
/// arms — surfaces amplifier naming drift in days instead of silently
/// minting ~609 permanent watches/day (design lines 160-164).
#[derive(Debug, Default)]
struct DailyCounter {
    day_stamp: u64,
    count: u32,
}

/// Unknown-format arms per UTC day that trip a single WARN (the real
/// corpus has 21 oddball arms at boot — 50 sits comfortably above
/// steady-state and far under a naming-drift flood of ~609/day).
const DRIFT_DAILY_WARN_THRESHOLD: u32 = 50;

impl DailyCounter {
    /// Note one unknown-format arm; returns the WARN message to log on the
    /// day-bucketed threshold crossing, `None` otherwise.
    fn note_unknown_arm(&mut self, now: SystemTime) -> Option<String> {
        let day = now
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() / 86_400)
            .unwrap_or(0);
        if day != self.day_stamp {
            self.day_stamp = day;
            self.count = 0;
        }
        self.count += 1;
        (self.count == DRIFT_DAILY_WARN_THRESHOLD).then(|| {
            format!(
                "session-watcher: {DRIFT_DAILY_WARN_THRESHOLD} unknown-format amplifier session dirs armed today — possible naming drift (each costs a permanent inotify watch)"
            )
        })
    }
}

/// The ONLY output channel of the arm helpers: watch-then-scan scoped
/// `metadata.json` marks plus a provider-level dirty flag. Drained by the
/// async caller into the index — the helpers NEVER take `&Arc<SessionIndex>`
/// and never touch the index, which is exactly what keeps them
/// `spawn_blocking`-safe: every bulk phase (startup apply, replan apply,
/// retry-drain batch, absent-root-return cascade) runs off the async
/// worker and hands marks/routing back. Index mutation ALWAYS happens on
/// the async loop.
#[derive(Default)]
struct ArmOutcome {
    marks: Vec<PathBuf>,
    provider_dirty: bool,
}

/// Shared arming clause for every managed target: one NonRecursive
/// `watch_path`, then the bookkeeping the design pins. Success: the path
/// lands in `armed` and any stale retry/absence entry clears. Deterministic
/// failure (ENOENT/ENOTDIR): the PROJECTS ROOT routes to `absent` +
/// provider dirty (the scan→arm ENOENT race is never silently dropped); a
/// SESSIONS DIR is routed by its caller to the project's stand-in + `absent`
/// (delta D2-1 — the parent-is-watched guarantee does not extend to it);
/// the remaining kinds (Standin, SessionDir) are dropped immediately (their
/// parents ARE watched, so a reappearance is a fresh structural create).
/// Transient failure: enters `retry` at doubled, capped backoff with the
/// kind retained (a re-failure bumps the count in place). Returns true when
/// the path is armed.
fn watch_and_record(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    provider: &str,
    path: &Path,
    kind: ArmKind,
) -> bool {
    match watch_path(watcher, provider, path, notify::RecursiveMode::NonRecursive) {
        Ok(()) => {
            book.armed.insert(path.to_path_buf());
            book.retry.remove(path);
            // A landed arm clears any absence booked for the exact path —
            // the D2-1 corner's sessions-dir entry disappears with the
            // successful re-arm/swap; a ProjectsRoot landing covers the
            // return flow the same way (the explicit removals stay as belt).
            book.absent.remove(path);
            true
        }
        Err(e) => {
            match classify_arm_error(&e) {
                ArmErr::Deterministic => {
                    book.retry.remove(path);
                    if kind == ArmKind::ProjectsRoot {
                        tracing::debug!(
                            provider = %provider,
                            path = %path.display(),
                            "session-watcher: projects root vanished between scan and arm; absence-tracking",
                        );
                        book.absent.insert(path.to_path_buf());
                        outcome.provider_dirty = true;
                    } else {
                        tracing::debug!(
                            provider = %provider,
                            path = %path.display(),
                            kind = ?kind,
                            "session-watcher: deterministic arm failure; dropped (reappearance is a fresh structural create)",
                        );
                    }
                }
                ArmErr::Transient => {
                    if !book.retry.contains_key(path) && book.retry.len() >= RETRY_CAP {
                        tracing::warn!(
                            provider = %provider,
                            path = %path.display(),
                            "session-watcher: retry set full ({RETRY_CAP}); dropping transient arm failure",
                        );
                        return false;
                    }
                    let failures = book.retry.get(path).map(|e| e.failures + 1).unwrap_or(1);
                    book.retry.insert(
                        path.to_path_buf(),
                        RetryEntry {
                            failures,
                            next_attempt: Instant::now() + retry_backoff(failures),
                            kind,
                        },
                    );
                    tracing::debug!(
                        provider = %provider,
                        path = %path.display(),
                        kind = ?kind,
                        failures,
                        "session-watcher: transient arm failure; retry scheduled",
                    );
                }
            }
            false
        }
    }
}

/// The FIRST-LINE arming site, KIND-AWARE so first-line, retry-drain, and
/// replan arms behave identically for the same target. (The refresh→watcher
/// self-correction channel deliberately does NOT flow through the
/// `ArmKind::SessionDir` name gate — its content-verified roots arm via
/// [`arm_reported_root_dir`].) Bookkeeping-idempotent: arming an
/// already-armed path is a no-op, so double discovery (initial scan ∪
/// post-arm rescans ∪ live events) is safe.
fn arm_managed_dir(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    provider: &str,
    path: &Path,
    arm_kind: ArmKind,
    emit_marks: bool,
) {
    match arm_kind {
        ArmKind::Standin => arm_sessions_or_standin(book, watcher, outcome, path, emit_marks),
        ArmKind::SessionsDir => {
            if book.armed.contains(path) {
                return;
            }
            if watch_and_record(book, watcher, outcome, provider, path, arm_kind) {
                // Watch-then-scan: the structural cascade runs only off a
                // LIVE watch, so a create landing between the readdir and
                // the arm can never be lost.
                cascade_session_children(book, watcher, outcome, path, emit_marks);
            } else if !book.retry.contains_key(path) {
                // Delta D2-1: a DETERMINISTIC failure (ENOENT/ENOTDIR — the
                // sessions dir vanished in the scan→arm window) must not
                // drop the target into the orphaned corner: planning SAW an
                // existing sessions dir, so no stand-in was armed for the
                // project, and the non-recursive root watch cannot observe
                // a grandchild's reappearance (a plain drop defers root
                // sessions created there to the 15-minute reconcile,
                // violating the zero-latency requirement). The corner is
                // only sound where the parent is guaranteed watched —
                // SessionDir's parent (the sessions dir) is, Standin's
                // parent (the root) is — so arm the PROJECT dir as the
                // stand-in, the same object a missing-at-plan sessions dir
                // produces (`arm_sessions_or_standin`, swap included: a
                // sessions/ reappearing mid-window swaps first-line), and
                // absent-track the sessions dir. A later reappearance
                // surfaces as the existing depth-2 `Create(sessions)` →
                // swap path. Transient failures entered `retry` instead
                // and own the target — the stand-in must not double-own it.
                book.absent.insert(path.to_path_buf());
                if let Some(project) = path.parent() {
                    arm_sessions_or_standin(book, watcher, outcome, project, emit_marks);
                }
            }
        }
        ArmKind::SessionDir => {
            // Classification by BASENAME only, inside the FIRST-LINE
            // arming site (defense in depth — planner, cascades, and
            // dispatch all pre-filter): subagent dirs are NEVER armed;
            // unknown formats fail safe toward watching (Task 4's drift
            // counter hooks this classification). The refresh→watcher
            // self-correction channel arms its content-verified roots via
            // [`arm_reported_root_dir`] instead — it alone bypasses the
            // name gate by design (its whole purpose is recovering dirs
            // whose name says subagent but whose parsed content says
            // root).
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let class = classify_basename(name);
            if !is_watch_target(class) {
                tracing::debug!(
                    provider = %provider,
                    path = %path.display(),
                    "session-watcher: subagent-class session dir is never armed",
                );
                return;
            }
            if book.armed.contains(path) {
                return;
            }
            tracing::debug!(
                provider = %provider,
                path = %path.display(),
                class = ?class,
                "session-watcher: arming session dir",
            );
            if watch_and_record(book, watcher, outcome, provider, path, arm_kind) {
                if class == BasenameClass::Unknown {
                    // Drift alarm: each SUCCESSFUL unknown-format arm mints
                    // a permanent inotify watch; the day-bucketed counter
                    // WARNs once per threshold-crossing day. Post-success
                    // ONLY (delta review D1-4): counted pre-arm, one
                    // transiently-failing unknown dir would re-count on every
                    // capped-backoff retry until the WARN claimed 50 armed
                    // dirs that never held a single watch.
                    if let Some(msg) = book.drift.note_unknown_arm(SystemTime::now()) {
                        tracing::warn!("{msg}");
                    }
                }
                if emit_marks {
                    // File-state watch-then-scan: a scoped mark on a
                    // (possibly missing) metadata.json is a safe no-op /
                    // correct prune downstream.
                    outcome.marks.push(path.join("metadata.json"));
                }
            }
        }
        ArmKind::ProjectsRoot => {
            if book.armed.contains(path) {
                return;
            }
            watch_and_record(book, watcher, outcome, provider, path, arm_kind);
        }
    }
}

/// Self-correction channel arm (design "Self-correction channel"): the
/// index reported this dir as a CONTENT-verified root (a sweep that fully
/// discovered amplifier parsed its metadata with `parent_id` absent), so
/// the basename classifier — the FIRST-LINE authority — is intentionally
/// not consulted: the misnamed-root case this channel exists to recover
/// is precisely name-says-subagent / content-says-root, and
/// `arm_managed_dir(.., ArmKind::SessionDir, ..)` would refuse the
/// subagent-pattern basename. Everything else is IDENTICAL to an
/// `ArmKind::SessionDir` arm: the shared `watch_and_record` clause (armed
/// bookkeeping, deterministic drop, transient retry — recorded under
/// `ArmKind::SessionDir` so the retry drain's kind routing in
/// [`arm_retry_entry`] recognizes it), the file-state watch-then-scan
/// mark when `emit_marks`, and the already-armed no-op. NO drift
/// accounting: drift counts unknown-FORMAT (non-UUID, non-subagent-
/// pattern) arms, and a reported dir that reaches here unarmed carries a
/// KNOWN-format subagent-pattern name by construction (UUID/unknown names
/// are armed first-line or sit in retry — both filtered before the
/// channel's arm loop runs).
fn arm_reported_root_dir(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    provider: &str,
    path: &Path,
    emit_marks: bool,
) {
    if book.armed.contains(path) {
        return;
    }
    tracing::debug!(
        provider = %provider,
        path = %path.display(),
        "session-watcher: arming content-verified root session dir reported by refresh",
    );
    if watch_and_record(book, watcher, outcome, provider, path, ArmKind::SessionDir) && emit_marks {
        outcome.marks.push(path.join("metadata.json"));
    }
}

/// Retry-drain routing: a `SessionDir`-kind retry entry whose basename
/// classifies Subagent can ONLY have been inserted by the content-verified
/// self-correction channel (first-line `ArmKind::SessionDir` arming refuses
/// subagent names before `watch_and_record` runs, so a genuinely subagent
/// dir never enters retry), so it re-arms through the channel's
/// classification-free helper rather than the first-line name gate — which
/// would refuse it forever. Every other entry re-arms kind-correctly
/// through the one arming site.
fn arm_retry_entry(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    provider: &str,
    path: &Path,
    kind: ArmKind,
) {
    if kind == ArmKind::SessionDir {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !is_watch_target(classify_basename(name)) {
            arm_reported_root_dir(book, watcher, outcome, provider, path, true);
            return;
        }
    }
    arm_managed_dir(book, watcher, outcome, provider, path, kind, true);
}

/// Readdir a sessions dir and arm every root-classified child session dir
/// (each arm does its own file-state watch-then-scan: the scoped
/// `metadata.json` mark lands in `outcome.marks` when `emit_marks`).
/// Tolerant per entry — a failed entry skips, never aborts the cascade
/// (the live parent watch reports later structural changes; STRICT scans
/// are the planner's job).
fn cascade_session_children(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    sessions_dir: &Path,
    emit_marks: bool,
) {
    let entries = match std::fs::read_dir(sessions_dir) {
        Ok(entries) => entries,
        Err(e) => {
            tracing::debug!(
                path = %sessions_dir.display(),
                error = %e,
                "session-watcher: sessions-dir rescan failed; live watch keeps reporting",
            );
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                tracing::debug!(
                    path = %sessions_dir.display(),
                    error = %e,
                    "session-watcher: sessions-dir rescan entry failed; skipped",
                );
                continue;
            }
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        arm_managed_dir(
            book,
            watcher,
            outcome,
            "amplifier",
            &entry.path(),
            ArmKind::SessionDir,
            emit_marks,
        );
    }
}

/// The design's stand-in rule, including the post-arm re-check: arm the
/// project dir itself when it has no `sessions/` child (so the later
/// `sessions/` create is observed); if `sessions/` already exists — or
/// appeared in the check→arm window — arm the real sessions dir
/// (`ArmKind::SessionsDir`, which cascades its children), then drop the
/// stand-in only once that arm has landed.
fn arm_sessions_or_standin(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    project_dir: &Path,
    emit_marks: bool,
) {
    let sessions = project_dir.join("sessions");
    if !sessions.is_dir() {
        // Stand-in arm (skip when already armed: the live watch then owns
        // the sessions/ create, and the recheck below would be stale).
        if book.armed.contains(project_dir) {
            return;
        }
        if !watch_and_record(
            book,
            watcher,
            outcome,
            "amplifier",
            project_dir,
            ArmKind::Standin,
        ) {
            return; // absence/retry bookkeeping done inside
        }
    }
    // Post-arm recheck: a sessions/ created between the first is_dir and
    // the watch arm produced NO event the armed watch could see — only
    // this recheck can catch it (the check→arm window).
    if sessions.is_dir() {
        // Swap order: arm the sessions dir FIRST (the kind-correct failure
        // routing inside — deterministic drop / transient retry — is
        // unchanged), then unwatch the stand-in only once the sessions arm
        // has landed. A failed swap keeps the stand-in watching the
        // project, so a re-created sessions/ is observed as a fresh depth-2
        // create; the brief double-watch window is harmless (all arms are
        // idempotent).
        arm_managed_dir(
            book,
            watcher,
            outcome,
            "amplifier",
            &sessions,
            ArmKind::SessionsDir,
            emit_marks,
        );
        if book.armed.contains(&sessions) && book.armed.remove(project_dir) {
            unwatch_tolerated(watcher, "amplifier", project_dir);
        }
    }
}

/// `Create(<proj>)`/`CreateFolder(<proj>)` on the root watch (or the
/// startup root rescan): arm the new project's sessions dir / stand-in,
/// cascading existing children. The stray-file guard skips non-dirs — a
/// stray file at project depth (e.g. `repl_history`) never generates a
/// doomed `<file>/sessions` arm attempt.
fn cascade_new_project(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    project_dir: &Path,
    emit_marks: bool,
) {
    if !project_dir.is_dir() {
        return;
    }
    arm_sessions_or_standin(book, watcher, outcome, project_dir, emit_marks);
}

/// The shared bookkeeping cleanup for one structurally-removed path (and
/// anything below it, by `starts_with` prefix): dropped from `armed`,
/// `absent`, and `retry` (a removed disposable workspace must not
/// forever-retry). IDEMPOTENT — the LB-01 untracked duplicate `Name(From)`
/// re-processes an already-forgotten path as a clean no-op. Unwatching is
/// the callers' job (they hold the watcher).
fn structural_remove(book: &mut ManagedBook, path: &Path) {
    book.armed.retain(|p| !p.starts_with(path));
    book.absent.retain(|p| !p.starts_with(path));
    book.retry.retain(|p, _| !p.starts_with(path));
}

/// The replan variant of [`structural_remove`]: an unwatch-diff path's
/// subtree cleanup SPARES every entry that remains a key of the replan's
/// desired map (which names exact paths, so a `contains_key` check covers
/// both the unwatch path itself — never desired by construction — and the
/// path's desired descendants). The arm loop runs BEFORE the unwatch loop,
/// so a stale stand-in's unwatch (`<proj>`, while `<proj>/sessions` is now
/// desired) would otherwise prefix-wipe the freshly-armed sessions dir and
/// its cascaded children out of `armed` while their KERNEL watches stay
/// live (unwatching the parent drops nothing else) — desyncing the ledger
/// from the kernel: the depth-2 swap-back gate (`armed.contains(sessions)`)
/// would misfire, project teardown would miss the live watches, and the
/// budget WARN would undercount. The same wipe would also silently drop a
/// desired entry sitting in `retry` (backoff silently ended). Sparing
/// desired keys on all three sets keeps the ledger matched to the kernel.
fn structural_remove_except(
    book: &mut ManagedBook,
    path: &Path,
    desired: &HashMap<PathBuf, ArmKind>,
) {
    book.armed
        .retain(|p| !p.starts_with(path) || desired.contains_key(p));
    book.absent
        .retain(|p| !p.starts_with(path) || desired.contains_key(p));
    book.retry
        .retain(|p, _| !p.starts_with(path) || desired.contains_key(p));
}

/// Forget ONE removed session dir: the explicit unwatch is belt-and-braces
/// (LB-01 sub-claim 3 nuance: in the managed-set shape the armed parent's
/// MOVED_FROM auto-drops the old-path watch, so this unwatch commonly
/// returns the tolerated `WatchNotFound`; it stays for the unowned-parent
/// inode-follow shape, whose watch would otherwise keep reporting under
/// the stale path forever) — then prefix bookkeeping cleanup, then a
/// scoped metadata.json mark so the row prunes promptly (stat None →
/// cache remove).
fn amplifier_remove_session(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    index: &SessionIndex,
    session_dir: &Path,
) {
    unwatch_tolerated(watcher, "amplifier", session_dir);
    structural_remove(book, session_dir);
    index.mark_dirty(&[(session_dir.join("metadata.json"), "amplifier".to_owned())]);
}

/// Structural removal of a whole project (design line 88: "Structural
/// removes clean up the whole subtree's bookkeeping"): unwatch EVERY armed
/// path under the project (inotify watches follow inodes — an `mv`'d
/// project would leak watchers reporting under stale paths), drop the
/// subtree from armed/absent/retry, and scoped-mark each removed session
/// dir's metadata.json so its row prunes promptly (the dispatch's
/// provider-dirty escalation then reconciles independently).
fn amplifier_teardown_project(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    index: &SessionIndex,
    project_dir: &Path,
) {
    let doomed: Vec<PathBuf> = book
        .armed
        .iter()
        .filter(|p| p.starts_with(project_dir))
        .cloned()
        .collect();
    for path in &doomed {
        unwatch_tolerated(watcher, "amplifier", path);
    }
    structural_remove(book, project_dir);
    let marks: Vec<(PathBuf, String)> = doomed
        .iter()
        .filter(|p| {
            // Session dirs sit exactly two levels below the project
            // (`<proj>/sessions/<id>`) — depth-relative, never basename-
            // routed (a project literally named `sessions` must not
            // misroute).
            p.strip_prefix(project_dir)
                .map(|r| r.components().count() == 2)
                .unwrap_or(false)
        })
        .map(|p| (p.join("metadata.json"), "amplifier".to_owned()))
        .collect();
    index.mark_dirty(&marks);
}

/// The DEPTH-0 self-removal of the ARMED projects root (LB-01: it surfaces
/// tagless as `Remove(File)` / untracked `Name(From)`; nothing watches the
/// root's parent, so depth-0 self-events are the ONLY way the watcher
/// learns the root is gone). Unwatch EVERY armed descendant, not just the
/// root: inotify watches follow inodes, and notify maps `MOVE_SELF` onto
/// the watched object only — a MOVED (not deleted) root leaves every
/// descendant non-recursive watch live, reporting under its stale path,
/// invisible to the ledger and the budget WARN, and un-tearable when a
/// replacement root is armed (delta review D1-1; the same sweep
/// [`amplifier_teardown_project`] performs at depth 1). For the delete
/// shape these descendant unwatches are the tolerated `WatchNotFound`
/// no-ops (the kernel already IN_IGNORED them). Then the whole managed
/// set's bookkeeping is dropped, and the root ALONE re-enters absence
/// tracking (design: "only the provider root itself re-enters absence
/// tracking when it disappears") — the late-root ancestor fast path
/// (delta D2-2) arms from the absence, so a re-created root is observed
/// the moment it happens; Task 3's rearm-tick absent re-check stays the
/// safety net, re-arming a returned root with the full structural cascade,
/// so delete-and-recreate (and move-away-and-recreate) leaves a live
/// watcher. The dispatch issues the provider-dirty escalation right after
/// (mirroring depth 1).
fn amplifier_root_vanished(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    projects_root: &Path,
) -> bool {
    let doomed: Vec<PathBuf> = book
        .armed
        .iter()
        .filter(|p| p.starts_with(projects_root))
        .cloned()
        .collect();
    for path in &doomed {
        unwatch_tolerated(watcher, "amplifier", path);
    }
    structural_remove(book, projects_root);
    book.absent.insert(projects_root.to_path_buf());
    // The ancestor is a strict PREFIX of the root, so it survived every
    // cleanup above — converge it to the new absence (arm if not armed).
    // D3-1: if the root ALREADY stands again (a delete-and-recreate inside
    // this event's dispatch latency — the ancestor was not armed when the
    // creation happened, so it queued no event), the sync reports TRUE and
    // the caller defers the FULL return cascade, exactly like a depth-0
    // create observed via the ancestor watch.
    sync_ancestor_watch(book, watcher, "amplifier", projects_root)
}

/// The structural Remove / rename-From routing (design "Structural removes
/// clean up the whole subtree's bookkeeping"), dispatched on the `Remove`
/// kind WITHOUT the notify dir-vs-file tag — an armed dir's self-delete
/// surfaces as `Remove(File)`, never `Remove(Folder)` (the kernel does not
/// set ISDIR on IN_DELETE_SELF — LB-01; a Folder-only gate would silently
/// miss it, so no refactor may add one). Every path is IDEMPOTENT: an
/// ARMED child's rename emits a 4th, UNTRACKED duplicate `Name(From)`
/// after the paired trio, and re-processing it is a clean no-op
/// (`unwatch_tolerated` absorbs the already-auto-dropped watch at debug;
/// the bookkeeping removes hit nothing). Runs strictly on the async loop,
/// so it calls `index.mark_dirty` / `mark_provider_dirty` directly (never
/// the `ArmOutcome` sink — that exists for the `spawn_blocking` arm
/// helpers). True = structurally handled; false → depth-4 mark fold or drop.
/// The depth-0 vanish may additionally SET `root_return` (delta D3-1): the
/// ancestor sync found the root standing again inside the remove→dispatch
/// window (a delete-and-recreate no armed ancestor could have observed),
/// so the full return cascade is deferred to the caller's spawn_blocking
/// batch exactly like a depth-0 create.
fn write_remove_dispatch(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    index: &SessionIndex,
    projects_root: &Path,
    path: &Path,
    root_return: &mut bool,
) -> bool {
    match amplifier_depth(projects_root, path) {
        // Depth 0: the ARMED projects root's own tagless self-removal —
        // the only way the watcher learns the root is gone (there is no
        // depth-0 Create to route; the root's RETURN is owned by the
        // late-root ancestor watch + deferred full cascade, with the
        // rearm-tick absent re-check's full cascade as the safety net).
        // Provider dirty: a provider discover reconciles the now-empty tree.
        Some(0) => {
            *root_return |= amplifier_root_vanished(book, watcher, projects_root);
            index.mark_provider_dirty("amplifier");
            true
        }
        // Depth 1: a whole project vanished (or was renamed away) — full
        // subtree teardown; provider dirty: the survivors' children are
        // gone, so a provider discover reconciles rows.
        Some(1) => {
            amplifier_teardown_project(book, watcher, index, path);
            index.mark_provider_dirty("amplifier");
            true
        }
        // Depth 2: `sessions/` removed (or renamed away) under an armed
        // sessions watch → (a) unwatch EVERY armed subtree member — same
        // inode-follow hazard as depth 1/depth 0: a MOVED sessions/ tree
        // leaves its session-dir watches live under stale paths —
        // (b) scoped-prune-mark each removed session dir's metadata.json
        // (same semantics as `amplifier_remove_session`) so cached rows
        // prune promptly, then (c) swap back to the stand-in (arm the
        // project) so a re-created sessions/ is observed. Already a
        // stand-in (or never armed): nothing; others → the caller's
        // `_ => {}`.
        Some(2) if path.file_name().and_then(|n| n.to_str()) == Some("sessions") => {
            if book.armed.contains(path) {
                let doomed: Vec<PathBuf> = book
                    .armed
                    .iter()
                    .filter(|p| p.starts_with(path))
                    .cloned()
                    .collect();
                for doomed_path in &doomed {
                    unwatch_tolerated(watcher, "amplifier", doomed_path);
                }
                structural_remove(book, path);
                // Session dirs sit exactly ONE level below the sessions dir
                // (depth-relative, never basename-routed).
                let marks: Vec<(PathBuf, String)> = doomed
                    .iter()
                    .filter(|p| {
                        p.strip_prefix(path)
                            .map(|r| r.components().count() == 1)
                            .unwrap_or(false)
                    })
                    .map(|p| (p.join("metadata.json"), "amplifier".to_owned()))
                    .collect();
                index.mark_dirty(&marks);
                if let Some(project) = path.parent() {
                    arm_sessions_or_standin(book, watcher, outcome, project, true);
                }
            }
            true
        }
        // Depth 3: one session dir vanished — forget it and prune its row.
        Some(3) => {
            amplifier_remove_session(book, watcher, index, path);
            true
        }
        _ => false,
    }
}

/// The startup half of the watch-then-scan invariant
/// (`apply_amplifier_plan` with `emit_marks: false`): the boot warm sweep
/// covers initial file state, so only the file-state stream is skipped —
/// the structural stream (arms + post-arm rescans) is NEVER skipped.
fn apply_amplifier_startup_plan(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    projects_root: &Path,
    plan: PlanTargets,
) {
    apply_amplifier_plan(book, watcher, outcome, projects_root, &plan, false);
}

/// `apply_amplifier_plan` with `emit_marks: true`, used by the rearm tick
/// when an ABSENT projects root returns — the watch-then-scan rescan
/// equivalent (readdir → arm/swap every child), so sessions created while
/// the root was gone are armed AND scoped-marked first-line, never
/// deferred to the 15-minute reconcile.
fn apply_amplifier_return_plan(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    projects_root: &Path,
    plan: &PlanTargets,
) {
    apply_amplifier_plan(book, watcher, outcome, projects_root, plan, true);
}

/// The plan an apply pass is reading: the CALLER's plan, or a FRESH plan
/// re-scanned by the D3-1 ancestor-sync recovery (the caller's plan went
/// stale when the root appeared inside the ancestor sync's window).
enum ApplyPlan<'a> {
    Caller(&'a PlanTargets),
    Fresh(PlanTargets),
}

impl ApplyPlan<'_> {
    fn plan(&self) -> &PlanTargets {
        match self {
            ApplyPlan::Caller(plan) => plan,
            ApplyPlan::Fresh(plan) => plan,
        }
    }
}

/// The ordered managed-set apply:
/// 1. Arm the projects root FIRST (NonRecursive, `ArmKind::ProjectsRoot`;
///    a deterministic failure routes to `absent` inside the shared
///    clause — the scan→arm ENOENT race is never silently dropped).
/// 2. Arm every plan-listed STRUCTURAL target kind-correctly
///    (`sessions_dirs` via `ArmKind::SessionsDir`, `standins` via
///    `ArmKind::Standin` — each arm does its own cascade/swap inline).
/// 3. Post-arm rescan — the union step: (a) readdir the ARMED projects
///    root and `cascade_new_project` every project dir the plan did not
///    cover (a project created between the initial scan and the root arm);
///    (b) `cascade_session_children` on every ARMED sessions dir, the
///    explicit idempotent union re-pass. Every session-dir arm therefore
///    comes from a readdir taken AFTER its parent watch is live, never
///    from the initial scan's possibly-stale listing — the scan→arm
///    window cannot lose a root session's freshness (the hard zero-latency
///    requirement). Arms landing while the batch runs queue events on the
///    watcher's channel and are processed normally by the recv arm.
fn apply_amplifier_plan(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    projects_root: &Path,
    plan: &PlanTargets,
    emit_marks: bool,
) {
    let mut plan = ApplyPlan::Caller(plan);
    let mut emit_marks = emit_marks;
    let mut recoveries = 0u32;
    // The D3-1 recovery pass-loop: EITHER ancestor sync below reporting
    // TRUE means the absent-booked root is present — it appeared while no
    // ancestor watch was live (between THIS pass's plan scan and the sync,
    // or inside the sync's own arm's check→arm window), so no return event
    // was queued. Restart the pass from a FRESH plan with the return
    // semantics (marks on — a scoped mark is a safe no-op downstream, and
    // the boot warm sweep races the return, so only the marks guarantee
    // first-line freshness; the provider-dirty startup carve-out stays off
    // the missing-root branch itself). Bounded by ROOT_RETURN_RECOVERY_CAP
    // per pass against a flapping root.
    loop {
        if !plan.plan().root_exists {
            // Missing root: absence-track (the late-root ancestor fast path
            // is converged at the end; the rearm tick re-checks as the
            // safety net). Provider dirty only on the RUNTIME paths
            // (emit_marks ⇔ the absent-return cascade): a hot index may
            // hold stale rows for the vanished root and must prune them. At
            // initial startup (emit_marks == false) the mark is
            // deliberately NOT set — the boot discover covers initial
            // state, nothing published can be stale yet, and a boot-time
            // detached refresh is unsynchronized with startup-settle
            // observability (it could publish content that only the
            // not-yet-armed watch set should have surfaced — the
            // pre-managed engine likewise armed the home ancestor then
            // without a provider-dirty mark). The planner-Err and arm-race
            // paths keep provider dirty unconditionally (both are
            // runtime-informative).
            book.absent.insert(projects_root.to_path_buf());
            if emit_marks {
                outcome.provider_dirty = true;
            }
            if !sync_ancestor_watch(book, watcher, "amplifier", projects_root) {
                return;
            }
            // D3-1 window (a)/(b): the root was present at the sync (it
            // appeared between this pass's plan scan and the ancestor
            // convergence) — recover via a fresh plan, never the tick.
            let Some(fresh) = replan_returned_root(outcome, projects_root, &mut recoveries) else {
                return;
            };
            plan = ApplyPlan::Fresh(fresh);
            emit_marks = true;
            continue;
        }
        // 1. Root first.
        arm_managed_dir(
            book,
            watcher,
            outcome,
            "amplifier",
            projects_root,
            ArmKind::ProjectsRoot,
            emit_marks,
        );
        // The root arm converged the absence state both ways (a
        // deterministic failure booked the absence; a landed arm clears
        // it) — converge the late-root ancestor watch to match. D3-1: a
        // TRUE report means the ProjectsRoot arm caught a vanish and the
        // root reappeared inside that arm→sync window — recover via a fresh
        // plan rather than leaving the returned root to the rearm tick.
        if sync_ancestor_watch(book, watcher, "amplifier", projects_root) {
            let Some(fresh) = replan_returned_root(outcome, projects_root, &mut recoveries) else {
                return;
            };
            plan = ApplyPlan::Fresh(fresh);
            emit_marks = true;
            continue;
        }
        break;
    }
    let plan = plan.plan();
    // 2. Plan-listed structural targets, kind-correct. Track every ARMED
    //    sessions dir for the 3(b) union re-pass, and every plan-covered
    //    project dir for 3(a)'s skip set.
    let mut armed_sessions_dirs: Vec<PathBuf> = Vec::new();
    let mut covered_projects: std::collections::HashSet<PathBuf> =
        plan.standins.iter().cloned().collect();
    for sessions_dir in &plan.sessions_dirs {
        arm_managed_dir(
            book,
            watcher,
            outcome,
            "amplifier",
            sessions_dir,
            ArmKind::SessionsDir,
            emit_marks,
        );
        if book.armed.contains(sessions_dir) {
            armed_sessions_dirs.push(sessions_dir.clone());
        }
        if let Some(project) = sessions_dir.parent() {
            covered_projects.insert(project.to_path_buf());
        }
    }
    for standin in &plan.standins {
        arm_managed_dir(
            book,
            watcher,
            outcome,
            "amplifier",
            standin,
            ArmKind::Standin,
            emit_marks,
        );
        // A stand-in whose sessions/ appeared mid-apply swaps inline.
        let sessions = standin.join("sessions");
        if book.armed.contains(&sessions) {
            armed_sessions_dirs.push(sessions);
        }
    }
    // 3(a). Root rescan: projects created between the initial plan scan
    // and the root arm produced no event the root watch could see.
    if book.armed.contains(projects_root) {
        match std::fs::read_dir(projects_root) {
            Ok(entries) => {
                for entry in entries {
                    let Ok(entry) = entry else { continue };
                    let Ok(file_type) = entry.file_type() else {
                        continue;
                    };
                    if !file_type.is_dir() {
                        continue;
                    }
                    let project = entry.path();
                    if !covered_projects.contains(&project) {
                        cascade_new_project(book, watcher, outcome, &project, emit_marks);
                        let sessions = project.join("sessions");
                        if book.armed.contains(&sessions) {
                            armed_sessions_dirs.push(sessions);
                        }
                    }
                }
            }
            Err(e) => {
                tracing::debug!(
                    path = %projects_root.display(),
                    error = %e,
                    "session-watcher: post-arm root rescan failed; live root watch owns later creates",
                );
            }
        }
    }
    // 3(b). Explicit union re-pass over every ARMED sessions dir (the
    // step-2 kind-aware arms already cascaded; re-running the same
    // idempotent helper keeps the invariant statement unconditional:
    // double discovery is a bookkeeping no-op).
    for sessions_dir in armed_sessions_dirs {
        cascade_session_children(book, watcher, outcome, &sessions_dir, emit_marks);
    }
}

/// The SYNC core of an amplifier watch-set replan (need_rescan /
/// IN_Q_OVERFLOW recovery): re-plan the desired watch set, diff it
/// (kind-tagged) against the armed set, and apply. Returns "applied" — the
/// async flush wrapper uses it for `book.replans` (the counter counts
/// APPLIED replans only).
///
/// ABORT discipline: when `plan_amplifier_targets` returns `Err` the replan
/// aborts BEFORE any diff application — a warn-level log, the armed set and
/// ALL bookkeeping stay untouched (a transient scan error — root OR nested;
/// the planner is strict-everywhere — is NOT an empty listing; same
/// transient-failure protection philosophy as `discover_checked`), while
/// `outcome.provider_dirty` is STILL set (the data plane recovers through
/// discover's own root-listing-failure protection).
///
/// On `Ok`, the desired set is `sessions_dirs → SessionsDir`,
/// `standins → Standin`, `root_session_dirs → SessionDir` PLUS
/// `{ projects_root → ProjectsRoot }` — the projects root ONLY when
/// `plan.root_exists`: the permanent root watch is not a `PlanTargets`
/// member (it is the engine's startup context, not a plan product), so the
/// union keeps the diff from classifying the structural root watch as
/// stale. When the root has VANISHED the desired set excludes it and the
/// replan itself routes the root to absence tracking (`unwatch_tolerated` +
/// `armed.remove` + `absent.insert` + provider dirty) — the dead subtree
/// then unwatches via the diff (all `WatchNotFound`-tolerated), and the
/// rearm tick's full-cascade re-arm owns the return. Apply is KIND-CORRECT,
/// never flattened: `SessionsDir` arms cascade their children, `Standin`
/// arms run the swap, `SessionDir` arms watch-then-scan; a path still in
/// `retry` is NOT re-armed (backoff is never bypassed). Each unwatch path
/// gets `unwatch_tolerated` + DESIRED-aware bookkeeping cleanup
/// ([`structural_remove_except`], which spares prefixed entries that are
/// keys of the desired map — the arm loop runs first, so a stale stand-in's
/// unwatch must not wipe the freshly-armed, kernel-live descendants it
/// just recorded, nor drop a desired entry sitting in `retry`).
/// Arm-failure routing (deterministic drop / absence / retry insert) stays
/// with `watch_and_record` inside the arm helpers. Every applied replan —
/// and the root-vanish/absence route — escalates `provider_dirty`.
fn replan_amplifier_watch_set(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    projects_root: &Path,
    provider: &str,
) -> bool {
    let plan = match plan_amplifier_targets(projects_root) {
        Ok(plan) => plan,
        Err(e) => {
            tracing::warn!(
                provider = %provider,
                path = %projects_root.display(),
                error = %e,
                "session-watcher: amplifier replan aborted: plan scan failed (armed set untouched)",
            );
            outcome.provider_dirty = true;
            return false;
        }
    };
    // The replan escalates provider dirty on both the applied and the
    // root-vanish routes: the rescan the event stood for still runs a full
    // provider discover.
    outcome.provider_dirty = true;
    let mut desired: HashMap<PathBuf, ArmKind> = HashMap::new();
    for sessions_dir in &plan.sessions_dirs {
        desired.insert(sessions_dir.clone(), ArmKind::SessionsDir);
    }
    for standin in &plan.standins {
        desired.insert(standin.clone(), ArmKind::Standin);
    }
    for session_dir in &plan.root_session_dirs {
        desired.insert(session_dir.clone(), ArmKind::SessionDir);
    }
    if plan.root_exists {
        desired.insert(projects_root.to_path_buf(), ArmKind::ProjectsRoot);
    } else {
        // Route the vanished root to absence tracking NOW (the rearm tick's
        // full-cascade return owns the re-arm) so delete-and-recreate can
        // never end up with no ancestor able to detect the return.
        if book.armed.remove(projects_root) {
            unwatch_tolerated(watcher, provider, projects_root);
        }
        book.absent.insert(projects_root.to_path_buf());
    }
    let diff = diff_armed(&desired, &book.armed);
    for target in &diff.arm {
        if book.retry.contains_key(&target.path) {
            continue; // arm-failure backoff is never bypassed by a replan
        }
        arm_managed_dir(
            book,
            watcher,
            outcome,
            provider,
            &target.path,
            target.kind,
            true,
        );
    }
    for path in &diff.unwatch {
        unwatch_tolerated(watcher, provider, path);
        structural_remove_except(book, path, &desired);
    }
    // Converge the late-root ancestor fast path with the replan's own
    // absence bookkeeping — the root-vanish branch inserted the absence,
    // and an apply that found the root again cleared it. D3-1: a TRUE
    // report means the root reappeared between the replan's plan scan and
    // this convergence — run the full root-return application now, inline
    // (the replan already runs inside a spawn_blocking batch).
    if sync_ancestor_watch(book, watcher, provider, projects_root) {
        recover_returned_root(book, watcher, outcome, projects_root);
    }
    true
}

/// The self-correction diff (design "Self-correction channel"): of the
/// content-verified root session dirs a full amplifier discover reported,
/// which still need an arm? PURE — diffs against (armed ∪ retry-pending),
/// so a dir under arm-failure backoff is suppressed outright (retry's
/// rearm-tick drain is the only path that works it, and only when due:
/// the channel NEVER bypasses backoff), and a dir already armed via the
/// race is a no-op.
fn roots_needing_arm(
    reported: &[PathBuf],
    armed: &std::collections::HashSet<PathBuf>,
    retry: &std::collections::HashMap<PathBuf, RetryEntry>,
) -> Vec<PathBuf> {
    reported
        .iter()
        .filter(|d| !armed.contains(*d))
        .filter(|d| !retry.contains_key(*d))
        .cloned()
        .collect()
}

/// Delta D4-1: the verdict of the PROMPT content probe applied to a
/// subagent-NAMED session-dir mkdir (the drift-rescue for a true root that
/// carries a subagent-pattern name). The probe is one stat+small read of
/// the dir's `metadata.json` — the same cost class as the `is_dir` stat
/// the depth-3 route already performs inline — and NEVER watches the dir:
/// subagent dirs stay watch-free; only positive root content arms.
enum RootProbe {
    /// No readable `metadata.json` yet — amplifier creates the dir before
    /// writing it (the design's known emit order), so the candidate is
    /// deferred for a bounded per-flush re-probe.
    Absent,
    /// The file parsed with `parent_id` PRESENT and non-null (Node parity:
    /// a true subagent), OR failed to parse — the content does not prove a
    /// root, and the probe defers to the channel/cadence/reconcile.
    Declined,
    /// The file parsed with `parent_id` ABSENT — the same content-verified
    /// root definition the self-correction channel's reports use.
    Root,
}

/// Stat+parse-probe `<dir>/metadata.json` for the drift-rescue verdict.
/// `parse_amplifier_metadata`'s `is_subagent` field is the exact Node
/// parity predicate (`Some(true)` ⇔ `parent_id` present-and-non-null);
/// malformed JSON yields `None` and declines (no arm, no recheck — the
/// channel owns the recoverable cases).
fn probe_subagent_named_dir(dir: &Path) -> RootProbe {
    let Ok(content) = std::fs::read_to_string(dir.join("metadata.json")) else {
        return RootProbe::Absent;
    };
    match crate::amplifier::parse_amplifier_metadata(&content).is_subagent {
        Some(false) => RootProbe::Root,
        Some(true) | None => RootProbe::Declined,
    }
}

/// Park a metadata-absent drift candidate for the per-flush re-probe,
/// under the set's bound: overflow drops the NEW candidate with a WARN to
/// the self-correction channel (the accepted-residual backstop), keeping
/// the per-flush probe cost of a subagent mkdir storm bounded.
fn defer_root_probe(book: &mut ManagedBook, dir: &Path) {
    if book.deferred.contains_key(dir) {
        return;
    }
    if book.deferred.len() >= DEFERRED_ROOT_PROBE_CAP {
        tracing::warn!(
            path = %dir.display(),
            "session-watcher: deferred root-probe set full ({DEFERRED_ROOT_PROBE_CAP}); \
             dropping drift probe (self-correction channel owns it)",
        );
        return;
    }
    book.deferred.insert(dir.to_path_buf(), Instant::now());
}

/// The per-flush re-probe of deferred drift candidates (delta D4-1),
/// driven from the flush arm so a `metadata.json` landing within a couple
/// of seconds of its mkdir still wins the prompt arm: positive root content
/// arms through the channel's content-verified helper (watch-then-scan —
/// [`ArmKind::SessionDir`] bookkeeping, so a transient arm failure lands
/// in retry and the drain's classification-free re-arm keeps it); a
/// declined (true-subagent or unparseable) candidate and a TTL-expired
/// absent candidate both drop out — the self-correction channel / cadence
/// / reconcile own them per the accepted residuals.
fn recheck_deferred_root_probes(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
) {
    let now = Instant::now();
    let candidates: Vec<(PathBuf, Instant)> =
        book.deferred.iter().map(|(p, t)| (p.clone(), *t)).collect();
    for (dir, since) in candidates {
        if now.duration_since(since) >= DEFERRED_ROOT_PROBE_TTL {
            tracing::debug!(
                path = %dir.display(),
                "session-watcher: deferred root probe expired ({DEFERRED_ROOT_PROBE_TTL:?}); \
                 self-correction channel owns the dir",
            );
            book.deferred.remove(&dir);
            continue;
        }
        match probe_subagent_named_dir(&dir) {
            RootProbe::Root => {
                arm_reported_root_dir(book, watcher, outcome, "amplifier", &dir, true);
                // Attempted: the arm owns success, retry owns a transient
                // failure — the probe's job is done either way.
                book.deferred.remove(&dir);
            }
            RootProbe::Absent => {} // still awaiting its metadata.json
            RootProbe::Declined => {
                book.deferred.remove(&dir);
            }
        }
    }
}

/// Depth of `path` below the managed projects root (`strip_prefix`
/// component count): 0 = the projects root's OWN self-event (its removal
/// wiring is Task 4's), 1 = a project child of the root watch, 3 = a
/// sessions-dir child, ... Routing is DEPTH-relative, never parent-basename
/// (a project literally named `sessions` must not misroute).
fn amplifier_depth(projects_root: &Path, path: &Path) -> Option<usize> {
    path.strip_prefix(projects_root)
        .ok()
        .map(|r| r.components().count())
}

/// One amplifier FileChanged path, routed by DEPTH below the projects root
/// (never by parent basename): structural create-ish kinds
/// (`Create | CreateFolder | NameTo | NameBoth` — a mkdir surfaces as
/// `CreateFolder`) at depths 1-3 run the managed arm path with
/// `emit_marks: true` (runtime events scan what they arm; only startup
/// skips marks); structural remove-ish kinds (`Remove | NameFrom`) at
/// depths 0-3 run [`write_remove_dispatch`] (renames: a `Name(To)` at
/// depths 1/3 IS a create — a `mv`'d root session dir re-arms first-line).
/// File-level (depth 4) events inside an armed root session dir fold onto
/// a scoped `metadata.json` mark batched through `pending` — EXCEPT a
/// folder creation, which is dropped outright. Everything else is dropped
/// by default: amplifier events NEVER reach the legacy pending map's
/// provider-escalation branch.
///
/// CASCADE-CLASS create routes never execute here — each expands to a
/// readdir plus a BATCH of arms (swap + cascaded children), which is bulk
/// work under the design's spawn_blocking rule (delta review D1-5). A
/// depth-1 project appeared or a depth-2 `sessions/` appeared under a
/// stand-in → the cascade's PROJECT dir is appended to `cascades`
/// ([`cascade_new_project`] is the deferred executor — its is_dir guard
/// re-verifies at execution time, so the deferral itself never arms a
/// vanished-in-between target). A depth-0 create — the ABSENT projects root
/// itself reappearing, observed via the late-root ancestor watch (delta
/// D2-2) — sets `root_return` instead (the deferred full plan + return
/// cascade); so does a depth-0 VANISH whose ancestor sync finds the root
/// standing again inside the remove→dispatch window (delta D3-1 — the
/// remove path above sets the same flag). DEPTH-CORRECTED: ancestor-watch
/// events carry the root's OWN
/// path, which is depth 0 measured from the provider root — the ancestor's
/// OTHER children (`~/.amplifier/keys.env`, …) are not under the root at
/// all (depth None) and are dropped by default. SINGLE-target arms (a
/// depth-3 session dir) stay inline.
#[allow(clippy::too_many_arguments)]
fn dispatch_amplifier_path(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    projects_root: &Path,
    interest: &std::sync::atomic::AtomicUsize,
    path: &Path,
    kind: WatchKind,
    pending: &mut HashMap<(PathBuf, String), Instant>,
    index: &SessionIndex,
    cascades: &mut Vec<PathBuf>,
    root_return: &mut bool,
) {
    let createish = matches!(
        kind,
        WatchKind::Create | WatchKind::CreateFolder | WatchKind::NameTo | WatchKind::NameBoth
    );
    if matches!(kind, WatchKind::Remove | WatchKind::NameFrom)
        && write_remove_dispatch(
            book,
            watcher,
            outcome,
            index,
            projects_root,
            path,
            root_return,
        )
    {
        return;
    }
    match (amplifier_depth(projects_root, path), createish) {
        // Depth 0: the absent projects root reappearing, observed via the
        // late-root ancestor watch (`Create(<projects>)` carries the root's
        // own path) — CASCADE-CLASS: the return runs the full plan + apply,
        // so defer it next to the project cascades. Gated on the absence so
        // a stale straggler against an armed root can never re-cascade.
        (Some(0), true) if book.absent.contains(projects_root) => *root_return = true,
        // Depth 1: a project appeared under the root watch (create_dir_all
        // surfaces only `Create(<proj>)` at the root) — CASCADE-CLASS: defer
        // the project dir to the caller's spawn_blocking batch (its
        // sessions dir / stand-in swap then scans its existing children).
        (Some(1), true) => cascades.push(path.to_path_buf()),
        // Depth 2: `sessions/` appearing under an armed stand-in —
        // CASCADE-CLASS: defer the parent project (the swap to the real
        // sessions arm cascades). Other stand-in children (e.g. a
        // `{project}/recipe-sessions/` tree) are dropped by default
        // (regression 14b).
        (Some(2), true) if path.file_name().and_then(|n| n.to_str()) == Some("sessions") => {
            if let Some(project) = path.parent() {
                cascades.push(project.to_path_buf());
            }
        }
        // Depth 3: a sessions-dir child. Root-classified dirs arm with the
        // watch-then-scan scoped mark. A subagent-NAMED dir gets the delta
        // D4-1 drift rescue FIRST: the pre-change recursive watcher observed
        // a drift-case true root's metadata.json landing instantly, so the
        // name gate's refusal is answered with a PROMPT, single-target
        // content probe (stat+read the one metadata.json — the dir itself
        // is NEVER watched). Positive root content arms via the
        // self-correction channel's own helper (the name gate bypassed
        // exactly as the channel bypasses it); metadata-absent parks the
        // candidate in the BOUNDED deferred set re-probed each flush
        // (creation precedes the write — a metadata.json landing within a
        // couple of seconds still wins the prompt arm); a declined
        // (true-subagent or unparseable) probe does nothing further — the
        // channel/cadence/reconcile own it per the accepted residuals.
        // Anything the probe did NOT arm keeps the design's escalation:
        // a DIRECT provider-dirty mark ONLY while a connected client has
        // declared subagent interest — otherwise the mkdir is dropped
        // silently (the 15-minute reconcile owns it). The escalation never
        // takes the pending-rescan channel: its amplifier branch runs the
        // strict whole-tree replan reserved for true need_rescan events.
        (Some(3), true) if path.is_dir() => {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if is_watch_target(classify_basename(name)) {
                arm_managed_dir(
                    book,
                    watcher,
                    outcome,
                    "amplifier",
                    path,
                    ArmKind::SessionDir,
                    true,
                );
            } else {
                match probe_subagent_named_dir(path) {
                    RootProbe::Root => {
                        arm_reported_root_dir(book, watcher, outcome, "amplifier", path, true)
                    }
                    RootProbe::Absent => defer_root_probe(book, path),
                    RootProbe::Declined => {}
                }
                if !book.armed.contains(path)
                    && interest.load(std::sync::atomic::Ordering::SeqCst) > 0
                {
                    index.mark_provider_dirty("amplifier");
                }
            }
        }
        // Depth 4: file-level events inside an armed root session dir. A
        // FOLDER creation (the `context-intelligence/` mkdir) is DROPPED —
        // sub-session trees are never watched and never marked (regression
        // 6). Every other kind (sidecar writes, tmp+rename metadata
        // replacements, backups, plus remove/rename-away variants) folds
        // onto ONE scoped mark on the sibling metadata.json — NO filename
        // whitelist (temp/backup files fold onto the canonical mark) —
        // batched into `pending` (deduped per flush) so the index re-stats
        // fold-aware and re-parses only that one session (regression 5).
        // The rewritten mark still passes the flush's
        // `AmplifierLayout::qualifies` safety check, so amplifier events
        // never reach the `dirty_provider_names` escalation branch.
        (Some(4), _) if kind != WatchKind::CreateFolder => {
            if let Some(session_dir) = path.parent() {
                pending.insert(
                    (session_dir.join("metadata.json"), "amplifier".to_owned()),
                    Instant::now(),
                );
            }
        }
        // Dropped by default: the depth-4 folder create, depths ≥5
        // (unreachable under NonRecursive arms — defensive), non-`sessions/`
        // stand-in children, and non-createish strays at structural depths.
        _ => {}
    }
}

/// Drain an [`ArmOutcome`] into the loop's coalescing maps — the
/// async-loop side of the hand-back: scoped `metadata.json` marks per
/// file-state arm land in the SAME `pending` map the depth-4 rewrites use
/// (event-time arm marks coalesce with them; the flush batches everything
/// through one `index.mark_dirty`), then a provider-level dirty flag marks
/// the provider directly.
fn drain_arm_outcome(
    index: &SessionIndex,
    pending: &mut HashMap<(PathBuf, String), Instant>,
    provider: &str,
    outcome: ArmOutcome,
) {
    for mark in outcome.marks {
        pending.insert((mark, provider.to_owned()), Instant::now());
    }
    if outcome.provider_dirty {
        index.mark_provider_dirty(provider);
    }
}

/// Rescan routing (need_rescan / IN_Q_OVERFLOW recovery), the async-loop
/// side. Amplifier additionally REPLANS its managed watch set before its
/// provider-dirty mark; claude/codex/opencode take the legacy
/// provider-dirty path unchanged. The replan moves the amplifier
/// `ProviderWatch` out of `watches` and runs its whole batch (plan scan +
/// `watch()`/`unwatch()` syscalls + cascade readdirs) in ONE
/// `spawn_blocking` closure over the locked book guard —
/// `RecommendedWatcher` is `Send` (the inotify handle), so nothing blocks
/// the watch-loop worker. Events arriving during the await buffer on the
/// unbounded channel and dispatch after re-insertion, exactly as the loop
/// already serializes arms today; only the `ArmOutcome` drain (plus the
/// applied-only `replans` bump and the post-batch budget check) returns to
/// the loop.
async fn flush_pending_rescans(
    amplifier: Option<&AmplifierLoopCtx>,
    watches: &mut HashMap<usize, ProviderWatch>,
    index: &SessionIndex,
    pending: &mut HashMap<(PathBuf, String), Instant>,
    pending_rescans: &mut std::collections::HashSet<String>,
) {
    let mut amplifier_rescan = false;
    for provider_name in pending_rescans.drain() {
        if provider_name == "amplifier" {
            amplifier_rescan = true;
        } else {
            index.mark_provider_dirty(&provider_name);
        }
    }
    if !amplifier_rescan {
        return;
    }
    let Some(amp) = amplifier else {
        // A rescan naming an unconfigured provider can only be a legacy
        // path — provider dirty only.
        index.mark_provider_dirty("amplifier");
        return;
    };
    let Some(pw) = watches.remove(&amp.prov_idx) else {
        // No watcher (startup creation failed / the root is absent):
        // nothing to replan with — the data plane still recovers.
        index.mark_provider_dirty("amplifier");
        return;
    };
    let book = Arc::clone(&amp.book);
    let projects_root = amp.projects_root.clone();
    let replan_batch = tokio::task::spawn_blocking(move || {
        let mut watcher = pw.watcher;
        let mut outcome = ArmOutcome::default();
        let applied = {
            let mut book = book.lock().unwrap();
            replan_amplifier_watch_set(
                &mut book,
                &mut watcher,
                &mut outcome,
                &projects_root,
                "amplifier",
            )
        };
        (watcher, outcome, applied)
    })
    .await;
    match replan_batch {
        Ok((watcher, outcome, applied)) => {
            watches.insert(
                amp.prov_idx,
                ProviderWatch {
                    watcher,
                    targets: Vec::new(),
                },
            );
            if applied {
                let mut book = amp.book.lock().unwrap();
                book.replans += 1;
                // Per-arm-batch budget check: the replan-apply site joins
                // the listed post-batch checks (a replan can arm thousands
                // of lost watches).
                check_watch_budget(&mut book);
            }
            drain_arm_outcome(index, pending, "amplifier", outcome);
        }
        Err(e) => {
            // The helpers never panic, so this is unreachable in practice —
            // degrade to the data plane (the watcher is lost, so re-entry
            // would go through the no-watcher branch above).
            tracing::warn!(
                error = %e,
                "session-watcher: amplifier replan batch failed; provider marked dirty",
            );
            index.mark_provider_dirty("amplifier");
        }
    }
}

impl SessionWatcher {
    pub fn new(index: Arc<SessionIndex>, providers: Vec<WatchedProvider>) -> Self {
        let amplifier_book = providers
            .iter()
            .any(|p| p.layout.name() == "amplifier")
            .then(|| Arc::new(std::sync::Mutex::new(ManagedBook::default())));
        let (event_tx, event_rx) = mpsc::unbounded_channel::<WatchEvent>();
        let (startup_ready_tx, startup_ready_rx) = tokio::sync::watch::channel(false);
        Self {
            index,
            providers,
            stop_tx: None,
            rearm_interval_secs: REARM_INTERVAL_SECS,
            amplifier_book,
            subagent_interest: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            event_tx,
            event_rx: Some(event_rx),
            startup_ready_tx: Some(startup_ready_tx),
            startup_ready_rx,
        }
    }

    #[cfg(test)]
    pub fn with_rearm_interval(mut self, secs: u64) -> Self {
        self.rearm_interval_secs = secs;
        self
    }

    /// Connected subagent interest (WS clients with the toggle on). The
    /// count handle is shared from freshell-ws' SubagentInterestRegistry;
    /// the subagent-mkdir escalation consults it (>0 = escalate).
    pub fn with_subagent_interest(
        mut self,
        interested: Arc<std::sync::atomic::AtomicUsize>,
    ) -> Self {
        self.subagent_interest = interested;
        self
    }

    /// The startup watcher-ready barrier (amplifier watch-reduction Task 9):
    /// returns a CLONE of the retained receiver, so any number of consumers
    /// (the index's cold-start publish gate, tests) subscribe identically
    /// BEFORE or AFTER `start()` — production call order is construct →
    /// subscribe/install → `start()`. The retained receiver never touches
    /// the sender; `start()` moves only the sender into the loop. Resolves
    /// `true` once the initial startup arming pass for EVERY configured
    /// provider has settled (amplifier's spawn_blocking plan+apply joined
    /// and its `ArmOutcome` drained into the index, success or planner-Err
    /// absent-branch alike), before the select loop begins.
    pub fn startup_ready(&self) -> tokio::sync::watch::Receiver<bool> {
        self.startup_ready_rx.clone()
    }

    /// Test-only probe: observe the amplifier managed book (armed / absent
    /// / retry) without racing the watcher loop, which clones the same Arc
    /// at `start`. There are deliberately NO `test_arm_*` probe methods on
    /// `SessionWatcher` — the book holds neither the `RecommendedWatcher`
    /// nor the provider context (both live inside the spawned loop), so a
    /// probe here cannot drive a real arm; bookkeeping tests call the free
    /// arm helpers directly instead (the identical code path the loop
    /// uses, with no spawned loop and no inotify timing).
    #[cfg(test)]
    pub(crate) fn amplifier_book_handle(&self) -> Option<Arc<std::sync::Mutex<ManagedBook>>> {
        self.amplifier_book.clone()
    }

    /// Test-only event-injection seam: clones the construction-time channel
    /// sender, so it is always `Some` BEFORE `start()` — tests can queue
    /// synthetic events ahead of the spawned loop (same channel, same
    /// consumer; no production behavior change).
    #[cfg(test)]
    pub(crate) fn test_event_tx(&self) -> Option<mpsc::UnboundedSender<WatchEvent>> {
        Some(self.event_tx.clone())
    }

    /// Start the watcher background task. Returns a `JoinHandle` for the
    /// event loop. Call `stop()` to shut it down.
    pub fn start(&mut self) -> tokio::task::JoinHandle<()> {
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        self.stop_tx = Some(stop_tx);

        let index = Arc::clone(&self.index);
        let providers: Vec<_> = self.providers.drain(..).collect();
        let rearm_secs = self.rearm_interval_secs;
        let amplifier_book = self.amplifier_book.clone();
        let subagent_interest = Arc::clone(&self.subagent_interest);
        let event_tx = self.event_tx.clone();
        let event_rx = self
            .event_rx
            .take()
            .expect("SessionWatcher::start may be called only once");
        // Readiness barrier: ONLY the sender moves into the loop; the
        // retained receiver stays here so `startup_ready()` clones keep
        // resolving after start (receiver clones never touch the sender).
        let startup_ready_tx = self
            .startup_ready_tx
            .take()
            .expect("SessionWatcher::start may be called only once");

        // The self-correction channel (refresh → watcher, one-way) exists
        // iff the amplifier managed book does: the index reports its
        // content-verified amplifier root session dirs on it after every
        // full amplifier discover.
        let root_report_rx = self.amplifier_book.is_some().then(|| {
            let (tx, rx) = mpsc::unbounded_channel::<Vec<PathBuf>>();
            self.index.set_amplifier_root_report_sink(tx);
            rx
        });

        tokio::spawn(async move {
            run_watcher_loop(
                index,
                providers,
                stop_rx,
                rearm_secs,
                amplifier_book,
                subagent_interest,
                (event_tx, event_rx),
                root_report_rx,
                startup_ready_tx,
            )
            .await;
        })
    }

    /// Signal the watcher to stop.
    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// The amplifier provider's managed-watch context inside the watcher loop:
/// its provider slot in `providers`/`watches`, its projects root, and the
/// shared bookkeeping + subagent-interest handles. `None` when no
/// amplifier provider is configured — claude/codex/opencode then take the
/// legacy watch_bases path unchanged.
struct AmplifierLoopCtx {
    prov_idx: usize,
    projects_root: PathBuf,
    book: Arc<std::sync::Mutex<ManagedBook>>,
    interest: Arc<std::sync::atomic::AtomicUsize>,
}

/// Arm watchers and run the coalescing event loop.
#[allow(clippy::too_many_arguments)]
async fn run_watcher_loop(
    index: Arc<SessionIndex>,
    providers: Vec<WatchedProvider>,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
    rearm_interval_secs: u64,
    amplifier_book: Option<Arc<std::sync::Mutex<ManagedBook>>>,
    subagent_interest: Arc<std::sync::atomic::AtomicUsize>,
    event: (
        mpsc::UnboundedSender<WatchEvent>,
        mpsc::UnboundedReceiver<WatchEvent>,
    ),
    root_report_rx: Option<mpsc::UnboundedReceiver<Vec<PathBuf>>>,
    startup_ready_tx: tokio::sync::watch::Sender<bool>,
) {
    let (event_tx, mut event_rx) = event;
    let mut root_report_rx = root_report_rx;

    // The amplifier managed-watch context: which provider slot it
    // occupies and where its projects root lives (both derivable from
    // `providers`), plus the shared handles passed in from `start`.
    let amplifier = providers
        .iter()
        .position(|p| p.layout.name() == "amplifier")
        .and_then(|prov_idx| {
            amplifier_book.map(|book| AmplifierLoopCtx {
                prov_idx,
                projects_root: providers[prov_idx]
                    .layout
                    .session_root(&providers[prov_idx].home),
                book,
                interest: Arc::clone(&subagent_interest),
            })
        });

    // One watcher per provider, keyed by provider index. Watch lifetimes
    // are explicit (`watch_path`/`unwatch_tolerated`); dropping a
    // `ProviderWatch` drops every remaining watch with its watcher.
    let mut watches: HashMap<usize, ProviderWatch> = HashMap::new();
    // Providers whose roots didn't exist at startup OR whose watchers
    // failed to arm. Checked periodically so watchers are armed once the
    // provider is installed or the transient error resolves.
    let mut absent: Vec<(usize, PathBuf)> = Vec::new();

    // File-level events keyed by (path, provider) → last-seen instant.
    // Declared before the arming loop: the amplifier startup apply's
    // ArmOutcome drain lands its scoped marks here too (the flush batches
    // arm marks and depth-4 rewrites through one `mark_dirty`).
    let mut pending: HashMap<(PathBuf, String), Instant> = HashMap::new();
    // Providers that need a full rescan (direct-listed change, rescan flag, or error).
    let mut pending_rescans: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (prov_idx, provider) in providers.iter().enumerate() {
        let name = provider.layout.name().to_owned();

        // The amplifier provider replaces the generic watch_bases arming
        // entirely: ONE spawn_blocking batch (the plan scan AND every
        // arm's watch()/unwatch() syscall and readdir) holding the book
        // lock, so the thousands of blocking syscalls never stall the
        // async worker. The watcher moves in and back out; the ArmOutcome
        // hands marks/routing back to the async side for the index drain.
        if let Some(amp) = amplifier.as_ref().filter(|a| a.prov_idx == prov_idx) {
            let Some(watcher) = create_provider_watcher(&event_tx, &name, false) else {
                index.mark_provider_dirty(&name);
                amp.book
                    .lock()
                    .unwrap()
                    .absent
                    .insert(amp.projects_root.clone());
                continue;
            };
            let book = Arc::clone(&amp.book);
            let projects_root = amp.projects_root.clone();
            let batch_name = name.clone();
            let applied = tokio::task::spawn_blocking(move || {
                let mut watcher = watcher;
                let mut outcome = ArmOutcome::default();
                {
                    let mut book = book.lock().unwrap();
                    match plan_amplifier_targets(&projects_root) {
                        Ok(plan) => apply_amplifier_startup_plan(
                            &mut book,
                            &mut watcher,
                            &mut outcome,
                            &projects_root,
                            plan,
                        ),
                        Err(e) => {
                            // Transient read failure at ANY scan depth (the
                            // planner is strict-everywhere): same branch as
                            // a missing root — absence-track + provider
                            // dirty; the rearm tick retries, and the Task 9
                            // readiness signal is never blocked by it. The
                            // late-root fast path converges too: when the
                            // scan raced a real deletion the ancestor arms;
                            // when the root itself exists (a NESTED read
                            // failed, or it appeared between the failed scan
                            // and this sync — D3-1) the sync reports TRUE and
                            // the full return application runs inline, never
                            // deferred to the tick's return cascade.
                            tracing::warn!(
                                provider = %batch_name,
                                path = %projects_root.display(),
                                error = %e,
                                "session-watcher: amplifier plan scan failed; absence-tracking the projects root",
                            );
                            book.absent.insert(projects_root.clone());
                            outcome.provider_dirty = true;
                            if sync_ancestor_watch(&mut book, &mut watcher, &batch_name, &projects_root)
                            {
                                recover_returned_root(
                                    &mut book,
                                    &mut watcher,
                                    &mut outcome,
                                    &projects_root,
                                );
                            }
                        }
                    }
                }
                (watcher, outcome)
            })
            .await;
            match applied {
                Ok((watcher, outcome)) => {
                    {
                        let mut book = amp.book.lock().unwrap();
                        tracing::info!(
                            provider = %name,
                            armed = book.armed.len(),
                            "session-watcher: amplifier managed watch set armed",
                        );
                        // First of the per-arm-batch budget checks: the
                        // ~4.4K-watch boot set can itself cross 25% of a
                        // small kernel limit.
                        check_watch_budget(&mut book);
                    }
                    watches.insert(
                        prov_idx,
                        ProviderWatch {
                            watcher,
                            targets: Vec::new(),
                        },
                    );
                    drain_arm_outcome(&index, &mut pending, &name, outcome);
                }
                Err(e) => {
                    // The helpers never panic, so this is unreachable in
                    // practice — but a lost batch must degrade (absence +
                    // provider dirty), never hang the startup.
                    tracing::warn!(
                        provider = %name,
                        error = %e,
                        "session-watcher: amplifier startup arm batch failed; absence-tracking the projects root",
                    );
                    index.mark_provider_dirty(&name);
                    amp.book
                        .lock()
                        .unwrap()
                        .absent
                        .insert(amp.projects_root.clone());
                }
            }
            continue;
        }

        let watch_bases = provider.layout.watch_bases(&provider.home);
        let is_direct = provider.layout.is_direct_listed();
        for base in &watch_bases {
            let mode = match provider.layout.watch_mode_for_base(&provider.home, base) {
                WatchMode::Recursive => notify::RecursiveMode::Recursive,
                WatchMode::NonRecursive => notify::RecursiveMode::NonRecursive,
            };
            let watch_target = if base.exists() {
                base.clone()
            } else {
                // Late-root: walk up toward the provider home looking
                // for an existing ancestor. For NonRecursive watchers
                // (OpenCode), allow climbing one level above provider.home
                // so we can observe when the data directory is created.
                let ancestor_bound = if mode == notify::RecursiveMode::NonRecursive {
                    provider.home.parent().unwrap_or(&provider.home)
                } else {
                    &provider.home
                };
                let candidate = nearest_existing_ancestor(base, ancestor_bound);
                if !candidate.exists() {
                    tracing::info!(
                        provider = %name,
                        path = %base.display(),
                        "session-watcher: provider root absent, will re-check periodically",
                    );
                    absent.push((prov_idx, base.clone()));
                    index.mark_provider_dirty(&name);
                    continue;
                }
                candidate
            };

            // THE provider's watcher: created on the first base that gets
            // this far, reused by later bases of the same provider.
            let pw = match watches.entry(prov_idx) {
                Entry::Occupied(o) => o.into_mut(),
                Entry::Vacant(v) => match create_provider_watcher(&event_tx, &name, is_direct) {
                    Some(watcher) => v.insert(ProviderWatch {
                        watcher,
                        targets: Vec::new(),
                    }),
                    None => {
                        index.mark_provider_dirty(&name);
                        absent.push((prov_idx, base.clone()));
                        continue;
                    }
                },
            };

            // Codex keeps a nonrecursive home arm independently of its
            // child roots. Do not create a duplicate ancestor stand-in:
            // retiring it later would also unwatch the permanent home arm.
            if name == "codex"
                && watch_target != *base
                && pw
                    .targets
                    .iter()
                    .any(|target| target.actual_target == watch_target)
            {
                absent.push((prov_idx, base.clone()));
                index.mark_provider_dirty(&name);
                continue;
            }

            match watch_path(&mut pw.watcher, &name, &watch_target, mode) {
                Ok(()) => {
                    pw.targets.push(ArmedTarget {
                        requested_base: base.clone(),
                        actual_target: watch_target,
                    });
                }
                Err(_) => {
                    index.mark_provider_dirty(&name);
                    absent.push((prov_idx, base.clone()));
                }
            }
        }
    }

    // Startup watcher-ready barrier (amplifier watch-reduction Task 9):
    // fire ONCE, here — every configured provider's startup arming pass has
    // SETTLED by this line: legacy recursive arms completed inline above,
    // and the amplifier `spawn_blocking` plan+apply JoinHandle was awaited
    // with its `ArmOutcome` drained into the index (`marks` → `pending` →
    // `index.mark_dirty` at the first flush; `provider_dirty` →
    // `index.mark_provider_dirty("amplifier")` already) — success OR
    // planner-Err absent-branch alike, so a failed plan never wedges the
    // boot sweeps. The index's cold-start publish gate (`set_startup_gate`)
    // opens now: the FIRST session-index publish of the process is provably
    // ordered AFTER these arms, so a metadata.json written in the scan↔arm
    // window is covered by that publish instead of sitting stale until the
    // 15-minute reconcile. `let _ =`: a receiver-less send (no gate
    // installed) is a valid steady state, and late subscribers still see
    // the retained value.
    let _ = startup_ready_tx.send(true);

    // Keep the sender alive for re-arming absent providers.
    let rearm_tx = event_tx;

    // Coalescing event loop.
    let debounce = Duration::from_millis(DEBOUNCE_MS);
    // Burst-start latch for the max-deferral cap: latched when a pending
    // burst goes empty→non-empty, cleared on flush. The flush deadline is
    // `min(now + debounce, pending_since + MAX_FLUSH_DEFERRAL)` — a
    // sustained sub-quiet-gap stream can no longer starve the flush.
    let mut pending_since: Option<tokio::time::Instant> = None;
    let mut rearm_interval = tokio::time::interval(Duration::from_secs(rearm_interval_secs));
    rearm_interval.tick().await; // consume the immediate first tick

    loop {
        // The amplifier managed book has tick work of its own (absent
        // re-check / retry drain) even while the legacy sets are empty —
        // and D4-1 deferred drift candidates schedule their per-flush
        // re-probe by keeping the flush deadline alive until the set
        // drains (one lock reads both facts).
        let (amplifier_book_pending, amplifier_deferred_pending) = amplifier
            .as_ref()
            .map(|amp| {
                let book = amp.book.lock().unwrap();
                (
                    !book.absent.is_empty() || !book.retry.is_empty(),
                    !book.deferred.is_empty(),
                )
            })
            .unwrap_or((false, false));
        let flush_deadline =
            if pending.is_empty() && pending_rescans.is_empty() && !amplifier_deferred_pending {
                pending_since = None;
                None
            } else {
                let start = pending_since.get_or_insert_with(tokio::time::Instant::now);
                let capped = *start + MAX_FLUSH_DEFERRAL;
                Some(capped.min(tokio::time::Instant::now() + debounce))
            };

        tokio::select! {
            _ = &mut stop_rx => break,
            event = event_rx.recv() => {
                match event {
                    // One message per notify event; fan the paths back out
                    // so the coalescing keys (path, provider) are identical
                    // to the old per-path messages.
                    Some(WatchEvent::FileChanged { paths, provider, kind }) => {
                        let amp = if provider == "amplifier" {
                            amplifier.as_ref()
                        } else {
                            None
                        };
                        match amp {
                            // Amplifier managed dispatch, one event per
                            // iteration, SPLIT by work class (delta review
                            // D1-5 — the design's spawn_blocking bulk rule
                            // applied at event time): SINGLE-TARGET work
                            // (structural removes + bookkeeping, depth-3
                            // session-dir arms, scoped marks) runs inline on
                            // the async loop as before; CASCADE-CLASS routes
                            // (a project move-in / a `sessions/` appearance —
                            // one readdir plus a batch of arms, potentially
                            // thousands of blocking watch() syscalls off one
                            // event) are collected into `cascades` and run as
                            // ONE spawn_blocking batch over the locked book
                            // guard, the provider watcher moved out and
                            // reinserted afterwards (RecommendedWatcher is
                            // Send, so nothing blocks the watch-loop worker;
                            // events arriving during the await buffer on the
                            // unbounded channel and are processed after
                            // re-insertion, exactly as the replan batch
                            // arranges; the ArmOutcome sink is what makes
                            // this split safe — index mutation still happens
                            // only on the loop, at the shared drain below).
                            Some(amp) => {
                                let mut outcome = ArmOutcome::default();
                                let mut cascades: Vec<PathBuf> = Vec::new();
                                let mut root_return = false;
                                let mut armed_before = None;
                                if let Some(pw) = watches.get_mut(&amp.prov_idx) {
                                    let mut book = amp.book.lock().unwrap();
                                    armed_before = Some(book.armed.len());
                                    if kind == WatchKind::NameBoth && paths.len() == 2 {
                                        // LB-01 paired shape: `Name(Both)`
                                        // carries [from, to] — the From
                                        // endpoint is remove-handled, the
                                        // To endpoint create-handled.
                                        dispatch_amplifier_path(
                                            &mut book,
                                            &mut pw.watcher,
                                            &mut outcome,
                                            &amp.projects_root,
                                            &amp.interest,
                                            &paths[0],
                                            WatchKind::NameFrom,
                                            &mut pending,
                                            &index,
                                            &mut cascades,
                                            &mut root_return,
                                        );
                                        dispatch_amplifier_path(
                                            &mut book,
                                            &mut pw.watcher,
                                            &mut outcome,
                                            &amp.projects_root,
                                            &amp.interest,
                                            &paths[1],
                                            WatchKind::NameTo,
                                            &mut pending,
                                            &index,
                                            &mut cascades,
                                            &mut root_return,
                                        );
                                    } else {
                                        for path in &paths {
                                            dispatch_amplifier_path(
                                                &mut book,
                                                &mut pw.watcher,
                                                &mut outcome,
                                                &amp.projects_root,
                                                &amp.interest,
                                                path,
                                                kind,
                                                &mut pending,
                                                &index,
                                                &mut cascades,
                                                &mut root_return,
                                            );
                                        }
                                    }
                                } else {
                                    // No watcher (startup creation failed):
                                    // nothing to arm with — legacy flow.
                                    for path in paths {
                                        pending.insert((path, provider.clone()), Instant::now());
                                    }
                                }
                                if root_return || !cascades.is_empty() {
                                    let pw = watches
                                        .remove(&amp.prov_idx)
                                        .expect("cascades imply the watcher was present");
                                    let book = Arc::clone(&amp.book);
                                    let projects_root = amp.projects_root.clone();
                                    let cascade_batch = tokio::task::spawn_blocking(move || {
                                        let mut watcher = pw.watcher;
                                        let mut cascade_outcome = ArmOutcome::default();
                                        {
                                            let mut book = book.lock().unwrap();
                                            // The absent root reappearing
                                            // (observed via the ancestor
                                            // watch, delta D2-2) runs the
                                            // FULL return cascade — the same
                                            // plan + apply the rearm tick's
                                            // safety net uses — first, so a
                                            // returned root's projects are
                                            // armed kind-correctly before
                                            // any same-batch project cascade.
                                            if root_return {
                                                match plan_amplifier_targets(&projects_root) {
                                                    Ok(plan) => apply_amplifier_return_plan(
                                                        &mut book,
                                                        &mut watcher,
                                                        &mut cascade_outcome,
                                                        &projects_root,
                                                        &plan,
                                                    ),
                                                    Err(e) => {
                                                        // Transient scan failure:
                                                        // stay absent (the tick
                                                        // retries), surface the
                                                        // data plane.
                                                        tracing::warn!(
                                                            path = %projects_root.display(),
                                                            error = %e,
                                                            "session-watcher: amplifier return plan scan failed; keeping the root absent",
                                                        );
                                                        cascade_outcome.provider_dirty = true;
                                                    }
                                                }
                                                if book.armed.contains(&projects_root) {
                                                    book.absent.remove(&projects_root);
                                                }
                                            }
                                            for project in cascades {
                                                cascade_new_project(
                                                    &mut book,
                                                    &mut watcher,
                                                    &mut cascade_outcome,
                                                    &project,
                                                    true,
                                                );
                                            }
                                            // Drop the ancestor watch once
                                            // the root stands (re-converges
                                            // identically when the return
                                            // raced another deletion).
                                            // D3-1: a TRUE report means the
                                            // root reappeared in the sync's
                                            // window (e.g. a return plan scan
                                            // failed transiently while the
                                            // root stood) — run the full
                                            // return application inline,
                                            // never the tick.
                                            if sync_ancestor_watch(
                                                &mut book,
                                                &mut watcher,
                                                "amplifier",
                                                &projects_root,
                                            ) {
                                                recover_returned_root(
                                                    &mut book,
                                                    &mut watcher,
                                                    &mut cascade_outcome,
                                                    &projects_root,
                                                );
                                            }
                                        }
                                        (watcher, cascade_outcome)
                                    })
                                    .await;
                                    match cascade_batch {
                                        Ok((watcher, cascade_outcome)) => {
                                            watches.insert(
                                                amp.prov_idx,
                                                ProviderWatch {
                                                    watcher,
                                                    targets: Vec::new(),
                                                },
                                            );
                                            outcome.marks.extend(cascade_outcome.marks);
                                            outcome.provider_dirty |=
                                                cascade_outcome.provider_dirty;
                                        }
                                        Err(e) => {
                                            // The helpers never panic, so
                                            // this is unreachable in
                                            // practice — same degrade shape
                                            // as the replan batch: the data
                                            // plane recovers via discover.
                                            tracing::warn!(
                                                error = %e,
                                                "session-watcher: amplifier cascade batch failed; provider marked dirty",
                                            );
                                            index.mark_provider_dirty("amplifier");
                                        }
                                    }
                                }
                                // The 25% watch-budget WARN is re-evaluated
                                // after every arm batch — the event-time
                                // dispatch (inline singles + the deferred
                                // cascade batch) is one of its call sites,
                                // checked once per processed event (not per
                                // arm), and only when the event actually
                                // changed the armed set.
                                if let Some(before) = armed_before {
                                    let mut book = amp.book.lock().unwrap();
                                    if book.armed.len() != before {
                                        check_watch_budget(&mut book);
                                    }
                                }
                                drain_arm_outcome(&index, &mut pending, "amplifier", outcome);
                            }
                            None => {
                                let configured = providers.iter().enumerate()
                                    .find(|(_, configured)| configured.layout.name() == provider);
                                for path in paths {
                                    let Some((prov_idx, configured)) = configured else { continue };
                                    if configured.layout.watch_change_scope(&configured.home, &path).is_none() {
                                        continue;
                                    }
                                    // A root can be removed and recreated between
                                    // periodic stats. Inotify follows its old inode;
                                    // explicitly retire and re-arm on root events.
                                    if provider == "codex" && matches!(kind, WatchKind::Create | WatchKind::CreateFolder
                                        | WatchKind::Remove | WatchKind::NameFrom
                                        | WatchKind::NameTo | WatchKind::NameBoth)
                                        && configured.layout.watch_bases(&configured.home).contains(&path)
                                    {
                                        if let Some(pw) = watches.get_mut(&prov_idx) {
                                            retire_codex_root_targets(pw, &mut absent, prov_idx, &path);
                                        }
                                        rearm_interval.reset_immediately();
                                    }
                                    pending.insert((path, provider.clone()), Instant::now());
                                }
                            }
                        }
                    }
                    Some(WatchEvent::ProviderRescan { provider }) => {
                        pending_rescans.insert(provider);
                    }
                    None => break,
                }
            }
            // Self-correction channel (refresh → watcher, one-way): each
            // full amplifier discover reports its content-verified root
            // session dirs. Diff against (armed ∪ retry-pending) —
            // arm-failure backoff is NEVER bypassed — and arm the misses
            // with the file-state watch-then-scan arm; a fresh ArmOutcome
            // drains to the index afterwards. Reports carry handfuls of
            // dirs, never bulk batches, so this arm stays on the async
            // loop (the spawn_blocking rule covers the batch phases).
            report = async {
                match root_report_rx.as_mut() {
                    Some(rx) => rx.recv().await,
                    // No amplifier provider (or a closed channel): park the
                    // arm forever. A bare `Some(dirs) = ...` pattern would
                    // busy-spin on a closed channel instead.
                    None => std::future::pending::<Option<Vec<PathBuf>>>().await,
                }
            } => {
                match report {
                    Some(dirs) => {
                        if let Some(amp) = amplifier.as_ref() {
                            // No watcher (startup creation failed): nothing
                            // to arm with — the replan/rearm paths own
                            // recovery; the next full discover re-reports.
                            if let Some(pw) = watches.get_mut(&amp.prov_idx) {
                                let mut outcome = ArmOutcome::default();
                                {
                                    let mut book = amp.book.lock().unwrap();
                                    let armed_before = book.armed.len();
                                    for dir in
                                        roots_needing_arm(&dirs, &book.armed, &book.retry)
                                    {
                                        arm_reported_root_dir(
                                            &mut book,
                                            &mut pw.watcher,
                                            &mut outcome,
                                            "amplifier",
                                            &dir,
                                            true,
                                        );
                                    }
                                    // Per-arm-batch budget check: every
                                    // arm-batch application re-evaluates
                                    // the 25%-of-kernel-limit WARN.
                                    if book.armed.len() != armed_before {
                                        check_watch_budget(&mut book);
                                    }
                                }
                                drain_arm_outcome(&index, &mut pending, "amplifier", outcome);
                            }
                        }
                    }
                    // The sink drops only with the index (which the loop
                    // itself holds), so a close is unreachable; disable the
                    // arm rather than spin.
                    None => root_report_rx = None,
                }
            }
            _ = async {
                match flush_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                // Debounce timer fired — flush. The burst-start latch clears
                // with the drained maps (a replan/arm outcome that re-adds
                // marks below relatches fresh on the next iteration).
                pending_since = None;
                flush_pending_rescans(
                    amplifier.as_ref(),
                    &mut watches,
                    &index,
                    &mut pending,
                    &mut pending_rescans,
                )
                .await;
                // Delta D4-1: each flush re-probes the deferred drift
                // candidates (a metadata.json landing within a couple of
                // seconds of its subagent-NAMED mkdir still wins the prompt
                // arm via the channel's own helper). Runs BEFORE the
                // pending drain below so a fresh arm's scoped mark flushes
                // in this same cycle. Single-target work (≤
                // DEFERRED_ROOT_PROBE_CAP small reads), so it stays on the
                // async loop like every other single-dir arm.
                if let Some(amp) = amplifier.as_ref() {
                    if !amp.book.lock().unwrap().deferred.is_empty() {
                        if let Some(pw) = watches.get_mut(&amp.prov_idx) {
                            let mut outcome = ArmOutcome::default();
                            {
                                let mut book = amp.book.lock().unwrap();
                                let armed_before = book.armed.len();
                                recheck_deferred_root_probes(
                                    &mut book,
                                    &mut pw.watcher,
                                    &mut outcome,
                                );
                                // Per-arm-batch budget check: deferred-probe
                                // arms join every other arm-batch site.
                                if book.armed.len() != armed_before {
                                    check_watch_budget(&mut book);
                                }
                            }
                            drain_arm_outcome(&index, &mut pending, "amplifier", outcome);
                        }
                    }
                }
                if !pending.is_empty() {
                    let events: Vec<((PathBuf, String), Instant)> =
                        pending.drain().collect();
                    let mut qualified: Vec<(PathBuf, String)> = Vec::new();
                    let mut dirty_provider_names = std::collections::HashSet::new();
                    for ((path, provider_name), _) in events {
                        let prov = providers
                            .iter()
                            .find(|p| p.layout.name() == provider_name);
                        match prov.and_then(|provider| provider.layout.watch_change_scope(&provider.home, &path)) {
                            Some(WatchChangeScope::File) => qualified.push((path, provider_name)),
                            Some(WatchChangeScope::Provider) => { dirty_provider_names.insert(provider_name); }
                            None => {}
                        }
                    }
                    if !qualified.is_empty() {
                        index.mark_dirty(&qualified);
                    }
                    for name in dirty_provider_names {
                        index.mark_provider_dirty(&name);
                    }
                }
            }
            _ = rearm_interval.tick(), if !absent.is_empty() || !watches.is_empty() || amplifier_book_pending => {
                // Detect ancestor watches whose precise base now exists,
                // and armed targets that disappeared. Unwatch the stale
                // target explicitly (inotify watches follow inodes, so an
                // un-unwatched move/delete keeps reporting under the stale
                // path) and move the base to absent for re-arming.
                for (prov_idx, pw) in watches.iter_mut() {
                    let name = providers[*prov_idx].layout.name();
                    let ProviderWatch { watcher, targets } = pw;
                    let mut removed_bases: Vec<PathBuf> = Vec::new();
                    targets.retain(|t| {
                        if t.actual_target != t.requested_base && t.requested_base.exists() {
                            tracing::info!(
                                provider = %name,
                                path = %t.requested_base.display(),
                                "session-watcher: precise root appeared, replacing ancestor watcher",
                            );
                            unwatch_tolerated(watcher, name, &t.actual_target);
                            removed_bases.push(t.requested_base.clone());
                            false
                        } else if !t.actual_target.exists() {
                            tracing::info!(
                                provider = %name,
                                path = %t.actual_target.display(),
                                "session-watcher: watch target disappeared, tracking for re-arm",
                            );
                            unwatch_tolerated(watcher, name, &t.actual_target);
                            removed_bases.push(t.requested_base.clone());
                            false
                        } else {
                            true
                        }
                    });
                    for base in removed_bases {
                        absent.push((*prov_idx, base));
                        index.mark_provider_dirty(name);
                    }
                }

                // Re-check absent providers: re-arm on the precise base
                // using the provider's EXISTING watcher (creating the
                // ProviderWatch first if the provider has none yet).
                absent.retain(|(prov_idx, base)| {
                    if !base.exists() {
                        return true; // still absent
                    }
                    let prov = &providers[*prov_idx];
                    let is_direct = prov.layout.is_direct_listed();
                    let mode = match prov.layout.watch_mode_for_base(&prov.home, base) {
                        WatchMode::Recursive => notify::RecursiveMode::Recursive,
                        WatchMode::NonRecursive => notify::RecursiveMode::NonRecursive,
                    };
                    let name = prov.layout.name().to_owned();
                    let pw = match watches.entry(*prov_idx) {
                        Entry::Occupied(o) => o.into_mut(),
                        Entry::Vacant(v) => {
                            match create_provider_watcher(&rearm_tx, &name, is_direct) {
                                Some(watcher) => v.insert(ProviderWatch {
                                    watcher,
                                    targets: Vec::new(),
                                }),
                                None => return true, // keep in absent
                            }
                        }
                    };
                    match watch_path(&mut pw.watcher, &name, base, mode) {
                        Ok(()) => {
                            tracing::info!(
                                provider = %name,
                                path = %base.display(),
                                "session-watcher: provider appeared, armed watcher",
                            );
                            pw.targets.push(ArmedTarget {
                                requested_base: base.clone(),
                                actual_target: base.clone(),
                            });
                            index.mark_provider_dirty(&name);
                            false // remove from absent
                        }
                        Err(_) => true, // keep in absent
                    }
                });

                // Amplifier managed bookkeeping: the absent re-check FIRST
                // (the projects root is the ONLY absence-tracked target),
                // then the retry drain — the retry set is WORKED, not just
                // accumulated, and only when due (collecting due keys +
                // kinds up front so no mutation happens during iteration).
                // Replan and self-correction never bypass this drain.
                if let Some(amp) = &amplifier {
                    let now = Instant::now();
                    let (root_returned, retry_due, ancestor_unsynced) = {
                        let book = amp.book.lock().unwrap();
                        (
                            book.absent.contains(&amp.projects_root) && amp.projects_root.exists(),
                            book.retry
                                .iter()
                                .filter(|(_, entry)| entry.next_attempt <= now)
                                .map(|(path, entry)| (path.clone(), entry.kind))
                                .collect::<Vec<(PathBuf, ArmKind)>>(),
                            // The late-root ancestor fast path is convergent
                            // state, not a one-shot arm: while the root sits
                            // absent it must exist — a failed ancestor arm
                            // (transient pressure) or an ANCESTOR vanishing
                            // (the kernel auto-dropped that watch; the stale
                            // path fails to exist) re-converges here, one
                            // cheap stat per tick while absent.
                            book.absent.contains(&amp.projects_root)
                                && book.ancestor.as_ref().is_none_or(|a| !a.exists()),
                        )
                    };
                    if root_returned || !retry_due.is_empty() || ancestor_unsynced {
                        // Every batched watch() syscall + cascade readdir
                        // runs off the async worker (same hand-back shape
                        // as startup); the outcome drains to the index
                        // afterwards.
                        if let Entry::Vacant(slot) = watches.entry(amp.prov_idx) {
                            if let Some(watcher) = create_provider_watcher(&rearm_tx, "amplifier", false) {
                                slot.insert(ProviderWatch {
                                    watcher,
                                    targets: Vec::new(),
                                });
                            }
                        }
                        if let Some(pw) = watches.remove(&amp.prov_idx) {
                            let book = Arc::clone(&amp.book);
                            let projects_root = amp.projects_root.clone();
                            let rearm_batch = tokio::task::spawn_blocking(move || {
                                let mut watcher = pw.watcher;
                                let mut outcome = ArmOutcome::default();
                                {
                                    let mut book = book.lock().unwrap();
                                    if root_returned {
                                        // The design's return semantics, in
                                        // full: plan + apply with marks ON,
                                        // so sessions created while the
                                        // root was gone are armed AND
                                        // scoped-marked first-line. The
                                        // root leaves absent only on a
                                        // successful re-arm.
                                        match plan_amplifier_targets(&projects_root) {
                                            Ok(plan) => apply_amplifier_return_plan(
                                                &mut book,
                                                &mut watcher,
                                                &mut outcome,
                                                &projects_root,
                                                &plan,
                                            ),
                                            Err(e) => {
                                                // Transient scan failure:
                                                // stay absent, surface the
                                                // data plane via discover's
                                                // own protections.
                                                tracing::warn!(
                                                    path = %projects_root.display(),
                                                    error = %e,
                                                    "session-watcher: amplifier return plan scan failed; keeping the root absent",
                                                );
                                                outcome.provider_dirty = true;
                                            }
                                        }
                                        if book.armed.contains(&projects_root) {
                                            book.absent.remove(&projects_root);
                                        }
                                    }
                                    // Retry drain: kind-retained re-arms
                                    // with the file-state watch-then-scan
                                    // (arm_retry_entry additionally routes
                                    // the channel-inserted subagent-named
                                    // SessionDir corner — see its doc).
                                    for (path, kind) in retry_due {
                                        arm_retry_entry(
                                            &mut book,
                                            &mut watcher,
                                            &mut outcome,
                                            "amplifier",
                                            &path,
                                            kind,
                                        );
                                    }
                                    // Re-converge the late-root ancestor
                                    // fast path last: covers the
                                    // ancestor_unsynced trigger, the return
                                    // cascade's absence clear, and a
                                    // ProjectsRoot retry arm that landed.
                                    // D3-1: a TRUE report means the root
                                    // reappeared in the sync's window (e.g.
                                    // a failed return plan scan or a
                                    // ProjectsRoot retry arm's vanish) —
                                    // run the full return application
                                    // inline, inside this same batch.
                                    if sync_ancestor_watch(
                                        &mut book,
                                        &mut watcher,
                                        "amplifier",
                                        &projects_root,
                                    ) {
                                        recover_returned_root(
                                            &mut book,
                                            &mut watcher,
                                            &mut outcome,
                                            &projects_root,
                                        );
                                    }
                                }
                                (watcher, outcome)
                            })
                            .await;
                            match rearm_batch {
                                Ok((watcher, outcome)) => {
                                    watches.insert(
                                        amp.prov_idx,
                                        ProviderWatch {
                                            watcher,
                                            targets: Vec::new(),
                                        },
                                    );
                                    // Per-arm-batch budget check: this
                                    // batch covers BOTH listed rearm-tick
                                    // sites (the retry-drain batch and the
                                    // absent-root-return cascade).
                                    check_watch_budget(&mut amp.book.lock().unwrap());
                                    drain_arm_outcome(&index, &mut pending, "amplifier", outcome);
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        error = %e,
                                        "session-watcher: amplifier rearm batch failed; provider marked dirty",
                                    );
                                    index.mark_provider_dirty("amplifier");
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// What one ancestor-sync pass must converge to — the SELECT half, split
/// from the arm half so tests can interleave a root creation INSIDE the
/// check→arm window (delta D3-1) between the two production steps.
enum AncestorSelection {
    /// Nothing to watch: the absence state is gone (or the root is already
    /// armed), or nothing above the root exists (the ghost corner — the
    /// rearm tick owns the return, exactly as the pre-change absent list
    /// did).
    NoWatch,
    /// Arm this nearest existing ancestor (bounded at the provider home —
    /// the same bound the pre-change recursive late-root rule used), so
    /// `Create(<projects>)` is observed instantly.
    Watch(PathBuf),
    /// The absent-booked, unarmed root is PRESENT on disk (delta D3-1
    /// window (a): it appeared between the missing-root plan/decision and
    /// this sync, while NO ancestor watch was live, so its creation queued
    /// no return event). Arm nothing — an ancestor watch for a creation
    /// that already happened observes nothing, and the root itself is never
    /// its own ancestor; the caller runs the full root-return application
    /// (plan + kind-correct apply, marks on) NOW.
    RootReturn,
}

/// The SELECT half of [`sync_ancestor_watch`] (existence checks + the
/// nearest-existing-ancestor walk; no watcher side effects).
fn select_ancestor_watch(book: &ManagedBook, projects_root: &Path) -> AncestorSelection {
    if !book.absent.contains(projects_root) || book.armed.contains(projects_root) {
        return AncestorSelection::NoWatch;
    }
    if projects_root.exists() {
        return AncestorSelection::RootReturn;
    }
    let bound = projects_root.parent().unwrap_or(projects_root);
    let candidate = nearest_existing_ancestor(projects_root, bound);
    if candidate != projects_root && candidate.exists() {
        AncestorSelection::Watch(candidate)
    } else {
        AncestorSelection::NoWatch
    }
}

/// The ARM half of [`sync_ancestor_watch`]: converge `book.ancestor` to the
/// selection. Returns true when the caller must run the full root-return
/// application (plan + kind-correct apply, marks on) through its own
/// channel — spawn_blocking contexts run it inline, the async-loop vanish
/// dispatch defers it via the existing `root_return` cascade batch.
fn apply_ancestor_selection(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    provider: &str,
    projects_root: &Path,
    selection: AncestorSelection,
) -> bool {
    let target = match selection {
        AncestorSelection::NoWatch => {
            if let Some(current) = book.ancestor.take() {
                unwatch_tolerated(watcher, provider, &current);
            }
            return false;
        }
        AncestorSelection::RootReturn => {
            if let Some(current) = book.ancestor.take() {
                unwatch_tolerated(watcher, provider, &current);
            }
            return true;
        }
        AncestorSelection::Watch(target) => target,
    };
    if book.ancestor.as_deref() == Some(target.as_path()) {
        return false; // already converged — idempotent, side-effect-free
    }
    if let Some(current) = book.ancestor.take() {
        unwatch_tolerated(watcher, provider, &current);
    }
    // A failed arm is logged by `watch_path`; `None` stays booked and
    // the rearm tick's convergence re-runs this — bounded backoff adds
    // nothing to a single watch on an existing dir.
    if watch_path(
        watcher,
        provider,
        &target,
        notify::RecursiveMode::NonRecursive,
    )
    .is_err()
    {
        return false;
    }
    tracing::info!(
        provider = %provider,
        path = %target.display(),
        "session-watcher: projects root absent, watching nearest existing ancestor",
    );
    book.ancestor = Some(target.clone());
    // ARM-THEN-RECHECK (delta D3-1 window (b) — the check→arm window, the
    // same closure the stand-in swap applies to a sessions/ appearing
    // mid-arm): a root created between the ancestor-SELECT existence walk
    // and this arm produced NO event the just-armed watch could see — the
    // watch only reports creations from its arming moment on. Re-check the
    // root's existence NOW; if it appeared in that window, swap the
    // ancestor for the root-return handoff.
    if projects_root.exists() {
        unwatch_tolerated(watcher, provider, &target);
        book.ancestor = None;
        return true;
    }
    false
}

/// Converge the late-root ancestor watch (delta D2-2) with the absence
/// state: the projects root absent-tracked AND not currently armed ⇒ exactly
/// one NonRecursive watch on the nearest existing ancestor (bounded at the
/// provider home — the same bound the pre-change recursive late-root rule
/// used), so `Create(<projects>)` is observed instantly; otherwise ⇒ no
/// ancestor watch. Idempotent and side-effect-free when already converged.
/// Never arms the root ITSELF as its own ancestor: when the root is present
/// at sync time — or appears inside the arm's check→arm window (delta
/// D3-1) — the sync instead returns TRUE and the caller runs the full
/// root-return application (plan + kind-correct apply, marks on), so a root
/// created while no ancestor watch was live is armed with its whole
/// structural tree immediately, never deferred to the 60s rearm tick (which
/// stays the safety net). When nothing above the root exists, no watch is
/// armed and the rearm tick owns the return, exactly as the pre-change
/// absent list did. A failed ancestor arm leaves `None` (the kernel
/// auto-drops a vanished ancestor's watch, so a stale entry is unbooked the
/// same way); the rearm tick re-runs this convergence while the root stays
/// absent, so transient pressure never wedges the fast path permanently.
/// Every path that inserts or removes the root's absence calls this before
/// returning and honors the TRUE handoff.
fn sync_ancestor_watch(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    provider: &str,
    projects_root: &Path,
) -> bool {
    let selection = select_ancestor_watch(book, projects_root);
    apply_ancestor_selection(book, watcher, provider, projects_root, selection)
}

/// Walk up from `target` toward `bound`, returning the first ancestor that
/// exists on disk. If nothing exists (not even `bound`), returns `bound`.
fn nearest_existing_ancestor(target: &Path, bound: &Path) -> PathBuf {
    let mut current = target.to_path_buf();
    while current != bound && !current.exists() {
        current = match current.parent() {
            Some(p) => p.to_path_buf(),
            None => break,
        };
    }
    if current.exists() {
        current
    } else {
        bound.to_path_buf()
    }
}

/// Bound on D3-1 ancestor-sync recoveries inside ONE convergence pass: each
/// recovery means the root vanished-and-returned again inside the previous
/// recovery's microseconds-wide window, so a continuously flapping root
/// degrades to the rearm tick (plus this WARN and a provider-dirty mark)
/// instead of an unbounded plan-scan loop.
const ROOT_RETURN_RECOVERY_CAP: u32 = 4;

/// The D3-1 recovery for a `sync_ancestor_watch` TRUE report (the
/// absent-booked projects root is present — it appeared in a window with no
/// live ancestor watch, so no return event was queued): re-scan a FRESH
/// plan for the caller to apply with the return semantics (marks on). Caps
/// the per-pass recovery count (`ROOT_RETURN_RECOVERY_CAP`) against a
/// flapping root. Returns `None` on a transient scan failure (stay absent —
/// provider dirty set, the rearm tick retries, exactly as the tick's own
/// return cascade degrades) and at the cap (the tick owns the flap), so a
/// `None` never wedges the fast path.
fn replan_returned_root(
    outcome: &mut ArmOutcome,
    projects_root: &Path,
    recoveries: &mut u32,
) -> Option<PlanTargets> {
    if *recoveries >= ROOT_RETURN_RECOVERY_CAP {
        tracing::warn!(
            path = %projects_root.display(),
            "session-watcher: amplifier root keeps vanishing/returning inside the ancestor-sync window; the rearm tick owns the next convergence",
        );
        outcome.provider_dirty = true;
        return None;
    }
    *recoveries += 1;
    match plan_amplifier_targets(projects_root) {
        Ok(plan) => Some(plan),
        Err(e) => {
            tracing::warn!(
                path = %projects_root.display(),
                error = %e,
                "session-watcher: amplifier return plan scan failed; keeping the root absent",
            );
            outcome.provider_dirty = true;
            None
        }
    }
}

/// The D3-1 recovery at a spawn_blocking call site whose ancestor sync
/// reported the absent-booked root present: run the full root-return
/// application (fresh plan + kind-correct apply, marks on) inline — never
/// deferred to the rearm tick. (The ONE non-spawn_blocking call site, the
/// depth-0 vanish dispatch, defers instead via the `root_return` cascade
/// batch.)
fn recover_returned_root(
    book: &mut ManagedBook,
    watcher: &mut notify::RecommendedWatcher,
    outcome: &mut ArmOutcome,
    projects_root: &Path,
) {
    let mut recoveries = 0;
    if let Some(fresh) = replan_returned_root(outcome, projects_root, &mut recoveries) {
        apply_amplifier_return_plan(book, watcher, outcome, projects_root, &fresh);
    }
}

#[cfg(test)]
#[path = "session_watcher_tests.rs"]
mod tests;
