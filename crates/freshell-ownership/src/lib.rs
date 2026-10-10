//! # Runtime-ownership coordinator (kata b8ke)
//!
//! One server-authoritative owner per canonical `(provider, sessionId)`,
//! shared by the terminal lane and every Fresh Agent provider. The
//! invariant: at most ONE writer may be `Starting` or `Live` for a key at
//! any moment, and every delayed lifecycle request carries the generation
//! it observed so a stale request can never recreate ownership after a
//! newer generation began.
//!
//! Design notes:
//! - Sync `std::sync::Mutex`, never held across an await; callers inject
//!   this registry exactly like `FreshAgentSessionLeases`
//!   (freshell-server/src/main.rs:318-321).
//! - The per-lane lease maps (`TerminalRegistry::session_ref_leases`,
//!   `FreshAgentSessionLeases`) remain as same-kind/TTL backstops; this
//!   registry is the CROSS-kind authority (and same-kind dedupe) whose
//!   claim happens FIRST in every lifecycle path.
//! - `generation` is per-key monotonic and never resets (Vacant keeps it),
//!   so "stale" is identity-of-generation, not wall clock.
//! - Stop path (round-1 review): `begin_stop` enters `Stopping` (blocking
//!   competing starts); the KILL happens while `Stopping`; `commit_stop`
//!   moves to `Vacant` only after the caller confirms the reap. A stop
//!   attempted during another operation's `Handoff` returns the typed
//!   `BlockedHandoff` — the caller must NOT kill. During `Starting` the
//!   typed `NotLive` result carries the in-flight state and licenses NO
//!   kill: the in-flight operation (or the watchdog) owns the transition.
//!   During `Stopping` the typed `AlreadyStopping` names the in-flight stop
//!   operation: the caller joins it (and, for a forced stop, escalates
//!   it), never starting a second stop. A stop abandoned before the kill
//!   (runtime confirmed still alive) unwinds via `abort_stop` —
//!   `Stopping` → `Live` at the owner's pre-stop generation (Task 4
//!   review F1: every granted stop reaches commit or abort; nothing
//!   strands).
//! - Release fencing (round-1 review): watcher/TTL releases carry
//!   `(operation_id, generation, runtime identity)` and are no-ops on any
//!   mismatch — a delayed watcher can never erase a newer owner or an
//!   in-flight handoff. Exit-watcher events arriving while the state is
//!   `Handoff` are folded by the handoff runner (its awaited kill/reap is
//!   the single fold point); `release` is a no-op there by construction.
//! - Ticket discipline (round-1 review): create/resume claims ride an
//!   `OperationTicket` RAII guard (drop = typed fail); the
//!   `recover_stale_starts` watchdog is the backstop for leaked tickets.
//! - Boot epoch (round-2 review): fenced comparisons use `(epoch,
//!   generation)` — every registry instance mints an epoch at construction
//!   that is unique per boot BY CONSTRUCTION (never bare wall-clock
//!   milliseconds: rapid restarts or clock adjustments could reuse
//!   values). The default source mixes the once-per-process start instant
//!   (nanosecond resolution) with a per-mint process-global counter, so
//!   two mints in one process can never share an epoch (the mixing is
//!   injective per mint) and restarts separate on distinct start
//!   instants; for strict cross-restart uniqueness the host injects a
//!   persisted monotonic counter via
//!   [`RuntimeOwnershipRegistry::with_epoch`] (this crate stays I/O-free
//!   so tests never touch the filesystem). An observed pair whose epoch
//!   differs from the registry's is ALWAYS stale — a pre-restart request
//!   can never recreate ownership against a restarted registry.
//! - Watchdog cancellation (round-2 review): `recover_stale_starts` never
//!   flips a live spawn to `Vacant` underneath it — the sweep holds
//!   `Stopping` (blocking new claims), returns the operation's registered
//!   cancellation handle and partial-runtime identity, and only the host's
//!   abort → settle → kill → `commit_stop` sequence reopens the key.
//! - Every transition emits a diagnostic `tracing` event with the FULL
//!   join-critical field set (operation_id, provider/session_id, epoch,
//!   generation, old/new kind, runtime id/pid, transition, initiator,
//!   outcome, duration_ms, failure_reason) as EVENT fields
//!   (target-directive filters kill span fields; see
//!   crates/freshell-server/src/logging.rs:30-44) on the stable target
//!   `freshell_ownership`. Diagnostic, not audit-grade.
//! - Units (codex-pane-lifecycle): every coding-agent pane is one contained
//!   unit, and its Running / Stopping / Gone states ARE this registry's
//!   Live / Stopping / Vacant — there is no second state machine. Every
//!   key a unit holds carries its `OwnerIdentity::unit_id` (the pane's own
//!   conversation as `HoldKind::Main`, threads its agent process holds
//!   besides it as `HoldKind::Extra`); `begin_unit_stop` /
//!   `commit_unit_stop` move all of them together, and a persisted
//!   Stopping unit is seeded back at boot by `restore_stopping`.
//! - Waiting is event-driven: `wait_settled` registers a waker under the
//!   records lock; every mutating scope wakes parked waiters when it ends.
//!   No timers, no polling.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// `retry_after_ms` hint for Blocked outcomes (mirrors the lane leases).
pub const OWNERSHIP_RETRY_AFTER_MS: u64 = 1_000;

/// The once-per-process epoch seed: captured at the first registry mint
/// (nanosecond wall-clock at that instant). NOT the epoch itself — see
/// [`default_boot_epoch`].
static BOOT_SEED_NS: OnceLock<u64> = OnceLock::new();

/// Per-mint counter: distinguishes registry instances inside one process
/// (the splitmix mix below is injective per mint for a fixed seed, so
/// distinct mints stay unique PRE-mask; the JSON-safety mask at the mint
/// makes residual collisions a negligible 53-bit coincidence, and
/// [`RuntimeOwnershipRegistry::with_epoch`] remains the
/// construction-uniqueness guarantee).
static NEXT_MINT: AtomicU64 = AtomicU64::new(1);

/// The JSON wire-safety bound every browser client imposes on the epoch:
/// IEEE-754 doubles represent integers EXACTLY only up to 2^53-1, and the
/// client's ready-frame schema (zod v4 `.int()`) enforces exactly this
/// range. The default mint masks its output into the range so the epoch
/// survives the JS JSON.parse round trip verbatim — both directions: the
/// `ready.runtimeOwners` / `session.runtimeOwner` frames the client folds,
/// and any `observedEpoch` fence the client sends back (a full-64-bit
/// value would round to a DIFFERENT integer and poison every fence
/// comparison). Explicitly injected epochs ([`RuntimeOwnershipRegistry::with_epoch`])
/// stay unconstrained by contract.
const EPOCH_JSON_SAFE_MASK: u64 = (1u64 << 53) - 1;

/// Mint a boot epoch unique per registry construction (round-2 review:
/// never bare wall-clock milliseconds). Within a process the per-mint
/// counter plus the injective mix guarantees uniqueness; across restarts
/// the distinct first-mint instants separate the seeds (a collision needs
/// an exact 53-bit coincidence after the JSON-safety mask below — the
/// splitmix avalanche keeps the masked outputs uniform). Hosts wanting
/// strict cross-restart uniqueness by construction inject a persisted
/// monotonic counter via [`RuntimeOwnershipRegistry::with_epoch`].
fn default_boot_epoch() -> u64 {
    let seed = *BOOT_SEED_NS.get_or_init(now_epoch_ns);
    let mint = NEXT_MINT.fetch_add(1, Ordering::Relaxed);
    mix_boot_epoch(seed, mint) & EPOCH_JSON_SAFE_MASK
}

/// splitmix64 finalizer over the rotated seed XOR the mint counter —
/// allocation-free, avalanche-complete, and injective in `mint` for a
/// fixed `seed` (rotation, xor with the counter, the odd-constant
/// multiplies, and the xorshift mixes are all bijections on `u64`).
fn mix_boot_epoch(seed: u64, mint: u64) -> u64 {
    let mut z = seed.rotate_left(32) ^ mint;
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn now_epoch_ns() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// Wall-clock milliseconds since the Unix epoch — for event `duration_ms`
/// fields ONLY (never for uniqueness; see [`default_boot_epoch`]).
/// b8ke e4r2 F2: pub for the release records' fence-age duration (the
/// stable transition-log schema's duration_ms).
pub fn now_epoch_ms() -> u64 {
    now_epoch_ns() / 1_000_000
}

/// The wire string for a kind (`"terminal"` | `"fresh-agent"`).
fn kind_wire(kind: &RuntimeOwnerKind) -> &'static str {
    match kind {
        RuntimeOwnerKind::Terminal => "terminal",
        RuntimeOwnerKind::FreshAgent => "fresh-agent",
    }
}

/// Runtime-identity match for the release fence: kind + terminal id (or
/// live session key) + pid must all agree with the watched runtime, and
/// the committing operation must agree (`owner.ownership_id`).
fn runtime_matches(owner: &OwnerIdentity, claim: &ReleaseClaim) -> bool {
    let Some(runtime) = claim.runtime.as_ref() else {
        return false;
    };
    owner.kind == runtime.kind
        && owner.terminal_id == runtime.terminal_id
        && owner.live_session_key == runtime.live_session_key
        && owner.pid == runtime.pid
        && owner.ownership_id.as_deref() == Some(claim.operation_id.as_str())
}

/// The generation a snapshot/replay consumer fences against (review M3):
/// for Live keys the Live STATE's own generation. A stop abandoned with
/// the runtime still alive (`abort_stop`) restores the PRE-STOP Live
/// generation while the record's generation was already bumped by the
/// stop, and every fence comparison — begin_stop's stale-claim check and
/// begin_start/begin_handoff's stale-generation check (M3-R) — uses the
/// Live state's generation, so reporting the record's value for such a
/// key would leave a snapshot-derived fence permanently stale (a
/// StaleGeneration/StaleClaim loop: fail-closed liveness corner, no
/// safety violation). The failed-HANDOFF restore does NOT straddle: it
/// writes the record's current generation (whole-branch review M-1 — the
/// handoff broadcasts carried it to every client, whose monotonic folds
/// cannot regress), so `abort_stop`'s restore is the one deliberate
/// straddle this helper papers over. Chosen over rolling the record's
/// generation back on any restore: the record's generation is the per-key
/// monotonic counter (never resets — see the crate doc), and a rollback
/// would let distinct eras reuse a generation number, weakening the
/// stale-request fence for every consumer. For every non-Live state the
/// record's generation always equals the state's own (they are written
/// together).
fn snapshot_generation(record: &SessionRecord) -> u64 {
    match &record.state {
        OwnershipState::Live { generation, .. } => *generation,
        _ => record.generation,
    }
}

impl OwnershipState {
    /// The recorded initiator of the in-flight operation (round-1 review
    /// observability: commit/fail/stop events emit it from the record).
    fn initiator(&self) -> Option<String> {
        match self {
            OwnershipState::Starting { initiator, .. }
            | OwnershipState::Handoff { initiator, .. }
            | OwnershipState::Stopping { initiator, .. }
            | OwnershipState::Fenced { initiator, .. } => Some(initiator.clone()),
            OwnershipState::Aliased { .. } => None,
            _ => None,
        }
    }

    /// The kind this state is (or is transitioning to), for old/new-kind
    /// event fields.
    fn kind(&self) -> Option<RuntimeOwnerKind> {
        match self {
            OwnershipState::Vacant | OwnershipState::Aliased { .. } => None,
            OwnershipState::Starting { kind, .. } => Some(*kind),
            OwnershipState::Live { owner, .. } => Some(owner.kind),
            OwnershipState::Handoff { to_kind, .. } => Some(*to_kind),
            OwnershipState::Stopping { owner, .. } => owner.as_ref().map(|o| o.kind),
            OwnershipState::Fenced { prior, .. } => prior.as_ref().map(|(owner, _)| owner.kind),
        }
    }

    /// b8ke focused episode-2 round-2 F2: the operation id of the
    /// in-flight transition this state represents — the correlation key a
    /// lane-side adoption can compare against its runtime's recorded
    /// owning operation (`None` for the settled states Vacant/Live).
    pub fn operation_id(&self) -> Option<&str> {
        match self {
            OwnershipState::Vacant
            | OwnershipState::Live { .. }
            | OwnershipState::Aliased { .. } => None,
            OwnershipState::Starting { operation_id, .. }
            | OwnershipState::Handoff { operation_id, .. }
            | OwnershipState::Stopping { operation_id, .. }
            | OwnershipState::Fenced { operation_id, .. } => Some(operation_id.as_str()),
        }
    }

    /// The record's `since_ms` (round-2 review: `Live` carries it too, so
    /// release/commit events include the terminal-transition duration the
    /// observability contract requires).
    fn since_ms(&self) -> Option<u64> {
        match self {
            OwnershipState::Vacant | OwnershipState::Aliased { .. } => None,
            OwnershipState::Live { since_ms, .. }
            | OwnershipState::Starting { since_ms, .. }
            | OwnershipState::Handoff { since_ms, .. }
            | OwnershipState::Stopping { since_ms, .. }
            | OwnershipState::Fenced { since_ms, .. } => Some(*since_ms),
        }
    }

    /// The `Handoff` state's captured prior owner plus the generation it held
    /// when it went Live (kata b8ke Task 6): the handoff runner's stop
    /// source — the identity to stop. The captured generation is the
    /// PRIOR's own (historical); a restore resumes at the RECORD's current
    /// generation instead (whole-branch review M-1), so the runner must
    /// not use this value as a restore fence. `None` for every other state
    /// (only `Handoff` carries a prior; a Vacant-entered handoff captures
    /// `None` too).
    pub fn prior_owner(&self) -> Option<(OwnerIdentity, u64)> {
        match self {
            OwnershipState::Handoff { prior, .. } => prior.clone(),
            _ => None,
        }
    }
}

/// The delayed-request fence (round-2 review): the `(epoch, generation)`
/// pair a lifecycle request observed when it decided to act. A pair whose
/// epoch differs from the registry's boot epoch is ALWAYS stale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObservedFence {
    pub epoch: u64,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeOwnerKind {
    #[default]
    Terminal,
    FreshAgent,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionKey {
    pub provider: String,
    pub session_id: String,
}

impl SessionKey {
    pub fn new(provider: &str, session_id: &str) -> Self {
        Self {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerIdentity {
    pub kind: RuntimeOwnerKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ownership_id: Option<String>,
    /// The containment unit (freshell-containment) whose processes ARE this
    /// owner. Every key a unit holds (main conversation and extra threads)
    /// carries the same unit id; unit stops and commits move them together.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_id: Option<String>,
    /// How the unit holds this key: its pane's own conversation, or an
    /// extra thread its agent process has loaded besides it.
    #[serde(default)]
    pub hold: HoldKind,
}

/// How a unit holds a conversation key ([`OwnerIdentity::hold`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HoldKind {
    /// The pane's own conversation.
    #[default]
    Main,
    /// A thread the unit's agent process holds besides its main
    /// conversation (a helper agent, a fork parent, an earlier
    /// conversation opened in the same pane). A handoff or reopen on such
    /// a key adopts the holder; it never stops the holding unit.
    Extra,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OwnershipState {
    Vacant,
    Starting {
        kind: RuntimeOwnerKind,
        operation_id: String,
        generation: u64,
        initiator: String,
        since_ms: u64,
    },
    Live {
        owner: OwnerIdentity,
        generation: u64,
        since_ms: u64,
    },
    Handoff {
        prior: Option<(OwnerIdentity, u64)>,
        to_kind: RuntimeOwnerKind,
        operation_id: String,
        generation: u64,
        initiator: String,
        since_ms: u64,
    },
    Stopping {
        owner: Option<OwnerIdentity>,
        /// The generation the owner held when the stop began (Task 4 review
        /// F1): `abort_stop` restores `Live` at THIS generation — the fence
        /// baseline a pre-stop observer (retained stamp, snapshot) still
        /// carries. `None` for the watchdog's zombie-`Starting` synthesis
        /// (no prior Live era — not abortable to `Live`).
        prior_generation: Option<u64>,
        operation_id: String,
        generation: u64,
        initiator: String,
        since_ms: u64,
    },
    /// b8ke focused round-2 review (R2-1/R2-3): the TYPED fenced state —
    /// the prior runtime's death is UNCONFIRMED and no in-flight operation
    /// remains that could ever settle it, so the key blocks EVERY new
    /// writer until [`RuntimeOwnershipRegistry::release_fenced`] clears it
    /// (ONLY a caller that confirmed the prior's death by a bounded
    /// identity/pid probe or a watcher event may invoke it). The fail-open
    /// to plain `Vacant` the round-1 fix shipped for a lost watcher is
    /// REMOVED: it licensed a second writer over a possibly-live prior.
    /// `PlatformLimited` fences have no probe that can ever confirm (the
    /// descendant-tree walk is Linux-only), so they persist for the boot
    /// epoch — the documented tradeoff (the operator can still kill the
    /// leftover processes by other means; the server restart mints a new
    /// epoch). `begin_stop` answers the typed `NotLive{Fenced}` for this
    /// state: the caller must NOT kill (the fence owns the transition).
    Fenced {
        prior: Option<(OwnerIdentity, u64)>,
        reason: FenceReason,
        operation_id: String,
        generation: u64,
        initiator: String,
        since_ms: u64,
    },
    /// b8ke focused episode-2 round-3 F1/F3: this key's session was
    /// RE-KEYED — ownership moved to the client-visible new durable id
    /// ([`RuntimeOwnershipRegistry::commit_live_rekey`] /
    /// [`RuntimeOwnershipRegistry::rekey_live`]). The coordinator itself
    /// is the single source of truth for old→new resolution: a stale wire
    /// id landing here resolves to the canonical key through
    /// [`RuntimeOwnershipRegistry::resolve_canonical`] (walked to the
    /// fixpoint — never a bounded-link cap), and the record replays as
    /// VACANT to clients (the old key holds no writer; stale divergence
    /// clears). The lane-side process-local alias maps are NOT
    /// load-bearing: every lifecycle path resolves through the registry.
    Aliased {
        to: String,
        /// The rekey's own generation (preserved for fence arithmetic).
        generation: u64,
    },
}

/// Why a key sits in [`OwnershipState::Fenced`] (b8ke focused round-2
/// review). Typed on the state so every Blocked refusal carries the
/// machine-readable reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FenceReason {
    /// The detached reap-confirmation watcher itself failed (its
    /// confirmation future was lost — a JoinError) while the prior's death
    /// stayed unconfirmed. A replacement watcher clears the fence only once
    /// its bounded recorded-identity probe confirms death.
    WatcherFailed,
    /// Non-Linux teardown: the direct child's awaited exit is the portable
    /// floor, but the descendant-tree verification requires `/proc` —
    /// confirmation is IMPOSSIBLE on this platform, so nothing clears the
    /// fence within this boot epoch (the documented tradeoff).
    PlatformLimited,
    /// b8ke ext r16 F4: the acknowledged PlatformLimited force-clear
    /// landed HERE (pre-r16 it landed in plain Vacant, so a good-faith
    /// user following the offered recovery could start a second writer
    /// beside a surviving descendant). The state truthfully encodes the
    /// unverified prior writer; a lifecycle start on it refuses typed
    /// unless it carries the acknowledged-risk arm
    /// ([`RuntimeOwnershipRegistry::begin_handoff_acknowledged_cleared_unverified`]
    /// — the operator's explicit start-again enters the r33
    /// FORCED-REAP-THEN-START handoff: the unverified prior and its
    /// descendant tree are REAP TARGETS, killed and confirmed before the
    /// new writer commits); confirmed death (the existing watchers) also
    /// clears it.
    ClearedUnverified,
    /// b8ke delta round-2 F2: the stale-Starting watchdog could not confirm
    /// the start operation's death (a blocked/hung start, an unregistered
    /// settle, or an unconfirmable partial reap). The fence's recovery
    /// paths: the operation's OWN unwind (its ticket's typed `fail` —
    /// [`RuntimeOwnershipRegistry::fail`] releases exactly this reason),
    /// a confirmed-death probe ([`Self::release_fenced`]), or the lane
    /// teardown paths. Never force-clearable (the r4 acknowledged
    /// force-clear matches only `PlatformLimited`): a possibly-live start
    /// is never an operator-acknowledged risk.
    StaleStart,
    /// b8ke e3r2 F2: an over-aged `Stopping` record whose stop operation
    /// died without `commit_stop`/`abort_stop` (e.g. a panicked kill
    /// handler between its claim and its commit) — the stale-Stopping
    /// watchdog fences it TYPED so the key can never strand in `Stopping`
    /// blocking every claimant until restart. The recorded prior's death
    /// is UNCONFIRMED (the operation that was killing it vanished), so
    /// the same force-clear discipline applies as StaleStart: the
    /// acknowledged operator action or the confirmed-death probe.
    StaleStop,
}

impl FenceReason {
    /// The wire string for the reconnect-replay fields (b8ke focused
    /// round-3 review R3-5) — the same kebab-case spelling the serde
    /// derive emits.
    pub fn wire_str(&self) -> &'static str {
        match self {
            FenceReason::WatcherFailed => "watcher-failed",
            FenceReason::PlatformLimited => "platform-limited",
            FenceReason::ClearedUnverified => "cleared-unverified",
            FenceReason::StaleStop => "stale-stop",
            FenceReason::StaleStart => "stale-start",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeginOutcome {
    /// The caller holds the lease; it MUST end with `commit_live` (or `fail`).
    Granted { generation: u64 },
    /// A live runtime of the SAME kind exists — adopt/attach, never spawn.
    AdoptLive {
        owner: OwnerIdentity,
        generation: u64,
    },
    /// A live runtime of the OTHER kind owns the key — typed conflict.
    OwnedByOtherKind {
        owner: OwnerIdentity,
        generation: u64,
    },
    /// A lifecycle operation is in flight (Starting/Handoff/Stopping).
    Blocked {
        state: OwnershipState,
        retry_after_ms: u64,
    },
    /// The request observed a stale fence — an older generation within the
    /// current boot epoch, or any pair from a DIFFERENT (pre-restart) epoch.
    StaleGeneration {
        current_epoch: u64,
        current_generation: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitOutcome {
    Committed,
    StaleGeneration { current_generation: u64 },
    ForeignOperation,
}

/// Outcome of [`RuntimeOwnershipRegistry::abort_stop`] (Task 4 review F1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AbortStopOutcome {
    /// The stop was rolled back; the key is `Live` again (the owner restored
    /// at its pre-stop generation).
    Aborted,
    /// The carried generation no longer matches the record.
    StaleGeneration { current_generation: u64 },
    /// The record is not this operation's restorable `Stopping` (moved on,
    /// or a watchdog-synthesized stop with no prior Live era).
    ForeignOperation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailVacantReason {
    /// The failed operation had no prior owner to restore.
    NoPrior,
    /// The prior runtime was reaped/confirmed dead — never record a dead
    /// runtime as Live (round-1 review).
    PriorNotLive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailOutcome {
    /// A Starting operation was released (key now Vacant).
    Released,
    /// A failed handoff restored the prior CONFIRMED-LIVE owner.
    RestoredPriorOwner,
    /// The key ends Vacant with the typed reason (no prior, or prior dead).
    Vacant {
        reason: FailVacantReason,
    },
    ForeignOperation,
}

/// Outcome of the typed fence transitions (b8ke focused round-2 review):
/// [`RuntimeOwnershipRegistry::fence_unconfirmed_handoff`] and
/// [`RuntimeOwnershipRegistry::fence_unconfirmed_stop`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FenceOutcome {
    /// The record moved into [`OwnershipState::Fenced`] with the typed
    /// reason — every begin is now Blocked.
    Fenced,
    /// The record moved on (a foreign operation id or generation, or the
    /// state is no longer the expected in-flight one) — the typed no-op.
    ForeignOperation,
}

/// b8ke ext r17 F1: the outcome of the ATOMIC acknowledged start — the
/// `ClearedUnverified → Handoff` transition in ONE coordinator lock
/// hold (no Vacant landing, no lock release/reacquire window for a
/// concurrent request to consume).
#[derive(Debug)]
pub enum AcknowledgedStartOutcome {
    /// The handoff ENTERED atomically: the caller holds the same
    /// in-flight `Handoff` lease `begin_handoff` grants (the
    /// generation is the entered record's).
    Granted { generation: u64 },
    /// The observed pair is stale (a different epoch, or an older
    /// generation) — the caller answers the typed stale refusal.
    StaleObservation {
        current_epoch: u64,
        current_generation: u64,
    },
    /// The key moved on under the claim (a concurrent lifecycle
    /// request — acknowledged or otherwise — won the record, or the
    /// fence already cleared): the caller answers the TYPED conflict
    /// refusal, NEVER a panic and never a fabricated fallback.
    LostRace { state: OwnershipState },
}

/// Outcome of [`RuntimeOwnershipRegistry::force_release_platform_limited`]
/// (b8ke focused round-3 review R3-4): the typed operator recovery for a
/// `Fenced{PlatformLimited}` key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForceReleaseOutcome {
    /// The fence cleared — the record is `Vacant` at the same generation;
    /// the caller's explicit retry may proceed.
    Released,
    /// The key is not a `Fenced{PlatformLimited}` record (anything else —
    /// including `WatcherFailed` fences, whose bounded probe can still
    /// confirm; the state rides along for the typed refusal).
    NotPlatformLimited { state: OwnershipState },
    /// The observation is stale (a different boot epoch, or an older
    /// generation than the fenced record) — refresh and retry.
    StaleObservation {
        current_epoch: u64,
        current_generation: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopOutcome {
    Granted {
        generation: u64,
    },
    /// The key is not Live. When the carried state is `Vacant` the caller
    /// may still kill what it observed (idempotent — a leftover child the
    /// registry never knew) but MUST skip `commit_stop`. When the carried
    /// state is `Starting` (or any other non-Live state) an operation is in
    /// flight and the caller MUST NOT kill — the in-flight operation (or
    /// the watchdog) owns the transition; retry after it settles (round-2
    /// review). A `Stopping` key answers [`StopOutcome::AlreadyStopping`].
    NotLive {
        state: OwnershipState,
    },
    /// An in-flight handoff owns the transition (round-1 review): the caller
    /// must NOT kill — typed, retryable after the handoff settles.
    BlockedHandoff {
        state: OwnershipState,
        retry_after_ms: u64,
    },
    /// The stop claim mismatched the current owner (kind/runtime identity,
    /// epoch, or generation — round-2 review): the caller must NOT kill.
    /// Typed, retryable after refreshing the observed fence.
    StaleClaim {
        current_epoch: u64,
        current_generation: u64,
        state: OwnershipState,
    },
    /// A stop is already in flight for this key (a unit stop or another
    /// kill). The caller JOINS it (waits for Gone through the unit's stop
    /// handle / `wait_settled`) and, for a forced stop, escalates it — it
    /// never starts a second, competing stop.
    AlreadyStopping {
        operation_id: String,
        generation: u64,
        owner: Option<OwnerIdentity>,
    },
}

/// One key a unit stop moved or joined ([`RuntimeOwnershipRegistry::begin_unit_stop`])
/// or a unit commit vacated ([`RuntimeOwnershipRegistry::commit_unit_stop`]).
/// `generation` is the record's generation after the call: for a commit,
/// the post-commit pair a fenced `begin_start` accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitStopKey {
    pub key: SessionKey,
    pub generation: u64,
    /// `true` when the key was already `Stopping` for the unit (the call
    /// joined the in-flight stop instead of moving the key).
    pub joined: bool,
}

/// Outcome of [`RuntimeOwnershipRegistry::hold_extra`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HoldOutcome {
    /// The vacant key is now `Live`, held by the unit as an extra thread.
    Held { generation: u64 },
    /// The same unit already holds the key (as its main conversation or
    /// as an extra thread).
    AlreadyHeld,
    /// Another owner holds the key Live.
    HeldByOther { owner: OwnerIdentity },
    /// Nothing changed: the key is in another state, the unit is stopping
    /// (a stopping unit never gains holds), or the owner names no unit.
    Skipped { state: OwnershipState },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnershipSnapshot {
    /// The registry's boot epoch (round-2 review): the snapshot's
    /// generation is only meaningful fenced against this epoch.
    pub epoch: u64,
    pub generation: u64,
    pub state: OwnershipState,
}

/// The fencing claim every watcher/TTL release must carry (round-1 review):
/// the operation that committed the runtime, the generation it committed
/// under, and the runtime identity. `runtime` is `None` only for the zombie
/// `Starting`-ticket recovery (nothing spawned yet — the operation id and
/// generation fence it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseClaim {
    pub operation_id: String,
    pub generation: u64,
    pub runtime: Option<OwnerIdentity>,
}

/// The FENCED stop claim (round-2 review): `begin_stop` requires the
/// stopper's believed owner (expected kind + runtime identity, matched with
/// the `runtime_matches` discipline) and the `(epoch, generation)` it
/// observed. Any mismatch against the current `Live` record is the typed
/// `StopOutcome::StaleClaim` — the caller must NOT kill.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopClaim {
    pub expected_kind: RuntimeOwnerKind,
    pub expected_runtime: Option<OwnerIdentity>,
    pub observed: ObservedFence,
}

/// A watchdog-recovered over-aged `Starting` ticket (round-1 review;
/// cancellation-first per round-2). `cancellation` is the abort handle the
/// operation registered; `settle` resolves once the aborted task has
/// unwound (the host awaits it, bounded); `partial_runtime` is the child
/// identity it registered once spawned (the host kills it during settle).
pub struct RecoveredStart {
    pub provider: String,
    pub session_id: String,
    pub operation_id: String,
    pub generation: u64,
    pub kind: RuntimeOwnerKind,
    pub initiator: String,
    /// b8ke focused episode-2 round-2 F6: the stale age at recovery — the
    /// `Starting` record's own `since_ms`, so the transition logs carry the
    /// required duration on every outcome.
    pub since_ms: u64,
    pub cancellation: Option<Arc<dyn Fn() + Send + Sync>>,
    pub settle: Option<Box<dyn std::future::Future<Output = ()> + Send>>,
    pub partial_runtime: Option<OwnerIdentity>,
}

/// b8ke e3r2 F2: one over-aged `Stopping` record the stale-Stopping
/// watchdog fenced — the stop-claim unwind's typed record.
#[derive(Debug, Clone)]
pub struct StaleStopping {
    pub provider: String,
    pub session_id: String,
    pub operation_id: String,
    pub generation: u64,
    pub prior: Option<(OwnerIdentity, u64)>,
    pub initiator: String,
    pub since_ms: u64,
}

/// One `Fenced{StaleStart}` record for the watchdog's confirmed-death
/// probe (b8ke focused episode-2 round-2 F5) — see
/// [`RuntimeOwnershipRegistry::stale_start_fences`].
#[derive(Debug, Clone)]
pub struct StaleStartFence {
    pub provider: String,
    pub session_id: String,
    pub operation_id: String,
    pub generation: u64,
    /// The fenced prior's recorded pid — the probe's target. `None` (no
    /// recorded runtime identity) resolves through the kind-aware
    /// liveness check instead.
    pub prior_pid: Option<u32>,
    /// b8ke focused episode-2 round-3 F8: the fencing initiator + the
    /// fenced prior's kind — the release record's schema fields.
    pub initiator: String,
    pub prior_kind: Option<RuntimeOwnerKind>,
    /// b8ke focused episode-2 post-cap F4 + e3r4 F3: the fenced
    /// operation's settlement state — REASON-AWARE: for StaleStart it is
    /// the START's settle_fired flag; for StaleStop it is the STOP's
    /// stop_settled flag. `Some(true)`: the registering guard dropped
    /// (the operation concluded); `Some(false)`: still in flight (the
    /// fence holds); `None`: NO registration — the probe routes the
    /// PID-less shape through the kind-aware lane confirmation instead
    /// of rejecting forever (the opencode production shape: no
    /// per-session pid, no start settlement).
    pub settle_concluded: Option<bool>,
    /// b8ke e3r4 F3: WHICH stale reason is fenced — the probe's evidence
    /// discipline is reason-aware and the release records carry it.
    pub reason: FenceReason,
    /// b8ke d4 F2: the fenced TERMINAL prior's recorded pane/pty identity —
    /// the probe's terminal-liveness evidence (a terminal prior is NEVER
    /// probed through the Fresh Agent lanes: the opencode Fresh probe
    /// answers "true" because no Fresh map/turn exists, releasing while
    /// the terminal still runs; the claude/codex Fresh probes answer
    /// "false" forever, wedging even a dead terminal's fence).
    pub prior_terminal_id: Option<String>,
    /// b8ke e4r2 F2: the fence's entry timestamp — the release record's
    /// duration_ms (the fence's age at release) for the STABLE
    /// transition-log schema.
    pub since_ms: u64,
}

/// One replayed owner record for the `ready.runtimeOwners` handshake field
/// (kata b8ke reconnect-owner discovery, T1 rec A1). `owner_kind` is the
/// wire string "terminal" | "fresh-agent" | "vacant".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeOwnerReplayRecord {
    pub provider: String,
    pub session_id: String,
    /// The registry's boot epoch (round-2 review) — replayed so the client
    /// resets its generation state on epoch change instead of ignoring
    /// newer generations.
    pub epoch: u64,
    pub generation: u64,
    /// "terminal" | "fresh-agent" | "vacant"
    pub owner_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    /// b8ke focused round-3 review R3-5: the replayed state's truth.
    /// `Fenced` marks a record whose `owner_kind` names the FENCED PRIOR —
    /// NOT a live owner. A reconnecting device must never fold such a
    /// record as a committed owner (the pre-fix replay licensed a false
    /// "handoff-committed" fold after PLATFORM_LIMITED/WATCHER_FAILED — no
    /// divergence, no recovery UI). `reason` carries the typed fence reason
    /// when fenced.
    pub state: ReplayOwnerState,
    /// The typed fence reason (`state == Fenced` only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// b8ke focused episode-2 post-cap F5: the CANONICAL id this key was
    /// re-keyed to (`Aliased` keys only, wire-additive). The replayed
    /// owner_kind/state/generation are the CANONICAL record's — the
    /// server resolves the fixpoint — so a cross-device pane holding the
    /// pre-rekey id folds the authoritative owner state (never a
    /// permanent "vacant"), and `aliasOf` carries the navigation to the
    /// canonical key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_of: Option<String>,
}

/// The replayed record's truth for fenced and in-progress keys (b8ke
/// focused round-3 review R3-5; round-4 R4-6 widened the in-progress
/// states).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReplayOwnerState {
    /// The named owner is the committed live owner (a vacant key's
    /// `owner_kind: "vacant"` carries its own truth).
    Live,
    /// The record is FENCED: `owner_kind` names the fenced prior (not a
    /// live owner); the key blocks every new writer pending typed
    /// recovery. See `RuntimeOwnerReplayRecord::reason`.
    Fenced,
    /// b8ke focused round-4 review R4-6: a runtime of `owner_kind` is
    /// SPAWNING but not yet committed live — an in-progress lifecycle
    /// transition, never committed ownership (no attach/polling resume).
    Starting,
    /// b8ke focused round-4 review R4-6: a handoff owns the transition —
    /// `owner_kind` names the TARGET kind (the handoff-started
    /// broadcast's owner), pending the prior's confirmed reap and the
    /// target's commit.
    Handoff,
    /// b8ke focused round-4 review R4-6: the prior owner (`owner_kind`)
    /// is being STOPPED — the key's live era is ending; the record is an
    /// in-progress transition, never committed ownership.
    Stopping,
}

/// Per-key registry record. Hand-implemented `Default` (a `Vacant` record at
/// generation 0): the boxed settle future admits no `Debug`/`Clone` derive,
/// and `OwnershipState` has no derive-able default.
struct SessionRecord {
    generation: u64,
    state: OwnershipState,
    /// The in-flight `Starting` operation's registered abort handle, settle
    /// future, and partial-runtime identity (round-2 watchdog cancellation).
    cancellation: Option<Arc<dyn Fn() + Send + Sync>>,
    settle: Option<Box<dyn std::future::Future<Output = ()> + Send>>,
    /// b8ke focused episode-2 post-cap F4: the SENDER-side settle signal —
    /// the registering lane's guard sets this flag on Drop (the operation
    /// concluded/unwound), independent of whether anyone ever polls the
    /// boxed settle future. The stale-start probe requires it for PID-less
    /// fence release: "the operation's settle/cancellation has concluded"
    /// is probe-able HERE, never inferred from registration absence.
    settle_fired: Option<Arc<std::sync::atomic::AtomicBool>>,
    /// b8ke e3r3 F7: the STOP operation's sender-side settlement flag —
    /// the kill handler's scope guard sets it on Drop, so the
    /// stale-Stopping watchdog can distinguish a SLOW-BUT-LIVE stop (flag
    /// not fired: the handler is still running — NOT stale, never fenced
    /// on age) from a genuinely-vanished one (flag fired — fence typed).
    /// `None`: the stop predates the registration (age-only fencing).
    stop_settled: Option<Arc<std::sync::atomic::AtomicBool>>,
    partial_runtime: Option<OwnerIdentity>,
    /// b8ke ext r12 F2: the LIVE key's in-flight ATTACH guards (the
    /// existing-runtime attach's real claim — see
    /// [`RuntimeOwnershipRegistry::begin_attach_guard`]). A `begin_handoff`
    /// or `begin_stop` on a Live key with a held attach guard answers the
    /// typed `Blocked` outcome: the coordinator covers the attach through
    /// its completion (the restamp/register/bridge-restart window can never
    /// interleave with a state move), and the losing lifecycle operation
    /// retries after the window.
    in_flight_attaches: u32,
    /// b8ke ext r32 F1: the ARMED attach guards' operation ids — the
    /// same windows `in_flight_attaches` counts, identified so the
    /// GUARD HOLDER's own late claim (the create/attach flow that armed
    /// the window and now acquires the death-vacated key) can EXEMPT
    /// itself from the deferred-acquisition block: its begin carries
    /// `Some(window_operation_id)` matching one of these ids, while
    /// every competitor (no window op, or one that does not match)
    /// answers the typed Blocked outcome. The ids are server-minted
    /// UUIDs, never wire-exposed — a competitor cannot name one.
    armed_attach_ops: Vec<String>,
}

impl Default for SessionRecord {
    fn default() -> Self {
        Self {
            generation: 0,
            state: OwnershipState::Vacant,
            cancellation: None,
            settle: None,
            settle_fired: None,
            stop_settled: None,
            partial_runtime: None,
            in_flight_attaches: 0,
            armed_attach_ops: Vec::new(),
        }
    }
}

/// b8ke ext r12 F2: the refusal shapes of
/// [`RuntimeOwnershipRegistry::begin_attach_guard`].
pub enum AttachGuardOutcome {
    /// The guard is ARMED and held: the attach owns the key's window
    /// through its completion — a concurrent `begin_handoff` /
    /// `begin_stop` answers the typed `Blocked` outcome until the
    /// guard drops.
    Armed(Box<AttachGuard>),
    /// The key's state cannot be attached under a guard right now (a
    /// lifecycle transition owns it, or the key is not Live — the
    /// attach paths' own claim machinery owns those windows).
    Refused {
        state: OwnershipState,
        generation: u64,
    },
    /// The attach's observed generation is stale — refresh and retry.
    StaleGeneration {
        current_epoch: u64,
        current_generation: u64,
    },
}

impl std::fmt::Debug for AttachGuardOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // The guard itself is not inspectable (the Arc'd registry is
            // opaque); the armed fact is the printable truth.
            Self::Armed(_) => f.debug_tuple("Armed").finish(),
            Self::Refused { state, generation } => f
                .debug_struct("Refused")
                .field("state", state)
                .field("generation", generation)
                .finish(),
            Self::StaleGeneration {
                current_epoch,
                current_generation,
            } => f
                .debug_struct("StaleGeneration")
                .field("current_epoch", current_epoch)
                .field("current_generation", current_generation)
                .finish(),
        }
    }
}

/// b8ke ext r12 F2: the existing-runtime attach's RAII guard — a REAL
/// claim held across the attach's restamp/register/bridge-restart
/// window. `Drop` (or `disarm`) decrements the key's in-flight count;
/// a forgotten drop is the safe no-op (the count is clamped at zero).
pub struct AttachGuard {
    registry: Arc<RuntimeOwnershipRegistry>,
    provider: String,
    session_id: String,
    operation_id: String,
    generation: u64,
    disarmed: std::sync::atomic::AtomicBool,
    /// b8ke ext r15 F3: the arm instant (wall-clock ms) — the release
    /// event's REAL measured window duration (pre-r15 it hard-coded 0).
    armed_at_ms: u64,
    /// b8ke ext r15 F3: the initiating client/device the guard armed
    /// under — the release event's initiator (the stable schema's field).
    initiator: String,
}

impl AttachGuard {
    /// Release the guard's window NOW (the attach completed early or
    /// aborts before Drop; symmetric with `OperationTicket::disarm`'s
    /// scope shape). Exactly-once: the Drop of a disarmed guard is a
    /// no-op.
    pub fn disarm(&self) {
        if !self.disarmed.swap(true, Ordering::SeqCst) {
            self.release_window();
        }
    }

    /// The generation the guard armed under (the attach's fenced
    /// baseline — a state move to a LATER generation aborts the
    /// attach typed at the call site).
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// b8ke ext r32 F1: the armed window's operation id — the holder's
    /// own late claim (the create/attach flow that armed this guard)
    /// passes this to the windowed begin so the deferred-acquisition
    /// block exempts it (a competitor cannot name the UUID).
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
}

impl AttachGuard {
    /// The exactly-once window release (disarm or Drop — never both).
    fn release_window(&self) {
        let mut inner = self.registry.lock_records();
        let key = SessionKey::new(&self.provider, &self.session_id);
        // b8ke ext r15 F3: the release event joins the UNIFORM transition
        // schema — the record's CURRENT owner at release time (the
        // identity a blocked lifecycle window pinned), the initiating
        // client/device, and the REAL measured window duration (pre-r15
        // the event omitted the kinds, the runtime identity, and the
        // initiator, and hard-coded the duration to zero).
        let mut released_from_kind = None;
        let mut released_runtime_id = None;
        let mut released_pid = None;
        if let Some(record) = inner.get_mut(&key) {
            // b8ke ext r32 F1: the identified window closes with the
            // count (the holder's exemption list stays in lockstep). A
            // window a unit's Gone commit already cleared is not in the
            // list any more, and its late release must not close a window
            // armed afterwards by a newer attach.
            if let Some(pos) = record
                .armed_attach_ops
                .iter()
                .position(|op| op == &self.operation_id)
            {
                record.armed_attach_ops.remove(pos);
                record.in_flight_attaches = record.in_flight_attaches.saturating_sub(1);
            }
            if let OwnershipState::Live { owner, .. } = &record.state {
                released_from_kind = Some(owner.kind);
                released_runtime_id = owner.terminal_id.clone();
                released_pid = owner.pid;
            }
        }
        let duration_ms = now_epoch_ms().saturating_sub(self.armed_at_ms);
        tracing::info!(target: "freshell_ownership",
            event = "ownership.attach_guard.released",
            operation_id = %self.operation_id, provider = %self.provider,
            session_id = %self.session_id, initiator = %self.initiator,
            from_kind = ?released_from_kind,
            to_kind = ?Option::<RuntimeOwnerKind>::None,
            runtime_id = ?released_runtime_id, pid = ?released_pid,
            epoch = self.registry.epoch, generation = self.generation,
            duration_ms,
            outcome = "released", failure_reason = "",
            "the attach guard released after {duration_ms}ms — the key's window \
             is closed and blocked lifecycle operations may retry");
    }
}

impl Drop for AttachGuard {
    fn drop(&mut self) {
        if !self.disarmed.swap(true, Ordering::SeqCst) {
            self.release_window();
        }
    }
}

/// RAII claim guard for create/resume tickets (round-1 review). Constructed
/// on `Granted`; `Drop` without `disarm()` performs the typed `fail`
/// releasing the claim, so a panicked spawn cannot wedge a session in
/// `Starting`. After a successful `commit_live` the record is `Live` and a
/// forgotten `disarm()` is a safe typed no-op (ForeignOperation).
pub struct OperationTicket {
    registry: Arc<RuntimeOwnershipRegistry>,
    provider: String,
    session_id: String,
    operation_id: String,
    kind: RuntimeOwnerKind,
    generation: u64,
    initiator: String,
    disarmed: bool,
}

impl OperationTicket {
    /// Wrap an already-`Granted` claim (the caller holds the `Granted`
    /// generation from its `begin_start`/`begin_handoff` call). This never
    /// claims by itself — pair it with the grant that minted the claim.
    pub fn new(
        registry: Arc<RuntimeOwnershipRegistry>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        kind: RuntimeOwnerKind,
        generation: u64,
        initiator: &str,
    ) -> Self {
        Self {
            registry,
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            operation_id: operation_id.to_string(),
            kind,
            generation,
            initiator: initiator.to_string(),
            disarmed: false,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// b8ke focused episode-2 round-2 F1: the ticket's coordinator key —
    /// the key the claim was minted under (the claude lane's commit
    /// derives its registry key from the ticket, never a caller-passed
    /// wire id, so a claim minted under a resolved/aliased key commits
    /// under the same key).
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    /// Keep the claim alive past this guard's drop (the holder completed
    /// its `commit_live`, or transferred ownership of the claim).
    pub fn disarm(&mut self) {
        self.disarmed = true;
    }

    /// b8ke ext r22 F1: the ticket SURVIVES the id change — after a
    /// [`RuntimeOwnershipRegistry::rekey_starting`] moved this ticket's
    /// in-flight `Starting` record from the pane-scoped provisional key to
    /// the minted canonical id, the ticket's own key is re-pointed so the
    /// holder's later `commit_live` (and the RAII typed fail on a dropped
    /// unarmed ticket) address the CANONICAL key, never the superseded
    /// provisional one.
    pub fn rekey_session_id(&mut self, new_session_id: &str) {
        self.session_id = new_session_id.to_string();
    }
}

impl Drop for OperationTicket {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        // The ticket's whole purpose is surviving a panicked holder: run
        // the typed fail inside catch_unwind so a panic WHILE unwinding
        // (e.g. a poisoned lock) cannot abort the process — a panic raised
        // during another panic's unwind aborts.
        let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.registry.fail(
                &self.provider,
                &self.session_id,
                &self.operation_id,
                self.generation,
                /* prior_confirmed_live: */ false,
            )
        }));
        match failed {
            Ok(outcome) => tracing::warn!(target: "freshell_ownership",
                event = "ownership.ticket.dropped_unarmed",
                operation_id = %self.operation_id,
                provider = %self.provider, session_id = %self.session_id,
                initiator = %self.initiator, kind = ?self.kind,
                epoch = self.registry.boot_epoch(), generation = self.generation,
                outcome = ?outcome, failure_reason = "TICKET_DROPPED"),
            Err(_) => tracing::error!(target: "freshell_ownership",
                event = "ownership.ticket.fail_panicked",
                operation_id = %self.operation_id,
                provider = %self.provider, session_id = %self.session_id,
                initiator = %self.initiator,
                epoch = self.registry.boot_epoch(), generation = self.generation,
                outcome = "fail_panicked", failure_reason = "TICKET_FAIL_PANICKED"),
        }
    }
}

/// The ONE server-wide runtime-ownership coordinator. Mint exactly one per
/// server boot (freshell-server::main) and inject it into every lifecycle
/// lane; the per-boot epoch is minted at construction (see
/// [`default_boot_epoch`]) and can be injected explicitly via
/// [`RuntimeOwnershipRegistry::with_epoch`] (a persisted monotonic counter
/// gives strict cross-restart uniqueness by construction).
pub struct RuntimeOwnershipRegistry {
    epoch: u64,
    inner: Mutex<HashMap<SessionKey, SessionRecord>>,
    /// Parked [`SettledWait`] futures. Woken (all of them; each re-checks
    /// its own key) whenever a mutating lock scope ends. No timers, no
    /// polling.
    waiters: Mutex<Vec<std::task::Waker>>,
}

/// The records lock taken by every MUTATING scope
/// ([`RuntimeOwnershipRegistry::lock_records`]): when the scope ends it
/// releases the records lock FIRST and then wakes every parked
/// [`SettledWait`], so a woken waiter can take the lock at once and sees
/// the committed state.
struct RecordsGuard<'a> {
    guard: Option<std::sync::MutexGuard<'a, HashMap<SessionKey, SessionRecord>>>,
    waiters: &'a Mutex<Vec<std::task::Waker>>,
}

impl std::ops::Deref for RecordsGuard<'_> {
    type Target = HashMap<SessionKey, SessionRecord>;
    fn deref(&self) -> &Self::Target {
        self.guard
            .as_ref()
            .expect("records guard is live until drop")
    }
}

impl std::ops::DerefMut for RecordsGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.guard
            .as_mut()
            .expect("records guard is live until drop")
    }
}

impl Drop for RecordsGuard<'_> {
    fn drop(&mut self) {
        // Release the records lock BEFORE waking: a woken waiter re-polls
        // and takes it immediately.
        drop(self.guard.take());
        let wakers = std::mem::take(&mut *self.waiters.lock().expect("waiters lock poisoned"));
        for waker in wakers {
            waker.wake();
        }
    }
}

/// `true` while a lifecycle operation owns the key (Starting / Handoff /
/// Stopping); every other state is settled for [`SettledWait`].
fn in_progress(state: &OwnershipState) -> bool {
    matches!(
        state,
        OwnershipState::Starting { .. }
            | OwnershipState::Handoff { .. }
            | OwnershipState::Stopping { .. }
    )
}

/// The identity a record is STAMPED with for unit-scoped operations: the
/// owner of a `Live` or `Stopping` record, the partial runtime a
/// `Starting` record registered, or the prior a `Handoff` captured. Every
/// other state (including `Aliased`, which carries no owner) is unstamped.
fn stamping_owner(record: &SessionRecord) -> Option<&OwnerIdentity> {
    match &record.state {
        OwnershipState::Live { owner, .. } => Some(owner),
        OwnershipState::Stopping { owner, .. } => owner.as_ref(),
        OwnershipState::Starting { .. } => record.partial_runtime.as_ref(),
        OwnershipState::Handoff { prior, .. } => prior.as_ref().map(|(owner, _)| owner),
        _ => None,
    }
}

/// The unit a record is stamped with (see [`stamping_owner`]).
fn stamped_unit(record: &SessionRecord) -> Option<&str> {
    stamping_owner(record).and_then(|owner| owner.unit_id.as_deref())
}

/// The order unit-scoped results are reported in: by session id, then
/// provider.
fn by_session_id(a: &SessionKey, b: &SessionKey) -> std::cmp::Ordering {
    (a.session_id.as_str(), a.provider.as_str()).cmp(&(b.session_id.as_str(), b.provider.as_str()))
}

/// Event-driven wait for a key to settle
/// ([`RuntimeOwnershipRegistry::wait_settled`]): resolves with the first
/// snapshot whose state is not Starting / Handoff / Stopping.
pub struct SettledWait {
    registry: Arc<RuntimeOwnershipRegistry>,
    key: SessionKey,
}

impl std::future::Future for SettledWait {
    type Output = OwnershipSnapshot;

    fn poll(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<OwnershipSnapshot> {
        // Register the waker WHILE holding the records lock: any later
        // mutation takes the lock after us and wakes us when it ends.
        let inner = self.registry.inner.lock().expect("ownership lock poisoned");
        let snapshot = match inner.get(&self.key) {
            Some(record) => OwnershipSnapshot {
                epoch: self.registry.epoch,
                generation: snapshot_generation(record),
                state: record.state.clone(),
            },
            None => OwnershipSnapshot {
                epoch: self.registry.epoch,
                generation: 0,
                state: OwnershipState::Vacant,
            },
        };
        if in_progress(&snapshot.state) {
            self.registry
                .waiters
                .lock()
                .expect("waiters lock poisoned")
                .push(cx.waker().clone());
            std::task::Poll::Pending
        } else {
            std::task::Poll::Ready(snapshot)
        }
    }
}

impl Default for RuntimeOwnershipRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeOwnershipRegistry {
    /// Mint a registry with a default boot epoch (unique per construction;
    /// see [`default_boot_epoch`]).
    pub fn new() -> Self {
        Self::with_epoch(default_boot_epoch())
    }

    /// Mint a registry with an injected boot epoch — the host's hook for a
    /// persisted monotonic counter when strict cross-restart uniqueness is
    /// required; tests use it to simulate distinct boots.
    pub fn with_epoch(epoch: u64) -> Self {
        Self {
            epoch,
            inner: Mutex::new(HashMap::new()),
            waiters: Mutex::new(Vec::new()),
        }
    }

    /// The records lock for a MUTATING scope: parked [`SettledWait`]s are
    /// woken when the returned guard drops. Read-only scopes take
    /// `self.inner.lock()` directly so a read never wakes waiters.
    fn lock_records(&self) -> RecordsGuard<'_> {
        RecordsGuard {
            guard: Some(self.inner.lock().expect("ownership lock poisoned")),
            waiters: &self.waiters,
        }
    }

    /// Event-driven: resolves once the key is not Starting / Handoff /
    /// Stopping (settled = Vacant, Live, Aliased or Fenced). The future
    /// parks a waker under the records lock and is woken when a mutating
    /// scope ends; it never polls on a timer. The caller resolves a stale
    /// id to its canonical key ([`Self::resolve_canonical`]) before
    /// waiting.
    pub fn wait_settled(self: &Arc<Self>, provider: &str, session_id: &str) -> SettledWait {
        SettledWait {
            registry: Arc::clone(self),
            key: SessionKey::new(provider, session_id),
        }
    }

    /// The boot epoch (round-2 review): fenced comparisons use
    /// `(epoch, generation)`; an observed pair from a different epoch is
    /// always stale.
    pub fn boot_epoch(&self) -> u64 {
        self.epoch
    }

    /// Atomically begin a start/attach/resume of `kind` for
    /// `(provider, session_id)`. `observed` is the `(epoch, generation)`
    /// fence a DELAYED request saw when it decided to act; `None` means the
    /// caller has no stale risk to fence (legacy unfenced senders still
    /// pass the same-kind/cross-kind checks — the coordinator closes the
    /// vacant-state race either way). `initiator` identifies the initiating
    /// client/device/lane for the transition events. Entering `Starting`
    /// increments the generation. Re-claiming a `Starting`/`Handoff` held
    /// by the SAME operation and kind is Granted (the handoff target
    /// continuation relies on this).
    #[allow(clippy::too_many_arguments)] // The plan-frozen coordinator surface (Tasks 3-10 consume it).
    pub fn begin_start(
        &self,
        provider: &str,
        session_id: &str,
        kind: RuntimeOwnerKind,
        operation_id: &str,
        observed: Option<ObservedFence>,
        initiator: &str,
        now_ms: u64,
    ) -> BeginOutcome {
        self.begin_start_inner(
            provider,
            session_id,
            kind,
            operation_id,
            observed,
            initiator,
            now_ms,
            None,
        )
    }

    /// b8ke ext r32 F1: the GUARD HOLDER's own begin — the create/attach
    /// flow that armed an attach window on this key and now acquires the
    /// death-vacated key inside its own window. `window_operation_id`
    /// names one of the record's ARMED guard ids (the holder got it from
    /// its [`AttachGuard::operation_id`]); the deferred-acquisition
    /// block in the Vacant arm exempts it, so the holder's late claim
    /// grants with continuous authority while every competitor still
    /// answers the typed Blocked outcome. A window op that matches
    /// nothing is refused exactly like a competitor's.
    #[allow(clippy::too_many_arguments)] // the begin field set + the window id (b8ke ext r32 F1)
    pub fn begin_start_under_attach_window(
        &self,
        provider: &str,
        session_id: &str,
        kind: RuntimeOwnerKind,
        operation_id: &str,
        observed: Option<ObservedFence>,
        initiator: &str,
        now_ms: u64,
        window_operation_id: &str,
    ) -> BeginOutcome {
        self.begin_start_inner(
            provider,
            session_id,
            kind,
            operation_id,
            observed,
            initiator,
            now_ms,
            Some(window_operation_id),
        )
    }

    #[allow(clippy::too_many_arguments)] // the begin field set + the window id (b8ke ext r32 F1)
    fn begin_start_inner(
        &self,
        provider: &str,
        session_id: &str,
        kind: RuntimeOwnerKind,
        operation_id: &str,
        observed: Option<ObservedFence>,
        initiator: &str,
        now_ms: u64,
        attach_window_operation_id: Option<&str>,
    ) -> BeginOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        // Fence check BEFORE creating the record: a stale request must not
        // create ownership — not even a Vacant replay entry for a key it
        // never legitimately touched.
        if let Some(fence) = observed {
            // The coherent fence baseline (M3-R): the same value a
            // snapshot-derived fence carries, so refreshing from
            // observe()/snapshot_records() converges on restored keys.
            let current_generation = inner.get(&key).map_or(0, snapshot_generation);
            if fence.epoch != self.epoch || fence.generation < current_generation {
                // b8ke ext r7 F4: the UNIFORM transition schema — the
                // refusal carries the complete stable field set, the
                // unknown prior/next runtime identities None-valued.
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.begin_start.stale_generation",
                    operation_id, provider, session_id, initiator,
                    from_kind = ?Option::<RuntimeOwnerKind>::None,
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                    observed_epoch = fence.epoch, observed_generation = fence.generation,
                    epoch = self.epoch, generation = current_generation,
                    duration_ms = 0u64,
                    outcome = "refused", failure_reason = "STALE_GENERATION");
                return BeginOutcome::StaleGeneration {
                    current_epoch: self.epoch,
                    current_generation,
                };
            }
        }
        let record = inner.entry(key).or_default();
        match record.state.clone() {
            // b8ke focused episode-2 round-3 F3: a superseded (re-keyed)
            // id is NEVER directly claimable — the caller resolves to the
            // canonical key first (`resolve_canonical`); a direct begin
            // under the old id would fork ownership beside the live
            // re-keyed runtime. Typed Blocked so the caller learns to
            // resolve.
            OwnershipState::Aliased { to, generation } => {
                // b8ke ext r7 F4: the UNIFORM transition schema.
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.begin.on_aliased_key",
                    operation_id, provider, session_id,
                    from_kind = ?Option::<RuntimeOwnerKind>::None,
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                    aliased_to = %to, epoch = self.epoch, generation,
                    duration_ms = 0u64,
                    outcome = "refused", failure_reason = "REKEYED_ALIAS_KEY");
                BeginOutcome::Blocked {
                    state: OwnershipState::Aliased { to, generation },
                    retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
                }
            }
            OwnershipState::Vacant => {
                // b8ke ext r32 F1: an in-flight ATTACH guard owns the
                // key's window EVEN AFTER the incumbent's exit — the
                // exit-during-guard race. Pre-r32 the incumbent's
                // release flipped Live→Vacant unconditionally and this
                // branch ignored `in_flight_attaches`, so a competing
                // cross-kind begin acquired the coordinator and started
                // its writer while the guarded create was still in its
                // spawn; the create's late claim only detected and
                // killed the writer AFTER the overlap. The deferred
                // acquisition lands when the LAST guard resolves (the
                // count hits zero — `AttachGuard::release_window`); the
                // record's Vacant state itself stays honest (the
                // runtime IS dead), the DEFERRAL is the acquisition
                // policy, so no fence can become permanent and the
                // guarded create's own windowed begin
                // (`begin_start_under_attach_window`) is never refused.
                if record.in_flight_attaches > 0
                    && !attach_window_operation_id.is_some_and(|window_op| {
                        record
                            .armed_attach_ops
                            .iter()
                            .any(|armed| armed == window_op)
                    })
                {
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.start.blocked_by_attach_guard",
                        operation_id, provider, session_id, initiator,
                        from_kind = ?Option::<RuntimeOwnerKind>::None,
                        to_kind = ?Some(kind),
                        runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                        epoch = self.epoch, generation = record.generation,
                        duration_ms = 0u64,
                        outcome = "refused", failure_reason = "ATTACH_IN_FLIGHT",
                        "the incumbent exited but an in-flight attach still holds \
                         the key's coordinator window — the start retries after the \
                         attach completes");
                    return BeginOutcome::Blocked {
                        state: record.state.clone(),
                        retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
                    };
                }
                // Every entry into `Starting` goes through this arm, so
                // resetting the registration fields here is the single
                // choke point guaranteeing a later Starting operation can
                // never inherit its DEAD predecessor's cancellation/settle/
                // partial-runtime handles (a predecessor that exited via
                // fail/commit_live/force_release leaves them behind; only
                // the sweep takes them) — the watchdog's RecoveredStart
                // must only ever carry handles the CURRENT resident
                // registered itself. b8ke delta round-3 F7: `settle_fired`
                // resets here too — a settled-and-failed predecessor's
                // fired flag must never mark the NEXT operation as
                // concluded before it registers (the probe would release
                // its fence as already-settled while it still runs, and a
                // third operation could start inside the dual-runtime
                // window).
                record.cancellation = None;
                record.settle = None;
                record.settle_fired = None;
                record.partial_runtime = None;
                record.generation += 1;
                record.state = OwnershipState::Starting {
                    kind,
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    initiator: initiator.to_string(),
                    since_ms: now_ms,
                };
                // b8ke ext F3: the STABLE transition-log schema — every
                // field present at every transition, the not-yet-known
                // values None-valued (the same contract the release
                // records follow): a start begin logs the vacated key's
                // from-side as None (no prior owner exists) and the empty
                // (not-applicable) failure reason.
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.start.begin", operation_id, provider, session_id,
                    initiator,
                    from_kind = ?Option::<RuntimeOwnerKind>::None, to_kind = ?kind,
                    runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                    epoch = self.epoch, generation = record.generation,
                    duration_ms = 0u64, outcome = "granted", failure_reason = "");
                BeginOutcome::Granted {
                    generation: record.generation,
                }
            }
            OwnershipState::Starting {
                kind: held_kind,
                operation_id: held_op,
                generation,
                ..
            } if held_kind == kind && held_op == operation_id => {
                BeginOutcome::Granted { generation }
            }
            OwnershipState::Handoff {
                to_kind,
                operation_id: ho_op,
                generation,
                ..
            } if to_kind == kind && ho_op == operation_id => BeginOutcome::Granted { generation },
            OwnershipState::Live {
                owner, generation, ..
            } if owner.kind == kind => BeginOutcome::AdoptLive { owner, generation },
            OwnershipState::Live {
                owner, generation, ..
            } => BeginOutcome::OwnedByOtherKind { owner, generation },
            state => BeginOutcome::Blocked {
                state,
                retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
            },
        }
    }

    /// Atomically enter `Handoff` (incrementing the generation), capturing
    /// the prior live owner for restore-on-failure. Granted from `Vacant`
    /// (no prior to stop) and from `Live` of any kind; `Starting` /
    /// `Handoff` / `Stopping` block (a handoff from `Starting` is Blocked
    /// BY DESIGN — round-1 review test alignment).
    /// b8ke ext r12 F2: arm the existing-runtime attach's REAL claim.
    /// The check-then-arm is ONE critical section (under the registry
    /// lock): the key must be `Live` (an attach to an existing runtime;
    /// the not-Live shapes keep their own claim machinery — the
    /// crash-recovery re-claims, the resume claims) and the attach's
    /// observed generation (when it carries one) must be current. While
    /// the guard is held, `begin_handoff` and `begin_stop` on the key
    /// answer the typed `Blocked` outcome — the handoff CANNOT begin and
    /// commit inside the attach's restamp/register/bridge-restart window
    /// (the pre-r12 point-in-time `observe()` closed no window: a
    /// handoff could begin and commit between the snapshot and the
    /// durable restamp, leaving the delayed attach persisting stale
    /// old-runtime binding, answering from the superseded runtime, or
    /// restarting a torn-down SSE bridge).
    /// b8ke ext r14 F2: the identity REBIND's atomic coordinator move —
    /// ONE lock scope, mirroring [`Self::rekey_live`]'s machinery for a
    /// TERMINAL incumbent whose writer moved to a NEW canonical key:
    /// (1) the NEW key's `Starting{operation_id, generation}` claim (the
    ///     rebind's held ticket) commits `Live{owner, generation}`;
    /// (2) the OLD key's `Live{Terminal, expected_terminal_id}` record
    ///     becomes `Aliased{to: new}` (the monotone generation bumped, so
    ///     old-key fences see the advance and old-key panes resolve the
    ///     canonical chain).
    /// Any mismatch (the new key's claim is stale/foreign, the old key is
    /// not Live under THIS terminal) is the typed refusal and NOTHING
    /// moves — never the interval where BOTH keys name the writer.
    #[allow(clippy::too_many_arguments)] // the rekey field set (the ids + the claim + the expected identity)
    pub fn commit_live_rekey_from_terminal(
        &self,
        provider: &str,
        new_session_id: &str,
        operation_id: &str,
        generation: u64,
        old_session_id: &str,
        expected_terminal_id: &str,
        owner: OwnerIdentity,
        initiator: &str,
    ) -> CommitOutcome {
        let mut inner = self.lock_records();
        let new_key = SessionKey::new(provider, new_session_id);
        // (1) The new key's Starting claim must be ours.
        match inner.get(&new_key).map(|r| r.state.clone()) {
            Some(OwnershipState::Starting {
                operation_id: starting_op,
                generation: starting_gen,
                ..
            }) if starting_op == operation_id && starting_gen == generation => {}
            _ => {
                tracing::error!(target: "invariant",
                    event = "ownership.commit_live_rekey_from_terminal.new_claim_mismatch",
                    operation_id = %operation_id, provider, initiator,
                    old_session_id, new_session_id,
                    expected_terminal_id = %expected_terminal_id,
                    epoch = self.epoch, generation,
                    outcome = "refused", failure_reason = "FOREIGN_NEW_CLAIM",
                    "the rebind's new-key Starting claim is stale or foreign — \
                     nothing moves");
                return CommitOutcome::ForeignOperation;
            }
        }
        // (2) The old key must be Live under THIS terminal.
        let old_key = SessionKey::new(provider, old_session_id);
        let old_generation = match inner.get(&old_key).map(|r| r.state.clone()) {
            Some(OwnershipState::Live {
                owner: old_owner,
                generation,
                ..
            }) if old_owner.kind == RuntimeOwnerKind::Terminal
                && old_owner.terminal_id.as_deref() == Some(expected_terminal_id) =>
            {
                generation
            }
            _ => {
                tracing::error!(target: "invariant",
                    event = "ownership.commit_live_rekey_from_terminal.old_owner_mismatch",
                    operation_id = %operation_id, provider, initiator,
                    old_session_id, new_session_id,
                    expected_terminal_id = %expected_terminal_id,
                    epoch = self.epoch, generation,
                    outcome = "refused", failure_reason = "FOREIGN_OLD_OWNER",
                    "the rebind's old key is not Live under this terminal — \
                     nothing moves");
                return CommitOutcome::ForeignOperation;
            }
        };
        // THE MOVE (one lock scope): new Starting → Live; old Live →
        // Aliased{to: new} with the monotone generation bumped.
        if let Some(record) = inner.get_mut(&new_key) {
            record.state = OwnershipState::Live {
                owner: owner.clone(),
                generation,
                since_ms: now_epoch_ms(),
            };
        }
        let aliased_generation = old_generation + 1;
        if let Some(record) = inner.get_mut(&old_key) {
            record.generation = aliased_generation;
            record.state = OwnershipState::Aliased {
                to: new_session_id.to_string(),
                generation: aliased_generation,
            };
        }
        tracing::info!(target: "freshell_ownership",
            event = "ownership.live.rekey_from_terminal", operation_id, provider,
            old_session_id, new_session_id, initiator,
            from_kind = ?RuntimeOwnerKind::Terminal,
            to_kind = ?RuntimeOwnerKind::Terminal,
            runtime_id = ?owner.terminal_id, pid = ?owner.pid,
            epoch = self.epoch, generation, aliased_generation,
            duration_ms = 0u64,
            outcome = "rekeyed_committed", failure_reason = "",
            "the identity rebind moved the terminal owner old→new in ONE \
             coordinator lock scope — no interval where both keys name the \
             writer");
        CommitOutcome::Committed
    }

    pub fn begin_attach_guard(
        self: &Arc<Self>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        observed_generation: Option<u64>,
        initiator: &str,
    ) -> AttachGuardOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return AttachGuardOutcome::Refused {
                state: OwnershipState::Vacant,
                generation: 0,
            };
        };
        // A lifecycle transition (or a non-Live shape) owns the key —
        // the attach refuses typed; the guard never arms.
        if !matches!(record.state, OwnershipState::Live { .. }) {
            return AttachGuardOutcome::Refused {
                state: record.state.clone(),
                generation: snapshot_generation(record),
            };
        }
        let current_generation = snapshot_generation(record);
        if let Some(observed) = observed_generation {
            if observed < current_generation {
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.attach_guard.stale_generation",
                    operation_id, provider, session_id, initiator,
                    observed_generation = observed,
                    epoch = self.epoch, generation = current_generation,
                    outcome = "refused", failure_reason = "STALE_GENERATION",
                    "the attach's observed generation is stale — the attach \
                     aborts typed (refresh and retry)");
                return AttachGuardOutcome::StaleGeneration {
                    current_epoch: self.epoch,
                    current_generation,
                };
            }
        }
        record.in_flight_attaches = record.in_flight_attaches.saturating_add(1);
        // b8ke ext r32 F1: the armed window is IDENTIFIED — the holder's
        // own late claim exempts itself by naming this id.
        record.armed_attach_ops.push(operation_id.to_string());
        // b8ke ext r15 F3: the arm event joins the UNIFORM transition
        // schema — the LIVE OWNER the guard pins (from_kind + the runtime
        // identity) is the owner a blocked handoff/stop would name, so
        // diagnosing a blocked lifecycle window needs it on the record.
        let (guard_from_kind, guard_runtime_id, guard_pid) = match &record.state {
            OwnershipState::Live { owner, .. } => {
                (Some(owner.kind), owner.terminal_id.clone(), owner.pid)
            }
            _ => (None, None, None),
        };
        tracing::info!(target: "freshell_ownership",
            event = "ownership.attach_guard.armed",
            operation_id, provider, session_id, initiator,
            from_kind = ?guard_from_kind,
            to_kind = ?Option::<RuntimeOwnerKind>::None,
            runtime_id = ?guard_runtime_id, pid = ?guard_pid,
            epoch = self.epoch, generation = current_generation,
            in_flight_attaches = record.in_flight_attaches,
            duration_ms = 0u64,
            outcome = "armed", failure_reason = "",
            "the attach guard is armed — the coordinator covers the attach \
             window; concurrent lifecycle begins answer Blocked");
        AttachGuardOutcome::Armed(Box::new(AttachGuard {
            registry: Arc::clone(self),
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            operation_id: operation_id.to_string(),
            generation: current_generation,
            disarmed: std::sync::atomic::AtomicBool::new(false),
            armed_at_ms: now_epoch_ms(),
            initiator: initiator.to_string(),
        }))
    }

    /// b8ke ext r38 F1: the ATOMIC ADOPT — the guard PRIMITIVE for every
    /// path that starts or restarts a runtime/bridge over an existing
    /// owner. `begin_attach_guard` is a generic window (any Live owner,
    /// an optional generation, no epoch check) — a precheck-then-guard
    /// sequence can observe one owner and arm on ANOTHER (a terminal
    /// handoff committing between the caller's snapshot and the guard
    /// acquisition armed the rollback's guard on the TERMINAL owner and
    /// let it spawn a Fresh Claude sidecar beside the terminal before
    /// the late rekey tore it down). The adopt validates EVERYTHING in
    /// ONE coordinator-lock decision: the observed EPOCH (a different
    /// boot's pair is stale), the observed GENERATION (exactly — the
    /// adopt names the specific record the caller observed; any advance
    /// is a changed world), the owner's KIND (the caller's expectation),
    /// and every identity field the caller supplies (terminal_id /
    /// live_session_key / pid — `None`-valued fields are unchecked, the
    /// caller's honest knowledge boundary). Any mismatch answers the
    /// typed refusal: a kind/identity mismatch as `Refused` carrying the
    /// CURRENT owner (the lane surfaces SESSION_RESERVED + the owner
    /// fields), an epoch/generation mismatch as `StaleGeneration` (the
    /// refresh-and-retry contract). The armed window is the SAME
    /// r32-identified attach window (`in_flight_attaches` +
    /// `armed_attach_ops`), so the holder's late-claim exemption and the
    /// exit-during-guard deferral apply unchanged.
    pub fn begin_adopt_guard(
        self: &Arc<Self>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        expected: &OwnerIdentity,
        observed: ObservedFence,
        initiator: &str,
    ) -> AttachGuardOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        // (1) THE EPOCH — the pair is one fence; a different boot's pair
        // is stale regardless of the generation.
        if observed.epoch != self.epoch {
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.adopt_guard.stale_epoch",
                operation_id, provider, session_id, initiator,
                from_kind = ?Some(expected.kind),
                to_kind = ?Option::<RuntimeOwnerKind>::None,
                runtime_id = ?expected.terminal_id, pid = ?expected.pid,
                observed_epoch = observed.epoch, observed_generation = observed.generation,
                epoch = self.epoch,
                duration_ms = 0u64,
                outcome = "refused", failure_reason = "STALE_EPOCH",
                "the adopt's observed epoch predates this boot — the adopt \
                 refuses typed (refresh and retry)");
            return AttachGuardOutcome::StaleGeneration {
                current_epoch: self.epoch,
                current_generation: 0,
            };
        }
        let Some(record) = inner.get_mut(&key) else {
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.adopt_guard.refused",
                operation_id, provider, session_id, initiator,
                from_kind = ?Some(expected.kind),
                to_kind = ?Option::<RuntimeOwnerKind>::None,
                runtime_id = ?expected.terminal_id, pid = ?expected.pid,
                observed_generation = observed.generation,
                epoch = self.epoch,
                duration_ms = 0u64,
                outcome = "refused", failure_reason = "NOT_LIVE",
                "the adopt's key holds no coordinator record — the adopt \
                 refuses typed");
            return AttachGuardOutcome::Refused {
                state: OwnershipState::Vacant,
                generation: 0,
            };
        };
        // (2) THE STATE — only a Live owner can be adopted.
        let OwnershipState::Live {
            owner: current_owner,
            generation: current_generation,
            ..
        } = record.state.clone()
        else {
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.adopt_guard.refused",
                operation_id, provider, session_id, initiator,
                from_kind = ?Some(expected.kind),
                to_kind = ?Option::<RuntimeOwnerKind>::None,
                runtime_id = ?expected.terminal_id, pid = ?expected.pid,
                observed_generation = observed.generation,
                epoch = self.epoch, generation = snapshot_generation(record),
                duration_ms = 0u64,
                outcome = "refused", failure_reason = "NOT_LIVE",
                "a lifecycle transition (or a non-Live shape) owns the key — \
                 the adopt refuses typed; the guard never arms");
            return AttachGuardOutcome::Refused {
                state: record.state.clone(),
                generation: snapshot_generation(record),
            };
        };
        // (3) THE GENERATION — exactly. The adopt names the SPECIFIC
        // record the caller observed; any advance (a committed handoff
        // bumped it) is a changed world, never the owner the caller
        // decided on.
        if observed.generation != current_generation {
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.adopt_guard.stale_generation",
                operation_id, provider, session_id, initiator,
                from_kind = ?Some(expected.kind),
                to_kind = ?Option::<RuntimeOwnerKind>::None,
                runtime_id = ?expected.terminal_id, pid = ?expected.pid,
                observed_generation = observed.generation,
                epoch = self.epoch, generation = current_generation,
                duration_ms = 0u64,
                outcome = "refused", failure_reason = "STALE_GENERATION",
                "the adopt's observed generation does not name the current \
                 record — ownership advanced between the caller's decision \
                 and the adopt; refresh and retry");
            return AttachGuardOutcome::StaleGeneration {
                current_epoch: self.epoch,
                current_generation,
            };
        }
        // (4) THE EXPECTED OWNER — the kind always; every identity field
        // the caller supplied (a `None`-valued field is the caller's
        // honest "unknown", unchecked).
        let kind_mismatch = current_owner.kind != expected.kind;
        let identity_mismatch = expected
            .terminal_id
            .as_ref()
            .is_some_and(|tid| current_owner.terminal_id.as_ref() != Some(tid))
            || expected
                .live_session_key
                .as_ref()
                .is_some_and(|key| current_owner.live_session_key.as_ref() != Some(key))
            || expected
                .pid
                .is_some_and(|pid| current_owner.pid != Some(pid));
        if kind_mismatch || identity_mismatch {
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.adopt_guard.owner_mismatch",
                operation_id, provider, session_id, initiator,
                from_kind = ?Some(expected.kind),
                to_kind = ?Option::<RuntimeOwnerKind>::None,
                runtime_id = ?expected.terminal_id, pid = ?expected.pid,
                observed_generation = observed.generation,
                epoch = self.epoch, generation = current_generation,
                current_kind = ?current_owner.kind,
                current_runtime_id = ?current_owner.terminal_id,
                current_pid = ?current_owner.pid,
                duration_ms = 0u64,
                outcome = "refused", failure_reason = "OWNER_MISMATCH",
                "the current owner is not the owner the caller observed and \
                 expected — the adopt refuses typed, never arming over a \
                 runtime the caller did not decide on");
            return AttachGuardOutcome::Refused {
                state: record.state.clone(),
                generation: current_generation,
            };
        }
        // (5) ARM — the same identified r32 window.
        record.in_flight_attaches = record.in_flight_attaches.saturating_add(1);
        record.armed_attach_ops.push(operation_id.to_string());
        tracing::info!(target: "freshell_ownership",
            event = "ownership.adopt_guard.armed",
            operation_id, provider, session_id, initiator,
            from_kind = ?Some(expected.kind),
            to_kind = ?Option::<RuntimeOwnerKind>::None,
            runtime_id = ?current_owner.terminal_id, pid = ?current_owner.pid,
            epoch = self.epoch, generation = current_generation,
            in_flight_attaches = record.in_flight_attaches,
            duration_ms = 0u64,
            outcome = "armed", failure_reason = "",
            "the ATOMIC adopt armed — the observed fence and the expected \
             owner validated in ONE coordinator-lock decision; the window \
             covers the adopt through completion and concurrent lifecycle \
             begins answer Blocked");
        AttachGuardOutcome::Armed(Box::new(AttachGuard {
            registry: Arc::clone(self),
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            operation_id: operation_id.to_string(),
            generation: current_generation,
            disarmed: std::sync::atomic::AtomicBool::new(false),
            armed_at_ms: now_epoch_ms(),
            initiator: initiator.to_string(),
        }))
    }

    /// b8ke ext r17 F1: the ATOMIC acknowledged start — the ONE-lock-hold
    /// conditional transition `Fenced{ClearedUnverified} → Handoff` with
    /// the acknowledged-risk arm carried INTO the claim. Pre-r17 the
    /// acknowledged start was two steps (a plain-Vacant vacate, then
    /// `begin_handoff` reacquiring the lock and PANICKING on refusal): a
    /// concurrent cross-device lifecycle request could claim the vacancy
    /// between the calls — including an UNACKNOWLEDGED request consuming
    /// the opening another client's acknowledgment created — and the
    /// losing original panicked (its caller saw the fallback in-progress
    /// lie). Here the record either enters Handoff under this claim or
    /// the caller answers typed; the unverified prior is encoded in the
    /// transition log (the operator's acknowledgment recorded AT THE
    /// START).
    /// b8ke ext r33 F1: the entered handoff CARRIES THE UNVERIFIED PRIOR
    /// as its reap target — the FORCED-REAP-THEN-START contract: the
    /// runner kills and confirms the prior's death (the descendant tree
    /// included) before the new writer spawns, and an unconfirmable kill
    /// lands the SAME typed fenced family again. Pre-r33 the enter
    /// discarded the prior (`prior: None`) and the runner started a
    /// SECOND writer over a possibly-live first one — the acknowledged
    /// risk broke the max-one-writer invariant.
    #[allow(clippy::too_many_arguments)] // begin_handoff's field set + the acknowledgment context.
    pub fn begin_handoff_acknowledged_cleared_unverified(
        &self,
        provider: &str,
        session_id: &str,
        to_kind: RuntimeOwnerKind,
        operation_id: &str,
        observed: ObservedFence,
        initiator: &str,
        now_ms: u64,
    ) -> AcknowledgedStartOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        // The fence check BEFORE the record is read (begin_handoff's
        // discipline): a stale pair refuses without touching anything.
        let Some(record) = inner.get_mut(&key) else {
            return AcknowledgedStartOutcome::LostRace {
                state: OwnershipState::Vacant,
            };
        };
        let current_generation = snapshot_generation(record);
        if observed.epoch != self.epoch || observed.generation != current_generation {
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.handoff.acknowledged_start.stale_observation",
                operation_id, provider, session_id, initiator,
                from_kind = ?Option::<RuntimeOwnerKind>::None,
                to_kind = ?Some(to_kind),
                runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                observed_epoch = observed.epoch, observed_generation = observed.generation,
                epoch = self.epoch, generation = current_generation,
                duration_ms = 0u64,
                outcome = "refused", failure_reason = "STALE_OBSERVATION",
                "the acknowledged start observed a stale fence pair — refresh and retry");
            return AcknowledgedStartOutcome::StaleObservation {
                current_epoch: self.epoch,
                current_generation,
            };
        }
        // The conditional transition: ONLY the cleared-unverified state
        // enters, atomically.
        match record.state.clone() {
            OwnershipState::Fenced {
                reason: reason @ FenceReason::ClearedUnverified,
                prior,
                operation_id: fencing_operation_id,
                since_ms,
                ..
            } => {
                let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                let unverified_kind = prior.as_ref().map(|(o, _)| o.kind);
                let unverified_id = prior.as_ref().and_then(|(o, _)| o.terminal_id.clone());
                let unverified_pid = prior.as_ref().and_then(|(o, _)| o.pid);
                let unverified_live_key =
                    prior.as_ref().and_then(|(o, _)| o.live_session_key.clone());
                // b8ke ext r33 F1: FORCED-REAP-THEN-START — the enter
                // carries the UNVERIFIED PRIOR (and through the runner's
                // tree-kill, its potentially-surviving descendants) as
                // the handoff's REAP TARGET: the runner's step 3+4 kills
                // and confirms the prior's death BEFORE the new writer
                // spawns, and an UNCONFIRMABLE kill lands the SAME typed
                // fenced family again (PlatformLimited through the
                // runner's fence path — the operator's acknowledged
                // retry can attempt the kill again, so the fence stays
                // non-permanent) — the acknowledged path can make
                // progress (it kills) but a provably-alive writer is
                // never overlapped. Pre-r33 the enter discarded the
                // prior (`prior: None` — the no-prior sequence) and
                // started a second writer over a possibly-live first
                // one: the acknowledgment recorded the risk but broke
                // the max-one-writer invariant.
                record.generation += 1;
                record.state = OwnershipState::Handoff {
                    prior: prior.clone(),
                    to_kind,
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    initiator: initiator.to_string(),
                    since_ms: now_ms,
                };
                let entered_generation = record.generation;
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.handoff.acknowledged_start.entered",
                    operation_id, provider, session_id, initiator,
                    from_kind = ?unverified_kind,
                    to_kind = ?Some(to_kind),
                    runtime_id = ?unverified_id, pid = ?unverified_pid,
                    live_session_key = ?unverified_live_key,
                    epoch = self.epoch, generation = entered_generation, duration_ms,
                    fence_reason = ?reason,
                    fencing_operation_id = %fencing_operation_id,
                    outcome = "acknowledged_start_entered",
                    failure_reason = "UNVERIFIED_PRIOR_ACKNOWLEDGED",
                    "the operator's acknowledged-risk start entered Handoff \
                     ATOMICALLY over the cleared-unverified state carrying the \
                     UNVERIFIED PRIOR as the reap target — the runner kills and \
                     confirms the prior's death (the descendant tree included) \
                     BEFORE the new writer spawns; an unconfirmable kill lands \
                     the typed fenced state again, never a second writer");
                AcknowledgedStartOutcome::Granted {
                    generation: entered_generation,
                }
            }
            // Any other state — a concurrent claim's Handoff, a confirmed
            // death's Vacant, a foreign fence — is the typed lost race.
            state => AcknowledgedStartOutcome::LostRace { state },
        }
    }

    #[allow(clippy::too_many_arguments)] // The plan-frozen coordinator surface (Tasks 3-10 consume it).
    pub fn begin_handoff(
        &self,
        provider: &str,
        session_id: &str,
        to_kind: RuntimeOwnerKind,
        operation_id: &str,
        observed: Option<ObservedFence>,
        initiator: &str,
        now_ms: u64,
    ) -> BeginOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        // Fence check BEFORE creating the record (same discipline as
        // begin_start: a stale request creates nothing).
        if let Some(fence) = observed {
            // The coherent fence baseline (M3-R): the same value a
            // snapshot-derived fence carries, so refreshing from
            // observe()/snapshot_records() converges on restored keys.
            let current_generation = inner.get(&key).map_or(0, snapshot_generation);
            if fence.epoch != self.epoch || fence.generation < current_generation {
                // b8ke ext r7 F4: the UNIFORM transition schema.
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.begin_handoff.stale_generation",
                    operation_id, provider, session_id, initiator,
                    from_kind = ?Option::<RuntimeOwnerKind>::None,
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                    observed_epoch = fence.epoch, observed_generation = fence.generation,
                    epoch = self.epoch, generation = current_generation,
                    duration_ms = 0u64,
                    outcome = "refused", failure_reason = "STALE_GENERATION");
                return BeginOutcome::StaleGeneration {
                    current_epoch: self.epoch,
                    current_generation,
                };
            }
        }
        let record = inner.entry(key).or_default();
        match record.state.clone() {
            // b8ke focused episode-2 round-3 F3: as begin_start — a
            // superseded id refuses typed; resolve to the canonical key.
            OwnershipState::Aliased { to, generation } => {
                // b8ke ext r7 F4: the UNIFORM transition schema.
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.handoff.on_aliased_key",
                    operation_id, provider, session_id,
                    from_kind = ?Option::<RuntimeOwnerKind>::None,
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                    aliased_to = %to, epoch = self.epoch, generation,
                    duration_ms = 0u64,
                    outcome = "refused", failure_reason = "REKEYED_ALIAS_KEY");
                BeginOutcome::Blocked {
                    state: OwnershipState::Aliased { to, generation },
                    retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
                }
            }
            OwnershipState::Vacant => {
                // b8ke ext r32 F1: the same exit-during-guard race as
                // begin_start's Vacant arm — an incumbent that exited
                // while an attach/create guard is in flight left the
                // record Vacant with the guard count still riding it;
                // the handoff answers the SAME typed Blocked outcome
                // the Live branch (r12 F2) gives, so a competing
                // cross-kind operation never acquires the coordinator
                // through the vacated key while the guarded create
                // holds continuous authority. The deferral lands when
                // the last guard resolves.
                if record.in_flight_attaches > 0 {
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.handoff.blocked_by_attach_guard",
                        operation_id, provider, session_id, initiator,
                        from_kind = ?Option::<RuntimeOwnerKind>::None,
                        to_kind = ?Some(to_kind),
                        runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                        epoch = self.epoch, generation = record.generation,
                        duration_ms = 0u64,
                        outcome = "refused", failure_reason = "ATTACH_IN_FLIGHT",
                        "the incumbent exited but an in-flight attach still holds \
                         the key's coordinator window — the handoff retries after \
                         the attach completes");
                    return BeginOutcome::Blocked {
                        state: record.state.clone(),
                        retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
                    };
                }
                record.generation += 1;
                record.state = OwnershipState::Handoff {
                    prior: None,
                    to_kind,
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    initiator: initiator.to_string(),
                    since_ms: now_ms,
                };
                // b8ke ext F3: the STABLE transition-log schema (the
                // vacated-key handoff begin: the from-side is None-valued).
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.handoff.begin", operation_id, provider, session_id,
                    initiator,
                    from_kind = ?Option::<RuntimeOwnerKind>::None, to_kind = ?to_kind,
                    runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                    epoch = self.epoch, generation = record.generation,
                    duration_ms = 0u64, outcome = "granted", failure_reason = "");
                BeginOutcome::Granted {
                    generation: record.generation,
                }
            }
            // A thread a unit holds as an EXTRA (a helper, fork parent or
            // earlier conversation its agent process has loaded) is never
            // switched away: stopping the holder would kill the pane that
            // displays a different conversation. The caller jumps to the
            // holder instead (Decision 1); nothing changes here.
            OwnershipState::Live {
                owner, generation, ..
            } if owner.hold == HoldKind::Extra => {
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.handoff.extra_hold_adopt",
                    operation_id, provider, session_id, initiator,
                    from_kind = ?Some(owner.kind), to_kind = ?Some(to_kind),
                    runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                    epoch = self.epoch, generation,
                    duration_ms = 0u64,
                    outcome = "adopt-live", failure_reason = "",
                    unit_id = owner.unit_id.as_deref().unwrap_or(""),
                    terminal_id = owner.terminal_id.as_deref().unwrap_or(""),
                    "the key is held as an extra thread by a running unit — the \
                     switch adopts the holder and never stops it");
                BeginOutcome::AdoptLive { owner, generation }
            }
            OwnershipState::Live {
                owner,
                generation,
                since_ms,
            } => {
                // b8ke ext r12 F2: an in-flight ATTACH guard owns the key's
                // window — the handoff answers the typed Blocked outcome
                // (retryable), never interleaving with the attach's
                // restamp/register/bridge-restart work.
                if record.in_flight_attaches > 0 {
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.handoff.blocked_by_attach_guard",
                        operation_id, provider, session_id, initiator,
                        from_kind = ?Some(owner.kind),
                        to_kind = ?Some(to_kind),
                        runtime_id = ?owner.terminal_id.clone(), pid = ?owner.pid,
                        epoch = self.epoch, generation,
                        duration_ms = 0u64,
                        outcome = "refused", failure_reason = "ATTACH_IN_FLIGHT",
                        "an in-flight attach holds the key's coordinator window — \
                         the handoff retries after the attach completes");
                    return BeginOutcome::Blocked {
                        state: record.state.clone(),
                        retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
                    };
                }
                let prior = (owner.clone(), generation);
                // b8ke ext r6 F5: the prior owner's REAL tenure — computed
                // BEFORE the state replacement (pre-r6 the log read the
                // just-replaced Handoff state's own timestamp, so the
                // duration was always zero).
                let prior_tenure_ms = now_ms.saturating_sub(since_ms);
                record.generation += 1;
                record.state = OwnershipState::Handoff {
                    prior: Some(prior),
                    to_kind,
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    initiator: initiator.to_string(),
                    since_ms: now_ms,
                };
                // b8ke ext F3: the STABLE transition-log schema — the live
                // begin carries the prior owner's tenure (duration_ms) and
                // the empty (not-applicable) failure reason alongside the
                // prior's identity fields.
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.handoff.begin", operation_id, provider, session_id,
                    initiator, from_kind = ?owner.kind, to_kind = ?to_kind,
                    runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                    epoch = self.epoch, generation = record.generation,
                    duration_ms = prior_tenure_ms,
                    outcome = "granted", failure_reason = "");
                BeginOutcome::Granted {
                    generation: record.generation,
                }
            }
            state => BeginOutcome::Blocked {
                state,
                retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
            },
        }
    }

    /// Commit a live runtime. Legal from this operation's `Starting`, or
    /// from this operation's `Handoff` (the target writer commit —
    /// generation retained; the handoff runner is the SINGLE commit
    /// authority, round-1 review: target paths invoked under-ticket skip
    /// their own commit). A stale generation commits nothing: the caller
    /// must tear down its own child. Stamps `ownership_id` from the
    /// committing operation (the release fence key) when the caller left
    /// it `None`.
    pub fn commit_live(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        mut owner: OwnerIdentity,
    ) -> CommitOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return CommitOutcome::ForeignOperation;
        };
        if generation != record.generation {
            // A stale-generation commit is a typed, anticipated race
            // outcome (the delayed caller tears down its own child) —
            // warn on the crate's diagnostic target; error!/invariant is
            // reserved for genuine contract violations (e.g.
            // force_release during Handoff below).
            // b8ke ext r7 F4: the UNIFORM transition schema.
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.commit_live.stale_generation",
                operation_id, provider, session_id,
                from_kind = ?Option::<RuntimeOwnerKind>::None,
                to_kind = ?Option::<RuntimeOwnerKind>::None,
                runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                epoch = self.epoch, generation, current_generation = record.generation,
                duration_ms = 0u64,
                outcome = "refused", failure_reason = "STALE_GENERATION");
            return CommitOutcome::StaleGeneration {
                current_generation: record.generation,
            };
        }
        let initiator = record.state.initiator().unwrap_or_default();
        // b8ke ext F3: the TRUE prior kind — for a Handoff record the
        // PRE-HANDOFF owner (the Handoff-prior identity), NOT the
        // Handoff's TARGET kind: `kind()` maps Handoff to its target, so a
        // fresh-agent→terminal commit logged as terminal-to-terminal. A
        // vacant-entered handoff has no prior owner (None — the honest
        // vacancy); a Starting record's prior kind is the operation's own
        // kind.
        let old_kind = match &record.state {
            OwnershipState::Handoff { prior, .. } => prior.as_ref().map(|(owner, _)| owner.kind),
            other => other.kind(),
        };
        let since_ms = record.state.since_ms();
        match record.state.clone() {
            OwnershipState::Starting {
                operation_id: op, ..
            } if op == operation_id => {}
            OwnershipState::Handoff {
                operation_id: op,
                to_kind,
                ..
            } if op == operation_id && to_kind == owner.kind => {}
            _ => return CommitOutcome::ForeignOperation,
        }
        if owner.ownership_id.is_none() {
            owner.ownership_id = Some(operation_id.to_string());
        }
        let duration_ms = since_ms
            .map(|s| now_epoch_ms().saturating_sub(s))
            .unwrap_or(0);
        record.state = OwnershipState::Live {
            owner: owner.clone(),
            generation,
            since_ms: now_epoch_ms(),
        };
        tracing::info!(target: "freshell_ownership",
            event = "ownership.live.commit", operation_id, provider, session_id,
            initiator, from_kind = ?old_kind, to_kind = ?owner.kind,
            runtime_id = ?owner.terminal_id,
            live_session_key = ?owner.live_session_key, pid = ?owner.pid,
            // b8ke ext r6 F5: the STABLE schema — the empty
            // (not-applicable) failure_reason on the success transition.
            epoch = self.epoch, generation, duration_ms, outcome = "committed",
            failure_reason = "");
        CommitOutcome::Committed
    }

    /// b8ke focused episode-2 round-2 F1: atomically RE-KEY a live claim —
    /// commit the start's `Starting{op}` record under a NEW canonical
    /// session id while vacating the old key, in ONE lock scope (never
    /// both-Live, never both-Vacant; no window in which either key holds a
    /// half-committed record). The claude rollback's fork re-key uses this
    /// to move ownership to the durable id the CLIENT now sees (the
    /// materialization replaced the pane's sessionRef) — one source of
    /// truth: every later lifecycle operation on the new id finds the
    /// owner; the old key replays Vacant so stale divergence clears.
    ///
    /// Refused typed exactly like [`Self::commit_live`]: a foreign record
    /// under either key, or a stale generation, is the caller's
    /// teardown path — never a partial move.
    pub fn commit_live_rekey(
        &self,
        provider: &str,
        old_session_id: &str,
        new_session_id: &str,
        operation_id: &str,
        generation: u64,
        mut owner: OwnerIdentity,
    ) -> CommitOutcome {
        let mut inner = self.lock_records();
        let old_key = SessionKey::new(provider, old_session_id);
        // Validation pass (immutable reads — the mutation below cannot
        // interleave with any of these checks).
        let initiator;
        let since_ms;
        {
            let Some(record) = inner.get(&old_key) else {
                return CommitOutcome::ForeignOperation;
            };
            if generation != record.generation {
                // b8ke ext r7 F4: the UNIFORM transition schema.
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.commit_live_rekey.stale_generation",
                    operation_id, provider,
                    old_session_id, new_session_id,
                    from_kind = ?Option::<RuntimeOwnerKind>::None,
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                    epoch = self.epoch, generation, current_generation = record.generation,
                    duration_ms = 0u64,
                    outcome = "refused", failure_reason = "STALE_GENERATION");
                return CommitOutcome::StaleGeneration {
                    current_generation: record.generation,
                };
            }
            initiator = record.state.initiator().unwrap_or_default();
            since_ms = record.state.since_ms();
            match &record.state {
                OwnershipState::Starting {
                    operation_id: op, ..
                } if op == operation_id => {}
                _ => return CommitOutcome::ForeignOperation,
            }
            // A record already present under the NEW key means a competitor
            // claimed the client-visible id in the claim window — the typed
            // refusal; the caller tears its runtime down. Never overwrite.
            if inner
                .get(&SessionKey::new(provider, new_session_id))
                .is_some()
            {
                // b8ke ext r7 F4: the UNIFORM transition schema.
                tracing::error!(target: "invariant",
                    event = "ownership.commit_live_rekey.target_occupied",
                    operation_id, provider, old_session_id, new_session_id,
                    from_kind = ?Option::<RuntimeOwnerKind>::None,
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                    epoch = self.epoch, generation,
                    duration_ms = 0u64,
                    outcome = "refused", failure_reason = "FOREIGN_TARGET_KEY");
                return CommitOutcome::ForeignOperation;
            }
        }
        if owner.ownership_id.is_none() {
            owner.ownership_id = Some(operation_id.to_string());
        }
        // THE MOVE (still one lock scope): old key → Aliased{to: new} (the
        // coordinator's own old→new resolution record), new key →
        // Live{owner} at the same generation.
        let new_key = SessionKey::new(provider, new_session_id);
        let new_record = SessionRecord {
            generation,
            state: OwnershipState::Live {
                owner: owner.clone(),
                generation,
                since_ms: now_epoch_ms(),
            },
            ..SessionRecord::default()
        };
        let duration_ms = since_ms
            .map(|start| now_epoch_ms().saturating_sub(start))
            .unwrap_or(0);
        if let Some(record) = inner.get_mut(&old_key) {
            record.state = OwnershipState::Aliased {
                to: new_session_id.to_string(),
                generation,
            };
        }
        inner.insert(new_key, new_record);
        tracing::info!(target: "freshell_ownership",
            event = "ownership.live.commit_rekey", operation_id, provider,
            old_session_id, new_session_id,
            initiator, from_kind = ?owner.kind,
            to_kind = ?owner.kind,
            runtime_id = ?owner.terminal_id,
            live_session_key = ?owner.live_session_key, pid = ?owner.pid,
            // b8ke ext r7 F4: the UNIFORM transition schema — the empty
            // (not-applicable) failure_reason on the success transition.
            epoch = self.epoch, generation, duration_ms,
            outcome = "rekeyed_committed", failure_reason = "",
            "the start's record moved to the client-visible durable id in one \
             atomic step — the old key is Aliased, the new key is Live");
        CommitOutcome::Committed
    }

    /// b8ke ext r22 F1: re-key an IN-FLIGHT `Starting` record from the
    /// pane-scoped provisional identity to the freshly minted canonical
    /// session id — the fresh-create lane's mint-time step. The claim
    /// (`operation_id`, `generation`, kind, initiator) is PRESERVED under
    /// the new key (the ticket survives via
    /// [`OperationTicket::rekey_session_id`]), so the holder's existing
    /// registration-tail `commit_live` completes under the canonical key
    /// exactly as if the claim had been made there — while the canonical
    /// key is coordinator-owned from the MINT onward (the pre-mint spawn
    /// window is owned by the provisional record). The provisional key
    /// becomes `Aliased{to: new}` — the rekey family's old-key resolution
    /// record (a duplicate create for the same pane-scoped id resolves to
    /// the canonical owner and answers typed).
    ///
    /// A record already present under the NEW key means a competitor
    /// claimed the freshly discoverable minted id in the claim window —
    /// the typed refusal (FOREIGN_TARGET_KEY); NOTHING moves and the
    /// caller tears its minted runtime down. Never two writers, never an
    /// overwrite.
    pub fn rekey_starting(
        &self,
        provider: &str,
        old_session_id: &str,
        new_session_id: &str,
        operation_id: &str,
        generation: u64,
    ) -> CommitOutcome {
        let mut inner = self.lock_records();
        let old_key = SessionKey::new(provider, old_session_id);
        // Validation pass (immutable reads — the mutation below cannot
        // interleave with any of these checks).
        let (initiator, since_ms) = {
            let Some(record) = inner.get(&old_key) else {
                tracing::error!(target: "invariant",
                    event = "ownership.rekey_starting.old_claim_missing",
                    operation_id, provider, old_session_id, new_session_id,
                    from_kind = ?Option::<RuntimeOwnerKind>::None,
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                    epoch = self.epoch, generation,
                    duration_ms = 0u64,
                    outcome = "refused", failure_reason = "FOREIGN_OLD_CLAIM",
                    "the provisional key holds no record — nothing moves");
                return CommitOutcome::ForeignOperation;
            };
            if generation != record.generation {
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.rekey_starting.stale_generation",
                    operation_id, provider, old_session_id, new_session_id,
                    from_kind = ?Option::<RuntimeOwnerKind>::None,
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                    epoch = self.epoch, generation, current_generation = record.generation,
                    duration_ms = 0u64,
                    outcome = "refused", failure_reason = "STALE_GENERATION");
                return CommitOutcome::StaleGeneration {
                    current_generation: record.generation,
                };
            }
            match &record.state {
                OwnershipState::Starting {
                    operation_id: op,
                    initiator,
                    since_ms,
                    ..
                } if op == operation_id => (initiator.clone(), *since_ms),
                _ => {
                    tracing::error!(target: "invariant",
                        event = "ownership.rekey_starting.old_claim_mismatch",
                        operation_id, provider, old_session_id, new_session_id,
                        from_kind = ?Option::<RuntimeOwnerKind>::None,
                        to_kind = ?Option::<RuntimeOwnerKind>::None,
                        runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                        epoch = self.epoch, generation,
                        duration_ms = 0u64,
                        outcome = "refused", failure_reason = "FOREIGN_OLD_CLAIM",
                        "the provisional key is not Starting under this operation — \
                         nothing moves");
                    return CommitOutcome::ForeignOperation;
                }
            }
        };
        // A record already present under the NEW key — the minted-key-lost
        // race. The typed refusal; the caller tears its runtime down.
        if inner
            .get(&SessionKey::new(provider, new_session_id))
            .is_some()
        {
            tracing::error!(target: "invariant",
                event = "ownership.rekey_starting.target_occupied",
                operation_id, provider, old_session_id, new_session_id,
                from_kind = ?Option::<RuntimeOwnerKind>::None,
                to_kind = ?Option::<RuntimeOwnerKind>::None,
                runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                epoch = self.epoch, generation,
                duration_ms = 0u64,
                outcome = "refused", failure_reason = "FOREIGN_TARGET_KEY",
                "a competitor claimed the minted canonical id in the claim window — \
                 the rekey refuses typed and the caller tears its runtime down");
            return CommitOutcome::ForeignOperation;
        }
        // THE MOVE (one lock scope): the provisional key → Aliased{to: new}
        // (the rekey family's old-key resolution record); the new key →
        // the SAME record — the validated Starting state (operation id,
        // generation, kind, initiator, since) moves untouched, and with it
        // EVERY in-flight witness the operation registered on the
        // provisional key (b8ke ext r22 F1's partial_runtime — the
        // watchdog's cancel/reap target; b8ke ext r26 F1's cancellation,
        // settle, settle_fired — the stale-start sweep's live-handler
        // evidence). Rebuilding the record from `SessionRecord::default()`
        // here would strand a post-rekey registration as UNWITNESSED: the
        // sweep fences over-age unwitnessed starts, and OpenCode's
        // 50-70s cold start routinely outlives the 30s sweep age while its
        // durable binding/registration/commit are still running.
        let new_key = SessionKey::new(provider, new_session_id);
        let moved_record = {
            let record = inner
                .get_mut(&old_key)
                .expect("validated above — the registry lock is held throughout");
            let moved = std::mem::take(record);
            record.generation = moved.generation;
            record.state = OwnershipState::Aliased {
                to: new_session_id.to_string(),
                generation,
            };
            moved
        };
        inner.insert(new_key, moved_record);
        tracing::info!(target: "freshell_ownership",
            event = "ownership.start.rekey", operation_id, provider,
            old_session_id, new_session_id,
            initiator,
            from_kind = ?Option::<RuntimeOwnerKind>::None,
            to_kind = ?Option::<RuntimeOwnerKind>::None,
            runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
            epoch = self.epoch, generation,
            duration_ms = now_epoch_ms().saturating_sub(since_ms),
            outcome = "rekeyed_starting", failure_reason = "",
            "the fresh create's in-flight start moved to the minted canonical id in \
             one atomic step — the provisional key is Aliased, the canonical key is \
             the operation's Starting record");
        CommitOutcome::Committed
    }

    /// b8ke focused episode-2 round-3 F1: re-key an ALREADY-LIVE record —
    /// the normal Claude rollback shape whose lane claim observes the
    /// existing `Live{FreshAgent}` owner and answers Adopt with NO ticket.
    /// The coordinator record (and its writer identity) moves old→new in
    /// ONE atomic registry step: never both-Live, never both-Vacant; the
    /// old key becomes `Aliased{to: new}` (the registry's own resolution
    /// record). A record already present under the NEW key refuses typed —
    /// never an overwrite. Full transition schema (finding 8): from_kind,
    /// to_kind, runtime id/pid, duration.
    #[allow(clippy::too_many_arguments)] // the rekey field set (expected identity + replacement owner)
    pub fn rekey_live(
        &self,
        provider: &str,
        old_session_id: &str,
        new_session_id: &str,
        expected_live_session_key: &str,
        new_owner: OwnerIdentity,
        initiator: &str,
        // b8ke ext r6 F5: the rekey transition's operation id — the
        // uniform schema's operation_id (the caller's rekey operation).
        operation_id: &str,
    ) -> CommitOutcome {
        let mut inner = self.lock_records();
        let old_key = SessionKey::new(provider, old_session_id);
        // b8ke focused episode-2 post-cap F1: EXPECTED-OWNER VERIFICATION.
        // The move happens ONLY for the lane's own runtime — the old record
        // must be Live, held by this lane's kind, keyed by THIS session's
        // map key. A terminal handoff that committed inside the rollback
        // window (a different owner identity or kind) refuses typed; the
        // caller tears down. The old owner's dead pid is NEVER carried: the
        // caller supplies the REPLACEMENT runtime's identity (the current
        // sidecar pid + ONE consistent operation id that the retained
        // stamp reuses, so exit/crash release matches).
        let (old_owner, since_ms) = {
            let Some(record) = inner.get(&old_key) else {
                return CommitOutcome::ForeignOperation;
            };
            match record.state.clone() {
                OwnershipState::Live {
                    owner, since_ms, ..
                } => {
                    if owner.kind != new_owner.kind
                        || owner.live_session_key.as_deref() != Some(expected_live_session_key)
                    {
                        // b8ke ext r7 F4: the UNIFORM transition schema.
                        tracing::error!(target: "invariant",
                            event = "ownership.rekey_live.expected_owner_mismatch",
                            provider, old_session_id, new_session_id,
                            expected_live_session_key,
                            observed_kind = ?owner.kind,
                            observed_live_session_key = ?owner.live_session_key,
                            from_kind = ?owner.kind,
                            to_kind = ?Option::<RuntimeOwnerKind>::None,
                            runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                            epoch = self.epoch,
                            duration_ms = 0u64,
                            outcome = "refused",
                            failure_reason = "FOREIGN_LIVE_OWNER");
                        return CommitOutcome::ForeignOperation;
                    }
                    (owner, since_ms)
                }
                _ => return CommitOutcome::ForeignOperation,
            }
        };
        if inner.contains_key(&SessionKey::new(provider, new_session_id)) {
            // b8ke ext r7 F4: the UNIFORM transition schema.
            tracing::error!(target: "invariant",
                event = "ownership.rekey_live.target_occupied",
                provider, old_session_id, new_session_id,
                from_kind = ?Option::<RuntimeOwnerKind>::None,
                to_kind = ?Option::<RuntimeOwnerKind>::None,
                runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                epoch = self.epoch,
                duration_ms = 0u64,
                outcome = "refused", failure_reason = "FOREIGN_TARGET_KEY");
            return CommitOutcome::ForeignOperation;
        }
        // b8ke F1: the rekey is a GENERATION-INCREMENTING transition — the
        // moved record's generation is one past the old Live era's, so a
        // concurrent stale-generation observer is refused by arithmetic,
        // not luck.
        let duration_ms = now_epoch_ms().saturating_sub(since_ms);
        let old_generation = inner.get(&old_key).map(|r| r.generation).unwrap_or(0);
        let new_generation = old_generation + 1;
        if let Some(record) = inner.get_mut(&old_key) {
            record.generation = new_generation;
            record.state = OwnershipState::Aliased {
                to: new_session_id.to_string(),
                generation: new_generation,
            };
        }
        let new_key = SessionKey::new(provider, new_session_id);
        let new_record = SessionRecord {
            generation: new_generation,
            state: OwnershipState::Live {
                owner: new_owner.clone(),
                generation: new_generation,
                since_ms: now_epoch_ms(),
            },
            ..SessionRecord::default()
        };
        inner.insert(new_key, new_record);
        // b8ke ext r6 F5: the STABLE transition-log schema — the rekey
        // event carries the operation id and the empty (not-applicable)
        // failure_reason (pre-r6 both were omitted).
        tracing::info!(target: "freshell_ownership",
            event = "ownership.live.rekey_live", operation_id, provider,
            old_session_id, new_session_id, initiator,
            from_kind = ?old_owner.kind, to_kind = ?new_owner.kind,
            runtime_id = ?new_owner.terminal_id,
            live_session_key = ?new_owner.live_session_key, pid = ?new_owner.pid,
            epoch = self.epoch, generation = new_generation, duration_ms,
            outcome = "rekeyed_committed", failure_reason = "",
            "the LIVE record moved to the client-visible durable id in one \
             atomic step — expected-owner verified, generation incremented, \
             the old key is Aliased, the new key carries the REPLACEMENT identity");
        CommitOutcome::Committed
    }

    /// b8ke focused episode-2 round-3 F3: resolve a wire session id to its
    /// CANONICAL coordinator key — the id itself, unless its record is
    /// `Aliased` (the durable re-key residue the coordinator itself
    /// owns). Walked to the FIXPOINT — never a bounded link cap — with a
    /// visited guard so a corrupt cycle terminates at the first repeat.
    pub fn resolve_canonical(&self, provider: &str, session_id: &str) -> String {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        let mut current = session_id.to_string();
        let mut visited = std::collections::HashSet::new();
        loop {
            if !visited.insert(current.clone()) {
                break;
            }
            let aliased_to = match inner.get(&SessionKey::new(provider, &current)) {
                Some(record) => match &record.state {
                    OwnershipState::Aliased { to, .. } => Some(to.clone()),
                    _ => None,
                },
                None => None,
            };
            match aliased_to {
                Some(next) => current = next,
                None => break,
            }
        }
        current
    }

    /// b8ke ext r23 F1: create an `Aliased{to}` resolution record for a
    /// key that NEVER held a coordinator presence — the OpenCode
    /// placeholder→durable materialization's alias (the `freshopencode-*`
    /// pane identity is not a runtime id; the durable `ses_*` key holds the
    /// actual owner). The placeholder's alias record carries the DURABLE
    /// key's current generation so the fence arithmetic stays coherent.
    /// An already-occupied key refuses typed (never overwrite an existing
    /// record — a prior alias or a real owner is never clobbered); a
    /// missing target key's record also refuses (the alias must point at
    /// a real owner).
    pub fn alias_vacant_key(
        &self,
        provider: &str,
        from_session_id: &str,
        to_session_id: &str,
        operation_id: &str,
        initiator: &str,
    ) -> CommitOutcome {
        let mut inner = self.lock_records();
        let from_key = SessionKey::new(provider, from_session_id);
        let to_key = SessionKey::new(provider, to_session_id);
        // The FROM key must be truly vacant (no record, or an existing
        // Vacant record with no state identity): never overwrite a prior
        // alias or any live/transitioning state.
        if let Some(record) = inner.get(&from_key) {
            let _ = record;
            tracing::warn!(target: "freshell_ownership",
                provider = %provider, from_session_id, to_session_id,
                epoch = self.epoch,
                duration_ms = 0u64,
                outcome = "refused", failure_reason = "FOREIGN_FROM_KEY",
                "alias_vacant_key: the from key already holds a coordinator \
                 record — never clobber an existing identity");
            return CommitOutcome::ForeignOperation;
        }
        // The TO key must hold a record (the alias must resolve to a real
        // owner — pointing at nothing is a dead-end alias).
        let Some(to_record) = inner.get(&to_key) else {
            tracing::warn!(target: "freshell_ownership",
                provider = %provider, from_session_id, to_session_id,
                epoch = self.epoch,
                duration_ms = 0u64,
                outcome = "refused", failure_reason = "FOREIGN_TARGET_KEY",
                "alias_vacant_key: the target key holds no coordinator record \
                 — the alias must point at a real owner");
            return CommitOutcome::ForeignOperation;
        };
        let target_generation = to_record.generation;
        // b8ke ext r33 F3: the ALIAS mutation joins the UNIFORM
        // coordinator log schema — the full required field set
        // (operation_id, the target's runtime kind/id/pid where known —
        // the placeholder's own side is None-valued, no runtime ever
        // existed under it), so the OpenCode placeholder→durable identity
        // transition is correlatable like every other coordinator
        // mutation. Pre-r33 the event omitted all of them.
        let (target_kind, target_terminal_id, target_pid) = match &to_record.state {
            OwnershipState::Live { owner, .. } => {
                (Some(owner.kind), owner.terminal_id.clone(), owner.pid)
            }
            OwnershipState::Starting { kind, .. } => (Some(*kind), None, None),
            OwnershipState::Handoff { to_kind, .. } => (Some(*to_kind), None, None),
            _ => (None, None, None),
        };
        inner.insert(
            from_key,
            SessionRecord {
                generation: target_generation,
                state: OwnershipState::Aliased {
                    to: to_session_id.to_string(),
                    generation: target_generation,
                },
                ..SessionRecord::default()
            },
        );
        tracing::info!(target: "freshell_ownership",
            event = "ownership.key.alias_vacant", provider,
            from_session_id, to_session_id, initiator, operation_id,
            from_kind = ?Option::<RuntimeOwnerKind>::None,
            to_kind = ?target_kind,
            runtime_id = ?target_terminal_id, pid = ?target_pid,
            epoch = self.epoch, generation = target_generation,
            duration_ms = 0u64,
            outcome = "aliased", failure_reason = "",
            "a placeholder identity becomes a coordinator alias — the wire id \
             resolves to the durable key through the canonical chain");
        CommitOutcome::Committed
    }

    /// Fail an in-flight operation: `Starting` → Vacant; `Handoff` → restore
    /// the prior owner ONLY when the caller confirms it is still live
    /// (`prior_confirmed_live: true`) — restored at the RECORD's CURRENT
    /// (handoff-bumped) generation, a FORWARD bump of the Live state that
    /// never rolls the record's monotonic counter back, so every fence
    /// family converges on one value: the handoff broadcasts the clients'
    /// monotonic folds hold (they cannot regress), the wire pairs those
    /// clients send, and the lane stamps/claims the host repairs
    /// (whole-branch review M-1 — a restored Live state at the prior's
    /// ORIGINAL generation wedged every wire-fenced kill from a client
    /// that folded the handoff frames in a StaleClaim loop until a
    /// reconnect). A reaped/confirmed-dead prior ends
    /// `Vacant { reason: PriorNotLive }` (never record a dead runtime as
    /// Live, round-1 review). Foreign operations are a typed no-op.
    pub fn fail(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        prior_confirmed_live: bool,
    ) -> FailOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return FailOutcome::ForeignOperation;
        };
        if generation != record.generation {
            return FailOutcome::ForeignOperation;
        }
        let initiator = record.state.initiator().unwrap_or_default();
        match record.state.clone() {
            OwnershipState::Starting {
                operation_id: op,
                kind,
                since_ms,
                ..
            } if op == operation_id => {
                record.state = OwnershipState::Vacant;
                // b8ke ext r7 F4: the UNIFORM transition schema — the
                // release-to-Vacant transition's to_kind is the None VALUE
                // and the Starting identity carried no runtime row.
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.start.failed", operation_id, provider, session_id,
                    initiator, from_kind = ?kind,
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                    epoch = self.epoch, generation, outcome = "released",
                    duration_ms = now_epoch_ms().saturating_sub(since_ms),
                    failure_reason = "START_FAILED");
                FailOutcome::Released
            }
            OwnershipState::Handoff {
                operation_id: op,
                prior,
                to_kind,
                since_ms,
                ..
            } if op == operation_id => {
                let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                match prior {
                    Some((owner, _)) if prior_confirmed_live => {
                        // Whole-branch review M-1: the Live state resumes at
                        // the RECORD's current generation (== the handoff's,
                        // fence-checked above) — NOT the prior's original.
                        // The handoff broadcasts carried this generation to
                        // every client and their same-epoch monotonic folds
                        // cannot regress, so any lower Live generation
                        // would wedge every wire-fenced kill (begin_stop's
                        // exact match) in a StaleClaim loop until a
                        // reconnect. The record's own counter is untouched
                        // (never a rollback).
                        let restored_generation = record.generation;
                        record.state = OwnershipState::Live {
                            owner: owner.clone(),
                            generation: restored_generation,
                            since_ms: now_epoch_ms(),
                        };
                        tracing::warn!(target: "freshell_ownership",
                            event = "ownership.handoff.failed", operation_id, provider, session_id,
                            initiator, from_kind = ?owner.kind, to_kind = ?to_kind,
                            runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                            epoch = self.epoch, generation,
                            outcome = "restored_prior_owner", duration_ms,
                            failure_reason = "HANDOFF_FAILED");
                        FailOutcome::RestoredPriorOwner
                    }
                    _ => {
                        let reason = if prior.is_some() {
                            FailVacantReason::PriorNotLive
                        } else {
                            FailVacantReason::NoPrior
                        };
                        record.state = OwnershipState::Vacant;
                        // b8ke ext r7 F4: the UNIFORM transition schema —
                        // the vacated arm's runtime identities are
                        // None-valued (the prior is consumed).
                        tracing::warn!(target: "freshell_ownership",
                            event = "ownership.handoff.failed", operation_id, provider, session_id,
                            initiator, from_kind = ?prior.map(|(o, _)| o.kind), to_kind = ?to_kind,
                            runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                            epoch = self.epoch, generation, outcome = "vacant", duration_ms,
                            failure_reason = ?reason);
                        FailOutcome::Vacant { reason }
                    }
                }
            }
            // b8ke focused episode-2 round-1 F1: a Fenced record — ANY
            // reason, including the watchdog's StaleStart — is NEVER
            // released by this generic fail. The delta-r2 arm cleared a
            // StaleStart fence merely because the operation's ticket
            // dropped, but a handler unwind proves only that the handler
            // cannot COMMIT; it does not prove the detached sidecar or its
            // descendants died. The strict release discipline is the only
            // path: a CONFIRMED-death probe invoking [`Self::release_fenced`]
            // (or the lane teardowns), never a stray fail — never plain
            // Vacant over an unconfirmed runtime.
            _ => FailOutcome::ForeignOperation,
        }
    }

    /// b8ke focused round-2 review R2-1: fail an in-flight `Handoff` whose
    /// DETACHED reap watcher was lost (its confirmation future failed — a
    /// JoinError) to the TYPED [`OwnershipState::Fenced`] state carrying
    /// [`FenceReason::WatcherFailed`] — NEVER plain `Vacant` (the round-1
    /// fail-open licensed a second writer over a possibly-live prior).
    /// The key stays fenced — every competing begin is Blocked with the
    /// typed in-flight answer — until the caller's replacement watcher
    /// confirms the prior's death (a bounded recorded-identity probe) and
    /// invokes [`Self::release_fenced`]. The captured prior identity
    /// (with the generation it held Live) rides the state so the probe has
    /// its kill target. Fenced exactly like [`Self::fail`]: a foreign
    /// operation/generation is the typed no-op.
    pub fn fence_unconfirmed_handoff(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        reason: FenceReason,
    ) -> FenceOutcome {
        self.fence_unconfirmed_handoff_with_prior(
            provider,
            session_id,
            operation_id,
            generation,
            reason,
            None,
        )
    }

    /// b8ke e4 post-cap F2: [`Self::fence_unconfirmed_handoff`] with the
    /// UNCONFIRMED RUNTIME'S OWN identity as the fenced prior — the
    /// uncommitted-TARGET teardown path's fence: the runtime whose
    /// descendant tree is unconfirmed is the newly started TARGET, not
    /// the Handoff record's already-reaped SOURCE, so the authoritative
    /// snapshot, the failure broadcast, and the typed answers must name
    /// the TARGET's kind/id (fencing with the Handoff-captured prior
    /// reported the wrong runtime on every channel). `None` keeps the
    /// Handoff record's captured prior (the prior-stop watchdog's shape).
    pub fn fence_unconfirmed_handoff_with_prior(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        reason: FenceReason,
        unconfirmed: Option<(OwnerIdentity, u64)>,
    ) -> FenceOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return FenceOutcome::ForeignOperation;
        };
        if generation != record.generation {
            return FenceOutcome::ForeignOperation;
        }
        let initiator = record.state.initiator().unwrap_or_default();
        match record.state.clone() {
            OwnershipState::Handoff {
                operation_id: op,
                prior,
                ..
            } if op == operation_id => {
                let duration_ms = now_epoch_ms()
                    .saturating_sub(record.state.since_ms().unwrap_or(now_epoch_ms()));
                // b8ke ext r7 F4: the UNIFORM transition schema — the
                // fenced record's captured identity rides the log (the
                // unconfirmed runtime the fence names).
                // b8ke e4 post-cap F2: the unconfirmed runtime's OWN
                // identity when the caller names it (the uncommitted
                // TARGET), else the Handoff record's captured prior.
                let fenced_prior = unconfirmed.or(prior);
                record.state = OwnershipState::Fenced {
                    prior: fenced_prior.clone(),
                    reason,
                    operation_id: op,
                    generation,
                    initiator: initiator.clone(),
                    since_ms: now_epoch_ms(),
                };
                tracing::error!(target: "freshell_ownership",
                    event = "ownership.handoff.fenced_unconfirmed", operation_id, provider, session_id,
                    initiator,
                    from_kind = ?fenced_prior.as_ref().map(|(o, _)| o.kind),
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?fenced_prior.as_ref().and_then(|(o, _)| o.terminal_id.clone()),
                    pid = ?fenced_prior.as_ref().and_then(|(o, _)| o.pid),
                    epoch = self.epoch, generation, duration_ms,
                    fence_reason = ?reason, outcome = "fenced",
                    failure_reason = "UNCONFIRMED_PRIOR_DEATH",
                    "the reap confirmation failed without confirming the prior's death — \
                     the key is fenced (blocked for every new writer) until confirmed death \
                     releases it; never a fail-open to Vacant");
                FenceOutcome::Fenced
            }
            _ => FenceOutcome::ForeignOperation,
        }
    }

    /// b8ke focused round-2 review R2-2: an explicit stop whose teardown
    /// could not confirm the prior runtime tree's death (a bounded
    /// platform-limited confirmation) moves `Stopping{op}` to the TYPED
    /// [`OwnershipState::Fenced`] state — never `commit_stop`'s `Vacant`.
    /// The key stays fenced until confirmed death releases it (on
    /// non-Linux nothing can — the documented tradeoff).
    pub fn fence_unconfirmed_stop(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        reason: FenceReason,
    ) -> FenceOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return FenceOutcome::ForeignOperation;
        };
        if generation != record.generation {
            return FenceOutcome::ForeignOperation;
        }
        let initiator = record.state.initiator().unwrap_or_default();
        match record.state.clone() {
            OwnershipState::Stopping {
                operation_id: op,
                owner,
                prior_generation,
                ..
            } if op == operation_id => {
                let prior =
                    owner.map(|o| (o, prior_generation.unwrap_or(generation.saturating_sub(1))));
                let logged_prior = prior.clone();
                let duration_ms = now_epoch_ms()
                    .saturating_sub(record.state.since_ms().unwrap_or(now_epoch_ms()));
                record.state = OwnershipState::Fenced {
                    prior,
                    reason,
                    operation_id: op,
                    generation,
                    initiator: initiator.clone(),
                    since_ms: now_epoch_ms(),
                };
                // b8ke ext r7 F4: the UNIFORM transition schema — the
                // fenced record's captured identity rides the log.
                tracing::error!(target: "freshell_ownership",
                    event = "ownership.stop.fenced_unconfirmed", operation_id, provider, session_id,
                    initiator,
                    from_kind = ?logged_prior.as_ref().map(|(o, _)| o.kind),
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?logged_prior.as_ref().and_then(|(o, _)| o.terminal_id.clone()),
                    pid = ?logged_prior.as_ref().and_then(|(o, _)| o.pid),
                    epoch = self.epoch, generation, duration_ms,
                    fence_reason = ?reason, outcome = "fenced",
                    failure_reason = "UNCONFIRMED_PRIOR_DEATH",
                    "the stop's teardown could not confirm the prior's death — the key is \
                     fenced (blocked for every new writer) until confirmed death releases it");
                FenceOutcome::Fenced
            }
            _ => FenceOutcome::ForeignOperation,
        }
    }

    /// Fence a runtime whose natural exit was observed but whose complete
    /// process tree could not be confirmed. This is the natural-exit twin of
    /// [`Self::fence_unconfirmed_stop`]: it matches the retained runtime
    /// identity and commit operation exactly, then moves `Live` directly to a
    /// typed `Fenced` record so recovery cannot recreate beside an
    /// unverified writer.
    pub fn fence_unconfirmed_live(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        expected_runtime: &OwnerIdentity,
        reason: FenceReason,
    ) -> FenceOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return FenceOutcome::ForeignOperation;
        };
        if generation != record.generation {
            return FenceOutcome::ForeignOperation;
        }
        let initiator = record.state.initiator().unwrap_or_default();
        match record.state.clone() {
            OwnershipState::Live {
                owner,
                generation: live_generation,
                since_ms,
            } if live_generation == generation
                && owner.kind == expected_runtime.kind
                && owner.terminal_id == expected_runtime.terminal_id
                && owner.live_session_key == expected_runtime.live_session_key
                && owner.pid == expected_runtime.pid
                && owner.ownership_id.as_deref() == Some(operation_id) =>
            {
                let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                record.state = OwnershipState::Fenced {
                    prior: Some((owner.clone(), generation)),
                    reason,
                    operation_id: operation_id.to_string(),
                    generation,
                    initiator: initiator.clone(),
                    since_ms: now_epoch_ms(),
                };
                tracing::error!(target: "freshell_ownership",
                    event = "ownership.live.fenced_unconfirmed", operation_id, provider, session_id,
                    initiator,
                    from_kind = ?Some(owner.kind),
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?owner.terminal_id,
                    pid = ?owner.pid,
                    epoch = self.epoch, generation, duration_ms,
                    fence_reason = ?reason, outcome = "fenced",
                    failure_reason = "UNCONFIRMED_PRIOR_DEATH",
                    "a natural runtime exit could not confirm the complete writer tree; the key stays fenced until confirmed death");
                FenceOutcome::Fenced
            }
            _ => FenceOutcome::ForeignOperation,
        }
    }

    /// b8ke focused round-2 review: `Fenced{op}` → `Vacant` (generation
    /// preserved). The caller MUST have CONFIRMED the fenced prior's death
    /// (a bounded identity/pid probe or a watcher event) before invoking —
    /// this is the ONLY transition that reopens a fenced key, and it is
    /// never taken on faith. Fenced on (operation_id, generation) exactly
    /// like [`Self::commit_stop`].
    pub fn release_fenced(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
    ) -> CommitOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return CommitOutcome::ForeignOperation;
        };
        if generation != record.generation {
            return CommitOutcome::StaleGeneration {
                current_generation: record.generation,
            };
        }
        match record.state.clone() {
            OwnershipState::Fenced {
                operation_id: op,
                prior,
                reason,
                since_ms,
                ..
            } if op == operation_id => {
                let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                // F8: capture the fencing initiator BEFORE the record clears.
                let fencing_initiator = record.state.initiator();
                record.state = OwnershipState::Vacant;
                // b8ke ext r7 F4: the UNIFORM transition schema — the
                // release creates no new runtime, so to_kind is the None
                // VALUE (never the prior's kind — that would falsely
                // describe a same-kind transition), and the
                // not-applicable failure_reason is the empty string.
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.fenced.released", operation_id, provider, session_id,
                    from_kind = ?prior.as_ref().map(|(o, _)| o.kind),
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?prior.as_ref().and_then(|(o, _)| o.terminal_id.clone()),
                    pid = ?prior.as_ref().and_then(|(o, _)| o.pid),
                    initiator = ?fencing_initiator,
                    epoch = self.epoch, generation, duration_ms,
                    fence_reason = ?reason, outcome = "released_on_confirmed_death",
                    failure_reason = "");
                CommitOutcome::Committed
            }
            _ => CommitOutcome::ForeignOperation,
        }
    }

    /// b8ke focused round-3 review R3-4: the typed operator recovery for a
    /// `Fenced{PlatformLimited}` key — the bounded path that keeps the
    /// session from being permanently disabled on non-Linux hosts. The
    /// b8ke focused episode-2 round-2 F5: enumerate the live
    /// `Fenced{StaleStart}` records — the watchdog's CONFIRMED-DEATH
    /// PROBE input. The stale-start sweep itself never revisits fenced
    /// records (it only recovers `Starting`), so a fence created before
    /// its runtime's reap evidence existed would otherwise be permanent:
    /// the host re-probes each fence's recorded prior pid every sweep and
    /// releases through [`Self::release_fenced`] ONLY on confirmed death
    /// (the pid is GONE — no signal is ever sent, so a recycled pid's
    /// unrelated occupant is safe: a LIVE pid, whatever its incarnation,
    /// keeps the fence held).
    pub fn stale_start_fences(&self) -> Vec<StaleStartFence> {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        let mut out = Vec::new();
        for (key, record) in inner.iter() {
            // b8ke e3r3 F3: the probe-recoverable set is BOTH stale
            // reasons — StaleStart AND the e3r2 watchdog's StaleStop
            // (pre-e3r3 the probe enumerated StaleStart only and a StaleStop
            // fence held until restart). Same confirmed-death discipline for
            // both: a recorded pid needs the lane's confirmed-tree reap;
            // a PID-less fence needs the kind-aware liveness absence AND the
            // operation's settle concluded (a stop's settle_fired is None —
            // it never registered — so PID-LESS stop fences HOLD, fail
            // closed, and the acknowledged operator force-clear is the
            // escape; PID-FUL stop fences release on the lane's confirm).
            if let OwnershipState::Fenced {
                prior,
                reason: reason @ (FenceReason::StaleStart | FenceReason::StaleStop),
                operation_id,
                generation,
                initiator,
                since_ms,
                ..
            } = &record.state
            {
                // e3r4 F3: the settle evidence is REASON-AWARE — the
                // start's flag for StaleStart, the stop's flag for
                // StaleStop (pre-e3r4 the enumerator read settle_fired for
                // BOTH, so a stop fence consulted evidence its stop never
                // armed).
                let settle_concluded = match reason {
                    FenceReason::StaleStart => record
                        .settle_fired
                        .as_ref()
                        .map(|f| f.load(std::sync::atomic::Ordering::SeqCst)),
                    _ => record
                        .stop_settled
                        .as_ref()
                        .map(|f| f.load(std::sync::atomic::Ordering::SeqCst)),
                };
                out.push(StaleStartFence {
                    provider: key.provider.clone(),
                    session_id: key.session_id.clone(),
                    operation_id: operation_id.clone(),
                    generation: *generation,
                    prior_pid: prior.as_ref().and_then(|(owner, _)| owner.pid),
                    initiator: initiator.clone(),
                    prior_kind: prior.as_ref().map(|(owner, _)| owner.kind),
                    settle_concluded,
                    reason: *reason,
                    prior_terminal_id: prior
                        .as_ref()
                        .and_then(|(owner, _)| owner.terminal_id.clone()),
                    since_ms: *since_ms,
                });
            }
        }
        out
    }

    /// non-Linux teardown semantics: the direct child's awaited exit WAS
    /// confirmed (the portable floor); only the DESCENDANT-tree
    /// verification is platform-limited. An EXPLICIT operator action — a
    /// handoff retry carrying a FRESH observed fence (the recovery UI's
    /// Retry refreshes the pair from the runtime-owner record) — may
    /// therefore force-clear the fence, and the log records the limitation
    /// honestly (the descendant tree is UNVERIFIED, not confirmed dead).
    /// Every other shape is the typed refusal: a `WatcherFailed` fence (a
    /// bounded probe can still confirm it), any non-fenced state, and a
    /// stale/mismatched observation (a different epoch, or an older
    /// generation than the fenced record) — the default path stays fenced.
    pub fn force_release_platform_limited(
        &self,
        provider: &str,
        session_id: &str,
        observed: ObservedFence,
        initiator: &str,
    ) -> ForceReleaseOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return ForceReleaseOutcome::NotPlatformLimited {
                state: OwnershipState::Vacant,
            };
        };
        let current_generation = snapshot_generation(record);
        if observed.epoch != self.epoch || observed.generation != current_generation {
            // b8ke ext r7 F4: the UNIFORM transition schema.
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.fenced.force_release_platform_limited",
                provider, session_id, initiator,
                from_kind = ?Option::<RuntimeOwnerKind>::None,
                to_kind = ?Option::<RuntimeOwnerKind>::None,
                runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                observed_epoch = observed.epoch, observed_generation = observed.generation,
                epoch = self.epoch, current_generation,
                duration_ms = 0u64,
                outcome = "refused", failure_reason = "STALE_OBSERVATION",
                "the force-clear's observed fence is stale — refresh and retry");
            return ForceReleaseOutcome::StaleObservation {
                current_epoch: self.epoch,
                current_generation,
            };
        }
        match record.state.clone() {
            OwnershipState::Fenced {
                reason:
                    reason @ (FenceReason::PlatformLimited
                    | FenceReason::StaleStart
                    | FenceReason::StaleStop),
                operation_id,
                prior,
                since_ms,
                ..
            } => {
                // b8ke ext r25 F1(b): the acknowledged operator force-clear
                // accepts the UNCONFIRMABLE fence reasons — PlatformLimited
                // AND the stale reasons (StaleStart/StaleStop). Pre-r25 the
                // stale reasons' recovery was the confirmed-death probe
                // ONLY, but the probe relies on the provider's retained
                // live-session/condemned-prior evidence — once those
                // records are gone (cancellation, panic, watchdog recovery)
                // the stale fence was PERMANENT (no automatic recovery, no
                // operator escape). The active-writer refusal is NOT
                // weakened: the clear lands the TYPED cleared-unverified
                // state through the EXISTING r16-F4 pipeline — never plain
                // Vacant — and a lifecycle start on the cleared key still
                // requires the acknowledged-risk arm (the ONE atomic
                // acknowledged start). The stale reasons' automatic
                // recovery stays the confirmed-death probe (now with the
                // r25 PID-level death confirmation for PID-bearing
                // priors); this clear is the explicit operator escape —
                // every typed fence has a working recovery or an escape,
                // NONE is permanent.
                let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                // b8ke ext r16 F4: the acknowledged clear lands in the
                // TYPED cleared-unverified state — never plain Vacant
                // (pre-r16 the plain-Vacant landing let a good-faith user
                // following the offered recovery start a second writer
                // beside a surviving descendant: the acknowledgment
                // belongs on the dangerous new-writer START, not the
                // harmless clear). The state truthfully encodes the
                // unverified prior writer; a lifecycle start on it
                // refuses typed unless it carries the acknowledged-risk
                // arm; confirmed death (the existing watchers) also
                // clears it.
                let cleared_prior = prior.clone();
                record.state = OwnershipState::Fenced {
                    reason: FenceReason::ClearedUnverified,
                    prior: cleared_prior,
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    initiator: initiator.to_string(),
                    since_ms: now_epoch_ms(),
                };
                tracing::warn!(target: "freshell_ownership",
                    // b8ke ext r7 F4: the UNIFORM transition schema —
                    // the release creates no new runtime (to_kind
                    // None-valued) and the reason-typed acknowledgment is
                    // the recorded failure_reason context.
                    event = "ownership.fenced.force_released_unconfirmable",
                    provider, session_id, initiator,
                    operation_id = %operation_id,
                    from_kind = ?prior.as_ref().map(|(o, _)| o.kind),
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?prior.as_ref().and_then(|(o, _)| o.terminal_id.clone()),
                    pid = ?prior.as_ref().and_then(|(o, _)| o.pid),
                    epoch = self.epoch, generation = record.generation, duration_ms,
                    fence_reason = ?reason,
                    outcome = "force_released_on_operator_action",
                    failure_reason = "UNCONFIRMABLE_FENCE_ACKNOWLEDGED",
                    "an explicit acknowledged operator force-clear released an \
                     UNCONFIRMABLE fence (PlatformLimited, StaleStart, or StaleStop) into \
                     the TYPED cleared-unverified state — the recorded runtime identity \
                     could not be confirmed dead, so a new lifecycle start still requires \
                     the acknowledged-risk arm; surviving processes are the operator's \
                     acknowledged risk, recorded honestly, never a confirmed reap");
                ForceReleaseOutcome::Released
            }
            state => ForceReleaseOutcome::NotPlatformLimited { state },
        }
    }

    /// Begin an explicit stop (kill): `Live` → `Stopping` (generation+1),
    /// blocking competing starts while the kill is confirmed. The KILL
    /// happens while `Stopping`; `commit_stop` moves to `Vacant` only after
    /// the caller confirms the reap (round-1 review). `NotLive` means the
    /// key is not Live (see the variant docs — in-flight states license NO
    /// kill). `BlockedHandoff` means an in-flight handoff owns the
    /// transition: the caller must NOT kill. FENCED (round-2 review): the
    /// caller carries a `StopClaim` — expected kind/runtime identity PLUS
    /// the observed `(epoch, generation)`; any mismatch (ownership moved
    /// to a different runtime, a different generation, or a pre-restart
    /// epoch) is the typed `StaleClaim` and the caller must NOT kill.
    pub fn begin_stop(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        claim: &StopClaim,
        initiator: &str,
        now_ms: u64,
    ) -> StopOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return StopOutcome::NotLive {
                state: OwnershipState::Vacant,
            };
        };
        match record.state.clone() {
            OwnershipState::Live {
                owner,
                generation,
                since_ms: live_since_ms,
                ..
            } => {
                // b8ke ext r12 F2: an in-flight ATTACH guard owns the key's
                // window — the stop answers the typed Blocked outcome
                // (retryable), never interleaving with the attach's work.
                if record.in_flight_attaches > 0 {
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.stop.blocked_by_attach_guard",
                        operation_id, provider, session_id, initiator,
                        from_kind = ?Some(owner.kind),
                        to_kind = ?Option::<RuntimeOwnerKind>::None,
                        runtime_id = ?owner.terminal_id.clone(), pid = ?owner.pid,
                        epoch = self.epoch, generation,
                        duration_ms = 0u64,
                        outcome = "refused", failure_reason = "ATTACH_IN_FLIGHT",
                        "an in-flight attach holds the key's coordinator window — \
                         the stop retries after the attach completes");
                    return StopOutcome::BlockedHandoff {
                        state: record.state.clone(),
                        retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
                    };
                }
                let identity_mismatch = claim.expected_kind != owner.kind
                    || claim
                        .expected_runtime
                        .as_ref()
                        .map(|expected| {
                            expected.kind != owner.kind
                                || expected.terminal_id != owner.terminal_id
                                || expected.live_session_key != owner.live_session_key
                                || expected.pid != owner.pid
                        })
                        .unwrap_or(false);
                if claim.observed.epoch != self.epoch
                    || claim.observed.generation != generation
                    || identity_mismatch
                {
                    // b8ke ext r7 F4: the UNIFORM transition schema —
                    // the refusal's duration is the live owner's tenure at
                    // the refused begin (never omitted).
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.stop.begin", operation_id, provider, session_id,
                        initiator, from_kind = ?owner.kind, to_kind = ?claim.expected_kind,
                        runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                        epoch = self.epoch, generation,
                        duration_ms = now_epoch_ms().saturating_sub(
                            record.state.since_ms().unwrap_or(now_epoch_ms()),
                        ),
                        outcome = "refused", failure_reason = "STALE_STOP_CLAIM");
                    return StopOutcome::StaleClaim {
                        current_epoch: self.epoch,
                        // The Live STATE's generation — the exact value a
                        // refreshed stop fence must carry to satisfy
                        // begin_stop (M3: for a stop-abandoned restore it
                        // can be lower than the record's bumped generation;
                        // a failed-handoff restore no longer straddles —
                        // whole-branch M-1).
                        current_generation: generation,
                        state: record.state.clone(),
                    };
                }
                // b8ke ext r8 F3: the prior owner's REAL tenure —
                // computed BEFORE the state replacement (the r6
                // handoff-begin class: reading the just-replaced Stopping
                // state's own timestamp reported ~zero instead of the
                // Live era's tenure).
                let prior_tenure_ms = now_ms.saturating_sub(live_since_ms);
                record.generation += 1;
                record.state = OwnershipState::Stopping {
                    owner: Some(owner.clone()),
                    // The PRE-stop Live generation — `abort_stop`'s restore
                    // target (Task 4 review F1: a stop abandoned with the
                    // runtime still alive must unwind to a fence-coherent
                    // `Live`, never the bumped record generation).
                    prior_generation: Some(generation),
                    operation_id: operation_id.to_string(),
                    generation: record.generation,
                    initiator: initiator.to_string(),
                    since_ms: now_ms,
                };
                // b8ke ext r7 F4: the UNIFORM transition schema — the
                // granted stop names the expected next-owner kind (the
                // stop claim's kind — a same-kind transition), the prior
                // owner's tenure at the begin, and the empty
                // (not-applicable) failure_reason.
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.stop.begin", operation_id, provider, session_id,
                    initiator, from_kind = ?owner.kind,
                    to_kind = ?claim.expected_kind,
                    runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                    epoch = self.epoch, generation = record.generation,
                    duration_ms = prior_tenure_ms,
                    outcome = "granted", failure_reason = "");
                StopOutcome::Granted {
                    generation: record.generation,
                }
            }
            OwnershipState::Handoff { .. } => StopOutcome::BlockedHandoff {
                state: record.state.clone(),
                retry_after_ms: OWNERSHIP_RETRY_AFTER_MS,
            },
            OwnershipState::Stopping {
                operation_id,
                generation,
                owner,
                ..
            } => StopOutcome::AlreadyStopping {
                operation_id,
                generation,
                owner,
            },
            state => StopOutcome::NotLive { state },
        }
    }

    /// Confirm a stop AFTER the reap: `Stopping{op}` → `Vacant` (generation
    /// preserved). Callers must only invoke this once the runtime's death
    /// is confirmed (round-1 review: never Vacant before the reap).
    pub fn commit_stop(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
    ) -> CommitOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return CommitOutcome::ForeignOperation;
        };
        if generation != record.generation {
            return CommitOutcome::StaleGeneration {
                current_generation: record.generation,
            };
        }
        match record.state.clone() {
            OwnershipState::Stopping {
                operation_id: op,
                owner,
                since_ms,
                initiator,
                ..
            } if op == operation_id => {
                let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                record.state = OwnershipState::Vacant;
                // b8ke ext r7 F4: the UNIFORM transition schema — the
                // commit releases the key to Vacant, so to_kind is the
                // None VALUE, and the empty failure_reason rides the
                // success transition.
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.stop.commit", operation_id, provider, session_id,
                    initiator, from_kind = ?owner.as_ref().map(|o| o.kind),
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?owner.as_ref().and_then(|o| o.terminal_id.clone()),
                    pid = ?owner.as_ref().and_then(|o| o.pid),
                    epoch = self.epoch, generation, outcome = "committed", duration_ms,
                    failure_reason = "");
                CommitOutcome::Committed
            }
            _ => CommitOutcome::ForeignOperation,
        }
    }

    /// Abort a GRANTED stop whose kill was abandoned BEFORE the reap (Task 4
    /// review F1): the stopper began, then exited without killing — the
    /// runtime is CONFIRMED still alive (e.g. the terminal lane's durable
    /// ledger close failed cleanly and the kill deliberately left the
    /// terminal running). `Stopping{op}` → `Live`, restoring the captured
    /// owner at its PRE-STOP generation so every fence a pre-stop observer
    /// carries (retained stamp, snapshot) stays coherent — unlike the
    /// failed-handoff restore, which writes the record's CURRENT generation
    /// because the handoff broadcasts carried it to every client
    /// (whole-branch review M-1); the stop path broadcasts nothing at the
    /// bumped generation, so the pre-stop fences are the ones observers
    /// hold. Neither restore ever rolls the record's monotonic counter
    /// back. Fenced on (operation_id, generation) exactly like
    /// `commit_stop`; a watchdog-synthesized `Stopping` (no prior Live era)
    /// is a typed `ForeignOperation` no-op — the host's abort/settle/commit
    /// owns that transition.
    pub fn abort_stop(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
    ) -> AbortStopOutcome {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return AbortStopOutcome::ForeignOperation;
        };
        if generation != record.generation {
            return AbortStopOutcome::StaleGeneration {
                current_generation: record.generation,
            };
        }
        let initiator = record.state.initiator().unwrap_or_default();
        match record.state.clone() {
            OwnershipState::Stopping {
                owner: Some(owner),
                prior_generation: Some(prior_generation),
                operation_id: op,
                since_ms,
                ..
            } if op == operation_id => {
                let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                record.state = OwnershipState::Live {
                    owner: owner.clone(),
                    generation: prior_generation,
                    since_ms: now_epoch_ms(),
                };
                tracing::warn!(target: "freshell_ownership",
                    // b8ke ext r7 F4: the UNIFORM transition schema — the
                    // abort restores the SAME runtime Live, so to_kind is
                    // the restored owner's kind.
                    event = "ownership.stop.aborted", operation_id, provider, session_id,
                    initiator, from_kind = ?owner.kind, to_kind = ?owner.kind,
                    runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                    epoch = self.epoch, generation, restored_generation = prior_generation,
                    outcome = "restored_live", duration_ms,
                    failure_reason = "STOP_ABANDONED_RUNTIME_ALIVE");
                AbortStopOutcome::Aborted
            }
            _ => AbortStopOutcome::ForeignOperation,
        }
    }

    /// Exit-watcher hook (round-1 review: FENCED). `Live` → `Vacant` only
    /// when the record still matches the watched runtime EXACTLY — same
    /// operation id (`owner.ownership_id`), same generation, same runtime
    /// identity (kind + terminal_id/live_session_key + pid). A newer owner,
    /// a different generation, or an in-flight handoff makes this a typed
    /// no-op (the handoff runner folds exit events itself — its awaited
    /// kill/reap is the single fold point).
    pub fn release(
        &self,
        provider: &str,
        session_id: &str,
        claim: &ReleaseClaim,
        initiator: &str,
    ) -> bool {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        if let Some(record) = inner.get_mut(&key) {
            if let OwnershipState::Live {
                owner,
                generation,
                since_ms,
            } = record.state.clone()
            {
                if runtime_matches(&owner, claim) && generation == claim.generation {
                    let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                    // b8ke ext r32 F1: the release itself lands Vacant
                    // (the honest state — the runtime IS dead), but when
                    // an in-flight attach/create guard rides the record
                    // the key's ACQUISITION stays deferred: the
                    // begin_start/begin_handoff Vacant arms answer the
                    // typed Blocked outcome while the count is nonzero,
                    // so the exit cannot invalidate the guarded
                    // operation's authority. The deferral resolves by
                    // itself when the last guard releases — no fence can
                    // become permanent.
                    record.state = OwnershipState::Vacant;
                    // Round-2 review: the released event reports the
                    // transition to Vacant CORRECTLY — `from_kind` is the
                    // released owner's kind; there is NO `to_kind` (no new
                    // runtime kind exists) — and it carries the
                    // terminal-transition `duration_ms`.
                    // b8ke ext r6 F5: the STABLE schema — the release
                    // creates no new runtime, so to_kind is the None VALUE
                    // (never a deleted field) and the failure_reason is the
                    // empty not-applicable string.
                    tracing::info!(target: "freshell_ownership",
                        event = "ownership.released", provider, session_id,
                        operation_id = %claim.operation_id, initiator,
                        from_kind = ?owner.kind,
                        to_kind = ?Option::<RuntimeOwnerKind>::None,
                        runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                        epoch = self.epoch, generation, duration_ms,
                        outcome = "released", failure_reason = "");
                    return true;
                } else {
                    // b8ke ext r7 F4: the UNIFORM transition schema —
                    // the noop names both kinds (no transition:
                    // to_kind None-valued) and the full identity set.
                    let duration_ms = now_epoch_ms().saturating_sub(since_ms);
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.release.fenced_noop", provider, session_id,
                        operation_id = %claim.operation_id, initiator,
                        from_kind = ?owner.kind,
                        to_kind = ?Option::<RuntimeOwnerKind>::None,
                        runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                        claim_generation = claim.generation, generation,
                        epoch = self.epoch,
                        duration_ms,
                        outcome = "no_op", failure_reason = "RELEASE_FENCE_MISMATCH");
                }
            }
        }
        false
    }

    /// Only after the holder's entire process tree death was confirmed
    /// (the lane TTL paths' kill-before-release contract). Round-1 review:
    /// FENCED — fires only when the current record still matches the
    /// confirmed-dead runtime (Live owner, or Stopping owner, matched on
    /// operation id + generation + runtime identity) or the claimed
    /// zombie `Starting` ticket (operation id + generation). NEVER fires
    /// during a `Handoff` (invariant log) and never erases a newer owner.
    pub fn force_release_for_confirmed_kill(
        &self,
        provider: &str,
        session_id: &str,
        claim: &ReleaseClaim,
        initiator: &str,
    ) {
        let mut inner = self.lock_records();
        let key = SessionKey::new(provider, session_id);
        let Some(record) = inner.get_mut(&key) else {
            return;
        };
        let matched = match record.state.clone() {
            OwnershipState::Handoff { .. } => {
                tracing::error!(target: "invariant", provider, session_id,
                    operation_id = %claim.operation_id, initiator,
                    "ownership.force_release.refused_during_handoff: the handoff runner owns the transition");
                false
            }
            OwnershipState::Live {
                owner, generation, ..
            } => runtime_matches(&owner, claim) && generation == claim.generation,
            OwnershipState::Stopping {
                owner,
                operation_id,
                generation,
                ..
            } => {
                operation_id == claim.operation_id
                    && generation == claim.generation
                    && owner
                        .map(|o| runtime_matches(&o, claim))
                        .unwrap_or(claim.runtime.is_none())
            }
            OwnershipState::Starting {
                operation_id,
                generation,
                ..
            } => {
                operation_id == claim.operation_id
                    && generation == claim.generation
                    && claim.runtime.is_none()
            }
            // b8ke focused round-2 review: a fenced key reopens ONLY via
            // `release_fenced` after ITS OWN probe confirms the prior's
            // death — the fenced record's operation id is the fencing
            // (handoff/stop) operation, which no lane TTL claim carries.
            OwnershipState::Fenced { .. } => false,
            OwnershipState::Vacant | OwnershipState::Aliased { .. } => false,
        };
        if matched {
            let from_kind = record.state.kind();
            record.state = OwnershipState::Vacant;
            // b8ke ext r7 F4: the UNIFORM transition schema — the
            // release creates no new runtime (to_kind None-valued) and
            // carries the released identity + duration.
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.force_released", provider, session_id,
                operation_id = %claim.operation_id, initiator,
                from_kind = ?from_kind,
                to_kind = ?Option::<RuntimeOwnerKind>::None,
                runtime_id = ?claim.runtime.as_ref().and_then(|o| o.terminal_id.clone()),
                pid = ?claim.runtime.as_ref().and_then(|o| o.pid),
                epoch = self.epoch, generation = claim.generation,
                duration_ms = 0u64,
                outcome = "released", failure_reason = "CONFIRMED_KILL");
        }
    }

    /// Begin (or join) the stop of a UNIT: every key stamped with the unit
    /// (see [`stamping_owner`]) moves to `Stopping` (generation + 1),
    /// whatever its state — a `Live` key keeps its owner
    /// (`prior_generation: Some(live generation)`), a `Starting` key's
    /// owner is the partial runtime it registered (`prior_generation:
    /// None`), a `Handoff` key's owner is the captured prior
    /// (`prior_generation: Some(prior generation)`). The one exception is a
    /// `Handoff` whose own operation id is `operation_id`: that handoff is
    /// stopping its own prior and commits the key itself. Keys already
    /// `Stopping` for the unit are reported `joined: true`.
    ///
    /// A unit has ONE stop operation at a time: when keys of the unit are
    /// already `Stopping`, every key moved now is moved under that
    /// in-flight operation (the caller's own `operation_id` when it is one
    /// of them), so the one [`Self::commit_unit_stop`] at Gone covers the
    /// whole unit. A kill always wins over an attach guard (logged
    /// `attach_in_flight=true`). `Aliased` keys carry no owner and are
    /// never touched. The result is sorted by session id.
    pub fn begin_unit_stop(
        &self,
        unit_id: &str,
        operation_id: &str,
        initiator: &str,
        now_ms: u64,
    ) -> Vec<UnitStopKey> {
        let mut inner = self.lock_records();
        let effective_op = {
            let mut in_flight: Vec<(&SessionKey, &str)> = inner
                .iter()
                .filter(|(_, record)| stamped_unit(record) == Some(unit_id))
                .filter_map(|(key, record)| match &record.state {
                    OwnershipState::Stopping {
                        operation_id: op, ..
                    } => Some((key, op.as_str())),
                    _ => None,
                })
                .collect();
            in_flight.sort_by(|a, b| by_session_id(a.0, b.0));
            if in_flight.iter().any(|(_, op)| *op == operation_id) {
                operation_id.to_string()
            } else {
                in_flight
                    .first()
                    .map_or_else(|| operation_id.to_string(), |(_, op)| op.to_string())
            }
        };
        let mut keys = Vec::new();
        for (key, record) in inner.iter_mut() {
            if stamped_unit(record) != Some(unit_id) {
                continue;
            }
            let (owner, prior_generation, from_state, prior_since_ms) = match &record.state {
                OwnershipState::Stopping { .. } => {
                    keys.push(UnitStopKey {
                        key: key.clone(),
                        generation: record.generation,
                        joined: true,
                    });
                    continue;
                }
                OwnershipState::Handoff {
                    operation_id: handoff_op,
                    ..
                } if handoff_op == operation_id => continue,
                OwnershipState::Live {
                    owner,
                    generation,
                    since_ms,
                } => (owner.clone(), Some(*generation), "live", *since_ms),
                OwnershipState::Handoff {
                    prior: Some((prior, prior_generation)),
                    since_ms,
                    ..
                } => (prior.clone(), Some(*prior_generation), "handoff", *since_ms),
                OwnershipState::Starting { since_ms, .. } => match &record.partial_runtime {
                    Some(partial) => (partial.clone(), None, "starting", *since_ms),
                    None => continue,
                },
                _ => continue,
            };
            record.generation += 1;
            record.state = OwnershipState::Stopping {
                owner: Some(owner.clone()),
                prior_generation,
                operation_id: effective_op.clone(),
                generation: record.generation,
                initiator: initiator.to_string(),
                since_ms: now_ms,
            };
            tracing::info!(target: "freshell_ownership",
                event = "ownership.stop.begin", operation_id = %effective_op,
                provider = %key.provider, session_id = %key.session_id, initiator,
                from_kind = ?owner.kind, to_kind = ?Option::<RuntimeOwnerKind>::None,
                runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                epoch = self.epoch, generation = record.generation,
                duration_ms = now_ms.saturating_sub(prior_since_ms),
                outcome = "granted", failure_reason = "",
                unit_id, terminal_id = owner.terminal_id.as_deref().unwrap_or(""),
                from_state, attach_in_flight = record.in_flight_attaches > 0,
                requested_operation_id = operation_id,
                "the unit's stop moved this key to Stopping");
            keys.push(UnitStopKey {
                key: key.clone(),
                generation: record.generation,
                joined: false,
            });
        }
        keys.sort_by(|a, b| by_session_id(&a.key, &b.key));
        keys
    }

    /// Gone for a unit: every key stamped with the unit whose `Stopping`
    /// operation is `operation_id` moves to `Vacant`. Keys the unit holds
    /// under any other operation (a boot seed, another stop) are left
    /// alone. Every armed attach guard on a vacated key is cleared, so no
    /// Vacant key stays blocked by a window the kill already won. Returns
    /// the vacated keys, sorted by session id, with their POST-COMMIT
    /// generation: the pair a fenced `begin_start` accepts (the one a
    /// crash event built at Gone must carry).
    pub fn commit_unit_stop(&self, unit_id: &str, operation_id: &str) -> Vec<UnitStopKey> {
        let mut inner = self.lock_records();
        let mut keys = Vec::new();
        for (key, record) in inner.iter_mut() {
            let OwnershipState::Stopping {
                owner: Some(owner),
                operation_id: stop_op,
                initiator,
                since_ms,
                ..
            } = &record.state
            else {
                continue;
            };
            if owner.unit_id.as_deref() != Some(unit_id) || stop_op != operation_id {
                continue;
            }
            let owner = owner.clone();
            let initiator = initiator.clone();
            let duration_ms = now_epoch_ms().saturating_sub(*since_ms);
            let attach_guards_cleared = record.in_flight_attaches;
            // The record generation is already the post-stop generation.
            record.state = OwnershipState::Vacant;
            record.in_flight_attaches = 0;
            record.armed_attach_ops.clear();
            tracing::info!(target: "freshell_ownership",
                event = "ownership.stop.commit", operation_id,
                provider = %key.provider, session_id = %key.session_id,
                initiator = %initiator,
                from_kind = ?owner.kind, to_kind = ?Option::<RuntimeOwnerKind>::None,
                runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                epoch = self.epoch, generation = record.generation,
                duration_ms, outcome = "committed", failure_reason = "",
                unit_id, terminal_id = owner.terminal_id.as_deref().unwrap_or(""),
                attach_guards_cleared,
                "the unit is Gone — the key is released");
            keys.push(UnitStopKey {
                key: key.clone(),
                generation: record.generation,
                joined: false,
            });
        }
        keys.sort_by(|a, b| by_session_id(&a.key, &b.key));
        keys
    }

    /// Record that a unit's agent process holds `session_id` as an EXTRA
    /// thread (a helper agent, a fork parent, an earlier conversation).
    /// `owner` must carry its `unit_id`; it is stored with
    /// `hold: HoldKind::Extra`. A `Vacant` key becomes `Live` (`Held`);
    /// a key the same unit already holds is `AlreadyHeld`; a key another
    /// owner holds Live is `HeldByOther`; any other state is `Skipped`.
    /// While any key of the unit is `Stopping`, nothing is held
    /// (`Skipped` carrying that state): a stopping unit never gains holds.
    pub fn hold_extra(
        &self,
        provider: &str,
        session_id: &str,
        owner: OwnerIdentity,
        initiator: &str,
        now_ms: u64,
    ) -> HoldOutcome {
        let mut inner = self.lock_records();
        let unit_id = owner.unit_id.clone().unwrap_or_default();
        let operation_id = owner.ownership_id.clone().unwrap_or_default();
        let terminal_id = owner.terminal_id.clone().unwrap_or_default();
        let log_refusal = |outcome: &str, failure_reason: &str, generation: u64| {
            tracing::info!(target: "freshell_ownership",
                event = "ownership.extra.hold", operation_id = %operation_id,
                provider, session_id, initiator,
                from_kind = ?Option::<RuntimeOwnerKind>::None, to_kind = ?Some(owner.kind),
                runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                epoch = self.epoch, generation, duration_ms = 0u64,
                outcome, failure_reason,
                unit_id = %unit_id, terminal_id = %terminal_id,
                "the extra-thread hold was not recorded");
        };
        if unit_id.is_empty() {
            // A caller bug: an extra hold names the unit that holds it.
            let state = inner
                .get(&SessionKey::new(provider, session_id))
                .map_or(OwnershipState::Vacant, |record| record.state.clone());
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.extra.hold", operation_id = %operation_id,
                provider, session_id, initiator,
                from_kind = ?Option::<RuntimeOwnerKind>::None, to_kind = ?Some(owner.kind),
                runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                epoch = self.epoch, generation = 0u64, duration_ms = 0u64,
                outcome = "skipped-no-unit", failure_reason = "OWNER_HAS_NO_UNIT",
                unit_id = "", terminal_id = %terminal_id,
                "an extra-thread hold must name its unit — nothing is recorded");
            return HoldOutcome::Skipped { state };
        }
        if let Some(stopping) = inner
            .values()
            .find(|record| {
                stamped_unit(record) == Some(unit_id.as_str())
                    && matches!(record.state, OwnershipState::Stopping { .. })
            })
            .map(|record| record.state.clone())
        {
            log_refusal("skipped-unit-stopping", "UNIT_STOPPING", 0);
            return HoldOutcome::Skipped { state: stopping };
        }
        let record = inner
            .entry(SessionKey::new(provider, session_id))
            .or_default();
        match &record.state {
            OwnershipState::Vacant => {
                record.generation += 1;
                let held = OwnerIdentity {
                    hold: HoldKind::Extra,
                    ..owner.clone()
                };
                record.state = OwnershipState::Live {
                    owner: held,
                    generation: record.generation,
                    since_ms: now_ms,
                };
                tracing::info!(target: "freshell_ownership",
                    event = "ownership.extra.hold", operation_id = %operation_id,
                    provider, session_id, initiator,
                    from_kind = ?Option::<RuntimeOwnerKind>::None, to_kind = ?Some(owner.kind),
                    runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                    epoch = self.epoch, generation = record.generation, duration_ms = 0u64,
                    outcome = "held", failure_reason = "",
                    unit_id = %unit_id, terminal_id = %terminal_id,
                    "the unit's agent process holds this thread besides its main \
                     conversation — the key is Live as an extra hold");
                HoldOutcome::Held {
                    generation: record.generation,
                }
            }
            OwnershipState::Live { owner: held, .. }
                if held.unit_id.as_deref() == Some(unit_id.as_str()) =>
            {
                HoldOutcome::AlreadyHeld
            }
            OwnershipState::Live {
                owner: held,
                generation,
                ..
            } => {
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.extra.hold", operation_id = %operation_id,
                    provider, session_id, initiator,
                    from_kind = ?Some(held.kind), to_kind = ?Some(owner.kind),
                    runtime_id = ?held.terminal_id, pid = ?held.pid,
                    epoch = self.epoch, generation = *generation, duration_ms = 0u64,
                    outcome = "held-by-other", failure_reason = "HELD_BY_OTHER",
                    unit_id = %unit_id, terminal_id = %terminal_id,
                    holder_unit_id = held.unit_id.as_deref().unwrap_or(""),
                    holder_terminal_id = held.terminal_id.as_deref().unwrap_or(""),
                    "another owner already holds this thread Live");
                HoldOutcome::HeldByOther {
                    owner: held.clone(),
                }
            }
            state => {
                let state = state.clone();
                log_refusal("skipped", "KEY_NOT_VACANT", snapshot_generation(record));
                HoldOutcome::Skipped { state }
            }
        }
    }

    /// Release an EXTRA hold: `Live` (held by `unit_id` as
    /// [`HoldKind::Extra`]) → `Vacant`. Anything else — another unit's
    /// key, the unit's main conversation, any other state — is a `false`
    /// no-op.
    pub fn release_extra(&self, provider: &str, session_id: &str, unit_id: &str) -> bool {
        let mut inner = self.lock_records();
        let Some(record) = inner.get_mut(&SessionKey::new(provider, session_id)) else {
            return false;
        };
        let OwnershipState::Live {
            owner, since_ms, ..
        } = &record.state
        else {
            return false;
        };
        if owner.unit_id.as_deref() != Some(unit_id) || owner.hold != HoldKind::Extra {
            return false;
        }
        let owner = owner.clone();
        let duration_ms = now_epoch_ms().saturating_sub(*since_ms);
        record.state = OwnershipState::Vacant;
        tracing::info!(target: "freshell_ownership",
            event = "ownership.extra.release",
            operation_id = owner.ownership_id.as_deref().unwrap_or(""),
            provider, session_id,
            from_kind = ?Some(owner.kind), to_kind = ?Option::<RuntimeOwnerKind>::None,
            runtime_id = ?owner.terminal_id, pid = ?owner.pid,
            epoch = self.epoch, generation = record.generation, duration_ms,
            outcome = "released", failure_reason = "",
            unit_id, terminal_id = owner.terminal_id.as_deref().unwrap_or(""),
            "the unit no longer holds this extra thread — the key is released");
        true
    }

    /// Boot seed for a unit persisted as Stopping: a `Vacant` (never-seen
    /// this boot) key becomes `Stopping { owner: Some(owner),
    /// prior_generation: None, .. }` (generation + 1), so it is never
    /// offered for reuse while the boot finishes the stop. Any other state
    /// refuses (`false`).
    pub fn restore_stopping(
        &self,
        provider: &str,
        session_id: &str,
        owner: OwnerIdentity,
        operation_id: &str,
        initiator: &str,
        now_ms: u64,
    ) -> bool {
        let mut inner = self.lock_records();
        let record = inner
            .entry(SessionKey::new(provider, session_id))
            .or_default();
        let unit_id = owner.unit_id.as_deref().unwrap_or("");
        let terminal_id = owner.terminal_id.as_deref().unwrap_or("");
        if record.state != OwnershipState::Vacant {
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.stop.restored", operation_id, provider, session_id,
                initiator,
                from_kind = ?record.state.kind(), to_kind = ?Option::<RuntimeOwnerKind>::None,
                runtime_id = ?owner.terminal_id, pid = ?owner.pid,
                epoch = self.epoch, generation = snapshot_generation(record),
                duration_ms = 0u64,
                outcome = "refused", failure_reason = "KEY_NOT_VACANT",
                unit_id, terminal_id,
                "a persisted Stopping unit names a key this boot already holds — \
                 the seed is refused");
            return false;
        }
        record.generation += 1;
        record.state = OwnershipState::Stopping {
            owner: Some(owner.clone()),
            prior_generation: None,
            operation_id: operation_id.to_string(),
            generation: record.generation,
            initiator: initiator.to_string(),
            since_ms: now_ms,
        };
        tracing::info!(target: "freshell_ownership",
            event = "ownership.stop.restored", operation_id, provider, session_id,
            initiator,
            from_kind = ?Some(owner.kind), to_kind = ?Option::<RuntimeOwnerKind>::None,
            runtime_id = ?owner.terminal_id, pid = ?owner.pid,
            epoch = self.epoch, generation = record.generation,
            duration_ms = 0u64,
            outcome = "stopping", failure_reason = "",
            unit_id, terminal_id,
            "a unit persisted as Stopping is seeded Stopping — the boot finishes \
             its stop before the key is offered again");
        true
    }

    /// Every key stamped with the unit (see [`stamping_owner`]), with its
    /// state, sorted by session id. Read-only.
    pub fn keys_for_unit(&self, unit_id: &str) -> Vec<(SessionKey, OwnershipState)> {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        let mut keys: Vec<(SessionKey, OwnershipState)> = inner
            .iter()
            .filter(|(_, record)| stamped_unit(record) == Some(unit_id))
            .map(|(key, record)| (key.clone(), record.state.clone()))
            .collect();
        keys.sort_by(|a, b| by_session_id(&a.0, &b.0));
        keys
    }

    /// Every key a terminal holds `Live` or is `Stopping`, with its state,
    /// sorted by session id. Read-only.
    pub fn states_for_terminal(&self, terminal_id: &str) -> Vec<(SessionKey, OwnershipState)> {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        let mut keys: Vec<(SessionKey, OwnershipState)> = inner
            .iter()
            .filter(|(_, record)| match &record.state {
                OwnershipState::Live { owner, .. }
                | OwnershipState::Stopping {
                    owner: Some(owner), ..
                } => owner.terminal_id.as_deref() == Some(terminal_id),
                _ => false,
            })
            .map(|(key, record)| (key.clone(), record.state.clone()))
            .collect();
        keys.sort_by(|a, b| by_session_id(&a.0, &b.0));
        keys
    }

    /// Register the in-flight `Starting` operation's abort + settle handles
    /// (round-2 review watchdog cancellation): the spawn task registers
    /// `abort` immediately after wrapping its Granted claim in an
    /// `OperationTicket` (`Arc<dyn Fn()>` — the tokio `JoinHandle::abort`
    /// is sync-callable; the crate stays tokio-free) and `settle` as a
    /// future that resolves once the (aborted) task has unwound — the lane
    /// builds it from its JoinHandle; the watchdog host `.await`s it,
    /// bounded. Fenced to the operation id + generation; a stale
    /// registration is a typed no-op.
    #[allow(clippy::too_many_arguments)] // the registration field set (+ the e2 post-cap settle flag)
    pub fn register_start_cancellation(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        abort: Arc<dyn Fn() + Send + Sync>,
        settle: Box<dyn std::future::Future<Output = ()> + Send>,
        settle_fired: Option<Arc<std::sync::atomic::AtomicBool>>,
    ) -> bool {
        let mut inner = self.lock_records();
        if let Some(record) = inner.get_mut(&SessionKey::new(provider, session_id)) {
            if let OwnershipState::Starting {
                operation_id: op,
                generation: gen,
                ..
            } = &record.state
            {
                if op == operation_id && *gen == generation {
                    record.cancellation = Some(abort);
                    record.settle = Some(settle);
                    record.settle_fired = settle_fired;
                    return true;
                }
            }
        }
        // b8ke focused episode-2 post-cap F6: the registration DECLINED —
        // the caller must know (a loudly-logged no-cancellation, never a
        // silent fence-bait). Reachable when the wire id was a superseded
        // alias (pre-fix the helper registered against the ALIASED key)
        // or the operation already moved on.
        false
    }

    /// b8ke e3r3 F7: register the STOP operation's settlement flag — the
    /// sender-side evidence the stale-Stopping watchdog consults before
    /// fencing on age (a progressing stop is not stale).
    pub fn register_stop_settlement(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        flag: Arc<std::sync::atomic::AtomicBool>,
    ) -> bool {
        let mut inner = self.lock_records();
        if let Some(record) = inner.get_mut(&SessionKey::new(provider, session_id)) {
            if let OwnershipState::Stopping {
                operation_id: op,
                generation: gen,
                ..
            } = &record.state
            {
                if op == operation_id && *gen == generation {
                    record.stop_settled = Some(flag);
                    return true;
                }
            }
        }
        false
    }

    /// b8ke e3r2 F2: the stale-Stopping watchdog — the stop-claim unwind
    /// analogous to the stale-start machinery. An over-aged `Stopping`
    /// record (whose stop operation died without commit_stop/abort_stop —
    /// a panicked handler between claim and commit) fences TYPED
    /// (`StaleStop`) so the key can never strand blocking every claimant
    /// until restart. The host sweeps this alongside the stale-start
    /// recovery; the fence releases through the confirmed-death probe or
    /// the acknowledged operator force-clear (the prior's death is
    /// UNCONFIRMED — the killing operation vanished mid-flight).
    pub fn recover_stale_stoppings(&self, now_ms: u64, max_age_ms: u64) -> Vec<StaleStopping> {
        let mut inner = self.lock_records();
        let mut out = Vec::new();
        for (key, record) in inner.iter_mut() {
            let snapshot = record.state.clone();
            if let OwnershipState::Stopping {
                owner,
                prior_generation,
                operation_id,
                generation,
                initiator,
                since_ms,
            } = snapshot
            {
                if now_ms.saturating_sub(since_ms) < max_age_ms {
                    continue;
                }
                // A UNIT's stop is supervised by its lifecycle and, if cut
                // off, finished on the next boot from its persisted unit
                // record — never fenced on age. This watchdog stays for
                // non-unit claims (a panicked handler between claim and
                // commit).
                if let Some(unit_owner) = owner.as_ref().filter(|o| o.unit_id.is_some()) {
                    tracing::info!(target: "freshell_ownership",
                        event = "ownership.stop.stale_stopping_skipped_unit",
                        operation_id = %operation_id, provider = %key.provider,
                        session_id = %key.session_id,
                        initiator = %initiator,
                        from_kind = ?Some(unit_owner.kind),
                        to_kind = ?Option::<RuntimeOwnerKind>::None,
                        runtime_id = ?unit_owner.terminal_id, pid = ?unit_owner.pid,
                        epoch = self.epoch, generation,
                        duration_ms = now_ms.saturating_sub(since_ms),
                        outcome = "skipped",
                        failure_reason = "",
                        unit_id = unit_owner.unit_id.as_deref().unwrap_or(""),
                        terminal_id = unit_owner.terminal_id.as_deref().unwrap_or(""),
                        "the over-aged stop belongs to a unit — its lifecycle (or the \
                         next boot) finishes it; the watchdog never fences it");
                    continue;
                }
                // b8ke e3r3 F7: consult the STOP's settlement evidence
                // BEFORE fencing on age — a SLOW-BUT-LIVE stop (its
                // handler's flag NOT fired: the reap or ledger write is
                // still progressing) is NOT stale and must never fence (a
                // successfully reaped session would otherwise end fenced
                // and its commit rejected). Only a FIRED flag (the
                // handler ended without commit/abort) or an UNREGISTERED
                // stop (a pre-e3r3 path) fences.
                if let Some(flag) = &record.stop_settled {
                    if !flag.load(std::sync::atomic::Ordering::SeqCst) {
                        // b8ke ext r7 F4: the UNIFORM transition schema —
                        // the skipped sweep names the Stopping record's
                        // owner identity (no transition: to_kind
                        // None-valued).
                        tracing::info!(target: "freshell_ownership",
                            event = "ownership.stop.stale_stopping_skipped_live",
                            operation_id = %operation_id, provider = %key.provider,
                            session_id = %key.session_id,
                            initiator = %initiator,
                            from_kind = ?owner.as_ref().map(|o| o.kind),
                            to_kind = ?Option::<RuntimeOwnerKind>::None,
                            runtime_id = ?owner.as_ref().and_then(|o| o.terminal_id.clone()),
                            pid = ?owner.as_ref().and_then(|o| o.pid),
                            duration_ms = now_ms.saturating_sub(since_ms),
                            outcome = "skipped",
                            failure_reason = "",
                            "the over-aged stop is STILL RUNNING (its settlement \
                             flag has not fired) — a progressing stop is not stale");
                        continue;
                    }
                }
                let prior = owner
                    .as_ref()
                    .map(|owner| (owner.clone(), prior_generation.unwrap_or(generation)));
                let stale = StaleStopping {
                    provider: key.provider.clone(),
                    session_id: key.session_id.clone(),
                    operation_id: operation_id.clone(),
                    generation,
                    prior: prior.clone(),
                    initiator: initiator.clone(),
                    since_ms,
                };
                record.state = OwnershipState::Fenced {
                    prior,
                    reason: FenceReason::StaleStop,
                    operation_id: operation_id.clone(),
                    generation,
                    initiator: initiator.clone(),
                    since_ms,
                };
                tracing::error!(target: "freshell_ownership",
                    event = "ownership.stop.stale_stopping_fenced",
                    operation_id = %operation_id, provider = %key.provider,
                    session_id = %key.session_id,
                    // b8ke e3r4 F5: the complete structured transition
                    // schema — the initiating client/device, the old/new
                    // runtime kinds, the recorded runtime identity.
                    // b8ke ext r7 F4: to_kind is the None VALUE — the
                    // fence creates no new runtime (the prior's kind would
                    // falsely describe a same-kind transition).
                    initiator = %initiator,
                    from_kind = ?stale.prior.as_ref().map(|(o, _)| o.kind),
                    to_kind = ?Option::<RuntimeOwnerKind>::None,
                    runtime_id = ?stale.prior.as_ref().and_then(|(o, _)| o.terminal_id.clone()),
                    pid = ?stale.prior.as_ref().and_then(|(o, _)| o.pid),
                    epoch = self.epoch, generation,
                    duration_ms = now_ms.saturating_sub(since_ms),
                    outcome = "fenced", failure_reason = "STALE_STOP",
                    "an over-aged Stopping record whose stop operation vanished — \
                     the key fences TYPED (never stranded until restart)");
                out.push(stale);
            }
        }
        out
    }

    /// Register the in-flight `Starting` operation's partial-runtime
    /// identity (round-2 review): called the moment the spawn produced
    /// its child (sidecar/PTY) but before `commit_live`, so the watchdog
    /// host can kill it during settle. Fenced to the operation id +
    /// generation.
    pub fn register_partial_runtime(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        owner: OwnerIdentity,
    ) {
        let mut inner = self.lock_records();
        if let Some(record) = inner.get_mut(&SessionKey::new(provider, session_id)) {
            if let OwnershipState::Starting {
                operation_id: op,
                generation: gen,
                ..
            } = &record.state
            {
                if op == operation_id && *gen == generation {
                    record.partial_runtime = Some(owner);
                }
            }
        }
    }

    /// The bounded Starting-state timeout watchdog, CANCELLATION-FIRST
    /// (round-2 review: the sweep never flips a still-running spawn to
    /// `Vacant` underneath it — that would grant a second writer while the
    /// first keeps spawning). An over-aged `Starting` record transitions to
    /// `Stopping { owner: partial_runtime, operation_id, generation, .. }`
    /// (generation preserved; new claims are Blocked during the settle
    /// window — the existing stop-path semantics), and the returned
    /// `RecoveredStart` carries the registered cancellation handle and
    /// partial-runtime identity. The HOST (Task 3's main.rs: 5s sweep, 30s
    /// max age) then aborts the operation, awaits its settle, kills the
    /// registered partial runtime if any, and finishes with `commit_stop`
    /// → `Vacant` + the typed `ownership.start.recovered` failure log.
    /// b8ke ext r16 F4, REMOVED b8ke ext r33 F1: the standalone
    /// acknowledged-start vacate (`acknowledge_cleared_unverified` —
    /// `Fenced{ClearedUnverified} → plain Vacant` with NO kill) is
    /// DELETED: it licensed a second writer over a possibly-live first
    /// one with nothing but the operator's risk-acceptance between
    /// them — the same violation
    /// [`RuntimeOwnershipRegistry::begin_handoff_acknowledged_cleared_unverified`]
    /// carried pre-r33. The ONE acknowledged start is the r33
    /// FORCED-REAP-THEN-START handoff enter: the prior (and its
    /// descendant tree, through the runner's tree-kill) is killed and
    /// confirmed dead BEFORE the new writer spawns, and an unconfirmable
    /// kill lands the SAME typed fenced family again — never a
    /// plain-Vacant bypass. (The r16/r17 tests that drove the deleted
    /// API's vacate semantics are reshaped onto the new contract: the
    /// acknowledged start now carries the prior as the reap target.)
    pub fn recover_stale_starts(&self, now_ms: u64, max_age_ms: u64) -> Vec<RecoveredStart> {
        let mut inner = self.lock_records();
        let mut recovered = Vec::new();
        for (key, record) in inner.iter_mut() {
            if let OwnershipState::Starting {
                kind,
                operation_id,
                generation,
                initiator,
                since_ms,
            } = record.state.clone()
            {
                if now_ms.saturating_sub(since_ms) >= max_age_ms {
                    // b8ke ext r20 F1: consult the start's SETTLEMENT
                    // EVIDENCE before converting on age — the e3r3 F7
                    // stop-sweep discipline. A registered settle flag
                    // that has NOT fired means the start's handler is
                    // STILL RUNNING (a slow-but-live start: the WS/REST
                    // managed codex launch planning takes multiple
                    // 45-second attempts, enabled by default, while this
                    // sweep declares unwitnessed starts stale at 30s) —
                    // a legitimate in-progress start the watchdog does
                    // NOT fence (pre-r20 the sweep converted EVERY
                    // over-age Starting unconditionally, so an ordinary
                    // slow launch was fenced Fenced{StaleStart}
                    // mid-planning with no probe evidence, wedging the
                    // session until restart and stale-rejecting the
                    // eventual commit). Only a FIRED flag (the handler
                    // unwound without commit) or an UNREGISTERED start
                    // (a pre-witness path) converts — the watchdog's
                    // zombie authority is untouched.
                    if let Some(flag) = record.settle_fired.as_ref() {
                        if !flag.load(std::sync::atomic::Ordering::SeqCst) {
                            tracing::info!(target: "freshell_ownership",
                                event = "ownership.start.stale_start_skipped_live",
                                operation_id = %operation_id,
                                provider = %key.provider,
                                session_id = %key.session_id,
                                initiator = %initiator,
                                from_kind = ?Some(kind),
                                to_kind = ?Option::<RuntimeOwnerKind>::None,
                                runtime_id = ?Option::<String>::None,
                                pid = ?Option::<u32>::None,
                                epoch = self.epoch, generation,
                                duration_ms = now_ms.saturating_sub(since_ms),
                                outcome = "skipped",
                                failure_reason = "START_HANDLER_STILL_RUNNING",
                                "the over-age start's settle witness is armed and NOT \
                                 fired — the handler still runs; a slow launch is a \
                                 legitimate in-progress start the watchdog does not fence");
                            continue;
                        }
                    }
                    let cancellation = record.cancellation.take();
                    let settle = record.settle.take();
                    let partial_runtime = record.partial_runtime.take();
                    record.state = OwnershipState::Stopping {
                        owner: partial_runtime.clone(),
                        // A zombie-`Starting` synthesis has no prior Live
                        // era — the host's abort/settle/commit owns this
                        // transition; `abort_stop` is a typed no-op here.
                        prior_generation: None,
                        operation_id: operation_id.clone(),
                        generation,
                        initiator: initiator.clone(),
                        since_ms,
                    };
                    // b8ke ext r7 F4: the UNIFORM transition schema —
                    // the sweep's synthesized Stopping transition carries
                    // the recorded start kind and the None-valued
                    // to-kind/identity (nothing spawned).
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.start.recovery_started",
                        operation_id = %operation_id,
                        provider = %key.provider, session_id = %key.session_id,
                        initiator = %initiator, from_kind = ?kind,
                        to_kind = ?Option::<RuntimeOwnerKind>::None,
                        runtime_id = ?Option::<String>::None, pid = ?Option::<u32>::None,
                        epoch = self.epoch, generation,
                        outcome = "stopping_stale_start",
                        duration_ms = now_ms.saturating_sub(since_ms),
                        failure_reason = "STARTING_TIMEOUT");
                    recovered.push(RecoveredStart {
                        provider: key.provider.clone(),
                        session_id: key.session_id.clone(),
                        since_ms,
                        operation_id,
                        generation,
                        kind,
                        initiator,
                        cancellation,
                        settle,
                        partial_runtime,
                    });
                }
            }
        }
        recovered
    }

    /// Side-effect-free read for snapshot GETs and reconcile verdicts.
    /// The reported `generation` is the fence-relevant one (see
    /// [`snapshot_generation`]): the Live state's own for Live keys.
    pub fn observe(&self, provider: &str, session_id: &str) -> OwnershipSnapshot {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        match inner.get(&SessionKey::new(provider, session_id)) {
            Some(record) => OwnershipSnapshot {
                epoch: self.epoch,
                generation: snapshot_generation(record),
                state: record.state.clone(),
            },
            None => OwnershipSnapshot {
                epoch: self.epoch,
                generation: 0,
                state: OwnershipState::Vacant,
            },
        }
    }

    /// Replay every recorded key's current owner (kata b8ke): the WS
    /// handshake builder serializes this into `ready.runtimeOwners` so a
    /// device that missed a handoff broadcast (offline during handoff,
    /// lag-4008 disconnect, page reload) learns the authoritative owner on
    /// reconnect. Vacant keys replay as "vacant" to CLEAR stale divergence.
    /// Sync; the lock is never held across an await.
    ///
    /// b8ke focused round-3 review R3-5: a FENCED record replays its
    /// truth — `state: "fenced"` + the typed reason, with `owner_kind`
    /// naming the fenced PRIOR (the owner the handoff-failed frames
    /// already named on every device). The client folds a fenced record as
    /// the typed recovery state (handoff-failed + reason), NEVER as a
    /// committed live owner.
    ///
    /// b8ke focused round-4 review R4-6: the in-progress lifecycle states
    /// (`Starting`/`Handoff`/`Stopping`) replay as their OWN states —
    /// a reconnecting device folds them as transition-in-progress, never
    /// as committed live ownership.
    /// b8ke focused episode-2 post-cap F5: the replay fields for one
    /// state — shared by the direct replay arms and the ALIASED key's
    /// canonical resolution (the old key replays exactly what the
    /// canonical record would).
    fn replay_fields_for(
        state: &OwnershipState,
    ) -> (
        &'static str,
        Option<String>,
        ReplayOwnerState,
        Option<String>,
    ) {
        match state {
            OwnershipState::Vacant | OwnershipState::Aliased { .. } => {
                ("vacant", None, ReplayOwnerState::Live, None)
            }
            OwnershipState::Live { owner, .. } => (
                kind_wire(&owner.kind),
                owner.terminal_id.clone(),
                ReplayOwnerState::Live,
                None,
            ),
            OwnershipState::Starting { kind, .. } => {
                (kind_wire(kind), None, ReplayOwnerState::Starting, None)
            }
            OwnershipState::Handoff { to_kind, .. } => {
                (kind_wire(to_kind), None, ReplayOwnerState::Handoff, None)
            }
            OwnershipState::Stopping { owner, .. } => match owner {
                Some(owner) => (
                    kind_wire(&owner.kind),
                    owner.terminal_id.clone(),
                    ReplayOwnerState::Stopping,
                    None,
                ),
                None => ("vacant", None, ReplayOwnerState::Stopping, None),
            },
            OwnershipState::Fenced {
                prior,
                reason: fence_reason,
                ..
            } => {
                let wire_reason = Some(fence_reason.wire_str().to_string());
                match prior {
                    Some((owner, _)) => (
                        kind_wire(&owner.kind),
                        owner.terminal_id.clone(),
                        ReplayOwnerState::Fenced,
                        wire_reason,
                    ),
                    None => ("vacant", None, ReplayOwnerState::Fenced, wire_reason),
                }
            }
        }
    }

    /// b8ke focused episode-2 post-cap F5: the fixpoint alias walk under
    /// the caller's already-held lock (the public `resolve_canonical`
    /// re-locks; this one is for `snapshot_records`'s single pass).
    fn resolve_canonical_locked(
        inner: &std::collections::HashMap<SessionKey, SessionRecord>,
        provider: &str,
        session_id: &str,
    ) -> String {
        let mut current = session_id.to_string();
        let mut visited = std::collections::HashSet::new();
        loop {
            if !visited.insert(current.clone()) {
                break;
            }
            let aliased_to = match inner.get(&SessionKey::new(provider, &current)) {
                Some(record) => match &record.state {
                    OwnershipState::Aliased { to, .. } => Some(to.clone()),
                    _ => None,
                },
                None => None,
            };
            match aliased_to {
                Some(next) => current = next,
                None => break,
            }
        }
        current
    }

    pub fn snapshot_records(&self) -> Vec<RuntimeOwnerReplayRecord> {
        let inner = self.inner.lock().expect("ownership lock poisoned");
        inner
            .iter()
            .map(|(key, record)| {
                // b8ke focused episode-2 post-cap F5: an ALIASED key
                // replays the CANONICAL record's resolved truth (the
                // server walks the fixpoint) plus `alias_of` — the old key
                // is never a permanent "vacant" for a stale pane; it folds
                // the authoritative owner state and can navigate to the
                // canonical id.
                // b8ke delta round-3 F6: an ALIASED key derives ALL of
                // its replayed truth — aliasOf, owner fields, AND
                // generation — from the SAME fixpoint target. The
                // pre-fix shape resolved aliasOf to the final canonical
                // id but read the owner fields from the IMMEDIATE hop: a
                // multi-hop chain A→B→C replayed A as aliasOf:C while
                // deriving ownership from B (itself Aliased → vacant) —
                // an offline device holding A got contradictory state and
                // never converged on C. One resolve, one read: the
                // record the client can navigate to is exactly the record
                // whose truth it folds.
                let (alias_of, owner_kind, terminal_id, replay_state, reason, generation) =
                    match &record.state {
                        OwnershipState::Aliased { to, .. } => {
                            let canonical =
                                Self::resolve_canonical_locked(&inner, &key.provider, to);
                            let resolved = inner.get(&SessionKey::new(&key.provider, &canonical));
                            match resolved {
                                Some(resolved) => {
                                    let (kind, tid, st, rsn) =
                                        Self::replay_fields_for(&resolved.state);
                                    (
                                        Some(canonical),
                                        kind,
                                        tid,
                                        st,
                                        rsn,
                                        snapshot_generation(resolved),
                                    )
                                }
                                // The canonical record is absent
                                // (post-restart residue): the honest
                                // vacant truth.
                                None => (
                                    Some(canonical),
                                    "vacant",
                                    None,
                                    ReplayOwnerState::Live,
                                    None,
                                    snapshot_generation(record),
                                ),
                            }
                        }
                        _ => {
                            let (kind, tid, st, rsn) = Self::replay_fields_for(&record.state);
                            (None, kind, tid, st, rsn, snapshot_generation(record))
                        }
                    };
                RuntimeOwnerReplayRecord {
                    provider: key.provider.clone(),
                    session_id: key.session_id.clone(),
                    epoch: self.epoch,
                    generation,
                    owner_kind: owner_kind.to_string(),
                    terminal_id,
                    state: replay_state,
                    reason,
                    alias_of,
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod unit_scope_tests;

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;

    use crate::*;

    const PROVIDER: &str = "codex";

    /// kata b8ke (Task 11 e2e red): the DEFAULT boot epoch must stay inside
    /// the JSON-safe integer range. Every browser client parses the epoch
    /// as an IEEE-754 double (JSON.parse) — and the ready-frame schema's
    /// zod v4 `.int()` enforces exactly this bound — so a full-64-bit epoch
    /// is either silently dropped from `ready.runtimeOwners` (the array's
    /// `.catch(undefined)` swallows the whole replay) or rounds to a
    /// DIFFERENT integer in any `observedEpoch` fence the client sends
    /// back, poisoning every fence comparison. Injected epochs
    /// (`with_epoch`) stay unconstrained by contract.
    #[test]
    fn default_boot_epoch_fits_the_json_safe_integer_range() {
        for _ in 0..64 {
            assert!(
                default_boot_epoch() <= 9_007_199_254_740_991,
                "the default boot epoch must survive the JS double/zod safe-int round trip"
            );
        }
    }

    fn registry_with_live_terminal() -> (RuntimeOwnershipRegistry, OwnerIdentity, u64) {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-1",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-1".into()),
            live_session_key: None,
            pid: Some(4242),
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        assert_eq!(
            r.commit_live(PROVIDER, "sid", "op-1", generation, owner.clone()),
            CommitOutcome::Committed
        );
        (r, owner, generation)
    }

    /// The fencing claim an exit watcher carries: the operation that
    /// committed the runtime, the generation it committed under, and the
    /// runtime identity. (commit_live stamps `ownership_id` from the
    /// operation — round-1 review.)
    fn watcher_claim(owner: &OwnerIdentity, operation_id: &str, generation: u64) -> ReleaseClaim {
        ReleaseClaim {
            operation_id: operation_id.to_string(),
            generation,
            runtime: Some(owner.clone()),
        }
    }

    /// The fenced stop claim (round-2 review): the stopper's believed owner
    /// identity plus the (epoch, generation) it observed when it decided
    /// to act.
    fn stop_claim(owner: &OwnerIdentity, epoch: u64, generation: u64) -> StopClaim {
        StopClaim {
            expected_kind: owner.kind,
            expected_runtime: Some(owner.clone()),
            observed: ObservedFence { epoch, generation },
        }
    }

    fn fresh_agent_owner(pid: u32) -> OwnerIdentity {
        OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("freshcodex:sid".into()),
            pid: Some(pid),
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        }
    }

    /// The identity `commit_live` stamps from the committing operation (the
    /// release fence key, round-1 review) — the identity observers of the
    /// live owner (AdoptLive, restore-on-failed-handoff) learn back.
    fn stamped(mut owner: OwnerIdentity, operation_id: &str) -> OwnerIdentity {
        owner.ownership_id = Some(operation_id.to_string());
        owner
    }

    /// One captured `tracing` event: the level, target, the crate-convention
    /// `event` field's value, every visited field name, and every field's
    /// rendered value. The M2/N1 log-hygiene regression tests assert names
    /// through this; the b8ke ext F3 stable-schema tests assert VALUES.
    #[derive(Debug, Clone)]
    struct CapturedEvent {
        level: tracing::Level,
        target: String,
        event: Option<String>,
        fields: Vec<String>,
        values: std::collections::BTreeMap<String, String>,
    }

    /// A subscriber capturing every event fired on the installing thread.
    /// The crate never installs its own subscriber (the host owns the
    /// global one), so tests pin log levels and field presence through a
    /// thread-local `set_default`.
    #[derive(Clone, Default)]
    struct EventCapture {
        events: Arc<Mutex<Vec<CapturedEvent>>>,
    }

    impl EventCapture {
        fn install(&self) -> tracing::subscriber::DefaultGuard {
            tracing::subscriber::set_default(self.clone())
        }

        fn events(&self) -> Vec<CapturedEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    impl tracing::Subscriber for EventCapture {
        fn enabled(&self, _metadata: &tracing::Metadata<'_>) -> bool {
            true
        }

        fn new_span(&self, _span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }

        fn record(&self, _span: &tracing::span::Id, _values: &tracing::span::Record<'_>) {}

        fn record_follows_from(&self, _span: &tracing::span::Id, _follows: &tracing::span::Id) {}

        fn event(&self, event: &tracing::Event<'_>) {
            let mut visitor = EventFieldVisitor::default();
            event.record(&mut visitor);
            self.events.lock().unwrap().push(CapturedEvent {
                level: *event.metadata().level(),
                target: event.metadata().target().to_string(),
                event: visitor.event,
                fields: visitor.fields,
                values: visitor.values,
            });
        }

        fn enter(&self, _span: &tracing::span::Id) {}

        fn exit(&self, _span: &tracing::span::Id) {}
    }

    /// Collects every visited field name plus the `event` field's value.
    /// `record_debug` is the `Visit` trait's only required method — the
    /// typed `record_*` defaults all funnel through it — so implementing
    /// `record_debug` and `record_str` (raw string for the `event` name)
    /// sees every field the macros record.
    #[derive(Default)]
    struct EventFieldVisitor {
        event: Option<String>,
        fields: Vec<String>,
        values: std::collections::BTreeMap<String, String>,
    }

    impl tracing::field::Visit for EventFieldVisitor {
        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
            if field.name() == "event" {
                self.event = Some(format!("{value:?}"));
            }
            // b8ke ext F3: the rendered VALUE of every visited field (the
            // kind-VALUE assertions the stable-schema contract tests need).
            self.values
                .insert(field.name().to_string(), format!("{value:?}"));
            self.fields.push(field.name().to_string());
        }

        fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
            if field.name() == "event" {
                self.event = Some(value.to_string());
            }
            self.values
                .insert(field.name().to_string(), value.to_string());
            self.fields.push(field.name().to_string());
        }
    }

    #[test]
    fn concurrent_terminal_and_fresh_agent_start_yield_exactly_one_grant() {
        let r = Arc::new(RuntimeOwnershipRegistry::new());
        // Every Granted holder increments; a second concurrent grant observes >0 and fails.
        let live_holders = Arc::new(AtomicUsize::new(0));
        let violations = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for i in 0..200 {
            let r = Arc::clone(&r);
            let live_holders = Arc::clone(&live_holders);
            let violations = Arc::clone(&violations);
            handles.push(thread::spawn(move || {
                let kind = if i % 2 == 0 {
                    RuntimeOwnerKind::Terminal
                } else {
                    RuntimeOwnerKind::FreshAgent
                };
                let op = format!("op-{i}");
                if let BeginOutcome::Granted { generation } =
                    r.begin_start(PROVIDER, "sid", kind, &op, None, "stress", i as u64)
                {
                    if live_holders.fetch_add(1, Ordering::SeqCst) != 0 {
                        violations.fetch_add(1, Ordering::SeqCst);
                    }
                    for _ in 0..50 {
                        std::hint::spin_loop();
                    }
                    // Decrement BEFORE the fail (round-1 review): between fail()
                    // and a late decrement another valid grant could observe a
                    // stale nonzero count — a false double-owner violation. While
                    // the key is still Starting no other grant can happen, so
                    // decrement-then-fail has no window at all.
                    live_holders.fetch_sub(1, Ordering::SeqCst);
                    let _ = r.fail(PROVIDER, "sid", &op, generation, false);
                }
            }));
        }
        for h in handles {
            h.join().expect("worker panicked");
        }
        assert_eq!(
            violations.load(Ordering::SeqCst),
            0,
            "two writers were Granted simultaneously"
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    #[test]
    fn concurrent_handoffs_in_opposite_directions_yield_one_grant() {
        let r = Arc::new(RuntimeOwnershipRegistry::new());
        let grants = Arc::new(Mutex::new(Vec::<RuntimeOwnerKind>::new()));
        let mut handles = Vec::new();
        for i in 0..100usize {
            let r = Arc::clone(&r);
            let grants = Arc::clone(&grants);
            handles.push(thread::spawn(move || {
                let to = if i % 2 == 0 {
                    RuntimeOwnerKind::Terminal
                } else {
                    RuntimeOwnerKind::FreshAgent
                };
                if let BeginOutcome::Granted { .. } =
                    r.begin_handoff(PROVIDER, "sid", to, &format!("ho-{i}"), None, "stress", 1)
                {
                    grants.lock().unwrap().push(to);
                }
            }));
        }
        for h in handles {
            h.join().expect("worker panicked");
        }
        let grants = grants.lock().unwrap().clone();
        assert_eq!(
            grants.len(),
            1,
            "exactly one handoff may be granted, got {grants:?}"
        );
    }

    #[test]
    fn same_kind_duplicate_attach_converges_on_one_live_runtime() {
        let (r, owner, generation) = registry_with_live_terminal();
        let second = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-2",
            None,
            "test",
            2_000,
        );
        // AdoptLive returns the STORED owner — including the `ownership_id`
        // commit_live stamped from the committing operation ("op-1").
        assert_eq!(
            second,
            BeginOutcome::AdoptLive {
                owner: stamped(owner, "op-1"),
                generation
            }
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Live { .. }
        ));
    }

    /// kata b8ke Task 6: the handoff runner reads the captured prior (and its
    /// pre-handoff Live generation) off the `Handoff` state — and only there.
    #[test]
    fn prior_owner_is_the_handoff_states_captured_prior_and_its_generation() {
        let (r, owner, live_gen) = registry_with_live_terminal();
        let BeginOutcome::Granted { .. } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2_000,
        ) else {
            panic!("expected Granted")
        };
        let snap = r.observe(PROVIDER, "sid");
        assert_eq!(
            snap.state.prior_owner(),
            Some((stamped(owner, "op-1"), live_gen)),
            "the Handoff state carries the pre-handoff Live owner and ITS generation"
        );
        // Every other state carries no prior (Vacant before any claim; the
        // Live and Starting states of a fresh key).
        assert_eq!(OwnershipState::Vacant.prior_owner(), None);
        let r2 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r2.begin_start(
            PROVIDER,
            "other",
            RuntimeOwnerKind::Terminal,
            "op-a",
            None,
            "test",
            1,
        ) else {
            panic!("expected Granted")
        };
        let _ = r2.commit_live(
            PROVIDER,
            "other",
            "op-a",
            generation,
            fresh_agent_owner(4321),
        );
        assert_eq!(
            r2.observe(PROVIDER, "other").state.prior_owner(),
            None,
            "Live is not a handoff — no prior"
        );
    }

    #[test]
    fn stop_crash_and_unfail_release_or_leave_recoverable_typed_state() {
        // Explicit stop: Live -> Stopping (kill happens while Stopping) ->
        // commit_stop -> Vacant ONLY after the confirmed reap. Never Vacant
        // before the reap (round-1 review).
        let (r, owner, live_gen) = registry_with_live_terminal();
        let gen = match r.begin_stop(
            PROVIDER,
            "sid",
            "kill-1",
            &stop_claim(&owner, r.boot_epoch(), live_gen),
            "test",
            1,
        ) {
            StopOutcome::Granted { generation } => generation,
            other => panic!("expected Granted, got {other:?}"),
        };
        // While Stopping, competing starts are Blocked — the key is not Vacant.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::FreshAgent,
                "op-x",
                None,
                "test",
                2
            ),
            BeginOutcome::Blocked { .. }
        ));
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Stopping { .. }
        ));
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-1", gen),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);

        // A stop attempted during another operation's Handoff is TYPED Blocked
        // and the caller must NOT kill (round-1 review).
        let (r, owner, live_gen) = registry_with_live_terminal();
        let BeginOutcome::Granted { .. } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert!(matches!(
            r.begin_stop(
                PROVIDER,
                "sid",
                "kill-2",
                &stop_claim(&owner, r.boot_epoch(), live_gen),
                "test",
                3
            ),
            StopOutcome::BlockedHandoff { .. }
        ));
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Handoff { .. }
        ));

        // A DELAYED cross-kind kill is fenced (round-2 review): after a
        // fresh-agent owner took over, a stale fresh-agent StopClaim is the
        // typed StaleClaim and the caller must NOT kill — the terminal owner
        // survives untouched.
        let (r, _owner, _) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g2 } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-x",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        let fresh_owner = fresh_agent_owner(77);
        assert_eq!(
            r.commit_live(PROVIDER, "sid", "ho-x", g2, fresh_owner.clone()),
            CommitOutcome::Committed
        );
        let stale_terminal_kill = stop_claim(
            &OwnerIdentity {
                kind: RuntimeOwnerKind::Terminal,
                terminal_id: Some("t-1".into()),
                live_session_key: None,
                pid: Some(4242),
                ownership_id: None,
                unit_id: None,
                hold: HoldKind::Main,
            },
            r.boot_epoch(),
            1,
        );
        assert!(
            matches!(
                r.begin_stop(
                    PROVIDER,
                    "sid",
                    "kill-late",
                    &stale_terminal_kill,
                    "test",
                    3
                ),
                StopOutcome::StaleClaim { .. }
            ),
            "a mismatched stop claim must never claim Stopping"
        );
        assert!(
            matches!(
                r.observe(PROVIDER, "sid").state,
                OwnershipState::Live { .. }
            ),
            "the stale kill must not have transitioned or killed the fresh owner"
        );

        // Crash (exit-watcher release): Live -> Vacant, generation preserved
        // (monotonic). The release carries the fencing claim — the committing
        // operation, the generation, and the runtime identity (round-1 review).
        let (r, owner, generation) = registry_with_live_terminal();
        r.release(
            PROVIDER,
            "sid",
            &watcher_claim(&owner, "op-1", generation),
            "exit-watcher",
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        assert!(r.observe(PROVIDER, "sid").generation >= 1);

        // A DELAYED watcher cannot erase a newer owner: after a re-start under a
        // new generation, the old claim is a typed no-op (round-1 review).
        let BeginOutcome::Granted { generation: g2 } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-new",
            None,
            "test",
            4,
        ) else {
            panic!()
        };
        let fresh_owner = fresh_agent_owner(99);
        assert_eq!(
            r.commit_live(PROVIDER, "sid", "op-new", g2, fresh_owner.clone()),
            CommitOutcome::Committed
        );
        r.release(
            PROVIDER,
            "sid",
            &watcher_claim(&owner, "op-1", generation),
            "exit-watcher",
        );
        assert!(
            matches!(
                r.observe(PROVIDER, "sid").state,
                OwnershipState::Live { .. }
            ),
            "a stale watcher release must never erase the newer owner"
        );

        // Holder panics/never completes: state stays Starting (typed Blocked for
        // the next claimant — recoverable, never a second grant) until the
        // fenced force-release (matched on operation id + generation).
        let r = RuntimeOwnershipRegistry::new();
        let g_zombie = match r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-zombie",
            None,
            "test",
            1,
        ) {
            BeginOutcome::Granted { generation } => generation,
            other => panic!("expected Granted, got {other:?}"),
        };
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "op-2",
                None,
                "test",
                2
            ),
            BeginOutcome::Blocked { .. }
        ));
        // A force-release fenced to a DIFFERENT operation is a no-op.
        r.force_release_for_confirmed_kill(
            PROVIDER,
            "sid",
            &ReleaseClaim {
                operation_id: "op-other".into(),
                generation: g_zombie,
                runtime: None,
            },
            "ttl-recovery",
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Starting { .. }
        ));
        // The matched force-release recovers the zombie ticket.
        r.force_release_for_confirmed_kill(
            PROVIDER,
            "sid",
            &ReleaseClaim {
                operation_id: "op-zombie".into(),
                generation: g_zombie,
                runtime: None,
            },
            "ttl-recovery",
        );
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "op-3",
                None,
                "test",
                3
            ),
            BeginOutcome::Granted { .. }
        ));
    }

    #[test]
    fn operation_ticket_drop_releases_a_panicked_claim_and_the_watchdog_recovers_leaked_starts() {
        // RAII (round-1 review): dropping an un-disarmed ticket performs the
        // typed fail, so a panicked spawn cannot wedge the session. The
        // ticket WRAPS a granted claim — begin first, then guard it.
        let r = Arc::new(RuntimeOwnershipRegistry::new());
        {
            let BeginOutcome::Granted { generation } = r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "op-panic",
                None,
                "test",
                1,
            ) else {
                panic!("expected Granted")
            };
            let ticket = OperationTicket::new(
                Arc::clone(&r),
                PROVIDER,
                "sid",
                "op-panic",
                RuntimeOwnerKind::Terminal,
                generation,
                "test",
            );
            assert!(matches!(
                r.observe(PROVIDER, "sid").state,
                OwnershipState::Starting { .. }
            ));
            drop(ticket); // no disarm — the simulated panic
        }
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        // Watchdog backstop (round-2 review: CANCEL first, never Vacant under
        // a live spawn): a LEAKED ticket (guard never ran — e.g. a detached
        // task killed without unwind) whose spawn is STILL RUNNING crosses the
        // threshold; the sweep holds Stopping (blocking new claims), hands the
        // registered cancellation to the host, and only the host's confirmed
        // settle + commit_stop reopens the key.
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-leak",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let aborted = Arc::new(AtomicBool::new(false));
        let abort = {
            let aborted = Arc::clone(&aborted);
            Arc::new(move || aborted.store(true, Ordering::SeqCst))
        };
        r.register_start_cancellation(
            PROVIDER,
            "sid",
            "op-leak",
            generation,
            abort,
            Box::new(std::future::ready(())),
            None,
        );
        let partial = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-partial".into()),
            live_session_key: None,
            pid: Some(555),
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        r.register_partial_runtime(PROVIDER, "sid", "op-leak", generation, partial.clone());
        let recovered = r.recover_stale_starts(0, 0); // everything is over-aged at now=0
        assert!(recovered.iter().any(|rec| rec.provider == PROVIDER
            && rec.session_id == "sid"
            && rec.operation_id == "op-leak"));
        // Mid-settle: the key is Stopping — a second writer is Blocked.
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Stopping { .. }
        ));
        assert!(
            matches!(
                r.begin_start(
                    PROVIDER,
                    "sid",
                    RuntimeOwnerKind::FreshAgent,
                    "op-second",
                    None,
                    "test",
                    1
                ),
                BeginOutcome::Blocked { .. }
            ),
            "no second writer may be granted while the stale spawn is being cancelled"
        );
        // The host aborts, awaits settle, and commits — only then Vacant.
        let rec = recovered.into_iter().next().unwrap();
        assert!(
            rec.cancellation.is_some(),
            "the watchdog must hand the abort handle to the host"
        );
        assert_eq!(
            rec.partial_runtime,
            Some(partial),
            "the registered partial runtime must flow to the host for the settle kill"
        );
        (rec.cancellation.unwrap())();
        assert!(
            aborted.load(Ordering::SeqCst),
            "the watchdog must abort the still-running operation"
        );
        assert!(matches!(
            r.commit_stop(PROVIDER, "sid", "op-leak", generation),
            CommitOutcome::Committed
        ));
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::FreshAgent,
                "op-after",
                None,
                "test",
                2
            ),
            BeginOutcome::Granted { .. }
        ));
    }

    /// b8ke focused episode-2 round-3 F1: `rekey_live` — the Adopt-path
    /// move the claude rollback's NORMAL live-rollback takes (its lane
    /// claim observes the existing Live{FreshAgent} owner and answers
    /// Adopt with NO ticket; pre-e2r3 the lane helper reported success
    /// without doing ANYTHING, leaving ownership + stamp under the old id
    /// while the client pane carried the new id — the deterministic
    /// split identity). The Live record moves old→new atomically; the
    /// old key becomes Aliased{to: new}; an occupied target key refuses
    /// typed; a non-Live old key refuses typed.
    #[test]
    fn rekey_live_moves_the_live_record_and_refuses_typed() {
        let r = RuntimeOwnershipRegistry::new();
        // A LIVE owner under the old id (the post-Adopt rollback shape).
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "old-live",
            RuntimeOwnerKind::FreshAgent,
            "op-original",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("map-key".into()),
            pid: Some(4321),
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        assert!(matches!(
            r.commit_live(PROVIDER, "old-live", "op-original", generation, owner),
            CommitOutcome::Committed
        ));

        // THE MOVE (e2 post-cap F1 contract): the expected owner verifies
        // (kind + THIS session's map key); the REPLACEMENT identity lands
        // under the new id — the CURRENT pid (9999), ONE consistent
        // operation id the retained stamp reuses — and the generation
        // INCREMENTS (a stale-generation observer is refused by
        // arithmetic).
        let replacement = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("map-key".into()),
            pid: Some(9999),
            ownership_id: Some("rekey-op-1".into()),
            unit_id: None,
            hold: HoldKind::Main,
        };
        assert!(matches!(
            r.rekey_live(
                PROVIDER,
                "old-live",
                "new-live",
                "map-key",
                replacement.clone(),
                "test-rekey",
                "rekey-op-1"
            ),
            CommitOutcome::Committed
        ));
        let observed_new = r.observe(PROVIDER, "new-live");
        match observed_new.state {
            OwnershipState::Live {
                owner: moved,
                generation: live_gen,
                ..
            } => {
                // Identities MUST match the replacement — never the dead
                // old pid, never a fabricated operation id.
                assert_eq!(moved.kind, RuntimeOwnerKind::FreshAgent);
                assert_eq!(moved.live_session_key.as_deref(), Some("map-key"));
                assert_eq!(moved.pid, Some(9999));
                assert_eq!(moved.ownership_id.as_deref(), Some("rekey-op-1"));
                assert_eq!(
                    live_gen,
                    generation + 1,
                    "the rekey increments the generation"
                );
            }
            other => panic!("expected Live under the new id, got {other:?}"),
        }
        assert!(matches!(
            r.observe(PROVIDER, "old-live").state,
            OwnershipState::Aliased { to, .. } if to == "new-live"
        ));
        assert_eq!(r.resolve_canonical(PROVIDER, "old-live"), "new-live");

        // e2 post-cap F1: a subsequent KILL succeeds against the moved
        // record — the stop claim's expected runtime MATCHES (the
        // replacement identity), the typed stop proceeds.
        let stop_claim = StopClaim {
            expected_kind: RuntimeOwnerKind::FreshAgent,
            expected_runtime: Some(replacement.clone()),
            observed: ObservedFence {
                epoch: r.boot_epoch(),
                generation: generation + 1,
            },
        };
        match r.begin_stop(PROVIDER, "new-live", "test-kill", &stop_claim, "test", 0) {
            StopOutcome::Granted {
                generation: stop_gen,
            } => {
                assert!(matches!(
                    r.commit_stop(PROVIDER, "new-live", "test-kill", stop_gen),
                    CommitOutcome::Committed
                ));
            }
            other => panic!("the kill after rekey must be granted, got {other:?}"),
        }
        assert!(matches!(
            r.observe(PROVIDER, "new-live").state,
            OwnershipState::Vacant
        ));

        // e2 post-cap F1: EXIT-AFTER-REKEY releases. A SECOND live owner
        // under a fresh old key (the first old key is Aliased-retired —
        // begin refuses typed on a superseded id by design), then the
        // normal sidecar-exit path (force_release with the RETAINED
        // STAMP's operation id + runtime identity — the stamp and the
        // record share the SAME consistent rekey identity) must release
        // the owner.
        let replacement_2 = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("map-key-2".into()),
            pid: Some(1111),
            ownership_id: Some("rekey-op-2".into()),
            unit_id: None,
            hold: HoldKind::Main,
        };
        let BeginOutcome::Granted { generation: g2 } = r.begin_start(
            PROVIDER,
            "old-live-b",
            RuntimeOwnerKind::FreshAgent,
            "op-original-2",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "old-live-b",
                "op-original-2",
                g2,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("map-key-2".into()),
                    pid: Some(4321),
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                }
            ),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r.rekey_live(
                PROVIDER,
                "old-live-b",
                "new-live-2",
                "map-key-2",
                replacement_2.clone(),
                "test-rekey-2",
                "rekey-op-2"
            ),
            CommitOutcome::Committed
        ));
        let exit_release = ReleaseClaim {
            operation_id: "rekey-op-2".to_string(),
            generation: g2 + 1,
            runtime: Some(replacement_2.clone()),
        };
        r.force_release_for_confirmed_kill(PROVIDER, "new-live-2", &exit_release, "claude-exit");
        assert!(
            matches!(
                r.observe(PROVIDER, "new-live-2").state,
                OwnershipState::Vacant
            ),
            "the exit/crash release after rekey must release the moved owner — \
             the stamp id and the record ownership_id are ONE identity"
        );

        // An OCCUPIED target key refuses typed — never an overwrite.
        let r2 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: ga } = r2.begin_start(
            PROVIDER,
            "old-2",
            RuntimeOwnerKind::FreshAgent,
            "op-a",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let owner_a = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("map-a".into()),
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        assert!(matches!(
            r2.commit_live(PROVIDER, "old-2", "op-a", ga, owner_a),
            CommitOutcome::Committed
        ));
        let BeginOutcome::Granted { generation: gb } = r2.begin_start(
            PROVIDER,
            "target-2",
            RuntimeOwnerKind::Terminal,
            "op-b",
            None,
            "test",
            1,
        ) else {
            panic!()
        };
        let owner_b = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-b".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        assert!(matches!(
            r2.commit_live(PROVIDER, "target-2", "op-b", gb, owner_b),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r2.rekey_live(
                PROVIDER,
                "old-2",
                "target-2",
                "map-a",
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("map-a".into()),
                    pid: Some(7777),
                    ownership_id: Some("rekey-op-x".into()),
                    unit_id: None,
                    hold: HoldKind::Main,
                },
                "test-rekey",
                "op-rekey"
            ),
            CommitOutcome::ForeignOperation
        ));
        match r2.observe(PROVIDER, "target-2").state {
            OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            }
            other => panic!("the foreign target must keep its owner, got {other:?}"),
        }

        // e2 post-cap F1: the EXPECTED-OWNER verification — a different
        // live session key under the old id (a foreign runtime this lane
        // does not own) refuses typed.
        let r4 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g4 } = r4.begin_start(
            PROVIDER,
            "old-4",
            RuntimeOwnerKind::FreshAgent,
            "op-4",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        assert!(matches!(
            r4.commit_live(
                PROVIDER,
                "old-4",
                "op-4",
                g4,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("foreign-map".into()),
                    pid: Some(4),
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                }
            ),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r4.rekey_live(
                PROVIDER,
                "old-4",
                "new-4",
                "this-lanes-map-key",
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("this-lanes-map-key".into()),
                    pid: Some(5),
                    ownership_id: Some("rekey-op-4".into()),
                    unit_id: None,
                    hold: HoldKind::Main,
                },
                "test-rekey",
                "op-rekey"
            ),
            CommitOutcome::ForeignOperation
        ));
        // And a TERMINAL owner under the old id (the handoff-committed-
        // in-the-window shape) refuses too.
        let r5 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g5 } = r5.begin_start(
            PROVIDER,
            "old-5",
            RuntimeOwnerKind::Terminal,
            "op-5",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        assert!(matches!(
            r5.commit_live(
                PROVIDER,
                "old-5",
                "op-5",
                g5,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-5".into()),
                    live_session_key: None,
                    pid: Some(5),
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                }
            ),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r5.rekey_live(
                PROVIDER,
                "old-5",
                "new-5",
                "any-map-key",
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("any-map-key".into()),
                    pid: Some(6),
                    ownership_id: Some("rekey-op-5".into()),
                    unit_id: None,
                    hold: HoldKind::Main,
                },
                "test-rekey",
                "op-rekey"
            ),
            CommitOutcome::ForeignOperation
        ));

        // A NON-LIVE (absent) old key refuses typed.
        let r3 = RuntimeOwnershipRegistry::new();
        assert!(matches!(
            r3.rekey_live(
                PROVIDER,
                "absent",
                "anywhere",
                "map-key",
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("map-key".into()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
                "test-rekey",
                "op-rekey"
            ),
            CommitOutcome::ForeignOperation
        ));
    }

    /// b8ke delta round-3 F6: MULTI-HOP alias replay. Consecutive rekeys
    /// A→B→C: the A-keyed record must derive ALL of its replayed truth
    /// (owner fields AND generation) from the FIXPOINT target C — the
    /// same id its aliasOf names. Pre-fix, A read the owner fields from
    /// the IMMEDIATE hop B (itself Aliased → rendered vacant) while
    /// aliasOf said C: an offline device holding A got contradictory
    /// state and never converged on C's live owner.
    #[test]
    fn multi_hop_alias_replay_derives_from_the_fixpoint_target() {
        let r = RuntimeOwnershipRegistry::new();

        fn live_owner(pid: u32) -> OwnerIdentity {
            OwnerIdentity {
                kind: RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: Some("map-key".into()),
                pid: Some(pid),
                ownership_id: Some("own-1".into()),
                unit_id: None,
                hold: HoldKind::Main,
            }
        }
        fn seed_live(r: &RuntimeOwnershipRegistry, id: &str, op: &str) -> u64 {
            let BeginOutcome::Granted { generation } = r.begin_start(
                PROVIDER,
                id,
                RuntimeOwnerKind::FreshAgent,
                op,
                None,
                "test",
                0,
            ) else {
                panic!("expected Granted for {id}")
            };
            assert!(matches!(
                r.commit_live(PROVIDER, id, op, generation, live_owner(1000)),
                CommitOutcome::Committed
            ));
            generation
        }

        // A→B (the first rekey), then B→C (the second).
        seed_live(&r, "A", "op-a");
        assert!(matches!(
            r.rekey_live(
                PROVIDER,
                "A",
                "B",
                "map-key",
                live_owner(1001),
                "test-rekey-ab",
                "op-rekey-ab"
            ),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r.rekey_live(
                PROVIDER,
                "B",
                "C",
                "map-key",
                live_owner(1002),
                "test-rekey-bc",
                "op-rekey-bc"
            ),
            CommitOutcome::Committed
        ));

        let records = r.snapshot_records();
        // The fixpoint: both old keys name C.
        let rec_a = records
            .iter()
            .find(|rec| rec.session_id == "A")
            .expect("A replays");
        let rec_b = records
            .iter()
            .find(|rec| rec.session_id == "B")
            .expect("B replays");
        let rec_c = records
            .iter()
            .find(|rec| rec.session_id == "C")
            .expect("C replays");
        assert_eq!(rec_a.alias_of.as_deref(), Some("C"));
        assert_eq!(rec_b.alias_of.as_deref(), Some("C"));
        // THE F6 CONTRACT: A's owner truth is C's Live owner (pid 1002,
        // fresh-agent, live) — NOT the immediate hop B's Aliased residue
        // (rendered vacant pre-fix).
        assert_eq!(rec_a.owner_kind, "fresh-agent");
        assert_eq!(rec_a.state, ReplayOwnerState::Live);
        // And A's generation is C's authoritative generation (the
        // fixpoint record's), so an old-key pane fences its next action
        // against the right number.
        assert_eq!(rec_a.generation, rec_c.generation);
        assert_eq!(rec_b.generation, rec_c.generation);
    }

    /// b8ke delta round-3 F7: `begin_start` clears the predecessor's
    /// `settle_fired` too. A settled-and-failed operation leaves its fired
    /// flag behind; without the clear, the NEXT operation inherits
    /// settle_fired=true before it registers anything — if it crosses the
    /// stale-start deadline pre-registration, the watchdog fences it and
    /// the probe releases that fence as "already settled" while the
    /// operation still runs, and a THIRD operation can start inside the
    /// dual-runtime window the generation fence exists to prevent.
    #[test]
    fn begin_start_clears_the_predecessors_settle_fired_flag() {
        let r = Arc::new(RuntimeOwnershipRegistry::new());
        // The predecessor: claims, registers (arming the sender-side
        // settle flag), settles (the guard drops), and FAILS its claim —
        // the record returns to Vacant with the fired flag still on it.
        let BeginOutcome::Granted { generation: g1 } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-predecessor",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let settle_fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        assert!(r.register_start_cancellation(
            PROVIDER,
            "sid",
            "op-predecessor",
            g1,
            Arc::new(|| {}),
            Box::new(std::future::ready(())),
            Some(Arc::clone(&settle_fired)),
        ));
        settle_fired.store(true, std::sync::atomic::Ordering::SeqCst); // it settled
        let ticket = OperationTicket::new(
            Arc::clone(&r),
            PROVIDER,
            "sid",
            "op-predecessor",
            RuntimeOwnerKind::FreshAgent,
            g1,
            "test",
        );
        drop(ticket); // the failed claim → the record returns to Vacant

        // THE NEXT OPERATION: begins on the same key BEFORE registering
        // anything of its own.
        let BeginOutcome::Granted { generation: g2 } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-next",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        // It crosses the stale-start deadline pre-registration; the
        // watchdog fences it.
        let recovered = r.recover_stale_starts(0, 0);
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].operation_id, "op-next");
        assert!(matches!(
            r.fence_unconfirmed_stop(
                PROVIDER,
                "sid",
                "op-next",
                recovered[0].generation,
                FenceReason::StaleStart,
            ),
            FenceOutcome::Fenced
        ));
        // THE F7 CONTRACT: the fence enumerates settle_fired as None —
        // the new operation has NOT concluded (pre-fix it inherited the
        // predecessor's fired flag and the probe released it as settled
        // while it still ran).
        let fences = r.stale_start_fences();
        assert_eq!(fences.len(), 1);
        assert_eq!(
            fences[0].settle_concluded, None,
            "begin_start cleared the predecessor's settle_fired — the new \
             operation is NOT pre-concluded"
        );
        assert_eq!(fences[0].reason, FenceReason::StaleStart);
        let _ = g2;
    }

    /// b8ke e3r4 F3: the probe's enumeration is REASON-AWARE — a
    /// StaleStart fence carries the START's settle_fired evidence, a
    /// StaleStop fence carries the STOP's stop_settled evidence (pre-e3r4
    /// the enumerator read settle_fired for both, so a stop fence
    /// consulted evidence its stop never armed).
    #[test]
    fn the_fence_enumeration_is_reason_aware() {
        let r = RuntimeOwnershipRegistry::new();
        // A StaleStop fence: the STOP's flag registered+FIRED.
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid-r",
            RuntimeOwnerKind::FreshAgent,
            "op-live",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-r",
                "op-live",
                generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("map".into()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                }
            ),
            CommitOutcome::Committed
        ));
        let claim = StopClaim {
            expected_kind: RuntimeOwnerKind::FreshAgent,
            expected_runtime: None,
            observed: ObservedFence {
                epoch: r.boot_epoch(),
                generation,
            },
        };
        match r.begin_stop(PROVIDER, "sid-r", "op-stop-r", &claim, "test", 0) {
            StopOutcome::Granted {
                generation: stop_gen,
            } => {
                let stop_flag = Arc::new(std::sync::atomic::AtomicBool::new(true));
                assert!(r.register_stop_settlement(
                    PROVIDER,
                    "sid-r",
                    "op-stop-r",
                    stop_gen,
                    Arc::clone(&stop_flag),
                ));
            }
            other => panic!("expected the stop claim granted, got {other:?}"),
        }
        let fenced = r.recover_stale_stoppings(10_000, 5_000);
        assert_eq!(fenced.len(), 1);
        let fences = r.stale_start_fences();
        assert_eq!(fences.len(), 1);
        // THE F3 CONTRACT: the StaleStop fence carries the STOP's
        // evidence — settle_concluded == Some(true) — and the reason.
        assert_eq!(fences[0].reason, FenceReason::StaleStop);
        assert_eq!(
            fences[0].settle_concluded,
            Some(true),
            "the STOP's fired evidence is carried (pre-e3r4: the START's \
             never-armed flag read as None forever)"
        );

        // The StaleStart twin: a start fence carries the START's flag.
        let BeginOutcome::Granted { generation: g2 } = r.begin_start(
            PROVIDER,
            "sid-s",
            RuntimeOwnerKind::FreshAgent,
            "op-live-s",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let start_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        assert!(r.register_start_cancellation(
            PROVIDER,
            "sid-s",
            "op-live-s",
            g2,
            Arc::new(|| {}),
            Box::new(std::future::ready(())),
            Some(Arc::clone(&start_flag)),
        ));
        // b8ke ext r20 F1: a NOT-FIRED settle flag is a live handler the
        // sweep SKIPS now — fire the flag (the handler-unwound shape) so
        // the fence-reason fixture reaches the sweep.
        start_flag.store(true, std::sync::atomic::Ordering::SeqCst);
        let recovered = r.recover_stale_starts(0, 0);
        assert_eq!(recovered.len(), 1);
        assert!(matches!(
            r.fence_unconfirmed_stop(
                PROVIDER,
                "sid-s",
                "op-live-s",
                recovered[0].generation,
                FenceReason::StaleStart,
            ),
            FenceOutcome::Fenced
        ));
        let fences2 = r.stale_start_fences();
        let f2 = fences2
            .iter()
            .find(|f| f.session_id == "sid-s")
            .expect("the start fence enumerated");
        assert_eq!(f2.reason, FenceReason::StaleStart);
        assert_eq!(
            f2.settle_concluded,
            Some(true),
            "the START's settle evidence is carried for the StaleStart fence \
             (b8ke ext r20 F1: the fixture fires the flag — the handler-unwound \
             arm — because a live not-fired flag is a legitimate in-progress \
             start the sweep now skips)"
        );
    }

    /// b8ke e3r3 F7: the watchdog consults the stop's settlement evidence
    /// BEFORE fencing on age — a SLOW-BUT-LIVE stop (its handler's flag NOT
    /// fired: the reap or ledger write is still progressing) is NOT stale
    /// and must never fence. Only the FIRED flag (or an unregistered stop)
    /// fences.
    #[test]
    fn a_slow_but_live_stop_is_not_fenced_by_the_watchdog() {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid-slow-stop",
            RuntimeOwnerKind::FreshAgent,
            "op-live",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("map".into()),
            pid: Some(4321),
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        assert!(matches!(
            r.commit_live(PROVIDER, "sid-slow-stop", "op-live", generation, owner),
            CommitOutcome::Committed
        ));
        let stop_claim = StopClaim {
            expected_kind: RuntimeOwnerKind::FreshAgent,
            expected_runtime: None,
            observed: ObservedFence {
                epoch: r.boot_epoch(),
                generation,
            },
        };
        let mut fired_flags = Vec::new();
        match r.begin_stop(
            PROVIDER,
            "sid-slow-stop",
            "op-slow-stop",
            &stop_claim,
            "test",
            0,
        ) {
            StopOutcome::Granted {
                generation: stop_gen,
            } => {
                let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
                assert!(r.register_stop_settlement(
                    PROVIDER,
                    "sid-slow-stop",
                    "op-slow-stop",
                    stop_gen,
                    Arc::clone(&flag),
                ));
                fired_flags.push(flag);
            }
            other => panic!("expected the stop claim granted, got {other:?}"),
        }

        // Over-aged BUT the flag has NOT fired (the handler is STILL
        // RUNNING): NOT fenced.
        let fenced = r.recover_stale_stoppings(10_000, 5_000);
        assert!(fenced.is_empty(), "a progressing stop is not stale");
        assert!(matches!(
            r.observe(PROVIDER, "sid-slow-stop").state,
            OwnershipState::Stopping { .. }
        ));

        // The handler ENDS (the flag fires) without commit/abort: NOW the
        // over-aged stop fences typed.
        fired_flags
            .pop()
            .expect("the flag")
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let fenced2 = r.recover_stale_stoppings(10_000, 5_000);
        assert_eq!(fenced2.len(), 1, "the FIRED (vanished) stop fences");
        assert!(matches!(
            r.observe(PROVIDER, "sid-slow-stop").state,
            OwnershipState::Fenced {
                reason: FenceReason::StaleStop,
                ..
            }
        ));
    }

    /// b8ke e3r2 F2: the stale-Stopping watchdog — an over-aged Stopping
    /// record (a stop operation that died without commit/abort) fences
    /// TYPED (StaleStop) so the key can never strand blocking every
    /// claimant until restart; the fence is recoverable through the
    /// acknowledged force-clear (the same discipline as StaleStart).
    /// b8ke ext r25 F1(b): the force-clear now genuinely ACCEPTS the
    /// stale reasons (pre-r25 it was PlatformLimited-only, so a stale
    /// fence whose provider evidence was gone was permanent) — the clear
    /// lands the TYPED cleared-unverified state and the ONE atomic
    /// acknowledged start consumes it.
    #[test]
    fn stale_stopping_records_fence_typed_and_recover_via_the_force_clear() {
        let r = RuntimeOwnershipRegistry::new();
        // A Live owner, then a stop claim that never commits (the
        // panicked-kill shape).
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid-stale-stop",
            RuntimeOwnerKind::FreshAgent,
            "op-live",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("map".into()),
            pid: Some(4321),
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        assert!(matches!(
            r.commit_live(PROVIDER, "sid-stale-stop", "op-live", generation, owner),
            CommitOutcome::Committed
        ));
        let stop_claim = StopClaim {
            expected_kind: RuntimeOwnerKind::FreshAgent,
            expected_runtime: None,
            observed: ObservedFence {
                epoch: r.boot_epoch(),
                generation,
            },
        };
        match r.begin_stop(
            PROVIDER,
            "sid-stale-stop",
            "op-stranded-stop",
            &stop_claim,
            "test",
            0,
        ) {
            StopOutcome::Granted { generation: _ } => {}
            other => panic!("expected the stop claim granted, got {other:?}"),
        }
        // In-flight claims are BLOCKED while Stopping (the strand).
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid-stale-stop",
                RuntimeOwnerKind::Terminal,
                "op-blocked",
                None,
                "test",
                1,
            ),
            BeginOutcome::Blocked { .. }
        ));

        // THE WATCHDOG: over-aged → the typed StaleStop fence.
        let fenced = r.recover_stale_stoppings(10_000, 5_000);
        assert_eq!(fenced.len(), 1);
        assert_eq!(fenced[0].operation_id, "op-stranded-stop");
        assert!(matches!(
            r.observe(PROVIDER, "sid-stale-stop").state,
            OwnershipState::Fenced {
                reason: FenceReason::StaleStop,
                ..
            }
        ));
        // b8ke ext r25 F1(b): the acknowledged force-clear now ACCEPTS the
        // stale fence reasons — landing the SAME typed cleared-unverified
        // state as PlatformLimited (never plain Vacant; the start on the
        // cleared key still requires the acknowledged-risk arm). The
        // stale fence's automatic recovery is the confirmed-death probe
        // (with the r25 PID arm); the acknowledged clear is the operator
        // escape — NO typed fence may become permanent.
        let snap = r.observe(PROVIDER, "sid-stale-stop");
        assert_eq!(
            r.force_release_platform_limited(
                PROVIDER,
                "sid-stale-stop",
                ObservedFence {
                    epoch: snap.epoch,
                    generation: snap.generation,
                },
                "operator",
            ),
            ForceReleaseOutcome::Released
        );
        assert!(
            matches!(
                r.observe(PROVIDER, "sid-stale-stop").state,
                OwnershipState::Fenced {
                    reason: FenceReason::ClearedUnverified,
                    ..
                }
            ),
            "the stale-reason force-clear lands the TYPED cleared-unverified \
             state — never plain Vacant"
        );
        // A NAIVE start on the cleared-unverified key is BLOCKED typed —
        // the acknowledged-risk arm is required (the existing r16-F4
        // discipline, unchanged).
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid-stale-stop",
                RuntimeOwnerKind::Terminal,
                "post-force-create-naive",
                None,
                "test",
                8,
            ),
            BeginOutcome::Blocked { .. }
        ));
        // b8ke ext r33 F1: THE ACKNOWLEDGED START is the FORCED-REAP-
        // THEN-START handoff enter — the operator's explicit risk
        // acceptance recorded at the START, and the unverified prior is
        // CARRIED as the handoff's reap target (the runner kills and
        // confirms it before the new writer commits; the pre-r33
        // plain-Vacant vacate that licensed an immediate second writer
        // is DELETED). At the coordinator level the enter is observable
        // as Handoff{prior: Some(the unverified prior)}.
        let snap = r.observe(PROVIDER, "sid-stale-stop");
        let AcknowledgedStartOutcome::Granted {
            generation: entered,
        } = r.begin_handoff_acknowledged_cleared_unverified(
            PROVIDER,
            "sid-stale-stop",
            RuntimeOwnerKind::Terminal,
            "op-ack-start",
            ObservedFence {
                epoch: snap.epoch,
                generation: snap.generation,
            },
            "operator-start-again",
            9,
        )
        else {
            panic!("the acknowledged start must enter")
        };
        match r.observe(PROVIDER, "sid-stale-stop").state {
            OwnershipState::Handoff {
                prior: Some((owner, _)),
                generation,
                ..
            } => {
                assert_eq!(generation, entered);
                assert_eq!(
                    owner.kind,
                    RuntimeOwnerKind::FreshAgent,
                    "the unverified prior is CARRIED as the reap target, never discarded"
                );
            }
            other => panic!("the acknowledged start carries the prior in Handoff: {other:?}"),
        }
        // A naive start during the acknowledged handoff's reap window is
        // STILL blocked — never a second writer beside the unverified
        // prior.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid-stale-stop",
                RuntimeOwnerKind::Terminal,
                "post-ack-start",
                None,
                "test",
                10,
            ),
            BeginOutcome::Blocked { .. }
        ));
    }

    // ── b8ke ext r22 F1: the fresh-create window's mint-time rekey ────────

    /// b8ke ext r22 F1: the provisional (pane-scoped) in-flight start moves
    /// to the minted canonical id as the SAME in-flight operation — old key
    /// `Aliased{to: new}`, new key `Starting` under the SAME operation id +
    /// generation (the ticket survives via `rekey_session_id`, so the
    /// holder's registration-tail commit and the RAII typed drop both
    /// address the canonical key).
    #[test]
    fn rekey_starting_moves_the_in_flight_start_to_the_minted_key() {
        let r = std::sync::Arc::new(RuntimeOwnershipRegistry::new());
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "pending-create-req-r22",
            RuntimeOwnerKind::FreshAgent,
            "op-r22-create",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        assert!(matches!(
            r.rekey_starting(
                PROVIDER,
                "pending-create-req-r22",
                "thread-minted-1",
                "op-r22-create",
                generation
            ),
            CommitOutcome::Committed
        ));
        // The provisional key is the rekey family's Aliased resolution
        // record; the canonical key holds the SAME in-flight start.
        assert!(matches!(
            r.observe(PROVIDER, "pending-create-req-r22").state,
            OwnershipState::Aliased { to, .. } if to == "thread-minted-1"
        ));
        assert_eq!(
            r.resolve_canonical(PROVIDER, "pending-create-req-r22"),
            "thread-minted-1"
        );
        match r.observe(PROVIDER, "thread-minted-1").state {
            OwnershipState::Starting {
                operation_id, kind, ..
            } => {
                assert_eq!(operation_id, "op-r22-create");
                assert_eq!(kind, RuntimeOwnerKind::FreshAgent);
            }
            other => panic!("expected the moved Starting record, got {other:?}"),
        }
        assert_eq!(
            r.observe(PROVIDER, "thread-minted-1").generation,
            generation
        );

        // THE TICKET SURVIVES: re-pointed at the canonical key, its unarmed
        // drop fails the CANONICAL record (the provisional Aliased record
        // stays as the resolution record), and a competing claim on the
        // canonical key while the start is in flight is refused typed.
        let mut ticket = OperationTicket::new(
            std::sync::Arc::clone(&r),
            PROVIDER,
            "pending-create-req-r22",
            "op-r22-create",
            RuntimeOwnerKind::FreshAgent,
            generation,
            "test",
        );
        ticket.rekey_session_id("thread-minted-1");
        assert_eq!(ticket.session_id(), "thread-minted-1");
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "thread-minted-1",
                RuntimeOwnerKind::Terminal,
                "op-competing",
                None,
                "test",
                1
            ),
            BeginOutcome::Blocked { .. }
        ));
        drop(ticket);
        assert!(
            matches!(
                r.observe(PROVIDER, "thread-minted-1").state,
                OwnershipState::Vacant
            ),
            "the rekeyed ticket's unarmed drop typed-fails the CANONICAL record"
        );
    }

    /// b8ke ext r22 F1: the minted-key-lost race — a record already present
    /// under the NEW key (a competitor claimed the freshly discoverable
    /// minted id in the spawn window) refuses typed and NOTHING moves: the
    /// provisional record stays the operation's in-flight start and the
    /// competitor's record is untouched.
    #[test]
    fn rekey_starting_refuses_an_occupied_target_key() {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "pending-create-req-lost",
            RuntimeOwnerKind::FreshAgent,
            "op-r22-lost",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        // The competitor: a terminal claimed the minted id in the window.
        let BeginOutcome::Granted {
            generation: term_gen,
        } = r.begin_start(
            PROVIDER,
            "thread-taken",
            RuntimeOwnerKind::Terminal,
            "op-terminal-won",
            None,
            "test",
            0,
        )
        else {
            panic!()
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "thread-taken",
                "op-terminal-won",
                term_gen,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-r22".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                }
            ),
            CommitOutcome::Committed
        ));
        // THE REFUSAL: nothing moves.
        assert!(matches!(
            r.rekey_starting(
                PROVIDER,
                "pending-create-req-lost",
                "thread-taken",
                "op-r22-lost",
                generation
            ),
            CommitOutcome::ForeignOperation
        ));
        // The provisional record is still the operation's in-flight start.
        assert!(matches!(
            r.observe(PROVIDER, "pending-create-req-lost").state,
            OwnershipState::Starting { operation_id, .. } if operation_id == "op-r22-lost"
        ));
        // The competitor's Live record is untouched.
        assert!(matches!(
            r.observe(PROVIDER, "thread-taken").state,
            OwnershipState::Live { owner, .. }
                if owner.kind == RuntimeOwnerKind::Terminal
        ));
    }

    /// b8ke ext r22 F1: a foreign operation (wrong op id) or a stale
    /// generation on the provisional key refuses typed — nothing moves.
    #[test]
    fn rekey_starting_refuses_a_foreign_or_stale_operation() {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "pending-create-req-foreign",
            RuntimeOwnerKind::FreshAgent,
            "op-mine",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        // A foreign operation id.
        assert!(matches!(
            r.rekey_starting(
                PROVIDER,
                "pending-create-req-foreign",
                "thread-x",
                "op-not-mine",
                generation
            ),
            CommitOutcome::ForeignOperation
        ));
        // A stale generation.
        assert!(matches!(
            r.rekey_starting(
                PROVIDER,
                "pending-create-req-foreign",
                "thread-x",
                "op-mine",
                generation + 1
            ),
            CommitOutcome::StaleGeneration { .. }
        ));
        // A missing old key.
        assert!(matches!(
            r.rekey_starting(
                PROVIDER,
                "pending-create-req-absent",
                "thread-x",
                "op-mine",
                generation
            ),
            CommitOutcome::ForeignOperation
        ));
        // Nothing moved: the record is still the in-flight start.
        assert!(matches!(
            r.observe(PROVIDER, "pending-create-req-foreign").state,
            OwnershipState::Starting { operation_id, .. } if operation_id == "op-mine"
        ));
    }

    /// b8ke ext r26 F1: the mint-time rekey CARRIES the in-flight start
    /// witnesses. Pre-r26 `rekey_starting` rebuilt the canonical record
    /// from `SessionRecord::default()`, so a start that registered its
    /// cancellation/settle/settle_fired on the provisional key BEFORE the
    /// mint (the fresh claude/codex lanes and the REST/MCP opencode
    /// materialization) arrived at the canonical key UNWITNESSED: the
    /// stale-start sweep then treated the still-running post-rekey
    /// registration as an unwitnessed over-age start and fenced it on a
    /// later tick (OpenCode's 50-70s cold start makes that window a normal
    /// path, not a remote race). The carried witnesses keep the sweep's
    /// skip-live discipline intact through the rekey, and a
    /// genuinely-concluded start still fences with its carried handles.
    #[test]
    fn rekey_starting_carries_the_in_flight_witnesses_past_the_sweep_age() {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "pending-create-req-r26",
            RuntimeOwnerKind::FreshAgent,
            "op-r26-create",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        // The fresh lanes' PRE-MINT registration: the abort handle, the
        // boxed settle future, and the sender-side settle flag, all armed
        // on the PROVISIONAL key before the durable id is minted.
        let settle_fired = Arc::new(AtomicBool::new(false));
        assert!(r.register_start_cancellation(
            PROVIDER,
            "pending-create-req-r26",
            "op-r26-create",
            generation,
            Arc::new(|| {}),
            Box::new(async {}),
            Some(Arc::clone(&settle_fired)),
        ));
        assert!(matches!(
            r.rekey_starting(
                PROVIDER,
                "pending-create-req-r26",
                "ses_minted_r26",
                "op-r26-create",
                generation
            ),
            CommitOutcome::Committed
        ));
        // Over-age by any measure: the sweep must SKIP the rekeyed start
        // while its handler is STILL RUNNING (the carried settle flag has
        // not fired) — pre-r26 the canonical record lost the flag and the
        // sweep fenced the live post-rekey registration here.
        assert!(
            r.recover_stale_starts(u64::MAX, 0).is_empty(),
            "the witnessed post-rekey start is skipped while still in flight"
        );
        // The handler unwinds without commit: the FIRED settle flag lets
        // the watchdog fence the concluded start, and the CARRIED
        // cancellation/settle handles reach the recovery (the host's
        // abort/await targets) instead of vanishing at the rekey.
        settle_fired.store(true, Ordering::SeqCst);
        let recovered = r.recover_stale_starts(u64::MAX, 0);
        assert_eq!(recovered.len(), 1);
        let rec = &recovered[0];
        assert_eq!(rec.session_id, "ses_minted_r26");
        assert_eq!(rec.operation_id, "op-r26-create");
        assert!(
            rec.cancellation.is_some(),
            "the carried cancellation handle reaches the sweep's recovery"
        );
        assert!(
            rec.settle.is_some(),
            "the carried settle future reaches the sweep's recovery"
        );
    }

    /// b8ke ext r26 F1: the sweep still fences a genuinely-unwitnessed
    /// post-rekey start — carrying the witnesses must never widen the
    /// watchdog's zombie authority (an operation that registered NOTHING
    /// before the rekey stays fenceable on age exactly as before).
    #[test]
    fn rekey_starting_still_fences_an_unwitnessed_over_age_start() {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "pending-create-req-r26-bare",
            RuntimeOwnerKind::FreshAgent,
            "op-r26-bare",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        assert!(matches!(
            r.rekey_starting(
                PROVIDER,
                "pending-create-req-r26-bare",
                "ses_minted_r26_bare",
                "op-r26-bare",
                generation
            ),
            CommitOutcome::Committed
        ));
        let recovered = r.recover_stale_starts(u64::MAX, 0);
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].session_id, "ses_minted_r26_bare");
        assert!(
            recovered[0].cancellation.is_none(),
            "an unregistered start recovers with no abort handle"
        );
    }

    // ── b8ke ext r23 F1: the placeholder→durable coordinator alias ────────

    /// b8ke ext r23 F1: `alias_vacant_key` creates an `Aliased{to}` record
    /// for a key that never held coordinator presence — the OpenCode
    /// placeholder→durable materialization's resolution record. The alias
    /// carries the DURABLE key's generation; `resolve_canonical` walks it.
    #[test]
    fn alias_vacant_key_creates_the_resolution_alias() {
        let r = RuntimeOwnershipRegistry::new();
        // Seed the durable owner (Live at generation G).
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "ses_durable",
            RuntimeOwnerKind::FreshAgent,
            "op-seed",
            None,
            "test",
            0,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "ses_durable",
                "op-seed",
                generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("map".into()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));

        // THE ALIAS: the placeholder key (no prior record) becomes an
        // Aliased{to: ses_durable} carrying the durable's generation.
        assert!(matches!(
            r.alias_vacant_key(
                PROVIDER,
                "freshopencode-req-1",
                "ses_durable",
                "op-r33-alias-1",
                "test"
            ),
            CommitOutcome::Committed
        ));
        // resolve_canonical walks the chain.
        assert_eq!(
            r.resolve_canonical(PROVIDER, "freshopencode-req-1"),
            "ses_durable"
        );
        assert_eq!(r.resolve_canonical(PROVIDER, "ses_durable"), "ses_durable");
        // The alias record carries the durable's generation (coherent fence
        // arithmetic).
        assert_eq!(
            r.observe(PROVIDER, "freshopencode-req-1").generation,
            generation
        );

        // An already-aliased key refuses typed (never clobber).
        assert!(matches!(
            r.alias_vacant_key(
                PROVIDER,
                "freshopencode-req-1",
                "ses_durable",
                "op-r33-alias-1",
                "test"
            ),
            CommitOutcome::ForeignOperation
        ));
        // A missing target key refuses typed (the alias must resolve to a
        // real owner).
        assert!(matches!(
            r.alias_vacant_key(
                PROVIDER,
                "freshopencode-req-2",
                "ses_absent",
                "op-r33-alias-2",
                "test"
            ),
            CommitOutcome::ForeignOperation
        ));
    }

    /// b8ke focused episode-2 round-2 F1: the atomic re-key — a start's
    /// `Starting{op}` record under the OLD key moves to the NEW key as
    /// `Live{owner}` in ONE registry step: never both-Live, never
    /// both-Vacant, no half-moved record. The claude rollback's fork uses
    /// this to put ownership under the client-visible new durable id; the
    /// old key replays Vacant so stale divergence clears. A foreign record
    /// under the TARGET key is the typed refusal — never an overwrite.
    #[test]
    fn commit_live_rekey_moves_the_record_atomically() {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "old-id",
            RuntimeOwnerKind::FreshAgent,
            "op-rekey",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("map-key".into()),
            pid: Some(4242),
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        assert!(matches!(
            r.commit_live_rekey(
                PROVIDER,
                "old-id",
                "new-id",
                "op-rekey",
                generation,
                owner.clone()
            ),
            CommitOutcome::Committed
        ));
        // The move (e2r3 contract): old key Aliased{to: new} — the
        // coordinator's OWN old→new resolution record; new key
        // Live{FreshAgent} at the same generation — never both-Live,
        // never both-Vacant.
        assert!(matches!(
            r.observe(PROVIDER, "old-id").state,
            OwnershipState::Aliased { to, .. } if to == "new-id"
        ));
        // The fixpoint resolution walks the alias to the canonical key.
        assert_eq!(r.resolve_canonical(PROVIDER, "old-id"), "new-id");
        assert_eq!(r.resolve_canonical(PROVIDER, "new-id"), "new-id");
        match r.observe(PROVIDER, "new-id").state {
            OwnershipState::Live {
                owner: observed, ..
            } => {
                assert_eq!(observed.kind, RuntimeOwnerKind::FreshAgent);
                assert_eq!(observed.live_session_key.as_deref(), Some("map-key"));
                assert_eq!(observed.pid, Some(4242));
            }
            other => panic!("expected Live under the new id, got {other:?}"),
        }
        // The Aliased key replays writer-VACANT to clients (stale
        // divergence clears) and the new key is the sole authoritative
        // record.
        let records = r.snapshot_records();
        assert!(records.iter().any(|rec| rec.session_id == "new-id"
            && rec.owner_kind == "fresh-agent"
            && rec.state == ReplayOwnerState::Live));
        // e2 post-cap F5: the ALIASED old key replays the CANONICAL
        // record's resolved truth + `alias_of` — never a bare vacant that
        // strands a stale pane.
        let old_key_rec = records
            .iter()
            .find(|rec| rec.session_id == "old-id")
            .expect("the aliased old key replays");
        assert_eq!(old_key_rec.alias_of.as_deref(), Some("new-id"));
        assert_eq!(old_key_rec.owner_kind, "fresh-agent");
        assert_eq!(old_key_rec.state, ReplayOwnerState::Live);

        // A foreign record under the TARGET key refuses — never an
        // overwrite; the caller tears its runtime down.
        let r2 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g2 } = r2.begin_start(
            PROVIDER,
            "old-2",
            RuntimeOwnerKind::FreshAgent,
            "op-rekey-2",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        let BeginOutcome::Granted {
            generation: foreign,
        } = r2.begin_start(
            PROVIDER,
            "new-2",
            RuntimeOwnerKind::Terminal,
            "op-foreign",
            None,
            "test",
            1,
        )
        else {
            panic!()
        };
        let foreign_owner = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-foreign".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        assert!(matches!(
            r2.commit_live(PROVIDER, "new-2", "op-foreign", foreign, foreign_owner),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r2.commit_live_rekey(PROVIDER, "old-2", "new-2", "op-rekey-2", g2, owner),
            CommitOutcome::ForeignOperation
        ));
        // The foreign target record is UNTOUCHED.
        match r2.observe(PROVIDER, "new-2").state {
            OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            }
            other => panic!("the foreign target must keep its owner, got {other:?}"),
        }
    }

    /// b8ke focused episode-2 round-1 F1: the watchdog's UNCONFIRMED
    /// StaleStart fence is NEVER released by the operation's own unwind —
    /// the ticket's typed `fail` proves only that the handler cannot
    /// commit, NOT that the detached sidecar or its descendants died (the
    /// delta-r2 arm cleared it to Vacant, licensing a second writer over
    /// an unconfirmed runtime). The STRICT release discipline is the only
    /// path: a CONFIRMED-death probe invoking `release_fenced` (or the
    /// lane teardowns); the unwind's `fail` is the typed no-op.
    #[test]
    fn a_watchdog_fence_survives_the_operations_unwind_and_releases_only_on_confirmed_death() {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-watchdog",
            None,
            "test",
            0,
        ) else {
            panic!()
        };
        // The watchdog sweep: Starting → Stopping (nothing registered —
        // the blocked-before-partial-registration shape).
        let recovered = r.recover_stale_starts(0, 0);
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].operation_id, "op-watchdog");
        // The watchdog's UNCONFIRMED arm: Stopping → Fenced typed StaleStart.
        assert!(matches!(
            r.fence_unconfirmed_stop(
                PROVIDER,
                "sid",
                "op-watchdog",
                generation,
                FenceReason::StaleStart
            ),
            FenceOutcome::Fenced
        ));
        // THE OPERATION UNWINDS (the ticket's Drop performs exactly this
        // fail): the unwind is NOT a confirmed runtime death — the fence
        // HOLDS (the pre-e2r1 arm released it to Vacant over the
        // unconfirmed runtime).
        assert!(matches!(
            r.fail(PROVIDER, "sid", "op-watchdog", generation, false),
            FailOutcome::ForeignOperation
        ));
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Fenced {
                reason: FenceReason::StaleStart,
                ..
            }
        ));
        // A foreign fail (a different operation / generation) never
        // releases it either.
        assert!(matches!(
            r.fail(PROVIDER, "sid", "op-foreign", generation, false),
            FailOutcome::ForeignOperation
        ));
        assert!(matches!(
            r.fail(PROVIDER, "sid", "op-watchdog", generation + 1, false),
            FailOutcome::ForeignOperation
        ));
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Fenced { .. }
        ));
        // THE ONLY RELEASE: a confirmed-death probe invoking release_fenced
        // — never a stray fail, never plain Vacant over the unconfirmed
        // runtime.
        assert!(matches!(
            r.release_fenced(PROVIDER, "sid", "op-watchdog", generation),
            CommitOutcome::Committed
        ));
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        // The recovered key reopens for a new writer.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "op-after",
                None,
                "test",
                1
            ),
            BeginOutcome::Granted { .. }
        ));
    }

    #[test]
    fn stale_pre_restart_fence_is_always_rejected_across_the_boot_epoch() {
        // Round-2 review + task-brief carried finding: the boot epoch is
        // unique per coordinator instance BY CONSTRUCTION, so a "restart" is
        // a second registry with its own epoch — never a fabricated epoch-1
        // in the same instance. A request carrying a PRE-RESTART pair is
        // stale even when its generation dwarfs the restarted registry's
        // fresh counters.
        let pre_restart = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = pre_restart.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-old",
            None,
            "test",
            1,
        ) else {
            panic!("expected Granted")
        };
        let pre_restart_fence = ObservedFence {
            epoch: pre_restart.boot_epoch(),
            generation,
        };
        let restarted = RuntimeOwnershipRegistry::new();
        assert!(
            restarted.boot_epoch() != pre_restart.boot_epoch(),
            "each coordinator instance must mint a distinct boot epoch by construction"
        );
        assert!(
            matches!(
                restarted.begin_start(
                    PROVIDER,
                    "sid",
                    RuntimeOwnerKind::Terminal,
                    "op-new",
                    Some(pre_restart_fence),
                    "test",
                    2
                ),
                BeginOutcome::StaleGeneration { .. }
            ),
            "a pre-restart epoch is stale regardless of generation"
        );
        assert!(
            matches!(
                restarted.begin_start(
                    PROVIDER,
                    "sid",
                    RuntimeOwnerKind::Terminal,
                    "op-new2",
                    Some(ObservedFence {
                        epoch: pre_restart.boot_epoch(),
                        generation: u64::MAX
                    }),
                    "test",
                    2
                ),
                BeginOutcome::StaleGeneration { .. }
            ),
            "a dwarfing generation cannot rescue a pre-restart epoch"
        );
        assert_eq!(
            restarted.observe(PROVIDER, "sid").state,
            OwnershipState::Vacant,
            "the stale requests must not have created ownership"
        );
        // The same-epoch rules: a NEWER generation than the record's is
        // stale; the CURRENT epoch with a not-yet-superseded generation is
        // Granted (the client observed the future it may create).
        let BeginOutcome::Granted { .. } = restarted.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-b",
            None,
            "test",
            1,
        ) else {
            panic!()
        };
        let stale_same_epoch = Some(ObservedFence {
            epoch: restarted.boot_epoch(),
            generation: 0,
        });
        assert!(matches!(
            restarted.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "op-c",
                stale_same_epoch,
                "test",
                2
            ),
            BeginOutcome::StaleGeneration { .. }
        ));
        let fresh_same_epoch = Some(ObservedFence {
            epoch: restarted.boot_epoch(),
            generation: 1,
        });
        // "sid2" is a FRESH key (its record's generation is 0), so the
        // fence's generation 1 is NEWER than the key's current — allowed by
        // the not-yet-superseded rule (the request observed the future it
        // may create), not the equality case.
        assert!(
            matches!(
                restarted.begin_start(
                    PROVIDER,
                    "sid2",
                    RuntimeOwnerKind::Terminal,
                    "op-d",
                    fresh_same_epoch,
                    "test",
                    2
                ),
                BeginOutcome::Granted { .. }
            ),
            "an observed generation NEWER than the key's current one is fresh, not stale"
        );
        // The TRUE equality case: "sid" is already claimed (held by op-b at
        // generation 1), and the fence observes exactly that generation.
        // The fence is fresh — it passes the staleness check — so the STATE
        // MACHINE answers, not the fence: a different operation is Blocked
        // as a second writer, and the holding operation's own re-claim is
        // Granted.
        let equal_same_epoch = Some(ObservedFence {
            epoch: restarted.boot_epoch(),
            generation: 1,
        });
        assert!(
            matches!(
                restarted.begin_start(
                    PROVIDER,
                    "sid",
                    RuntimeOwnerKind::Terminal,
                    "op-e",
                    equal_same_epoch,
                    "test",
                    2
                ),
                BeginOutcome::Blocked { .. }
            ),
            "an equal fence is fresh: the second writer is Blocked by the state machine, not fenced as stale"
        );
        let re = restarted.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-b",
            equal_same_epoch,
            "test",
            2,
        );
        assert!(
            matches!(re, BeginOutcome::Granted { generation: 1 }),
            "an observed generation equal to the current one is fresh, not stale"
        );
    }

    #[test]
    fn stale_generation_cannot_commit_after_a_later_generation_begins() {
        // Round-1 review: begin_handoff from Starting is Blocked BY DESIGN, so
        // this test starts from LIVE — a committed owner, then a handoff that
        // bumps the generation, then the delayed pre-handoff commit.
        let (r, _owner, _) = registry_with_live_terminal(); // Live, generation 1
        let BeginOutcome::Granted { .. } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-late".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        // A commit carrying the PRE-handoff generation is refused — the stale
        // caller must tear down its own child.
        assert_eq!(
            r.commit_live(PROVIDER, "sid", "op-slow", 1, owner),
            CommitOutcome::StaleGeneration {
                current_generation: 2
            }
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Handoff { .. }
        ));
    }

    /// b8ke focused round-2 review R2-1: a lost detached reap watcher must
    /// leave the TYPED FENCED state — NEVER the round-1 fail-open to
    /// `Vacant`. While fenced, every begin (start/handoff) is Blocked and a
    /// stop is the typed `NotLive` (the caller must not kill); ONLY
    /// [`RuntimeOwnershipRegistry::release_fenced`] — the confirmed-death
    /// caller — reopens the key (after which a create is Granted again). A
    /// foreign operation/generation is the typed no-op, and a wrong
    /// generation on the release is the typed stale refusal.
    #[test]
    fn watcher_lost_fences_the_handoff_until_confirmed_death_releases() {
        let (r, _owner, _) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-wf",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Handoff { .. }
        ));
        // The watcher was lost: the key is FENCED with the typed reason —
        // never Vacant, never restored.
        assert_eq!(
            r.fence_unconfirmed_handoff(PROVIDER, "sid", "ho-wf", g, FenceReason::WatcherFailed),
            FenceOutcome::Fenced
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Fenced {
                reason: FenceReason::WatcherFailed,
                ..
            }
        ));
        // While fenced: a create is BLOCKED (the round-1 fail-open granted
        // it — the defect this test pins), a handoff is BLOCKED, and a stop
        // is the typed NotLive (no kill).
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "fence-probe-create",
                None,
                "test",
                3,
            ),
            BeginOutcome::Blocked { .. }
        ));
        assert!(matches!(
            r.begin_handoff(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "fence-probe-handoff",
                None,
                "test",
                4,
            ),
            BeginOutcome::Blocked { .. }
        ));
        assert!(matches!(
            r.begin_stop(
                PROVIDER,
                "sid",
                "fence-probe-stop",
                &StopClaim {
                    expected_kind: RuntimeOwnerKind::Terminal,
                    expected_runtime: None,
                    observed: ObservedFence {
                        epoch: r.boot_epoch(),
                        generation: g
                    },
                },
                "test",
                5,
            ),
            StopOutcome::NotLive { .. }
        ));
        // The fenced key does NOT release through the generic fail (an
        // unarmed ticket drop is the typed no-op) — only release_fenced.
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-wf", g, false),
            FailOutcome::ForeignOperation
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Fenced { .. }
        ));
        // A stale generation on the release is the typed refusal.
        assert_eq!(
            r.release_fenced(PROVIDER, "sid", "ho-wf", g + 1),
            CommitOutcome::StaleGeneration {
                current_generation: g
            }
        );
        // Confirmed death releases: the key reopens and a create succeeds.
        assert_eq!(
            r.release_fenced(PROVIDER, "sid", "ho-wf", g),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::FreshAgent,
                "post-fence-create",
                None,
                "test",
                6,
            ),
            BeginOutcome::Granted { .. }
        ));

        // Foreign operation id: the typed no-op (the record moved on).
        let (r, _owner, _) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-wf-2",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fence_unconfirmed_handoff(
                PROVIDER,
                "sid",
                "ho-foreign",
                g,
                FenceReason::WatcherFailed
            ),
            FenceOutcome::ForeignOperation
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Handoff { .. }
        ));
    }

    /// b8ke focused round-2 review R2-2/R2-3: an explicit stop whose
    /// teardown cannot confirm the prior's death fences `Stopping` with
    /// the typed reason (never `commit_stop`'s Vacant), and — for the
    /// platform-limited reason — the fence is terminal for the epoch
    /// (nothing can confirm on that platform; the documented tradeoff).
    #[test]
    fn unconfirmed_stop_fences_the_key_typed() {
        let (r, owner, generation) = registry_with_live_terminal();
        let StopOutcome::Granted { generation: g } = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-pl",
            &StopClaim {
                expected_kind: RuntimeOwnerKind::Terminal,
                expected_runtime: Some(owner.clone()),
                observed: ObservedFence {
                    epoch: r.boot_epoch(),
                    generation,
                },
            },
            "test",
            7,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fence_unconfirmed_stop(PROVIDER, "sid", "kill-pl", g, FenceReason::PlatformLimited),
            FenceOutcome::Fenced
        );
        // The fenced record carries the PRIOR owner (the unconfirmed
        // runtime, stamped with its committing operation id) — a snapshot
        // consumer still sees the fence, and a create is Blocked until a
        // confirmed death releases it.
        let stamped_prior = stamped(owner, "op-1");
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Fenced {
                ref prior,
                reason: FenceReason::PlatformLimited,
                ..
            } if prior.as_ref().map(|(o, _)| o) == Some(&stamped_prior)
        ));
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "pl-probe-create",
                None,
                "test",
                8,
            ),
            BeginOutcome::Blocked { .. }
        ));
        // The stop commit no longer applies (the record moved past
        // Stopping): the fence owns the transition now.
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-pl", g),
            CommitOutcome::ForeignOperation
        );
        // Confirmed death still releases the fence (the one legal reopen).
        assert_eq!(
            r.release_fenced(PROVIDER, "sid", "kill-pl", g),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    /// b8ke focused round-3 review R3-4: the typed operator force-clear
    /// for a PlatformLimited fence. An explicit retry carrying a FRESH
    /// observed fence releases the record to Vacant (the limitation
    /// recorded honestly); a WatcherFailed fence is NOT force-releasable
    /// (its bounded probe can still confirm); a stale observation and any
    /// non-fenced state are the typed refusals — the default path stays
    /// fenced.
    #[test]
    fn force_release_platform_limited_is_the_typed_fenced_recovery() {
        // A PlatformLimited fence from a stop.
        let (r, owner, generation) = registry_with_live_terminal();
        let StopOutcome::Granted { generation: g } = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-pl2",
            &StopClaim {
                expected_kind: RuntimeOwnerKind::Terminal,
                expected_runtime: Some(owner.clone()),
                observed: ObservedFence {
                    epoch: r.boot_epoch(),
                    generation,
                },
            },
            "test",
            7,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fence_unconfirmed_stop(PROVIDER, "sid", "kill-pl2", g, FenceReason::PlatformLimited),
            FenceOutcome::Fenced
        );
        // A stale observation (an older generation) is the typed refusal.
        assert_eq!(
            r.force_release_platform_limited(
                PROVIDER,
                "sid",
                ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: g - 1,
                },
                "operator",
            ),
            ForceReleaseOutcome::StaleObservation {
                current_epoch: r.boot_epoch(),
                current_generation: g,
            }
        );
        // A foreign epoch is the typed refusal too.
        assert!(matches!(
            r.force_release_platform_limited(
                PROVIDER,
                "sid",
                ObservedFence {
                    epoch: r.boot_epoch() + 1,
                    generation: g,
                },
                "operator",
            ),
            ForceReleaseOutcome::StaleObservation { .. }
        ));
        // THE R3-4 recovery: the fresh observed fence force-clears — the
        // record reopens Vacant at the SAME generation (the caller's
        // retry proceeds).
        assert_eq!(
            r.force_release_platform_limited(
                PROVIDER,
                "sid",
                ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: g,
                },
                "operator",
            ),
            ForceReleaseOutcome::Released
        );
        // b8ke ext r16 F4: the acknowledged clear lands in the TYPED
        // cleared-unverified state — never plain Vacant (pre-r16 a naive
        // post-clear start could begin a second writer beside a surviving
        // descendant).
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Fenced {
                reason: FenceReason::ClearedUnverified,
                ..
            }
        ));
        assert_eq!(r.observe(PROVIDER, "sid").generation, g);
        // A NAIVE start on the cleared-unverified key is BLOCKED typed —
        // the acknowledged-risk arm is required.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "post-force-create-naive",
                None,
                "test",
                8,
            ),
            BeginOutcome::Blocked { .. }
        ));
        // b8ke ext r33 F1: THE ACKNOWLEDGED START is the FORCED-REAP-
        // THEN-START handoff enter — the unverified prior is CARRIED as
        // the reap target (the pre-r33 plain-Vacant vacate is DELETED).
        let AcknowledgedStartOutcome::Granted { .. } = r
            .begin_handoff_acknowledged_cleared_unverified(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "op-ack-start",
                ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: g,
                },
                "operator-start-again",
                9,
            )
        else {
            panic!("the acknowledged start must enter")
        };
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Handoff { prior: Some(_), .. }
        ));
        // A naive start during the acknowledged handoff's reap window is
        // STILL blocked — never a second writer beside the unverified
        // prior.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::Terminal,
                "post-ack-start",
                None,
                "test",
                10,
            ),
            BeginOutcome::Blocked { .. }
        ));

        // A WatcherFailed fence is NOT force-releasable: its bounded
        // replacement probe can still confirm death.
        let (r, _owner, _generation) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-wf-pl",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fence_unconfirmed_handoff(PROVIDER, "sid", "ho-wf-pl", g, FenceReason::WatcherFailed),
            FenceOutcome::Fenced
        );
        let refused = r.force_release_platform_limited(
            PROVIDER,
            "sid",
            ObservedFence {
                epoch: r.boot_epoch(),
                generation: g,
            },
            "operator",
        );
        assert!(
            matches!(
                &refused,
                ForceReleaseOutcome::NotPlatformLimited { state }
                    if matches!(state, OwnershipState::Fenced { .. })
            ),
            "a WatcherFailed fence must not force-clear: {refused:?}"
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Fenced { .. }
        ));

        // A non-fenced key is the typed NotPlatformLimited refusal.
        let (r, _owner, _) = registry_with_live_terminal();
        assert!(matches!(
            r.force_release_platform_limited(
                PROVIDER,
                "sid",
                ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: 1,
                },
                "operator",
            ),
            ForceReleaseOutcome::NotPlatformLimited { .. }
        ));
        // And an unknown key likewise.
        assert!(matches!(
            r.force_release_platform_limited(
                PROVIDER,
                "never-existed",
                ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: 0,
                },
                "operator",
            ),
            ForceReleaseOutcome::NotPlatformLimited { .. }
        ));
    }

    #[test]
    fn handoff_fail_restores_prior_owner_only_when_confirmed_live() {
        // Prior live owner, handoff fails BEFORE the prior was stopped — the
        // prior is confirmed still live, so it is restored (round-1 review).
        let (r, owner, _) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-1", g, /* prior_confirmed_live: */ true),
            FailOutcome::RestoredPriorOwner
        );
        // The restored prior is the STORED identity — with the
        // `ownership_id` its original commit stamped ("op-1").
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Live { owner: ref o, .. } if *o == stamped(owner.clone(), "op-1")
        ));
        // No prior: handoff fail -> Vacant{NoPrior}.
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "ho-2",
            None,
            "test",
            1,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-2", g, false),
            FailOutcome::Vacant {
                reason: FailVacantReason::NoPrior
            }
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        // Prior was REAPED (the runner confirmed the kill) and the target then
        // failed: restoring would record a dead runtime as Live — the key ends
        // Vacant with the typed PriorNotLive reason instead (round-1 review).
        let (r, _owner, _) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "ho-3",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-3", g, /* prior_confirmed_live: */ false),
            FailOutcome::Vacant {
                reason: FailVacantReason::PriorNotLive
            }
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    #[test]
    fn distinct_session_refs_start_concurrently() {
        let r = RuntimeOwnershipRegistry::new();
        let a = r.begin_start(
            PROVIDER,
            "sid-a",
            RuntimeOwnerKind::Terminal,
            "op-a",
            None,
            "test",
            1,
        );
        let b = r.begin_start(
            PROVIDER,
            "sid-b",
            RuntimeOwnerKind::FreshAgent,
            "op-b",
            None,
            "test",
            1,
        );
        assert!(matches!(a, BeginOutcome::Granted { .. }));
        assert!(matches!(b, BeginOutcome::Granted { .. }));
    }

    #[test]
    fn handoff_continuation_grants_target_start_under_same_operation() {
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "ho-1",
            None,
            "test",
            1,
        ) else {
            panic!()
        };
        // Target start under the handoff's operation_id + to_kind: granted, state stays Handoff.
        let cont = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "ho-1",
            None,
            "test",
            2,
        );
        assert_eq!(cont, BeginOutcome::Granted { generation: g });
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Handoff { .. }
        ));
        // A DIFFERENT operation (or wrong kind) is blocked.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::FreshAgent,
                "op-x",
                None,
                "test",
                3
            ),
            BeginOutcome::Blocked { .. }
        ));
    }

    #[test]
    fn same_operation_reclaim_is_granted() {
        // A lifecycle path that claims under its own operation id and then
        // re-claims under the SAME id (the handoff target continuation —
        // Task 6's runner invokes the target lane under its own operation
        // identity): that re-claim must be Granted (it is the same holder,
        // not a second writer).
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "snap-1",
            None,
            "test",
            1,
        ) else {
            panic!()
        };
        let re = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "snap-1",
            None,
            "test",
            2,
        );
        assert_eq!(re, BeginOutcome::Granted { generation });
        // A different op still blocked while snap-1 holds Starting.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::FreshAgent,
                "snap-2",
                None,
                "test",
                3
            ),
            BeginOutcome::Blocked { .. }
        ));
    }

    #[test]
    fn snapshot_records_replay_owner_state_and_released_keys_as_vacant() {
        // kata b8ke reconnect-owner discovery (T1 rec A1): the ready frame's
        // runtimeOwners payload comes from here — live owners replay with
        // their kind, released keys replay as "vacant" so replay CLEARS stale
        // divergence on reconnecting devices.
        let (r, owner, generation) = registry_with_live_terminal();
        let records = r.snapshot_records();
        assert!(records.iter().any(|rec| rec.provider == PROVIDER
            && rec.session_id == "sid"
            && rec.epoch == r.boot_epoch()
            && rec.generation == generation
            && rec.owner_kind == "terminal"
            && rec.state == ReplayOwnerState::Live
            && rec.reason.is_none()));
        r.release(
            PROVIDER,
            "sid",
            &watcher_claim(&owner, "op-1", generation),
            "exit-watcher",
        );
        let records = r.snapshot_records();
        assert!(records.iter().any(|rec| rec.provider == PROVIDER
            && rec.session_id == "sid"
            && rec.generation >= generation
            && rec.owner_kind == "vacant"
            && rec.state == ReplayOwnerState::Live));

        // b8ke focused round-3 review R3-5: a FENCED record replays its
        // truth — `state: "fenced"` with the typed reason and the fenced
        // PRIOR's kind — never a plain live owner (the pre-fix replay
        // licensed a false committed-owner fold on reconnecting devices
        // after PLATFORM_LIMITED/WATCHER_FAILED).
        let (r, _owner, _) = registry_with_live_terminal();
        let BeginOutcome::Granted { generation: g } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-fence-replay",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(
            r.fence_unconfirmed_handoff(
                PROVIDER,
                "sid",
                "ho-fence-replay",
                g,
                FenceReason::PlatformLimited,
            ),
            FenceOutcome::Fenced
        );
        let records = r.snapshot_records();
        let fenced = records
            .iter()
            .find(|rec| rec.session_id == "sid")
            .expect("the fenced key replays");
        assert_eq!(fenced.state, ReplayOwnerState::Fenced);
        assert_eq!(fenced.reason.as_deref(), Some("platform-limited"));
        assert_eq!(fenced.owner_kind, "terminal", "the fenced PRIOR's kind");
        assert_eq!(fenced.generation, g);
    }

    /// b8ke focused round-4 review R4-6: in-progress lifecycle states
    /// replay AS WHAT THEY ARE — a reconnecting device must never fold a
    /// `Starting`/`Handoff`/`Stopping` record as committed live ownership
    /// (the pre-fix replay serialized all three as `Live`, licensing a
    /// false "handoff-committed" fold and resumed polling/actions mid
    /// transition).
    #[test]
    fn snapshot_records_replay_in_progress_lifecycle_states_truthfully() {
        // Starting: a fresh-agent runtime is spawning (no prior).
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { .. } = r.begin_start(
            PROVIDER,
            "sid-starting",
            RuntimeOwnerKind::FreshAgent,
            "op-starting",
            None,
            "test",
            1,
        ) else {
            panic!("expected Granted")
        };
        // Handoff: a live terminal owner is being taken over to fresh-agent.
        let (r2, _owner, _gen) = registry_with_live_terminal();
        let BeginOutcome::Granted { .. } = r2.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-handoff",
            None,
            "test",
            2,
        ) else {
            panic!("expected Granted")
        };
        // Stopping: the live owner of a third key is being stopped.
        let r3 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g3 } = r3.begin_start(
            PROVIDER,
            "sid-stopping",
            RuntimeOwnerKind::Terminal,
            "op-stop-start",
            None,
            "test",
            3,
        ) else {
            panic!("expected Granted")
        };
        let owner3 = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-3".into()),
            live_session_key: None,
            pid: Some(4242),
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        assert_eq!(
            r3.commit_live(
                PROVIDER,
                "sid-stopping",
                "op-stop-start",
                g3,
                owner3.clone()
            ),
            CommitOutcome::Committed
        );
        let StopOutcome::Granted { .. } = r3.begin_stop(
            PROVIDER,
            "sid-stopping",
            "op-stopping",
            &stop_claim(&owner3, r3.boot_epoch(), g3),
            "test",
            4,
        ) else {
            panic!("expected Granted")
        };

        let starting = r
            .snapshot_records()
            .into_iter()
            .find(|rec| rec.session_id == "sid-starting")
            .expect("the Starting key replays");
        assert_eq!(starting.state, ReplayOwnerState::Starting);
        assert_eq!(starting.owner_kind, "fresh-agent");
        assert!(starting.reason.is_none());

        let handoff = r2
            .snapshot_records()
            .into_iter()
            .find(|rec| rec.session_id == "sid")
            .expect("the Handoff key replays");
        assert_eq!(handoff.state, ReplayOwnerState::Handoff);
        // The Handoff record's kind names the TARGET (the handoff-started
        // broadcast's owner kind — cross-device consistency).
        assert_eq!(handoff.owner_kind, "fresh-agent");

        let stopping = r3
            .snapshot_records()
            .into_iter()
            .find(|rec| rec.session_id == "sid-stopping")
            .expect("the Stopping key replays");
        assert_eq!(stopping.state, ReplayOwnerState::Stopping);
        // The Stopping record's kind names the PRIOR being stopped.
        assert_eq!(stopping.owner_kind, "terminal");
    }

    /// Task 4 review F1 (fix): a GRANTED stop abandoned before the kill (the
    /// runtime confirmed still alive) must roll back to `Live` at the
    /// owner's PRE-STOP generation — deliberately a DIFFERENT value than
    /// the failed-handoff restore (whole-branch review M-1): that restore
    /// forward-bumps to the record's current generation (the handoff
    /// broadcasts carried it to every client), while the stop path
    /// broadcasts nothing at the bumped generation, so the pre-stop one is
    /// what observers hold — the one remaining deliberate record≠Live
    /// straddle (`snapshot_generation`'s Live arm exists for it). A fenced
    /// retry carrying the retained/snapshot baseline is Granted again (no
    /// StaleClaim liveness corner), and the aborted stop is consumed (a
    /// late commit is foreign).
    #[test]
    fn abort_stop_restores_the_live_owner_at_its_pre_stop_generation() {
        let (r, owner, live_gen) = registry_with_live_terminal();
        let StopOutcome::Granted {
            generation: stop_gen,
        } = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-1",
            &stop_claim(&owner, r.boot_epoch(), live_gen),
            "test",
            2_000,
        )
        else {
            panic!("expected Granted")
        };
        assert!(
            stop_gen > live_gen,
            "begin_stop bumps the record generation entering Stopping"
        );
        // Mid-stop: the wedge shape — a competing start is Blocked.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid",
                RuntimeOwnerKind::FreshAgent,
                "op-x",
                None,
                "test",
                3_000
            ),
            BeginOutcome::Blocked { .. }
        ));
        assert_eq!(
            r.abort_stop(PROVIDER, "sid", "kill-1", stop_gen),
            AbortStopOutcome::Aborted
        );
        match r.observe(PROVIDER, "sid").state {
            OwnershipState::Live {
                owner: restored,
                generation,
                ..
            } => {
                assert_eq!(restored, stamped(owner.clone(), "op-1"));
                assert_eq!(
                    generation, live_gen,
                    "the restored Live keeps the owner's PRE-stop generation"
                );
            }
            other => panic!("abort must restore Live, got {other:?}"),
        }
        // RR-1 (re-review): the straddle is deliberate and typed — after
        // the abort restore, observe()/snapshot_records() must report the
        // Live STATE's (pre-stop) generation while the record keeps the
        // current (bumped) one. This is the only remaining record≠Live
        // divergence and the sole reason `snapshot_generation`'s Live arm
        // exists; a regression returning the record's generation
        // unconditionally would re-expose the snapshot-fenced StaleClaim
        // wedge in this corner (stop abandoned, runtime alive).
        let snap = r.observe(PROVIDER, "sid");
        assert_eq!(
            snap.generation, live_gen,
            "observe() must report the Live state's pre-stop generation, not the record's bumped one"
        );
        let replay = r
            .snapshot_records()
            .into_iter()
            .find(|rec| rec.provider == PROVIDER && rec.session_id == "sid")
            .expect("the aborted key must replay");
        assert_eq!(
            replay.generation, live_gen,
            "snapshot_records() must fence at the pre-stop generation"
        );
        // The record's own generation is still the bumped stop generation
        // (the per-key monotonic counter never rolls back) — the straddle
        // is real, and only a fence reporting the RECORD's value sees it.
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-1", stop_gen + 1),
            CommitOutcome::StaleGeneration {
                current_generation: stop_gen
            },
            "the record keeps the bumped stop generation while the Live state holds the pre-stop one"
        );
        // The aborted stop is consumed: a late commit for it is foreign.
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-1", stop_gen),
            CommitOutcome::ForeignOperation
        );
        // Fence coherence: a retry carrying the PRE-stop observed pair (the
        // retained stamp's baseline — equivalently, the snapshot-derived
        // `observe()` generation asserted above) is Granted — never a
        // StaleClaim loop — and that retry still commits normally.
        let StopOutcome::Granted {
            generation: retry_gen,
        } = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-2",
            &stop_claim(&owner, r.boot_epoch(), snap.generation),
            "test",
            4_000,
        )
        else {
            panic!("expected Granted on the post-abort retry")
        };
        assert!(matches!(
            r.commit_stop(PROVIDER, "sid", "kill-2", retry_gen),
            CommitOutcome::Committed
        ));
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    /// Task 4 review F1 (fix): `abort_stop` is fenced exactly like
    /// `commit_stop` — a foreign operation id or a stale generation is a
    /// typed no-op that changes nothing — and a watchdog-synthesized
    /// `Stopping` (zombie `Starting`, no prior Live era) is NEVER
    /// restorable: the host's abort/settle/commit owns that transition.
    #[test]
    fn abort_stop_is_fenced_and_never_restores_a_zombie_watchdog_stop() {
        let (r, owner, live_gen) = registry_with_live_terminal();
        let StopOutcome::Granted {
            generation: stop_gen,
        } = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-1",
            &stop_claim(&owner, r.boot_epoch(), live_gen),
            "test",
            2_000,
        )
        else {
            panic!("expected Granted")
        };
        assert_eq!(
            r.abort_stop(PROVIDER, "sid", "kill-other", stop_gen),
            AbortStopOutcome::ForeignOperation
        );
        assert_eq!(
            r.abort_stop(PROVIDER, "sid", "kill-1", stop_gen + 7),
            AbortStopOutcome::StaleGeneration {
                current_generation: stop_gen
            }
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Stopping { .. }
        ));
        // The no-ops changed nothing: the original stop still aborts.
        assert_eq!(
            r.abort_stop(PROVIDER, "sid", "kill-1", stop_gen),
            AbortStopOutcome::Aborted
        );
        // An unknown key is foreign.
        assert_eq!(
            r.abort_stop(PROVIDER, "sid-unknown", "kill-1", stop_gen),
            AbortStopOutcome::ForeignOperation
        );

        // The watchdog's zombie-Starting synthesis: abort is foreign, the
        // host's commit still works, and post-commit abort stays foreign.
        let r2 = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r2.begin_start(
            PROVIDER,
            "sid-2",
            RuntimeOwnerKind::Terminal,
            "op-z",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        let recovered = r2.recover_stale_starts(10_000, 0);
        assert_eq!(recovered.len(), 1, "the zombie start is swept");
        assert_eq!(
            r2.abort_stop(PROVIDER, "sid-2", "op-z", generation),
            AbortStopOutcome::ForeignOperation,
            "a watchdog-synthesized stop has no prior Live era to restore"
        );
        assert!(matches!(
            r2.observe(PROVIDER, "sid-2").state,
            OwnershipState::Stopping { .. }
        ));
        assert!(matches!(
            r2.commit_stop(PROVIDER, "sid-2", "op-z", generation),
            CommitOutcome::Committed
        ));
        assert_eq!(
            r2.abort_stop(PROVIDER, "sid-2", "op-z", generation),
            AbortStopOutcome::ForeignOperation
        );
    }

    #[test]
    fn stop_during_starting_or_stopping_is_typed_notlive_and_transitions_nothing() {
        // Task-brief carried finding (round-2): begin_stop during
        // Starting/Stopping returns TYPED blocked results WITHOUT licensing
        // a kill — the in-flight operation (or the watchdog) owns the
        // transition. (Handoff is covered by the BlockedHandoff block in
        // the stop/crash/cancellation test.)
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-1",
            None,
            "test",
            1,
        ) else {
            panic!()
        };
        let owner = fresh_agent_owner(9);
        let claim = stop_claim(&owner, r.boot_epoch(), generation);
        assert!(
            matches!(
                r.begin_stop(PROVIDER, "sid", "kill-early", &claim, "test", 2),
                StopOutcome::NotLive { .. }
            ),
            "a stop during Starting is typed NotLive and must not license a kill"
        );
        assert!(
            matches!(
                r.observe(PROVIDER, "sid").state,
                OwnershipState::Starting { .. }
            ),
            "the refused stop must not have transitioned the in-flight start"
        );

        // Stopping: the first stop owns the reap; a second stop is told to
        // JOIN it (`AlreadyStopping` names the in-flight operation — no
        // second, competing stop) and the first stop still commits.
        let (r, owner, live_gen) = registry_with_live_terminal();
        let StopOutcome::Granted { generation } = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-1",
            &stop_claim(&owner, r.boot_epoch(), live_gen),
            "test",
            1,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.begin_stop(
                PROVIDER,
                "sid",
                "kill-2",
                &stop_claim(&owner, r.boot_epoch(), live_gen),
                "test",
                2
            ),
            StopOutcome::AlreadyStopping { ref operation_id, .. } if operation_id == "kill-1"
        ));
        assert!(matches!(
            r.observe(PROVIDER, "sid").state,
            OwnershipState::Stopping { .. }
        ));
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-1", generation),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    #[test]
    fn sweep_never_hands_a_dead_operations_registration_to_a_later_start() {
        // M1 (review): the cancellation/settle/partial_runtime registration
        // fields must never outlive the Starting operation that registered
        // them. Op A registers its handles, then FAILS (Starting→Vacant);
        // op B enters Starting WITHOUT registering (the grant→register
        // window, or a register-immediately discipline violation). The
        // sweep must hand the host op B's handles — None — never dead op
        // A's (the host would abort and await the WRONG, already-settled
        // resources).
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation: g_a } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-a",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        let aborted = Arc::new(AtomicBool::new(false));
        let abort = {
            let aborted = Arc::clone(&aborted);
            Arc::new(move || aborted.store(true, Ordering::SeqCst))
        };
        r.register_start_cancellation(
            PROVIDER,
            "sid",
            "op-a",
            g_a,
            abort,
            Box::new(std::future::ready(())),
            None,
        );
        r.register_partial_runtime(
            PROVIDER,
            "sid",
            "op-a",
            g_a,
            OwnerIdentity {
                kind: RuntimeOwnerKind::Terminal,
                terminal_id: Some("t-dead".into()),
                live_session_key: None,
                pid: Some(1111),
                ownership_id: None,
                unit_id: None,
                hold: HoldKind::Main,
            },
        );
        assert_eq!(
            r.fail(PROVIDER, "sid", "op-a", g_a, false),
            FailOutcome::Released
        );
        // Op B enters Starting on the same key and never registers.
        let BeginOutcome::Granted { generation: g_b } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-b",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        let recovered = r.recover_stale_starts(11_000, 5_000); // op B is over-aged
        let rec = recovered
            .iter()
            .find(|rec| rec.operation_id == "op-b")
            .expect("the sweep must recover the over-aged op-b");
        assert!(
            rec.cancellation.is_none(),
            "the sweep must not hand dead op A's abort handle to the host as op B's"
        );
        assert!(
            rec.settle.is_none(),
            "the sweep must not hand dead op A's settle future to the host as op B's"
        );
        assert!(
            rec.partial_runtime.is_none(),
            "the sweep must not hand dead op A's partial runtime to the host as op B's"
        );
        assert!(
            !aborted.load(Ordering::SeqCst),
            "nothing may have invoked the dead operation's abort handle"
        );
        // Reopen the key through the host's confirmed-stop path.
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "op-b", g_b),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    #[test]
    fn stale_generation_commit_live_logs_warn_not_an_invariant_error() {
        // M2 (review): a stale-generation commit_live is a typed,
        // anticipated race outcome (the delayed caller tears down its own
        // child) — the refusal must log at warn on the crate's diagnostic
        // target, NOT as an error-level `invariant` event. Error-level
        // invariant events are reserved for genuine contract violations
        // (force_release during Handoff).
        let (r, _owner, _) = registry_with_live_terminal(); // Live, generation 1
        let BeginOutcome::Granted { .. } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        let capture = EventCapture::default();
        let _guard = capture.install();
        let stale_owner = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-late".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        assert_eq!(
            r.commit_live(PROVIDER, "sid", "op-slow", 1, stale_owner),
            CommitOutcome::StaleGeneration {
                current_generation: 2
            }
        );
        let events = capture.events();
        assert!(
            events.iter().any(|e| e.level == tracing::Level::WARN
                && e.target == "freshell_ownership"
                && e.event.as_deref() == Some("ownership.commit_live.stale_generation")),
            "the anticipated stale refusal must warn on freshell_ownership, got {events:?}"
        );
        assert!(
            events.iter().all(|e| e.level != tracing::Level::ERROR),
            "an expected stale commit must not emit error-level events, got {events:?}"
        );
    }

    #[test]
    fn handoff_restore_carries_the_record_generation_so_client_fences_converge() {
        // Whole-branch review M-1: the handoff broadcasts carry the HANDOFF
        // generation to every client, and the client fold is same-epoch
        // monotonic — it never regresses. A prior restored by a failed
        // handoff must therefore hold the RECORD's current (handoff)
        // generation: otherwise a wire-fenced kill from a client holding
        // the folded broadcast pair (epoch, N+1) fails begin_stop's
        // exact-generation match in a typed StaleClaim loop ("refresh and
        // retry" re-sends the same stale pair) until a reconnect replays
        // the truth.
        let (r, owner, live_gen) = registry_with_live_terminal(); // Live, generation 1
        let BeginOutcome::Granted { generation: ho_gen } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(ho_gen, live_gen + 1);
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-1", ho_gen, /* prior_confirmed_live: */ true),
            FailOutcome::RestoredPriorOwner
        );
        // Coherence: the record's generation and the restored Live state's
        // are ONE value (no straddle) — observe() reports it.
        let snap = r.observe(PROVIDER, "sid");
        assert!(matches!(snap.state, OwnershipState::Live { .. }));
        assert_eq!(
            snap.generation, ho_gen,
            "the restored Live key holds the record's (handoff) generation"
        );
        // The exact M-1 wedge: a kill fenced at the HANDOFF generation —
        // the pair every client folded from the broadcasts — must be
        // Granted (pre-fix: a permanent StaleClaim loop, fail-closed).
        let stop = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-1",
            &stop_claim(&owner, snap.epoch, ho_gen),
            "test",
            3,
        );
        assert!(
            matches!(stop, StopOutcome::Granted { .. }),
            "a handoff-generation fence must satisfy begin_stop on a restored key (got {stop:?})"
        );
        let StopOutcome::Granted { generation } = stop else {
            unreachable!("asserted Granted above")
        };
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-1", generation),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
        // Task 1's invariant: the per-key monotonic counter never resets —
        // the next transition bumps beyond the stop's generation.
        let BeginOutcome::Granted { generation: next } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "ho-2",
            None,
            "test",
            4,
        ) else {
            panic!()
        };
        assert!(
            next > generation,
            "the per-key counter stays monotonic across the restore (next {next}, stop {generation})"
        );
    }

    #[test]
    fn snapshot_fence_satisfies_begin_stop_after_a_failed_handoff_restore() {
        // M3 (review) + whole-branch M-1: a failed handoff restores the
        // prior owner at the RECORD's current generation (the handoff's
        // bump — the handoff broadcasts carried it to every client, whose
        // monotonic folds hold it and cannot regress). The snapshot must
        // report that same coherent value — otherwise a snapshot-fenced
        // stopper loops on StaleClaim forever (fail-closed liveness
        // corner; no safety violation, no kill licensed).
        let (r, owner, live_gen) = registry_with_live_terminal(); // Live, generation 1
        let BeginOutcome::Granted { generation: ho_gen } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(
            ho_gen,
            live_gen + 1,
            "the handoff bumped the record's generation above the Live state's"
        );
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-1", ho_gen, /* prior_confirmed_live: */ true),
            FailOutcome::RestoredPriorOwner
        );
        // The snapshot a stopper derives its fence from must be coherent
        // with begin_stop's comparison target: the restored key's ONE
        // generation (the record's current — the handoff's bump).
        let snap = r.observe(PROVIDER, "sid");
        assert!(matches!(snap.state, OwnershipState::Live { .. }));
        assert_eq!(
            snap.generation, ho_gen,
            "the snapshot generation for a restored-Live key is the record's (handoff) generation"
        );
        let rec = r
            .snapshot_records()
            .into_iter()
            .find(|rec| rec.provider == PROVIDER && rec.session_id == "sid")
            .expect("the restored key must replay");
        assert_eq!(
            rec.generation, ho_gen,
            "the replay record's generation for a restored-Live key is the record's (handoff) generation"
        );
        // A stopper fences from the snapshot and stops the restored owner:
        // no permanent StaleClaim loop.
        let stop = r.begin_stop(
            PROVIDER,
            "sid",
            "kill-1",
            &stop_claim(&owner, rec.epoch, rec.generation),
            "test",
            3,
        );
        assert!(
            matches!(stop, StopOutcome::Granted { .. }),
            "a snapshot-derived fence must satisfy begin_stop on a restored key (got {stop:?})"
        );
        let StopOutcome::Granted { generation } = stop else {
            unreachable!("asserted Granted above")
        };
        assert_eq!(
            r.commit_stop(PROVIDER, "sid", "kill-1", generation),
            CommitOutcome::Committed
        );
        assert_eq!(r.observe(PROVIDER, "sid").state, OwnershipState::Vacant);
    }

    #[test]
    fn snapshot_fence_satisfies_begin_start_and_handoff_after_a_failed_handoff_restore() {
        // M3-R (re-review of M3's remedy): begin_start/begin_handoff
        // compared fences against the RECORD's generation, which a failed
        // handoff leaves bumped above the restored Live state's own — so
        // a snapshot-fenced start/handoff was permanently StaleGeneration
        // on restored keys (refreshing from the snapshot loops). All fence
        // comparisons must use the same coherent baseline. Post whole-
        // branch M-1 the restored key's Live state IS the record's current
        // generation, so the baselines coincide by construction — the
        // test still pins the coherence.
        let (r, _owner, live_gen) = registry_with_live_terminal(); // Live, generation 1
        let BeginOutcome::Granted { generation: ho_gen } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-1",
            None,
            "test",
            2,
        ) else {
            panic!()
        };
        assert_eq!(ho_gen, live_gen + 1);
        assert_eq!(
            r.fail(PROVIDER, "sid", "ho-1", ho_gen, /* prior_confirmed_live: */ true),
            FailOutcome::RestoredPriorOwner
        );
        // The fence a snapshot consumer derives: snapshot_records reports
        // the restored key's ONE coherent generation.
        let rec = r
            .snapshot_records()
            .into_iter()
            .find(|rec| rec.provider == PROVIDER && rec.session_id == "sid")
            .expect("the restored key must replay");
        assert_eq!(
            rec.generation, ho_gen,
            "the replay record's generation for a restored-Live key is the record's (handoff) generation"
        );
        // begin_start: the state machine allows AdoptLive for the same
        // kind — the snapshot fence must not be StaleGeneration.
        let start = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-2",
            Some(ObservedFence {
                epoch: rec.epoch,
                generation: rec.generation,
            }),
            "test",
            3,
        );
        assert!(
            matches!(start, BeginOutcome::AdoptLive { .. }),
            "a snapshot-derived fence must satisfy begin_start on a restored key (got {start:?})"
        );
        // begin_handoff: granted from Live of any kind.
        let handoff = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "ho-2",
            Some(ObservedFence {
                epoch: rec.epoch,
                generation: rec.generation,
            }),
            "test",
            4,
        );
        assert!(
            matches!(handoff, BeginOutcome::Granted { .. }),
            "a snapshot-derived fence must satisfy begin_handoff on a restored key (got {handoff:?})"
        );
    }

    #[test]
    fn start_failed_event_carries_duration_ms() {
        // N1 (review): the Starting-fail observability event carries the
        // terminal-transition duration (`duration_ms`), matching the
        // Handoff-fail arm — the field is part of the event field set the
        // module's observability contract promises.
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "op-1",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        let capture = EventCapture::default();
        let _guard = capture.install();
        assert_eq!(
            r.fail(PROVIDER, "sid", "op-1", generation, false),
            FailOutcome::Released
        );
        let start_failed = capture
            .events()
            .into_iter()
            .find(|e| {
                e.target == "freshell_ownership"
                    && e.event.as_deref() == Some("ownership.start.failed")
            })
            .expect("the Starting-fail event must fire on freshell_ownership");
        assert!(
            start_failed.fields.contains(&"duration_ms".to_string()),
            "ownership.start.failed must carry duration_ms (got fields {:?})",
            start_failed.fields
        );
    }

    /// b8ke ext F3: a committed TERMINAL owner identity for the stable-schema
    /// tests.
    fn live_terminal_owner() -> OwnerIdentity {
        OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-live".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        }
    }

    /// b8ke ext F3: the begin events carry the COMPLETE stable field set —
    /// every field present at every coordinator transition, the
    /// not-yet-known values None-valued (the same contract the release
    /// records follow). Pre-ext `ownership.start.begin` and the vacant
    /// `ownership.handoff.begin` omitted the old kind, runtime ID/PID,
    /// duration, and the typed failure reason ENTIRELY, and the live
    /// handoff begin lacked duration/failure reason.
    #[test]
    fn begin_events_carry_the_stable_schema() {
        // b8ke ext r7 F4 DEFLAKE: the thread-local capture displacement
        // family — re-install + re-run, bounded (a REAL gap is
        // deterministic and fails every attempt).
        for _attempt in 0..3 {
            let outcome = std::panic::catch_unwind(run_begin_events_schema_once);
            if outcome.is_ok() {
                return;
            }
        }
        // The bounded retries are exhausted: run once more WITHOUT the
        // catch so the real panic (message + location) surfaces.
        run_begin_events_schema_once();
    }

    fn run_begin_events_schema_once() {
        let r = RuntimeOwnershipRegistry::new();
        let capture = EventCapture::default();
        let _guard = capture.install();

        let BeginOutcome::Granted { .. } = r.begin_start(
            PROVIDER,
            "sid-start",
            RuntimeOwnerKind::Terminal,
            "op-start",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        let BeginOutcome::Granted { .. } = r.begin_handoff(
            PROVIDER,
            "sid-vacant-handoff",
            RuntimeOwnerKind::Terminal,
            "op-vacant-ho",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        // A LIVE prior handoff begin: Live{Terminal} → a fresh-agent target.
        let BeginOutcome::Granted {
            generation: live_gen,
        } = r.begin_start(
            PROVIDER,
            "sid-live-handoff",
            RuntimeOwnerKind::Terminal,
            "op-live",
            None,
            "test",
            1_000,
        )
        else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-live-handoff",
                "op-live",
                live_gen,
                live_terminal_owner(),
            ),
            CommitOutcome::Committed
        ));
        let BeginOutcome::Granted { .. } = r.begin_handoff(
            PROVIDER,
            "sid-live-handoff",
            RuntimeOwnerKind::FreshAgent,
            "op-live-ho",
            None,
            "test",
            2_000,
        ) else {
            panic!("expected Granted")
        };

        let events = capture.events();
        let stable_fields = [
            "operation_id",
            "provider",
            "session_id",
            "initiator",
            "from_kind",
            "to_kind",
            "runtime_id",
            "pid",
            "epoch",
            "generation",
            "duration_ms",
            "outcome",
            "failure_reason",
        ];
        for (event_name, sid) in [
            ("ownership.start.begin", "sid-start"),
            ("ownership.handoff.begin", "sid-vacant-handoff"),
            ("ownership.handoff.begin", "sid-live-handoff"),
        ] {
            let begin = events
                .iter()
                .find(|e| {
                    e.target == "freshell_ownership"
                        && e.event.as_deref() == Some(event_name)
                        && e.values.get("session_id").map(String::as_str) == Some(sid)
                })
                .unwrap_or_else(|| panic!("the {event_name} event for {sid} must fire"));
            for field in stable_fields {
                assert!(
                    begin.fields.contains(&field.to_string()),
                    "{event_name} for {sid} must carry {field} — got {:?}",
                    begin.fields
                );
            }
        }
        // The vacant begins log the None-valued not-yet-known fields.
        for (event_name, sid) in [
            ("ownership.start.begin", "sid-start"),
            ("ownership.handoff.begin", "sid-vacant-handoff"),
        ] {
            let begin = events
                .iter()
                .find(|e| {
                    e.target == "freshell_ownership"
                        && e.event.as_deref() == Some(event_name)
                        && e.values.get("session_id").map(String::as_str) == Some(sid)
                })
                .unwrap();
            assert_eq!(
                begin.values.get("from_kind").map(String::as_str),
                Some("None"),
                "{event_name} from Vacant logs the None from_kind — got {:?}",
                begin.values
            );
            assert_eq!(
                begin.values.get("runtime_id").map(String::as_str),
                Some("None"),
                "{event_name} from Vacant logs the None runtime_id — got {:?}",
                begin.values
            );
            assert_eq!(
                begin.values.get("pid").map(String::as_str),
                Some("None"),
                "{event_name} from Vacant logs the None pid — got {:?}",
                begin.values
            );
            assert_eq!(
                begin.values.get("failure_reason").map(String::as_str),
                Some(""),
                "{event_name} carries the empty (not-applicable) failure_reason — got {:?}",
                begin.values
            );
        }
        // The live handoff begin names the TRUE prior (the live terminal
        // owner) and carries duration + failure_reason.
        let live_begin = events
            .iter()
            .find(|e| {
                e.target == "freshell_ownership"
                    && e.event.as_deref() == Some("ownership.handoff.begin")
                    && e.values.get("session_id").map(String::as_str) == Some("sid-live-handoff")
            })
            .unwrap();
        assert_eq!(
            live_begin.values.get("from_kind").map(String::as_str),
            Some("Terminal"),
            "the live handoff begin names the prior owner's kind — got {:?}",
            live_begin.values
        );
    }

    /// b8ke ext F3: the commit records the TRUE prior kind — the
    /// PRE-HANDOFF owner, never the Handoff record's TARGET kind
    /// (`kind()` maps Handoff to its target, so a fresh-agent→terminal
    /// commit logged as terminal-to-terminal).
    #[test]
    fn cross_kind_commit_logs_the_true_prior_kind() {
        // b8ke ext r7 F4 DEFLAKE: the thread-local capture displacement
        // family — re-install + re-run, bounded (a REAL gap is
        // deterministic and fails every attempt).
        for attempt in 0..3 {
            match run_cross_kind_commit_once() {
                Ok(()) => return,
                Err(missing) if attempt == 2 => panic!("{missing}"),
                Err(problem) => {
                    eprintln!(
                        "cross_kind_commit attempt {attempt} incomplete ({problem}); retrying"
                    );
                }
            }
        }
    }

    fn run_cross_kind_commit_once() -> Result<(), String> {
        let r = RuntimeOwnershipRegistry::new();
        // Live{FreshAgent}:
        let BeginOutcome::Granted {
            generation: fresh_gen,
        } = r.begin_start(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::FreshAgent,
            "op-fresh",
            None,
            "test",
            1_000,
        )
        else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid",
                "op-fresh",
                fresh_gen,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("sid".into()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));
        // The handoff to a TERMINAL target:
        let BeginOutcome::Granted { generation: ho_gen } = r.begin_handoff(
            PROVIDER,
            "sid",
            RuntimeOwnerKind::Terminal,
            "ho-1",
            None,
            "test",
            2_000,
        ) else {
            panic!("expected Granted")
        };
        let capture = EventCapture::default();
        let _guard = capture.install();
        assert!(matches!(
            r.commit_live(PROVIDER, "sid", "ho-1", ho_gen, live_terminal_owner(),),
            CommitOutcome::Committed
        ));
        let Some(commit) = capture.events().into_iter().find(|e| {
            e.target == "freshell_ownership" && e.event.as_deref() == Some("ownership.live.commit")
        }) else {
            return Err("the commit event must fire".to_string());
        };
        if commit.values.get("from_kind").map(String::as_str) != Some("Some(FreshAgent)") {
            return Err(format!(
                "the cross-kind commit logs the TRUE prior kind (the \
                 pre-handoff fresh-agent owner) — got {:?}",
                commit.values
            ));
        }
        if commit.values.get("to_kind").map(String::as_str) != Some("Terminal") {
            return Err(format!(
                "the cross-kind commit logs the committed target kind — got {:?}",
                commit.values
            ));
        }
        Ok(())
    }

    /// b8ke ext r6 F5: the UNIFORM transition-log schema — every
    /// transition records the complete stable field set:
    /// `ownership.live.commit` gains the (empty) failure_reason;
    /// `ownership.released` gains the None-valued to_kind (the release
    /// creates no new runtime — the vacancy is a VALUE, never a deleted
    /// field) and the empty failure_reason; `ownership.live.rekey_live`
    /// gains the operation id + failure_reason; the stale-stop sweep logs
    /// `duration_ms` (never `stale_age_ms`); and the live handoff-begin's
    /// duration is the PRIOR OWNER'S REAL TENURE (computed before the
    /// state replacement — pre-r6 it read the just-replaced state's
    /// timestamp and was always zero).
    #[test]
    fn commit_release_rekey_events_carry_the_stable_schema() {
        let r = RuntimeOwnershipRegistry::new();
        let capture = EventCapture::default();
        let _guard = capture.install();

        // Live{Terminal} → the commit + the released events.
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid-schema",
            RuntimeOwnerKind::Terminal,
            "op-schema",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-schema",
                "op-schema",
                generation,
                live_terminal_owner(),
            ),
            CommitOutcome::Committed
        ));
        r.release(
            PROVIDER,
            "sid-schema",
            &ReleaseClaim {
                operation_id: "op-schema".to_string(),
                generation,
                runtime: Some(live_terminal_owner()),
            },
            "test-release",
        );
        assert!(
            matches!(
                r.observe(PROVIDER, "sid-schema").state,
                OwnershipState::Vacant
            ),
            "the released key is Vacant"
        );
        let events = capture.events();
        let commit = events
            .iter()
            .find(|e| e.event.as_deref() == Some("ownership.live.commit"))
            .expect("the commit event fires");
        assert_eq!(
            commit.values.get("failure_reason").map(String::as_str),
            Some(""),
            "ownership.live.commit carries the empty (not-applicable) \
             failure_reason — got {:?}",
            commit.values
        );
        let released = events
            .iter()
            .find(|e| e.event.as_deref() == Some("ownership.released"))
            .expect("the released event fires");
        assert_eq!(
            released.values.get("to_kind").map(String::as_str),
            Some("None"),
            "ownership.released carries the None-valued to_kind (a release \
             creates no new runtime) — got {:?}",
            released.values
        );
        assert_eq!(
            released.values.get("failure_reason").map(String::as_str),
            Some(""),
            "ownership.released carries the empty failure_reason — got {:?}",
            released.values
        );

        // Live{FreshAgent} → the rekey event.
        let BeginOutcome::Granted {
            generation: fresh_gen,
        } = r.begin_start(
            PROVIDER,
            "sid-rekey",
            RuntimeOwnerKind::FreshAgent,
            "op-rekey-src",
            None,
            "test",
            1_000,
        )
        else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-rekey",
                "op-rekey-src",
                fresh_gen,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("sid-rekey".into()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r.rekey_live(
                PROVIDER,
                "sid-rekey",
                "sid-rekeyed",
                "sid-rekey",
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("sid-rekey".into()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
                "test",
                "op-rekey-move",
            ),
            CommitOutcome::Committed
        ));
        let rekey = capture
            .events()
            .into_iter()
            .find(|e| e.event.as_deref() == Some("ownership.live.rekey_live"))
            .expect("the rekey event fires");
        assert_eq!(
            rekey.values.get("operation_id").map(String::as_str),
            Some("op-rekey-move"),
            "ownership.live.rekey_live carries the rekey operation id — got {:?}",
            rekey.values
        );
        assert_eq!(
            rekey.values.get("failure_reason").map(String::as_str),
            Some(""),
            "ownership.live.rekey_live carries the empty failure_reason — got {:?}",
            rekey.values
        );
    }

    /// b8ke ext r6 F5: the stale-stop sweep logs `duration_ms` naming —
    /// never `stale_age_ms`.
    #[test]
    fn stale_stop_events_log_duration_ms_naming() {
        // b8ke ext r7 F4 DEFLAKE: the thread-local capture displacement
        // family — re-install + re-run, bounded (a REAL gap is
        // deterministic and fails every attempt).
        for _attempt in 0..3 {
            let outcome = std::panic::catch_unwind(run_stale_stop_naming_once);
            if outcome.is_ok() {
                return;
            }
        }
        // The bounded retries are exhausted: run once more WITHOUT the
        // catch so the real panic (message + location) surfaces.
        run_stale_stop_naming_once();
    }

    fn run_stale_stop_naming_once() {
        let r = RuntimeOwnershipRegistry::new();
        let capture = EventCapture::default();
        let _guard = capture.install();

        // Live{FreshAgent} → a stranded stop → the watchdog fences.
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid-stale-naming",
            RuntimeOwnerKind::FreshAgent,
            "op-live-naming",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-stale-naming",
                "op-live-naming",
                generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("sid-stale-naming".into()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));
        let claim = StopClaim {
            expected_kind: RuntimeOwnerKind::FreshAgent,
            expected_runtime: None,
            observed: ObservedFence {
                epoch: r.boot_epoch(),
                generation,
            },
        };
        match r.begin_stop(
            PROVIDER,
            "sid-stale-naming",
            "op-stranded-naming",
            &claim,
            "test",
            1_000,
        ) {
            StopOutcome::Granted { generation: sg } => {
                let flag = Arc::new(std::sync::atomic::AtomicBool::new(true));
                assert!(r.register_stop_settlement(
                    PROVIDER,
                    "sid-stale-naming",
                    "op-stranded-naming",
                    sg,
                    Arc::clone(&flag),
                ));
            }
            other => panic!("expected the stop claim granted, got {other:?}"),
        }
        let fenced = r.recover_stale_stoppings(10_000, 0);
        assert_eq!(fenced.len(), 1);
        let sweep_event = capture
            .events()
            .into_iter()
            .find(|e| {
                e.event.as_deref() == Some("ownership.stop.stale_stopping_fenced")
                    || e.event.as_deref() == Some("ownership.start.recovery_fenced")
            })
            .expect("the stale-stop sweep fence event fires");
        assert!(
            sweep_event.fields.contains(&"duration_ms".to_string()),
            "the stale-stop fence logs duration_ms naming — got {:?}",
            sweep_event.fields
        );
        assert!(
            !sweep_event.fields.contains(&"stale_age_ms".to_string()),
            "the stale-stop fence never logs stale_age_ms — got {:?}",
            sweep_event.fields
        );
    }

    /// b8ke ext r7 F4: the TRANSITION-SCHEMA ENUMERATION — every
    /// coordinator transition type carries the COMPLETE stable field set
    /// (from_kind, to_kind, operation_id, runtime_id, pid, duration_ms,
    /// failure_reason — None/empty where unknown, the same class-killer
    /// pattern as the parser enumeration). A missing field ANYWHERE in
    /// the enumerated set fails; new transition types join the list.
    #[test]
    fn every_coordinator_transition_type_carries_the_stable_schema() {
        // b8ke ext r7 F4 DEFLAKE: the thread-local capture displacement
        // family (the documented dead_session/load_index class — another
        // pooled-thread test's guard can momentarily displace this
        // thread's default, dropping a RANDOM event under full-suite
        // parallel load) — re-install + re-run the sequence, bounded. A
        // REAL schema gap is deterministic (the same field missing every
        // attempt); only the displacement heals on retry.
        let mut last_problem = String::new();
        for attempt in 0..3 {
            match run_enumeration_once() {
                Ok(()) => return,
                Err(problem) => {
                    eprintln!(
                        "enumeration attempt {attempt} incomplete ({problem}); retrying \
                         with a fresh capture"
                    );
                    last_problem = problem;
                }
            }
        }
        panic!("{last_problem}");
    }

    #[allow(clippy::type_complexity)]
    fn run_enumeration_once() -> Result<(), String> {
        let r = RuntimeOwnershipRegistry::new();
        let capture = EventCapture::default();
        let _guard = capture.install();

        // ── drive every transition type ──────────────────────────────────
        // 1. start.begin (granted, from Vacant).
        let BeginOutcome::Granted {
            generation: g_start,
        } = r.begin_start(
            PROVIDER,
            "sid-enum",
            RuntimeOwnerKind::Terminal,
            "op-enum-start",
            None,
            "test",
            1_000,
        )
        else {
            panic!("expected Granted")
        };
        // 2. live.commit.
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-enum",
                "op-enum-start",
                g_start,
                live_terminal_owner(),
            ),
            CommitOutcome::Committed
        ));
        // 3. stop.begin (granted + refused-stale).
        let claim = StopClaim {
            expected_kind: RuntimeOwnerKind::Terminal,
            expected_runtime: Some(live_terminal_owner()),
            observed: ObservedFence {
                epoch: r.boot_epoch(),
                generation: g_start,
            },
        };
        let StopOutcome::Granted { generation: g_stop } =
            r.begin_stop(PROVIDER, "sid-enum", "op-enum-stop", &claim, "test", 2_000)
        else {
            panic!("expected the stop granted")
        };
        // 4. stop.commit (release to Vacant).
        assert!(matches!(
            r.commit_stop(PROVIDER, "sid-enum", "op-enum-stop", g_stop),
            CommitOutcome::Committed
        ));
        // 5. handoff.begin (vacant + live) + handoff.failed.
        let BeginOutcome::Granted { generation: g_ho } = r.begin_handoff(
            PROVIDER,
            "sid-enum",
            RuntimeOwnerKind::Terminal,
            "op-enum-ho",
            None,
            "test",
            3_000,
        ) else {
            panic!("expected Granted")
        };
        // A vacant-entered handoff fails to the typed Vacant{NoPrior}
        // outcome — the handoff.failed event fires either way.
        assert!(matches!(
            r.fail(PROVIDER, "sid-enum", "op-enum-ho", g_ho, false),
            FailOutcome::Vacant { .. } | FailOutcome::Released
        ));
        // A second handoff from the restored vacancy, then the fenced
        // regime.
        let BeginOutcome::Granted { generation: g_ho2 } = r.begin_handoff(
            PROVIDER,
            "sid-enum",
            RuntimeOwnerKind::Terminal,
            "op-enum-ho2",
            None,
            "test",
            4_000,
        ) else {
            panic!("expected Granted")
        };
        // 6. handoff.fenced_unconfirmed (PlatformLimited — the reason
        // the acknowledged operator clear can release).
        assert!(matches!(
            r.fence_unconfirmed_handoff(
                PROVIDER,
                "sid-enum",
                "op-enum-ho2",
                g_ho2,
                FenceReason::PlatformLimited,
            ),
            FenceOutcome::Fenced
        ));
        // 7. release.fenced_noop — a mismatched release against a LIVE
        // record (the fenced-noop arm needs a live owner; the fence's
        // release is step 8). Seed a live owner first.
        let BeginOutcome::Granted { generation: g_noop } = r.begin_start(
            PROVIDER,
            "sid-enum-noop",
            RuntimeOwnerKind::Terminal,
            "op-enum-noop",
            None,
            "test",
            7_200,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-enum-noop",
                "op-enum-noop",
                g_noop,
                live_terminal_owner(),
            ),
            CommitOutcome::Committed
        ));
        r.release(
            PROVIDER,
            "sid-enum-noop",
            &ReleaseClaim {
                operation_id: "op-foreign".to_string(),
                generation: g_noop,
                runtime: Some(OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-foreign".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                }),
            },
            "test-noop",
        );
        // Release the seeded live owner properly (cleanup for this
        // enumeration key).
        r.release(
            PROVIDER,
            "sid-enum-noop",
            &ReleaseClaim {
                operation_id: "op-enum-noop".to_string(),
                generation: g_noop,
                runtime: Some(live_terminal_owner()),
            },
            "test-noop-real",
        );
        // 8. fenced.force_released_unconfirmable (the acknowledged clear —
        // b8ke ext r16 F4: lands in the TYPED cleared-unverified state,
        // never plain Vacant). b8ke ext r33 F1: the acknowledged START is
        // the FORCED-REAP-THEN-START handoff enter — the unverified
        // prior CARRIED as the reap target (the pre-r33 standalone vacate
        // API is DELETED). The entered handoff fails to the typed
        // Vacant{PriorNotLive} (no runner in this registry-only
        // enumeration) so the stale-generation drive below begins from
        // the vacated key exactly as before.
        assert!(matches!(
            r.force_release_platform_limited(
                PROVIDER,
                "sid-enum",
                ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: g_ho2,
                },
                "test-operator",
            ),
            ForceReleaseOutcome::Released
        ));
        assert!(matches!(
            r.observe(PROVIDER, "sid-enum").state,
            OwnershipState::Fenced {
                reason: FenceReason::ClearedUnverified,
                ..
            }
        ));
        let AcknowledgedStartOutcome::Granted { generation: g_ack } = r
            .begin_handoff_acknowledged_cleared_unverified(
                PROVIDER,
                "sid-enum",
                RuntimeOwnerKind::Terminal,
                "op-enum-ack",
                ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: g_ho2,
                },
                "test-operator-start-again",
                4_800,
            )
        else {
            panic!("the acknowledged start must enter")
        };
        // This key's fence came from a NO-PRIOR handoff (step 5's
        // vacant-entered handoff), so the enter legitimately carries no
        // prior — there is NOTHING to reap; the r33 prior-carrying
        // contract is asserted where a prior EXISTS (the cu key below).
        assert!(matches!(
            r.observe(PROVIDER, "sid-enum").state,
            OwnershipState::Handoff { generation, .. } if generation == g_ack
        ));
        assert!(matches!(
            r.fail(PROVIDER, "sid-enum", "op-enum-ack", g_ack, false),
            FailOutcome::Vacant { .. }
        ));
        // 9. begin_start.stale_generation + commit_live.stale_generation.
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid-enum",
                RuntimeOwnerKind::FreshAgent,
                "op-enum-stale",
                Some(ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: 0,
                }),
                "test",
                5_000,
            ),
            BeginOutcome::StaleGeneration { .. }
        ));
        let BeginOutcome::Granted {
            generation: g_stale,
        } = r.begin_start(
            PROVIDER,
            "sid-enum",
            RuntimeOwnerKind::FreshAgent,
            "op-enum-stale2",
            None,
            "test",
            6_000,
        )
        else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-enum",
                "op-enum-stale2",
                g_stale - 1,
                live_terminal_owner(),
            ),
            CommitOutcome::StaleGeneration { .. }
        ));
        // 9b. start.failed — release the stale2 claim (the key must be
        // Vacant for the later steps).
        assert!(matches!(
            r.fail(PROVIDER, "sid-enum", "op-enum-stale2", g_stale, false),
            FailOutcome::Released
        ));
        // 11. stop.fenced_unconfirmed (a stranded stop — re-seed a Live
        // FreshAgent owner first; the force-clear left the key Vacant).
        let BeginOutcome::Granted {
            generation: g_stop2_live,
        } = r.begin_start(
            PROVIDER,
            "sid-enum",
            RuntimeOwnerKind::FreshAgent,
            "op-enum-stop2-live",
            None,
            "test",
            7_500,
        )
        else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-enum",
                "op-enum-stop2-live",
                g_stop2_live,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("sid-enum".into()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));
        let StopOutcome::Granted {
            generation: g_stop2,
        } = r.begin_stop(
            PROVIDER,
            "sid-enum",
            "op-enum-stop2",
            &StopClaim {
                expected_kind: RuntimeOwnerKind::FreshAgent,
                expected_runtime: None,
                observed: ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: g_stop2_live,
                },
            },
            "test",
            8_000,
        )
        else {
            panic!("expected the stop granted")
        };
        assert!(matches!(
            r.fence_unconfirmed_stop(
                PROVIDER,
                "sid-enum",
                "op-enum-stop2",
                g_stop2,
                FenceReason::PlatformLimited,
            ),
            FenceOutcome::Fenced
        ));
        // 12. fenced.released (the confirmed-death probe release).
        assert!(matches!(
            r.release_fenced(PROVIDER, "sid-enum", "op-enum-stop2", g_stop2),
            CommitOutcome::Committed
        ));
        // 13. stop.aborted.
        let BeginOutcome::Granted {
            generation: g_abort,
        } = r.begin_start(
            PROVIDER,
            "sid-enum-abort",
            RuntimeOwnerKind::Terminal,
            "op-enum-abort",
            None,
            "test",
            9_000,
        )
        else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-enum-abort",
                "op-enum-abort",
                g_abort,
                live_terminal_owner(),
            ),
            CommitOutcome::Committed
        ));
        let StopOutcome::Granted {
            generation: g_stop3,
        } = r.begin_stop(
            PROVIDER,
            "sid-enum-abort",
            "op-enum-stop3",
            &StopClaim {
                expected_kind: RuntimeOwnerKind::Terminal,
                expected_runtime: Some(live_terminal_owner()),
                observed: ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: g_abort,
                },
            },
            "test",
            10_000,
        )
        else {
            panic!("expected the stop granted")
        };
        assert!(matches!(
            r.abort_stop(PROVIDER, "sid-enum-abort", "op-enum-stop3", g_stop3),
            AbortStopOutcome::Aborted
        ));
        // 14. live.commit_rekey + live.rekey_live.
        let BeginOutcome::Granted { generation: g_rk } = r.begin_start(
            PROVIDER,
            "sid-enum-rekey",
            RuntimeOwnerKind::FreshAgent,
            "op-enum-rk",
            None,
            "test",
            11_000,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-enum-rekey",
                "op-enum-rk",
                g_rk,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("sid-enum-rekey".into()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r.rekey_live(
                PROVIDER,
                "sid-enum-rekey",
                "sid-enum-rekeyed",
                "sid-enum-rekey",
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("sid-enum-rekey".into()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
                "test",
                "op-enum-rekey",
            ),
            CommitOutcome::Committed
        ));
        // 14b. live.commit_rekey — a start claim under the OLD key
        // committed to the NEW key (the claude lane's fork-rekey commit).
        let BeginOutcome::Granted { generation: g_crk } = r.begin_start(
            PROVIDER,
            "sid-enum-crk-old",
            RuntimeOwnerKind::FreshAgent,
            "op-enum-crk",
            None,
            "test",
            11_500,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live_rekey(
                PROVIDER,
                "sid-enum-crk-old",
                "sid-enum-crk-new",
                "op-enum-crk",
                g_crk,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("sid-enum-crk-new".into()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));

        // 10. begin.on_aliased_key (the old rekeyed key is Aliased).
        assert!(matches!(
            r.begin_start(
                PROVIDER,
                "sid-enum-rekey",
                RuntimeOwnerKind::Terminal,
                "op-enum-alias",
                None,
                "test",
                7_000,
            ),
            BeginOutcome::Blocked { .. }
        ));
        // 15. start.recovery_started + stale_stopping fenced/skipped.
        let BeginOutcome::Granted {
            generation: g_sweep,
        } = r.begin_start(
            PROVIDER,
            "sid-enum-sweep",
            RuntimeOwnerKind::FreshAgent,
            "op-enum-sweep",
            None,
            "test",
            12_000,
        )
        else {
            panic!("expected Granted")
        };
        let _ = r.recover_stale_starts(20_000, 0);
        let _ = g_sweep;
        // 16. start.failed (a claimed start's release).
        let BeginOutcome::Granted { generation: g_fail } = r.begin_start(
            PROVIDER,
            "sid-enum-fail",
            RuntimeOwnerKind::Terminal,
            "op-enum-fail",
            None,
            "test",
            13_000,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.fail(PROVIDER, "sid-enum-fail", "op-enum-fail", g_fail, false),
            FailOutcome::Released
        ));

        // 19. b8ke ext r33 F3: the previously-UNENUMERATED coordinator
        // mutations — the sibling-omission audit's fixes. Every one of
        // these is a state mutation whose event must carry the same
        // stable schema, and pre-r33 the "exhaustive" test never looked
        // at any of them.
        // 19a. ownership.released (the plain release's mutation — already
        // driven by the noop-cleanup release above, but never checked).
        // 19b. ownership.start.rekey (rekey_starting's move).
        let BeginOutcome::Granted {
            generation: g_rekey_start,
        } = r.begin_start(
            PROVIDER,
            "sid-enum-rekey-start-old",
            RuntimeOwnerKind::FreshAgent,
            "op-enum-rekey-start",
            None,
            "test",
            14_100,
        )
        else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.rekey_starting(
                PROVIDER,
                "sid-enum-rekey-start-old",
                "sid-enum-rekey-start-new",
                "op-enum-rekey-start",
                g_rekey_start,
            ),
            CommitOutcome::Committed
        ));
        // 19c. ownership.live.rekey_from_terminal (the identity rebind's
        // old→new move — the same shape the r33 F2 codex test drives).
        let BeginOutcome::Granted { generation: g_rft } = r.begin_start(
            PROVIDER,
            "sid-enum-rft-old",
            RuntimeOwnerKind::Terminal,
            "op-enum-rft-live",
            None,
            "test",
            14_200,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-enum-rft-old",
                "op-enum-rft-live",
                g_rft,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-enum-rft".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));
        let BeginOutcome::Granted {
            generation: g_rft_new,
        } = r.begin_start(
            PROVIDER,
            "sid-enum-rft-new",
            RuntimeOwnerKind::Terminal,
            "op-enum-rft-rebind",
            None,
            "test",
            14_300,
        )
        else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live_rekey_from_terminal(
                PROVIDER,
                "sid-enum-rft-new",
                "op-enum-rft-rebind",
                g_rft_new,
                "sid-enum-rft-old",
                "t-enum-rft",
                OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-enum-rft".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
                "test",
            ),
            CommitOutcome::Committed
        ));
        // 19d. ownership.force_released (the confirmed-kill raw force
        // release's mutation).
        let BeginOutcome::Granted {
            generation: g_force,
        } = r.begin_start(
            PROVIDER,
            "sid-enum-force",
            RuntimeOwnerKind::FreshAgent,
            "op-enum-force",
            None,
            "test",
            14_400,
        )
        else {
            panic!("expected Granted")
        };
        let force_owner = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("sid-enum-force".into()),
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-enum-force",
                "op-enum-force",
                g_force,
                force_owner.clone(),
            ),
            CommitOutcome::Committed
        ));
        r.force_release_for_confirmed_kill(
            PROVIDER,
            "sid-enum-force",
            &ReleaseClaim {
                operation_id: "op-enum-force".to_string(),
                generation: g_force,
                runtime: Some(force_owner),
            },
            "test-force",
        );
        // 19e. ownership.key.alias_vacant (the OpenCode placeholder→
        // durable identity alias — b8ke ext r33 F3's finding: the event
        // previously omitted operation_id/from-kind/to-kind/runtime_id/
        // pid entirely). The durable target key holds a live owner first
        // (the alias's to-side truth).
        let BeginOutcome::Granted {
            generation: g_alias_to,
        } = r.begin_start(
            PROVIDER,
            "sid-enum-alias-to",
            RuntimeOwnerKind::FreshAgent,
            "op-enum-alias-to",
            None,
            "test",
            14_500,
        )
        else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-enum-alias-to",
                "op-enum-alias-to",
                g_alias_to,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("sid-enum-alias-to".into()),
                    pid: Some(6464),
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r.alias_vacant_key(
                PROVIDER,
                "freshopencode-enum-placeholder",
                "sid-enum-alias-to",
                "op-enum-alias",
                "test",
            ),
            CommitOutcome::Committed
        ));
        // 17. b8ke ext r15 F3: the attach-guard pair (an armed guard over
        // a live key, then released) — the claims BLOCK handoff/stop
        // operations, so their transition records must carry the same
        // stable schema as every other coordinator transition.
        let r_attach = Arc::new(RuntimeOwnershipRegistry::new());
        // 18. b8ke ext r16 F4: the cleared-unverified pair's registry.
        let r_cu = Arc::new(RuntimeOwnershipRegistry::new());
        let BeginOutcome::Granted {
            generation: g_attach,
        } = r_attach.begin_start(
            PROVIDER,
            "sid-enum-attach",
            RuntimeOwnerKind::Terminal,
            "op-enum-attach-live",
            None,
            "test",
            14_000,
        )
        else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r_attach.commit_live(
                PROVIDER,
                "sid-enum-attach",
                "op-enum-attach-live",
                g_attach,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-enum-attach".into()),
                    live_session_key: None,
                    pid: Some(4242),
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));
        let AttachGuardOutcome::Armed(guard) = r_attach.begin_attach_guard(
            PROVIDER,
            "sid-enum-attach",
            "op-enum-attach",
            Some(g_attach),
            "test-attach",
        ) else {
            panic!("expected Armed")
        };
        drop(guard);

        // 18. b8ke ext r16 F4: the cleared-unverified pair — the
        // acknowledged PlatformLimited force-clear lands in the typed
        // state (never plain Vacant), and the operator's acknowledged
        // START vacates it (the stale-observation refusal arm is also
        // driven: the same API with a stale pair first).
        let BeginOutcome::Granted { generation: g_cu } = r_cu.begin_start(
            PROVIDER,
            "sid-enum-cleared-unverified",
            RuntimeOwnerKind::FreshAgent,
            "op-enum-cu-live",
            None,
            "test",
            15_000,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r_cu.commit_live(
                PROVIDER,
                "sid-enum-cleared-unverified",
                "op-enum-cu-live",
                g_cu,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("sid-enum-cleared-unverified".into()),
                    pid: Some(5555),
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));
        // The PlatformLimited fence, taken directly through
        // fence_unconfirmed_handoff (the stop's PlatformLimited outcome
        // needs the platform-limited teardown seam; the fence shape is
        // identical). The fence requires the in-flight Handoff record —
        // enter it first.
        let BeginOutcome::Granted {
            generation: g_cu_ho,
        } = r_cu.begin_handoff(
            PROVIDER,
            "sid-enum-cleared-unverified",
            RuntimeOwnerKind::Terminal,
            "op-enum-cu-fence",
            None,
            "test",
            15_500,
        )
        else {
            panic!("expected the cu handoff granted")
        };
        assert!(matches!(
            r_cu.fence_unconfirmed_handoff(
                PROVIDER,
                "sid-enum-cleared-unverified",
                "op-enum-cu-fence",
                g_cu_ho,
                FenceReason::PlatformLimited,
            ),
            FenceOutcome::Fenced
        ));
        let cu_fence_generation = r_cu
            .observe(PROVIDER, "sid-enum-cleared-unverified")
            .generation;
        // The acknowledged clear lands typed.
        assert!(matches!(
            r_cu.force_release_platform_limited(
                PROVIDER,
                "sid-enum-cleared-unverified",
                ObservedFence {
                    epoch: r_cu.boot_epoch(),
                    generation: cu_fence_generation,
                },
                "operator",
            ),
            ForceReleaseOutcome::Released
        ));
        // b8ke ext r33 F1: the legacy standalone acknowledge API is
        // DELETED (its plain-Vacant vacate licensed a second writer) —
        // its stale-observation arm's coverage lives on in the NEW
        // acknowledged-start enter's own stale drive below (op-enum-cu2).
        // THE ACKNOWLEDGED START — b8ke ext r17 F1: the ATOMIC
        // ClearedUnverified→Handoff claim (one lock hold, the risk carried
        // into the claim); b8ke ext r33 F1: the enter CARRIES the
        // unverified prior as the handoff's reap target (the runner
        // kills and confirms it before the new writer commits).
        let AcknowledgedStartOutcome::Granted {
            generation: cu_entered,
        } = r_cu.begin_handoff_acknowledged_cleared_unverified(
            PROVIDER,
            "sid-enum-cleared-unverified",
            RuntimeOwnerKind::Terminal,
            "op-enum-cu-ack",
            ObservedFence {
                epoch: r_cu.boot_epoch(),
                generation: cu_fence_generation,
            },
            "operator-start-again",
            17_000,
        )
        else {
            panic!("the cu acknowledged start must grant")
        };
        assert!(matches!(
            r_cu.observe(PROVIDER, "sid-enum-cleared-unverified").state,
            OwnershipState::Handoff { prior: Some((owner, _)), generation, .. }
                if generation == cu_entered
                    && owner.kind == RuntimeOwnerKind::FreshAgent
                    && owner.pid == Some(5555)
        ));
        // The stale-observation refusal arm (a fresh cu key, the stale pair).
        let BeginOutcome::Granted { generation: g_cu2 } = r_cu.begin_start(
            PROVIDER,
            "sid-enum-cu-stale-obs",
            RuntimeOwnerKind::FreshAgent,
            "op-enum-cu2-live",
            None,
            "test",
            17_500,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r_cu.commit_live(
                PROVIDER,
                "sid-enum-cu-stale-obs",
                "op-enum-cu2-live",
                g_cu2,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("sid-enum-cu-stale-obs".into()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));
        let BeginOutcome::Granted {
            generation: g_cu2_fence,
        } = r_cu.begin_handoff(
            PROVIDER,
            "sid-enum-cu-stale-obs",
            RuntimeOwnerKind::Terminal,
            "op-enum-cu2-fence",
            None,
            "test",
            17_600,
        )
        else {
            panic!("expected the cu2 handoff granted")
        };
        assert!(matches!(
            r_cu.fence_unconfirmed_handoff(
                PROVIDER,
                "sid-enum-cu-stale-obs",
                "op-enum-cu2-fence",
                g_cu2_fence,
                FenceReason::PlatformLimited,
            ),
            FenceOutcome::Fenced
        ));
        let cu2_fence_generation = r_cu.observe(PROVIDER, "sid-enum-cu-stale-obs").generation;
        assert!(matches!(
            r_cu.force_release_platform_limited(
                PROVIDER,
                "sid-enum-cu-stale-obs",
                ObservedFence {
                    epoch: r_cu.boot_epoch(),
                    generation: cu2_fence_generation,
                },
                "operator",
            ),
            ForceReleaseOutcome::Released
        ));
        assert!(matches!(
            r_cu.begin_handoff_acknowledged_cleared_unverified(
                PROVIDER,
                "sid-enum-cu-stale-obs",
                RuntimeOwnerKind::Terminal,
                "op-enum-cu2-ack",
                ObservedFence {
                    epoch: r_cu.boot_epoch(),
                    generation: cu2_fence_generation.saturating_sub(1),
                },
                "operator",
                17_700,
            ),
            AcknowledgedStartOutcome::StaleObservation { .. }
        ));

        // codex-pane-lifecycle Task 8: the unit-scoped transitions (a
        // separate registry so the earlier keys stay as they are).
        let r_unit = RuntimeOwnershipRegistry::new();
        drive_unit_scoped_transitions(&r_unit, "u-enum", "t-enum-unit");

        // ── the ENUMERATION: every captured transition event carries the
        // complete stable schema. A missing field anywhere fails.
        let events = capture.events();
        let stable_fields = [
            "operation_id",
            "from_kind",
            "to_kind",
            "runtime_id",
            "pid",
            "duration_ms",
            "failure_reason",
        ];
        let expected_transitions = [
            "ownership.start.begin",
            "ownership.live.commit",
            "ownership.stop.begin",
            "ownership.stop.commit",
            "ownership.handoff.begin",
            "ownership.handoff.failed",
            "ownership.handoff.fenced_unconfirmed",
            "ownership.release.fenced_noop",
            "ownership.fenced.force_released_unconfirmable",
            "ownership.begin_start.stale_generation",
            "ownership.commit_live.stale_generation",
            "ownership.begin.on_aliased_key",
            "ownership.stop.fenced_unconfirmed",
            "ownership.fenced.released",
            "ownership.stop.aborted",
            "ownership.live.commit_rekey",
            "ownership.live.rekey_live",
            "ownership.start.recovery_started",
            "ownership.start.failed",
            "ownership.attach_guard.armed",
            "ownership.attach_guard.released",
            // b8ke ext r33 F1: the two legacy standalone-acknowledge
            // events are GONE with the deleted API; the acknowledged
            // start's coverage is the enter + its stale refusal below.
            "ownership.handoff.acknowledged_start.entered",
            "ownership.handoff.acknowledged_start.stale_observation",
            // b8ke ext r33 F3: the sibling-omission audit — the
            // previously-UNENUMERATED coordinator mutations now checked
            // for the same stable schema (the alias_vacant event itself
            // was the finding: it omitted the required fields AND the
            // enumeration entirely, so no test could catch it).
            "ownership.released",
            "ownership.start.rekey",
            "ownership.live.rekey_from_terminal",
            "ownership.force_released",
            "ownership.key.alias_vacant",
            // codex-pane-lifecycle Task 8: the unit-scoped transitions
            // (the unit stop/commit log `ownership.stop.begin` /
            // `ownership.stop.commit`, listed above).
            "ownership.extra.hold",
            "ownership.extra.release",
            "ownership.stop.restored",
            "ownership.handoff.extra_hold_adopt",
        ];
        let mut covered: Vec<&str> = Vec::new();
        for event in &events {
            let Some(name) = event.event.as_deref() else {
                continue;
            };
            if !expected_transitions.contains(&name) {
                continue;
            }
            if !covered.contains(&name) {
                covered.push(name);
            }
            for field in stable_fields {
                if !event.fields.contains(&field.to_string()) {
                    return Err(format!(
                        "{name} must carry {field} (the stable transition schema) — \
                         got {:?}",
                        event.fields
                    ));
                }
            }
        }
        for expected in expected_transitions {
            if !covered.contains(&expected) {
                return Err(format!(
                    "the enumeration must cover {expected} — covered: {covered:?}"
                ));
            }
        }
        Ok(())
    }

    /// Drive every unit-scoped transition once for `unit_id` (owner
    /// terminal `terminal_id`): a Live main key, an extra hold adopted by a
    /// switch and released, a boot seed, the unit stop (joining the seed),
    /// the stale-Stopping sweep skipping the unit, and the Gone commit.
    fn drive_unit_scoped_transitions(
        r: &RuntimeOwnershipRegistry,
        unit_id: &str,
        terminal_id: &str,
    ) {
        let unit_owner = OwnerIdentity {
            terminal_id: Some(terminal_id.into()),
            unit_id: Some(unit_id.into()),
            ..OwnerIdentity::default()
        };
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid-unit-main",
            RuntimeOwnerKind::Terminal,
            "op-unit-start",
            None,
            "test",
            18_000,
        ) else {
            panic!("expected Granted")
        };
        assert_eq!(
            r.commit_live(
                PROVIDER,
                "sid-unit-main",
                "op-unit-start",
                generation,
                unit_owner.clone()
            ),
            CommitOutcome::Committed
        );
        assert!(matches!(
            r.hold_extra(
                PROVIDER,
                "sid-unit-extra",
                unit_owner.clone(),
                "test",
                18_100
            ),
            HoldOutcome::Held { .. }
        ));
        assert!(matches!(
            r.begin_handoff(
                PROVIDER,
                "sid-unit-extra",
                RuntimeOwnerKind::FreshAgent,
                "op-unit-switch",
                None,
                "test",
                18_200,
            ),
            BeginOutcome::AdoptLive { .. }
        ));
        assert!(r.release_extra(PROVIDER, "sid-unit-extra", unit_id));
        assert!(r.restore_stopping(
            PROVIDER,
            "sid-unit-restored",
            unit_owner,
            "op-unit-stop",
            "boot",
            18_300,
        ));
        assert_eq!(
            r.begin_unit_stop(unit_id, "op-unit-stop", "test", 18_400)
                .len(),
            2
        );
        assert!(r
            .recover_stale_stoppings(18_400 + 3_600_000, 30_000)
            .is_empty());
        assert_eq!(r.commit_unit_stop(unit_id, "op-unit-stop").len(), 2);
    }

    /// codex-pane-lifecycle Task 8: every unit-scoped ownership event is
    /// keyed by the unit and its terminal (plain values), so the registry's
    /// lines join the `freshell_unit` lifecycle lines of the same unit.
    #[test]
    fn unit_scoped_events_carry_the_unit_keys() {
        let mut last_problem = String::new();
        for attempt in 0..3 {
            match run_unit_keys_once() {
                Ok(()) => return,
                Err(problem) => {
                    eprintln!(
                        "unit-keys attempt {attempt} incomplete ({problem}); retrying with a \
                         fresh capture"
                    );
                    last_problem = problem;
                }
            }
        }
        panic!("{last_problem}");
    }

    fn run_unit_keys_once() -> Result<(), String> {
        let r = RuntimeOwnershipRegistry::new();
        let capture = EventCapture::default();
        let _guard = capture.install();
        drive_unit_scoped_transitions(&r, "u-keys", "t-keys");
        let events = capture.events();
        for (name, extra_fields) in [
            (
                "ownership.stop.begin",
                &["from_state", "attach_in_flight"][..],
            ),
            ("ownership.stop.commit", &["attach_guards_cleared"][..]),
            ("ownership.extra.hold", &[][..]),
            ("ownership.extra.release", &[][..]),
            ("ownership.stop.restored", &[][..]),
            ("ownership.handoff.extra_hold_adopt", &[][..]),
            ("ownership.stop.stale_stopping_skipped_unit", &[][..]),
        ] {
            let matching: Vec<&CapturedEvent> = events
                .iter()
                .filter(|e| e.event.as_deref() == Some(name))
                .collect();
            if matching.is_empty() {
                return Err(format!("{name} was not logged"));
            }
            for event in matching {
                for (key, expected) in [("unit_id", "u-keys"), ("terminal_id", "t-keys")] {
                    if event.values.get(key).map(String::as_str) != Some(expected) {
                        return Err(format!(
                            "{name} must carry {key}={expected} — got {:?}",
                            event.values
                        ));
                    }
                }
                for field in extra_fields {
                    if !event.fields.contains(&field.to_string()) {
                        return Err(format!(
                            "{name} must carry {field} — got {:?}",
                            event.fields
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    // ── b8ke ext r20 F1: the start-sweep's settlement consultation ────

    // The witness fixture: a Starting claim with a REGISTERED settle
    // witness whose settle_fired flag is armed-but-NOT-fired (the
    // handler still runs — the slow-managed-launch shape).
    fn witnessed_start(r: &RuntimeOwnershipRegistry, op: &str, fired: bool) -> u64 {
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid-witness",
            RuntimeOwnerKind::Terminal,
            op,
            None,
            "test",
            0,
        ) else {
            panic!("fixture granted")
        };
        let settle_fired = Arc::new(AtomicBool::new(false));
        let registered = r.register_start_cancellation(
            PROVIDER,
            "sid-witness",
            op,
            generation,
            Arc::new(|| {}),
            Box::new(std::future::pending::<()>()),
            Some(Arc::clone(&settle_fired)),
        );
        assert!(registered, "fixture: the witness registered");
        if fired {
            settle_fired.store(true, Ordering::SeqCst);
        }
        generation
    }

    #[test]
    fn a_witnessed_slow_start_is_not_swept_while_its_handler_runs() {
        let r = RuntimeOwnershipRegistry::new();
        witnessed_start(&r, "op-r20-f1-live", false);
        // The handler still runs: the over-age sweep SKIPS the
        // witnessed slow-but-live start (a slow managed launch is a
        // legitimate in-progress start the watchdog does NOT fence —
        // pre-r20 the sweep converted it unconditionally).
        let recovered = r.recover_stale_starts(100_000, 30_000);
        assert!(
            recovered.is_empty(),
            "a witness-backed in-progress start is NOT stale — got {} ops",
            recovered
                .iter()
                .map(|rec| rec.operation_id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
        assert!(
            matches!(
                r.observe(PROVIDER, "sid-witness").state,
                OwnershipState::Starting { .. }
            ),
            "the in-progress start keeps its Starting record"
        );
    }

    #[test]
    fn a_witnessed_start_whose_handler_unwound_is_swept() {
        // The settle_fired flag (the handler unwound WITHOUT commit) —
        // the sweep takes the record and the host resolves it through
        // the witness (the abandoned-start arm the watchdog exists for).
        let r = RuntimeOwnershipRegistry::new();
        witnessed_start(&r, "op-r20-f1-fired", true);
        let recovered = r.recover_stale_starts(100_000, 30_000);
        assert!(
            recovered
                .iter()
                .any(|rec| rec.operation_id == "op-r20-f1-fired"),
            "a handler-unwound witnessed start IS swept"
        );
        assert!(matches!(
            r.observe(PROVIDER, "sid-witness").state,
            OwnershipState::Stopping { .. }
        ));
    }

    #[test]
    fn an_unwitnessed_overage_start_is_still_swept() {
        // The no-witness arm (a pre-witness path or a crashed
        // pre-registration handler) — the sweep's zombie authority is
        // unchanged.
        let r = RuntimeOwnershipRegistry::new();
        let BeginOutcome::Granted { .. } = r.begin_start(
            PROVIDER,
            "sid-unwitnessed",
            RuntimeOwnerKind::Terminal,
            "op-r20-f1-bare",
            None,
            "test",
            0,
        ) else {
            panic!("fixture granted")
        };
        let recovered = r.recover_stale_starts(100_000, 30_000);
        assert!(
            recovered
                .iter()
                .any(|rec| rec.operation_id == "op-r20-f1-bare"),
            "an unwitnessed over-age start IS swept"
        );
    }

    /// b8ke ext r15 F3: the attach-guard release event's duration is
    /// the REAL measured window — the guard's held wall-clock time
    /// between arm and release (pre-r15 the event hard-coded 0).
    #[test]
    fn the_attach_guard_release_duration_is_the_real_window() {
        let r = Arc::new(RuntimeOwnershipRegistry::new());
        let capture = EventCapture::default();
        let _guard = capture.install();

        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid-attach-dur",
            RuntimeOwnerKind::Terminal,
            "op-attach-dur",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-attach-dur",
                "op-attach-dur",
                generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-attach-dur".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));
        let AttachGuardOutcome::Armed(guard) = r.begin_attach_guard(
            PROVIDER,
            "sid-attach-dur",
            "op-attach-dur-guard",
            Some(generation),
            "test-attach",
        ) else {
            panic!("expected Armed")
        };
        std::thread::sleep(std::time::Duration::from_millis(60));
        drop(guard);

        let release = capture
            .events()
            .into_iter()
            .find(|event| event.event.as_deref() == Some("ownership.attach_guard.released"))
            .expect("the release event");
        let duration = release
            .values
            .get("duration_ms")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or_else(|| {
                panic!(
                    "duration_ms present with a value — got {:?}",
                    release.values
                )
            });
        assert!(
            duration >= 50,
            "the release duration is the REAL measured window (>= the 60ms hold), got {duration}"
        );
    }

    // ── b8ke ext r17 F1: the atomic acknowledged start ────────────────────

    /// The F1 fixture: a key sitting in Fenced{ClearedUnverified} at a
    /// known generation (the acknowledged-clear landing).
    fn cleared_unverified_registry() -> (Arc<RuntimeOwnershipRegistry>, String, u64) {
        let r = Arc::new(RuntimeOwnershipRegistry::new());
        let sid = "sid-r17-f1".to_string();
        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            &sid,
            RuntimeOwnerKind::FreshAgent,
            "op-seed-live",
            None,
            "test",
            1_000,
        ) else {
            panic!("seed granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                &sid,
                "op-seed-live",
                generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some(sid.clone()),
                    pid: Some(1111),
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        ));
        let BeginOutcome::Granted {
            generation: fence_gen,
        } = r.begin_handoff(
            PROVIDER,
            &sid,
            RuntimeOwnerKind::Terminal,
            "op-seed-fence",
            None,
            "test",
            2_000,
        )
        else {
            panic!("fence granted")
        };
        assert!(matches!(
            r.fence_unconfirmed_handoff(
                PROVIDER,
                &sid,
                "op-seed-fence",
                fence_gen,
                FenceReason::PlatformLimited,
            ),
            FenceOutcome::Fenced
        ));
        let fence_snapshot = r.observe(PROVIDER, &sid);
        assert!(matches!(
            r.force_release_platform_limited(
                PROVIDER,
                &sid,
                ObservedFence {
                    epoch: r.boot_epoch(),
                    generation: fence_snapshot.generation,
                },
                "operator",
            ),
            ForceReleaseOutcome::Released
        ));
        assert!(matches!(
            r.observe(PROVIDER, &sid).state,
            OwnershipState::Fenced {
                reason: FenceReason::ClearedUnverified,
                ..
            }
        ));
        let cleared = r.observe(PROVIDER, &sid);
        (r, sid, cleared.generation)
    }

    /// b8ke ext r17 F1 (b): the acknowledged start completes ATOMICICALLY —
    /// `Fenced{ClearedUnverified} → Handoff` in ONE lock hold; the record is
    /// NEVER plain Vacant, and the entered handoff is the no-prior sequence
    /// (prior None — the unverified descendants are the operator's
    /// acknowledged risk, never a reap target).
    #[test]
    fn the_acknowledged_start_enters_handoff_atomically_never_vacant() {
        let (r, sid, cleared_generation) = cleared_unverified_registry();
        let outcome = r.begin_handoff_acknowledged_cleared_unverified(
            PROVIDER,
            &sid,
            RuntimeOwnerKind::Terminal,
            "op-ack-start",
            ObservedFence {
                epoch: r.boot_epoch(),
                generation: cleared_generation,
            },
            "operator-start-again",
            3_000,
        );
        match outcome {
            AcknowledgedStartOutcome::Granted { generation } => {
                assert_eq!(generation, cleared_generation + 1);
                match r.observe(PROVIDER, &sid).state {
                    OwnershipState::Handoff {
                        prior,
                        to_kind,
                        operation_id,
                        generation: entered_gen,
                        ..
                    } => {
                        // b8ke ext r33 F1: the enter CARRIES the unverified
                        // prior as the handoff's REAP TARGET — the
                        // FORCED-REAP-THEN-START contract (the runner
                        // kills and confirms it before the new writer
                        // commits). Pre-r33 this pinned `prior.is_none()`
                        // — the no-prior sequence that started a second
                        // writer over the possibly-live prior.
                        match prior {
                            Some((owner, prior_gen)) => {
                                assert_eq!(
                                    owner.kind,
                                    RuntimeOwnerKind::FreshAgent,
                                    "the unverified prior is carried verbatim: {owner:?}"
                                );
                                assert_eq!(prior_gen, 1);
                            }
                            None => panic!(
                                "the acknowledged start carries the prior as the \
                                 reap target — never the discarded no-prior sequence"
                            ),
                        }
                        assert_eq!(to_kind, RuntimeOwnerKind::Terminal);
                        assert_eq!(operation_id, "op-ack-start");
                        assert_eq!(entered_gen, cleared_generation + 1);
                    }
                    other => {
                        panic!("the acknowledged start enters Handoff atomically — got {other:?}")
                    }
                }
            }
            other => panic!("the acknowledged start must grant: {other:?}"),
        }
    }

    /// b8ke ext r17 F1 (a)+(c): the concurrent-race property — N threads
    /// of acknowledged starts, UNACKNOWLEDGED plain begins, and plain
    /// terminal starts hammer the cleared-unverified key: EXACTLY ONE
    /// winner, the key is NEVER observed plain Vacant (no two-step
    /// opening to consume), and every loser answers typed
    /// (Blocked/Refused/LostRace — never a mid-race Vacant grant).
    #[test]
    fn the_acknowledged_start_race_has_exactly_one_winner_never_vacant() {
        let (r, sid, cleared_generation) = cleared_unverified_registry();
        let fence = ObservedFence {
            epoch: r.boot_epoch(),
            generation: cleared_generation,
        };
        let winners = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let vacants = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut handles = Vec::new();
        for i in 0..8u32 {
            let r = Arc::clone(&r);
            let sid = sid.clone();
            let winners = Arc::clone(&winners);
            let vacants = Arc::clone(&vacants);
            handles.push(std::thread::spawn(move || {
                let op = format!("op-race-{i}");
                match i % 4 {
                    // The acknowledged start.
                    0 => {
                        match r.begin_handoff_acknowledged_cleared_unverified(
                            PROVIDER,
                            &sid,
                            RuntimeOwnerKind::Terminal,
                            &op,
                            fence,
                            "operator-start-again",
                            4_000,
                        ) {
                            AcknowledgedStartOutcome::Granted { .. } => {
                                winners.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            }
                            AcknowledgedStartOutcome::StaleObservation { .. }
                            | AcknowledgedStartOutcome::LostRace { .. } => {}
                        }
                    }
                    // The UNACKNOWLEDGED plain begins — these must NEVER
                    // consume the opening (pre-r17 they could claim the
                    // two-step vacancy).
                    1 | 2 => {
                        match r.begin_handoff(
                            PROVIDER,
                            &sid,
                            RuntimeOwnerKind::Terminal,
                            &op,
                            None,
                            "naive-device",
                            4_000,
                        ) {
                            BeginOutcome::Granted { .. } => {
                                winners.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            }
                            BeginOutcome::Blocked { state, .. } => {
                                if matches!(state, OwnershipState::Vacant) {
                                    vacants.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                                }
                            }
                            _ => {}
                        }
                    }
                    // A plain terminal start.
                    _ => {
                        match r.begin_start(
                            PROVIDER,
                            &sid,
                            RuntimeOwnerKind::Terminal,
                            &op,
                            None,
                            "plain-start",
                            4_000,
                        ) {
                            BeginOutcome::Granted { .. } => {
                                winners.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            }
                            BeginOutcome::Blocked { state, .. } => {
                                if matches!(state, OwnershipState::Vacant) {
                                    vacants.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                // The key is never observed plain Vacant during the race
                // (the transition is Fenced→Handoff; a Vacant observation
                // would prove the pre-r17 two-step window).
                if matches!(r.observe(PROVIDER, &sid).state, OwnershipState::Vacant) {
                    // Only legitimate AFTER a single winner entered and its
                    // commit/fail settled — under the race the winner is
                    // in-flight (Handoff), so Vacant here is the defect.
                    // (The threads never commit/fail their tickets, so the
                    // record stays in its post-begin state.)
                    vacants.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }));
        }
        for handle in handles {
            handle.join().expect("race thread");
        }
        assert_eq!(
            winners.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "exactly one writer wins the cleared-unverified race"
        );
        assert_eq!(
            vacants.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "the key is NEVER plain Vacant during the race — no two-step opening"
        );
    }

    /// b8ke ext r17 F1 (a): an UNACKNOWLEDGED hammering start can NEVER
    /// consume the opening during the acknowledged start — the transition
    /// is ONE atomic lock hold, so there is no vacancy to claim (pre-r17
    /// the two-step clear-to-Vacant/re-claim left a real window a
    /// concurrent unacknowledged request could take, with the losing
    /// original panicking).
    #[test]
    fn an_unacknowledged_hammer_cannot_consume_the_acknowledged_opening() {
        let (r, sid, cleared_generation) = cleared_unverified_registry();
        // The spinner: an unacknowledged device hammering plain starts
        // against the key for the whole duration of the acknowledged start.
        let spinner_r = Arc::clone(&r);
        let spinner_sid = sid.clone();
        let spinner_wins = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let spinner_wins_for_thread = Arc::clone(&spinner_wins);
        let stop_for_thread = Arc::clone(&stop);
        let started_for_thread = Arc::clone(&started);
        let spinner = std::thread::spawn(move || {
            let mut attempts = 0usize;
            started_for_thread.store(true, std::sync::atomic::Ordering::SeqCst);
            while !stop_for_thread.load(std::sync::atomic::Ordering::SeqCst) && attempts < 500_000 {
                attempts += 1;
                if let BeginOutcome::Granted { .. } = spinner_r.begin_start(
                    PROVIDER,
                    &spinner_sid,
                    RuntimeOwnerKind::Terminal,
                    "op-naive-hammer",
                    None,
                    "naive-device",
                    4_000,
                ) {
                    spinner_wins_for_thread.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    break;
                }
            }
        });

        // The spinner must be RUNNING before the acknowledged start —
        // the race is about the window DURING the start, not thread
        // startup.
        while !started.load(std::sync::atomic::Ordering::SeqCst) {
            std::thread::yield_now();
        }

        // THE ACKNOWLEDGED START (with the spinner hammering the same lock).
        let outcome = r.begin_handoff_acknowledged_cleared_unverified(
            PROVIDER,
            &sid,
            RuntimeOwnerKind::Terminal,
            "op-ack-start-hammered",
            ObservedFence {
                epoch: r.boot_epoch(),
                generation: cleared_generation,
            },
            "operator-start-again",
            4_500,
        );
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        spinner.join().expect("spinner thread");

        // EXACTLY the acknowledged start wins; the spinner NEVER consumed
        // the opening (pre-r17 it granted from the two-step vacancy).
        assert!(
            matches!(outcome, AcknowledgedStartOutcome::Granted { .. }),
            "the acknowledged start wins its own opening: {outcome:?}"
        );
        assert_eq!(
            spinner_wins.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "the unacknowledged hammer never consumed the opening"
        );
    }

    /// b8ke ext r17 F1 (c): a claim that loses the race answers TYPED —
    /// the confirmed-death release (Vacant at the SAME generation) makes
    /// the second acknowledged call a LostRace, never a panic and never a
    /// fabricated in-progress fallback.
    #[test]
    fn the_acknowledged_start_losing_the_race_answers_typed() {
        let (r, sid, cleared_generation) = cleared_unverified_registry();
        // The fence clears on confirmed death (the existing watcher path)
        // at the SAME generation — no state advance, so the still-current
        // observed pair is valid.
        assert!(matches!(
            r.release_fenced(PROVIDER, &sid, "op-seed-fence", cleared_generation),
            CommitOutcome::Committed
        ));
        assert!(matches!(
            r.observe(PROVIDER, &sid).state,
            OwnershipState::Vacant
        ));
        // The acknowledged start with the still-current pair answers
        // LostRace{Vacant} — typed, never a panic.
        match r.begin_handoff_acknowledged_cleared_unverified(
            PROVIDER,
            &sid,
            RuntimeOwnerKind::Terminal,
            "op-ack-lost",
            ObservedFence {
                epoch: r.boot_epoch(),
                generation: cleared_generation,
            },
            "operator-start-again",
            5_000,
        ) {
            AcknowledgedStartOutcome::LostRace { state } => {
                assert!(matches!(state, OwnershipState::Vacant), "{state:?}");
            }
            other => panic!("the lost race must answer LostRace typed — got {other:?}"),
        }
    }

    /// b8ke ext r6 F5: the live handoff-begin's duration is the PRIOR
    /// OWNER'S REAL TENURE — computed before the state replacement
    /// (pre-r6 it read the just-replaced Handoff state's own timestamp,
    /// so it was always zero).
    #[test]
    fn the_live_handoff_begin_duration_is_the_prior_tenure() {
        let r = RuntimeOwnershipRegistry::new();
        let capture = EventCapture::default();
        let _guard = capture.install();

        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid-tenure",
            RuntimeOwnerKind::Terminal,
            "op-tenure",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-tenure",
                "op-tenure",
                generation,
                live_terminal_owner(),
            ),
            CommitOutcome::Committed
        ));
        // The handoff begin carries a now_ms 10s past the REAL epoch: the
        // prior's tenure is at least 10s by construction (pre-r6 the log
        // read the replaced state's timestamp and printed 0).
        let begin_now = now_epoch_ms() + 10_000;
        let BeginOutcome::Granted { .. } = r.begin_handoff(
            PROVIDER,
            "sid-tenure",
            RuntimeOwnerKind::FreshAgent,
            "ho-tenure",
            None,
            "test",
            begin_now,
        ) else {
            panic!("expected Granted")
        };
        let begin = capture
            .events()
            .into_iter()
            .find(|e| {
                e.event.as_deref() == Some("ownership.handoff.begin")
                    && e.values.get("session_id").map(String::as_str) == Some("sid-tenure")
            })
            .expect("the handoff begin event fires");
        let _ = begin;
        let duration: u64 = begin
            .values
            .get("duration_ms")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        assert!(
            duration >= 10_000,
            "the live handoff-begin duration is the prior's REAL tenure — \
             got {duration} ({:?})",
            begin.values
        );
    }

    /// b8ke ext r8 F3: the granted stop.begin's duration is the PRIOR
    /// RUNTIME'S REAL TENURE — computed before the state replacement
    /// (pre-r8 the log read the just-replaced Stopping state's own
    /// timestamp, so the tenure reported ~zero / the test-clock delta
    /// instead of the Live era's age).
    #[test]
    fn the_granted_stop_begin_duration_is_the_prior_tenure() {
        let r = RuntimeOwnershipRegistry::new();
        let capture = EventCapture::default();
        let _guard = capture.install();

        let BeginOutcome::Granted { generation } = r.begin_start(
            PROVIDER,
            "sid-stop-tenure",
            RuntimeOwnerKind::Terminal,
            "op-stop-tenure",
            None,
            "test",
            1_000,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            r.commit_live(
                PROVIDER,
                "sid-stop-tenure",
                "op-stop-tenure",
                generation,
                live_terminal_owner(),
            ),
            CommitOutcome::Committed
        ));
        // The stop begin carries a now_ms 10s past the commit: the prior's
        // tenure is at least 10s by construction (pre-r8 the log read the
        // replaced Stopping state's own timestamp).
        let begin_now = now_epoch_ms() + 10_000;
        let claim = StopClaim {
            expected_kind: RuntimeOwnerKind::Terminal,
            expected_runtime: Some(live_terminal_owner()),
            observed: ObservedFence {
                epoch: r.boot_epoch(),
                generation,
            },
        };
        let StopOutcome::Granted { .. } = r.begin_stop(
            PROVIDER,
            "sid-stop-tenure",
            "ho-stop",
            &claim,
            "test",
            begin_now,
        ) else {
            panic!("expected the stop granted")
        };
        let begin = capture
            .events()
            .into_iter()
            .find(|e| {
                e.event.as_deref() == Some("ownership.stop.begin")
                    && e.values.get("session_id").map(String::as_str) == Some("sid-stop-tenure")
            })
            .expect("the stop begin event fires");
        let duration: u64 = begin
            .values
            .get("duration_ms")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        assert!(
            duration >= 10_000,
            "the granted stop.begin duration is the prior's REAL tenure — \
             got {duration} ({:?})",
            begin.values
        );
    }

    /// b8ke ext r12 F2: the attach guard is a REAL claim — while armed on
    /// a Live key, `begin_handoff` and `begin_stop` answer the typed
    /// Blocked outcome (the handoff can NEVER begin and commit inside the
    /// attach's window); the guard's Drop closes the window and the
    /// blocked operation proceeds on retry.
    #[test]
    fn an_armed_attach_guard_blocks_handoff_and_stop_then_releases() {
        let registry = Arc::new(RuntimeOwnershipRegistry::new());
        let BeginOutcome::Granted { generation } = registry.begin_start(
            "claude",
            "sid-a",
            RuntimeOwnerKind::Terminal,
            "op-live",
            None,
            "test",
            1_000,
        ) else {
            panic!("fixture granted")
        };
        assert_eq!(
            registry.commit_live(
                "claude",
                "sid-a",
                "op-live",
                generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-1".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        );

        match registry.begin_attach_guard("claude", "sid-a", "attach-1", Some(generation), "test") {
            AttachGuardOutcome::Armed(guard) => {
                // THE WINDOW: a handoff begin answers Blocked (typed,
                // retryable) — never Granted.
                match registry.begin_handoff(
                    "claude",
                    "sid-a",
                    RuntimeOwnerKind::FreshAgent,
                    "op-handoff-raced",
                    None,
                    "test",
                    2_000,
                ) {
                    BeginOutcome::Blocked {
                        state,
                        retry_after_ms,
                    } => {
                        assert!(matches!(state, OwnershipState::Live { .. }));
                        assert!(retry_after_ms > 0);
                    }
                    other => {
                        panic!("the handoff must be Blocked inside the attach window: {other:?}")
                    }
                }
                // A stop begin answers BlockedHandoff too.
                match registry.begin_stop(
                    "claude",
                    "sid-a",
                    "op-stop-raced",
                    &StopClaim {
                        expected_kind: RuntimeOwnerKind::Terminal,
                        expected_runtime: Some(OwnerIdentity {
                            kind: RuntimeOwnerKind::Terminal,
                            terminal_id: Some("t-1".into()),
                            live_session_key: None,
                            pid: None,
                            ownership_id: None,
                            unit_id: None,
                            hold: HoldKind::Main,
                        }),
                        observed: ObservedFence {
                            epoch: registry.boot_epoch(),
                            generation,
                        },
                    },
                    "test",
                    2_000,
                ) {
                    StopOutcome::BlockedHandoff { retry_after_ms, .. } => {
                        assert!(retry_after_ms > 0);
                    }
                    other => panic!("the stop must be Blocked inside the attach window: {other:?}"),
                }
                // The record is still Live (nothing moved).
                assert!(matches!(
                    registry.observe("claude", "sid-a").state,
                    OwnershipState::Live { .. }
                ));
                guard.disarm();
            }
            other => panic!("the guard must arm on a Live key: {other:?}"),
        }

        // THE WINDOW CLOSED: the handoff proceeds.
        match registry.begin_handoff(
            "claude",
            "sid-a",
            RuntimeOwnerKind::FreshAgent,
            "op-handoff-after",
            None,
            "test",
            3_000,
        ) {
            BeginOutcome::Granted { .. } => {}
            other => panic!("the handoff must proceed after the window closed: {other:?}"),
        }
    }

    /// b8ke ext r32 F1: the EXIT-DURING-GUARD race — the attach-window
    /// tests above keep the incumbent Live; this variant kills it
    /// mid-window. The incumbent's release lands the record Vacant with
    /// the guard count still riding it; a competing cross-kind
    /// begin_start/begin_handoff must answer the SAME typed Blocked
    /// outcome (never acquire the coordinator and start a writer while
    /// the guarded create is still in its spawn), the guarded create's
    /// own commit completes with continuous authority (at the armed
    /// generation), and the deferred acquisition lands when the last
    /// guard resolves. Pre-r32 both Vacant arms ignored
    /// `in_flight_attaches`: the competitor acquired, started its
    /// writer, and the create's late claim killed it only AFTER the
    /// overlap — and the create's own commit went StaleGeneration.
    #[test]
    fn an_incumbent_exit_during_an_attach_guard_defers_acquisition_until_the_guard_resolves() {
        let registry = Arc::new(RuntimeOwnershipRegistry::new());
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("live-key-1".into()),
            pid: Some(424_242),
            ownership_id: Some("op-live-r32".into()),
            unit_id: None,
            hold: HoldKind::Main,
        };
        let BeginOutcome::Granted { generation } = registry.begin_start(
            "codex",
            "sid-r32-exit-guard",
            RuntimeOwnerKind::FreshAgent,
            "op-live-r32",
            None,
            "test",
            1_000,
        ) else {
            panic!("fixture granted")
        };
        assert_eq!(
            registry.commit_live(
                "codex",
                "sid-r32-exit-guard",
                "op-live-r32",
                generation,
                owner.clone(),
            ),
            CommitOutcome::Committed
        );

        // The existing-runtime attach/create guard arms on the LIVE
        // incumbent (the window the r12 F2 pins keep Live).
        let AttachGuardOutcome::Armed(guard) = registry.begin_attach_guard(
            "codex",
            "sid-r32-exit-guard",
            "attach-r32",
            Some(generation),
            "test",
        ) else {
            panic!("the guard must arm on the Live incumbent")
        };

        // THE INCUMBENT EXITS while the guard is in flight: the release
        // lands the record Vacant (the honest state) with the count
        // still riding it.
        registry.release(
            "codex",
            "sid-r32-exit-guard",
            &ReleaseClaim {
                operation_id: "op-live-r32".into(),
                generation,
                runtime: Some(owner.clone()),
            },
            "watcher",
        );
        assert!(
            matches!(
                registry.observe("codex", "sid-r32-exit-guard").state,
                OwnershipState::Vacant
            ),
            "fixture: the incumbent's exit landed the record Vacant"
        );

        // THE COMPETING CROSS-KIND BEGIN — pre-r32 this ACQUIRED the
        // coordinator through the unguarded Vacant arm; it must answer
        // the typed Blocked outcome (the deferred acquisition).
        match registry.begin_start(
            "codex",
            "sid-r32-exit-guard",
            RuntimeOwnerKind::Terminal,
            "op-competitor-start",
            None,
            "competitor",
            2_000,
        ) {
            BeginOutcome::Blocked {
                state,
                retry_after_ms,
            } => {
                assert!(matches!(state, OwnershipState::Vacant));
                assert!(retry_after_ms > 0);
            }
            other => {
                panic!("the cross-kind start over a guarded-Vacant key must be Blocked: {other:?}")
            }
        }
        match registry.begin_handoff(
            "codex",
            "sid-r32-exit-guard",
            RuntimeOwnerKind::Terminal,
            "op-competitor-handoff",
            None,
            "competitor",
            2_000,
        ) {
            BeginOutcome::Blocked {
                state,
                retry_after_ms,
            } => {
                assert!(matches!(state, OwnershipState::Vacant));
                assert!(retry_after_ms > 0);
            }
            other => panic!(
                "the cross-kind handoff over a guarded-Vacant key must be Blocked: {other:?}"
            ),
        }

        // The guarded create completes with CONTINUOUS AUTHORITY: the
        // holder's OWN late claim (the create/attach flow that armed the
        // window, now acquiring the death-vacated key inside it) grants
        // through the windowed begin — naming its armed guard's op id.
        // Pre-r32 the competitor's grant had already taken the key and
        // the holder's late claim found a foreign owner (killing its
        // own writer only AFTER the overlap).
        //
        // A window op that names NOTHING armed is refused exactly like
        // a competitor's — the exemption is the holder's identity, not
        // a blanket bypass.
        match registry.begin_start_under_attach_window(
            "codex",
            "sid-r32-exit-guard",
            RuntimeOwnerKind::Terminal,
            "op-bogus-window",
            None,
            "competitor",
            2_400,
            "not-an-armed-window",
        ) {
            BeginOutcome::Blocked { .. } => {}
            other => panic!("a bogus window op must be refused like a competitor's: {other:?}"),
        }
        let holder_generation = match registry.begin_start_under_attach_window(
            "codex",
            "sid-r32-exit-guard",
            RuntimeOwnerKind::Terminal,
            "op-holder-late",
            None,
            "holder",
            2_500,
            "attach-r32",
        ) {
            // The windowed grant is a FRESH acquisition over the vacated
            // key (the monotone bump — generation + 1), NOT the armed
            // baseline: "continuous authority" means it GRANTED with no
            // competitor interleaved (every competitor answered Blocked
            // at every step), never that generations freeze.
            BeginOutcome::Granted {
                generation: holder_gen,
            } => {
                assert_eq!(
                    holder_gen,
                    generation + 1,
                    "the holder's windowed claim grants the fresh monotone generation"
                );
                holder_gen
            }
            other => panic!("the holder's own windowed begin must grant: {other:?}"),
        };
        assert_eq!(
            registry.commit_live(
                "codex",
                "sid-r32-exit-guard",
                "op-holder-late",
                holder_generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-holder-r32".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: Some("op-holder-late".into()),
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed,
            "the holder's claim commits Live through its own window"
        );

        // THE DEFERRED ACQUISITION LANDS when the last guard resolves
        // (the count hits zero — the deferred release lands after guard
        // resolution, never a permanent fence): the holder's owner exits
        // after the window and the key is acquirable by anyone again.
        guard.disarm();
        registry.release(
            "codex",
            "sid-r32-exit-guard",
            &ReleaseClaim {
                operation_id: "op-holder-late".into(),
                generation: holder_generation,
                runtime: Some(OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-holder-r32".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: Some("op-holder-late".into()),
                    unit_id: None,
                    hold: HoldKind::Main,
                }),
            },
            "watcher",
        );
        match registry.begin_start(
            "codex",
            "sid-r32-exit-guard",
            RuntimeOwnerKind::Terminal,
            "op-competitor-after",
            None,
            "competitor",
            3_000,
        ) {
            BeginOutcome::Granted { .. } => {}
            other => {
                panic!("the deferred acquisition must land after the guard resolves: {other:?}")
            }
        }
    }

    /// b8ke ext r12 F2: the guard arms ONLY on a Live key with a current
    /// observed generation — a lifecycle transition refuses, a stale
    /// generation refuses typed, and a non-Live key refuses (the attach
    /// paths' own claim machinery owns those windows).
    #[test]
    fn the_attach_guard_refuses_transitions_stale_generations_and_non_live_keys() {
        let registry = Arc::new(RuntimeOwnershipRegistry::new());
        // A Vacant key: Refused.
        match registry.begin_attach_guard("claude", "sid-v", "attach-v", None, "test") {
            AttachGuardOutcome::Refused { state, .. } => {
                assert!(matches!(state, OwnershipState::Vacant));
            }
            other => panic!("a Vacant key must refuse the guard: {other:?}"),
        }

        // A Live key with a STALE observed generation: typed refusal.
        let BeginOutcome::Granted { generation } = registry.begin_start(
            "claude",
            "sid-b",
            RuntimeOwnerKind::Terminal,
            "op-live-b",
            None,
            "test",
            1_000,
        ) else {
            panic!("fixture granted")
        };
        assert_eq!(
            registry.commit_live(
                "claude",
                "sid-b",
                "op-live-b",
                generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-b".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: HoldKind::Main,
                },
            ),
            CommitOutcome::Committed
        );
        match registry.begin_attach_guard(
            "claude",
            "sid-b",
            "attach-stale",
            Some(generation - 1),
            "test",
        ) {
            AttachGuardOutcome::StaleGeneration {
                current_generation, ..
            } => {
                assert_eq!(current_generation, generation);
            }
            other => panic!("a stale observed generation must refuse typed: {other:?}"),
        }

        // A mid-Handoff key: Refused (the transition owns it).
        let BeginOutcome::Granted { .. } = registry.begin_handoff(
            "claude",
            "sid-b",
            RuntimeOwnerKind::FreshAgent,
            "op-handoff-b",
            None,
            "test",
            2_000,
        ) else {
            panic!("fixture handoff granted")
        };
        match registry.begin_attach_guard("claude", "sid-b", "attach-mid", None, "test") {
            AttachGuardOutcome::Refused { state, .. } => {
                assert!(matches!(state, OwnershipState::Handoff { .. }));
            }
            other => panic!("a mid-Handoff key must refuse the guard: {other:?}"),
        }
    }

    /// b8ke ext r38 F1: the ATOMIC ADOPT — `begin_adopt_guard` validates
    /// the epoch, the Live state, the EXACT generation, and the EXPECTED
    /// owner in ONE lock-held decision, then arms the same r32 window. A
    /// stale epoch or generation answers StaleGeneration; a non-Live key
    /// or an owner that is not the expected kind/identity answers Refused
    /// carrying the CURRENT state; only the observed-and-expected owner
    /// arms. The check-to-guard laundering (re-observe whatever's live and
    /// arm on it) is structurally impossible here: the caller's decision
    /// pair and expectation ARE the arming condition.
    #[test]
    fn the_adopt_guard_validates_epoch_state_generation_and_expected_owner_atomically() {
        let registry = Arc::new(RuntimeOwnershipRegistry::new());
        let fresh_owner = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: None,
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };

        // (1) A Vacant key: Refused typed.
        match registry.begin_adopt_guard(
            "claude",
            "sid-adopt-v",
            "adopt-v",
            &fresh_owner,
            ObservedFence {
                epoch: registry.epoch,
                generation: 1,
            },
            "test",
        ) {
            AttachGuardOutcome::Refused { state, .. } => {
                assert!(matches!(state, OwnershipState::Vacant));
            }
            other => panic!("a Vacant key must refuse the adopt: {other:?}"),
        }

        // A Live FRESH-AGENT key as the adopt fixture.
        let BeginOutcome::Granted { generation } = registry.begin_start(
            "claude",
            "sid-adopt",
            RuntimeOwnerKind::FreshAgent,
            "op-live-adopt",
            None,
            "test",
            1_000,
        ) else {
            panic!("fixture start granted")
        };
        assert_eq!(
            registry.commit_live(
                "claude",
                "sid-adopt",
                "op-live-adopt",
                generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    live_session_key: Some("k-adopt".into()),
                    ..fresh_owner.clone()
                },
            ),
            CommitOutcome::Committed
        );
        let live_fence = ObservedFence {
            epoch: registry.epoch,
            generation,
        };

        // (2) A stale EPOCH (a different boot's pair): StaleGeneration
        // typed, never Refused-with-live-state (the caller must refresh,
        // not re-decide).
        match registry.begin_adopt_guard(
            "claude",
            "sid-adopt",
            "adopt-epoch",
            &fresh_owner,
            ObservedFence {
                epoch: registry.epoch + 1,
                generation,
            },
            "test",
        ) {
            AttachGuardOutcome::StaleGeneration { current_epoch, .. } => {
                assert_eq!(current_epoch, registry.epoch);
            }
            other => panic!("a foreign epoch must refuse the adopt typed-stale: {other:?}"),
        }

        // (3) A stale GENERATION (ownership advanced — a handoff
        // committed between the caller's decision and the adopt):
        // StaleGeneration typed.
        match registry.begin_adopt_guard(
            "claude",
            "sid-adopt",
            "adopt-stale-gen",
            &fresh_owner,
            ObservedFence {
                epoch: registry.epoch,
                generation: generation - 1,
            },
            "test",
        ) {
            AttachGuardOutcome::StaleGeneration {
                current_generation, ..
            } => {
                assert_eq!(current_generation, generation);
            }
            other => panic!("a stale generation must refuse the adopt typed-stale: {other:?}"),
        }

        // (4) The EXPECTED-OWNER mismatch — the caller's pair is CURRENT
        // but the live owner is not the kind the caller decided on (the
        // defense-in-depth under the generation check): Refused carrying
        // the CURRENT live state, never Armed.
        let expected_terminal = OwnerIdentity {
            kind: RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-decoy".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: HoldKind::Main,
        };
        match registry.begin_adopt_guard(
            "claude",
            "sid-adopt",
            "adopt-kind",
            &expected_terminal,
            live_fence,
            "test",
        ) {
            AttachGuardOutcome::Refused {
                state,
                generation: ref gen,
            } => {
                assert!(matches!(state, OwnershipState::Live { .. }), "{state:?}");
                assert_eq!(*gen, generation);
            }
            other => panic!("a kind mismatch must refuse the adopt: {other:?}"),
        }

        // (4b) An identity mismatch with the RIGHT kind — the caller
        // supplied a terminal id the live owner does not hold: Refused.
        let wrong_terminal = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: Some("t-wrong".into()),
            ..fresh_owner.clone()
        };
        match registry.begin_adopt_guard(
            "claude",
            "sid-adopt",
            "adopt-identity",
            &wrong_terminal,
            live_fence,
            "test",
        ) {
            AttachGuardOutcome::Refused { state, .. } => {
                assert!(matches!(state, OwnershipState::Live { .. }), "{state:?}");
            }
            other => panic!("an identity mismatch must refuse the adopt: {other:?}"),
        }

        // (5) The HAPPY adopt — the current pair over the expected owner:
        // Armed, the r32 window open (a concurrent handoff begin answers
        // Blocked), and the window CLOSES on drop (the handoff then
        // grants).
        let guard = match registry.begin_adopt_guard(
            "claude",
            "sid-adopt",
            "adopt-happy",
            &fresh_owner,
            live_fence,
            "test",
        ) {
            AttachGuardOutcome::Armed(guard) => guard,
            other => panic!("the observed-and-expected owner must arm: {other:?}"),
        };
        assert_eq!(guard.operation_id(), "adopt-happy");
        match registry.begin_handoff(
            "claude",
            "sid-adopt",
            RuntimeOwnerKind::Terminal,
            "op-competitor-adopt",
            None,
            "competitor",
            2_000,
        ) {
            BeginOutcome::Blocked { .. } => {}
            other => panic!("the armed adopt window must block a competitor: {other:?}"),
        }
        drop(guard);
        let BeginOutcome::Granted { .. } = registry.begin_handoff(
            "claude",
            "sid-adopt",
            RuntimeOwnerKind::Terminal,
            "op-competitor-adopt-2",
            None,
            "competitor",
            3_000,
        ) else {
            panic!("the closed adopt window must let a competitor through")
        };

        // (6) A mid-transition key (the handoff above never committed —
        // still in Handoff): Refused, never Armed.
        match registry.begin_adopt_guard(
            "claude",
            "sid-adopt",
            "adopt-mid",
            &fresh_owner,
            ObservedFence {
                epoch: registry.epoch,
                generation: generation + 1,
            },
            "test",
        ) {
            AttachGuardOutcome::Refused { state, .. } => {
                assert!(matches!(state, OwnershipState::Handoff { .. }), "{state:?}");
            }
            other => panic!("a mid-transition key must refuse the adopt: {other:?}"),
        }
    }
}
