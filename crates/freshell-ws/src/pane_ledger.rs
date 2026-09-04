//! P1.8 — the server-side pane-identity ledger (restart-resilience campaign
//! §4.2): a small per-row disk store under `<home>/.freshell/pane-ledger/`,
//! written durably at identity events with atomic temp+rename
//! (`crate::tabs_persist::atomic_write_durable`).
//!
//! Three row types with different keys and different rights:
//!
//! * **Binding rows** — durable identity facts, keyed on the server-minted
//!   `sessionRef` (provider, sessionId), with `terminalId` as a secondary
//!   index. A binding row is *the resume-invocation record*: it stores
//!   exactly what re-issuing the provider's resume needs (for terminal panes:
//!   provider, sessionId, mode, cwd). Layout:
//!   `bindings/<enc(provider)>/<enc(sessionId)>.json`.
//! * **Pending markers** — evidence that identity establishment was in
//!   flight, keyed on `terminalId` (the only stable server-minted id that
//!   exists pre-identity). NEVER promoted, never joined (G1): resolution
//!   writes a fresh binding row FIRST, then deletes the marker. Layout:
//!   `pending/<enc(terminalId)>.json`.
//! * **Rollback rows** (kata 1wxv) — fresh-agent conversation-rollback state,
//!   keyed `(provider, sessionId)`. Payload-OPAQUE to the ledger:
//!   `freshell_freshagent::rollback_record` owns the schema (the version gate
//!   lives in that crate's sink layer). Layout:
//!   `rollback/<enc(provider)>/<enc(sessionId)>.json`.
//! * **Kill tombstones** (focused-ep5-r1 Finding 2, retire-on-kill round 2) —
//!   the durable record that an explicit close (`retire_closed`) happened for
//!   a `(provider, sessionId)` identity, consulted by
//!   [`PaneLedger::record_fresh_agent_binding`] (a fresh one suppresses the
//!   late in-flight write that would otherwise resurrect a Bound row the kill
//!   just retired; an expired one is swept). TTL'd
//!   ([`KILL_TOMBSTONE_TTL_MS`]); cleared by
//!   [`PaneLedger::clear_kill_tombstone`] on a genuine claim (explicit
//!   resume/attach). Layout:
//!   `kill-tombstones/<enc(provider)>/<enc(sessionId)>.json`.
//!
//!   Retire-on-kill round 3 (focused-ep5-r2): the tombstone is THE AUTHOR OF
//!   TRUTH for the identity's closedness — `retire_closed`'s two durable
//!   writes (tombstone, then row retire) can split across a crash or a failed
//!   second write, so a fresh tombstone DOMINATES a still-Bound row by ONE
//!   rule enforced twice: the boot/periodic sweep re-applies the retirement
//!   durably ([`PaneLedger::gc`]'s per-row pass;
//!   `BootScanReport::kill_tombstone_enforced_retires`), and the recovery
//!   inventory reads a dominated row as Retired at offer-build time (via
//!   [`PaneLedger::fresh_kill_tombstone_keys`]). The claim lifecycle's row
//!   side is [`PaneLedger::revive_closed`]: a successful resume/attach
//!   returns a kill-closed row to Bound (Closed-only; never creates a row),
//!   invoked by the provider claim lanes together with the tombstone clear.
//!
//! Deliberately NOT stored: scrollback (own store, P2.19), transcripts
//! (provider-owned), layout (client-owned). NOT keyed on `createRequestId`
//! (D4/V9.md: every restore path that re-creates an anchored pane re-mints
//! it first; only the orphaned in-flight-create replay preserves it) —
//! stored only as an advisory field, never an identity join key.
//!
//! Corruption policy: fail loud PER-ROW, never per-store — an unparsable row
//! is quarantined (renamed aside + logged), never silently dropped, and never
//! causes healthy rows to be skipped.
//!
//! Write-failure policy: a ledger write failure never blocks the
//! create/identity event, but it is never silent — see
//! [`surface_write_failure`].
//!
//! Read/scan policy (V1.md / A15): a write-through in-memory index, loaded
//! ONCE at construction by a single directory scan, answers ALL steady-state
//! reads — no API does a per-call directory scan (full-store scans measured
//! at 21ms@1k / 426ms@20k rows; TTL math yields 1.2k-12k rows). Files stay
//! the durable source of truth; this process is the only writer
//! (single-writer flock, [`PaneLedger::new_locked`]), so write-through
//! invalidation is trivial. Reads never touch the fs and may run inline on
//! async paths; WRITES fsync (~15ms p50 on this host) and must be wrapped in
//! `spawn_blocking` at async call sites (the `terminal.rs:1369-1379`
//! PTY-spawn precedent) — the sync API here stays call-site-agnostic.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use freshell_protocol::SessionLocator;
use serde::{Deserialize, Serialize};

#[path = "pane_ledger_scan.rs"]
mod pane_ledger_scan;
pub use pane_ledger_scan::{BootScanReport, QuarantinedRow, PENDING_MARKER_ORPHAN_TTL_MS};

/// Gates schema migration (spec §4.2): rows with a different version are
/// quarantined loudly at boot, never silently reinterpreted.
pub const LEDGER_VERSION: u32 = 1;

/// Bound rows not observed within this TTL are expired TO TOMBSTONES
/// (`retired/gc_expired`), never deleted (spec §4.2 lifecycle).
pub const BOUND_GC_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Tombstones older than this are deleted ONLY once the transcript no longer
/// exists on disk — silent-fresh never returns by timer while the
/// conversation is still recoverable.
pub const TOMBSTONE_GC_TTL_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// Pending markers older than this are swept (boot scan + periodic GC),
/// bounding leaked-marker lifetime (A8/V7: a pane that dies WITH the server
/// leaves a marker no exit hook will ever delete — terminal ids are never
/// re-minted). Fresh-by-race evidence matters at the boots near the crash;
/// a month-old marker is stale noise.
pub const PENDING_MARKER_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Focused-ep5-r1 Finding 2 (retire-on-kill round 2): how long a kill
/// tombstone keeps fencing the fresh-agent binder. The tombstone exists to
/// defeat the spawn_blocking orphan window (a binding write launched before
/// the kill whose blocking closure lands after it — milli- to seconds-scale),
/// the post-kill in-flight create/resume lane (seconds), and the immediate
/// post-restart write burst after a crash (minutes, worst case). HOURS of
/// retention cover every one of those with orders of magnitude of margin
/// while still bounding the store (the boot + periodic GC sweep them; a
/// write consult also lazily sweeps an expired one it encounters). The TTL
/// is deliberately NOT days-scale: a tombstone suppresses
/// `record_fresh_agent_binding` for its identity, so it must not outlive the
/// genuine-claim lanes that clear it (explicit resume/attach) by more than a
/// kill→resume horizon a human actually spans.
pub const KILL_TOMBSTONE_TTL_MS: i64 = 6 * 60 * 60 * 1000;

/// A kill tombstone (focused-ep5-r1 Finding 2, restore-open-sessions-only):
/// the durable record that an explicit `retire_closed` (the retire-on-kill
/// trigger) happened for this `(provider, session_id)` identity.
/// [`PaneLedger::record_fresh_agent_binding`] consults it under the SAME
/// index guard as the write it gates, so a binding write that was already in
/// flight when the kill landed (an aborted consumer's orphaned
/// `spawn_blocking` closure — task abort can never cancel it) is suppressed
/// by CONSULTING STATE, never by task-abort ordering: whichever way the
/// lock serializes, a fresh tombstone seen by the write means the identity
/// stays dead. TTL'd (see [`KILL_TOMBSTONE_TTL_MS`]); cleared by
/// [`PaneLedger::clear_kill_tombstone`] when a NEW pane/session genuinely
/// claims the identity (an explicit resume/attach). Layout:
/// `kill-tombstones/<enc(provider)>/<enc(sessionId)>.json`.
///
/// Deliberately a separate subtree from binding rows (NOT a row state): the
/// tombstone must fence identities whose row does NOT EXIST YET (the kill
/// beat the in-flight adoption write), which a row-state marker can never
/// express. The terminal-lineage binder (`record_binding` / `resolve_pending`)
/// deliberately does not consult it (a terminal kill's own resume lanes must
/// rebind freely). Round 3 (focused-ep5-r2) widened the READER set under one
/// rule — a fresh tombstone means the identity is Closed — to the row
/// sweep's dominance repair (`gc_row_locked`) and the recovery inventory's
/// offer-time read ([`PaneLedger::fresh_kill_tombstone_keys`]); see the audit
/// table in usual-sdd/retire-on-kill-r3-fix-report.md.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillTombstone {
    pub ledger_version: u32,
    pub provider: String,
    pub session_id: String,
    /// When the explicit close happened (the `retire_closed` call's
    /// `now_ms`). The TTL clock (freshness compare in
    /// [`PaneLedger::record_fresh_agent_binding`] and the GC sweep) keys on
    /// this; a backward wall-clock step counts tombstones as FRESH (the
    /// fail-closed direction — subtraction-based compare, never expiry-sum
    /// overflow).
    pub killed_at_ms: i64,
}

/// Focused-ep5-r3 Finding 1 (retire-on-kill round 4): the outcome of
/// [`PaneLedger::commit_claim`] — the claim lifecycle's conditional commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimCommitOutcome {
    /// The identity's dead-state was unchanged (or absent, or older) since
    /// the claim-start snapshot: the fence is cleared and a kill-closed row
    /// is back to Bound, as ONE durable transition.
    Committed,
    /// A NEWER close landed mid-claim (the tombstone stamp advanced past the
    /// claim-start snapshot — the user closed the pane while the provider
    /// resume was still awaiting). NOTHING was cleared, revived, or mutated:
    /// the identity stays durably closed and the caller tears its just-built
    /// session down.
    RefusedStale,
}

/// Focused-ep5-r1 Finding 2: tombstone freshness — subtraction-based so a
/// backward clock step reads as FRESH (fail-closed: the suppression holds,
/// never the resurrection).
fn kill_tombstone_is_fresh(killed_at_ms: i64, now_ms: i64) -> bool {
    now_ms - killed_at_ms < KILL_TOMBSTONE_TTL_MS
}

/// Focused-ep5-r3 Findings 3+4 (retire-on-kill round 4): every kill-tombstone
/// consult's shared view of ONE identity's tombstone against its row. ONE
/// classification serves all four consult sites (the binder's write gate, the
/// sweep's durability convergence, the sweep's pruning, and the recovery
/// inventory's offer boundary), so no two readers can disagree about what a
/// (tombstone, row) pair MEANS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KillTombstoneVerdict {
    /// The tombstone is as new as (or newer than) a Bound row's last liveness
    /// stamp: the row's own evidence PREDATES the close — the split-write
    /// crash remnant (`retire_closed` wrote the tombstone; the row retire
    /// never landed). Dominance: retire the row, suppress its writes, never
    /// offer it — and Finding 4: NEVER expires while the row reads Bound
    /// (the TTL exists to prune converged pairs, not to outrun an
    /// unconverged one).
    Dominant,
    /// A Bound row's liveness stamp POSTDATES the tombstone: the row is an
    /// accepted claim's COMMITTED revive whose own tombstone-clear crashed
    /// or failed mid-commit. Inert for every consult (the claim visibly
    /// outran the close); the sweeps prune it at any age — it is resolved
    /// bookkeeping, not protection.
    ClaimResidue,
    /// No Bound row to dominate (missing or already Retired) and still
    /// inside the protective TTL: fences in-flight orphan writes of the
    /// closed identity.
    Fresh,
    /// TTL elapsed with nothing Bound to protect: prunable noise.
    Expired,
}

/// The one classification rule behind [`KillTombstoneVerdict`]. The row input
/// is exactly `(state, updated_at)`: `updated_at` is the row's own liveness
/// stamp — `retire_closed` re-stamps it on the retire half, and the claim
/// commit writes the revived row with the claim's `now` BEFORE clearing the
/// tombstone, so a crash mid-commit leaves a row that visibly outranks the
/// surviving tombstone (ClaimResidue — Finding 3's "no observable
/// intermediate state" guarantee). The dominance tie goes to the KILL
/// (`killed_at >= updated_at`): a claim whose revive cannot be proven to
/// postdate the close fails closed toward the close.
fn classify_kill_tombstone(
    killed_at_ms: i64,
    row_view: Option<(RowState, i64)>,
    now_ms: i64,
) -> KillTombstoneVerdict {
    match row_view {
        Some((RowState::Bound, updated_at)) => {
            if killed_at_ms >= updated_at {
                KillTombstoneVerdict::Dominant
            } else {
                KillTombstoneVerdict::ClaimResidue
            }
        }
        Some((RowState::Retired, _)) | None => {
            if kill_tombstone_is_fresh(killed_at_ms, now_ms) {
                KillTombstoneVerdict::Fresh
            } else {
                KillTombstoneVerdict::Expired
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RowState {
    Bound,
    Retired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetiredReason {
    Superseded,
    Closed,
    GcExpired,
    SessionMissing,
}

/// A durable identity fact — see the module doc for the schema contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingRow {
    pub ledger_version: u32,
    pub provider: String,
    pub session_id: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Advisory secondary index — the terminal that last owned this identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_terminal_id: Option<String>,
    /// Advisory, latest-observed (D4: the client re-mints it on hydrate; it
    /// is never an identity join key).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_request_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_observed_at: i64,
    pub state: RowState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retired_reason: Option<RetiredReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<SessionLocator>,
    /// "fresh-agent" for fresh-agent rows (P1.13); absent on terminal rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_kind: Option<String>,
    /// Resume-invocation record (campaign plan §4.2): exactly what the
    /// provider-native resume command needs. Updated when the user changes
    /// them. All optional under LEDGER_VERSION 1 — no version bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// D8 (restore-open-sessions-only) provenance: the browser client + tab
    /// this binding was created from. What a write DOES with them is the
    /// tri-state [`ProvenancePolicy`] on the write structs (delta-r2 Finding
    /// 2): connection-scoped lanes `Replace`, conn-less re-bind lanes
    /// (respawn, locator/adoption resolution, fork chains) `Inherit`, and the
    /// explicitly-headless REST/MCP lineage lanes (`pane_identity_binder.rs`)
    /// `Clear`. Serde-optional under LEDGER_VERSION 1: pre-D8 rows (and
    /// headless rows — intentionally never stamped) parse to all-`None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// `deviceId:tabId` — exactly `src/lib/tab-registry-snapshot.ts`'s record
    /// composition, so the row can rejoin the right restored tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_key: Option<String>,
    /// Delta-r4 Finding 1 (judgment time decoupled from maintenance time):
    /// when a browser connection last ASSERTED this identity (see the
    /// floor note below for the one non-assertion shape). Focused-
    /// ep4-r2 Findings 1+2 (assertion time is VALUE-carried, never
    /// write-time): the stamped time is the ASSERTION's time, carried on the
    /// provenance value itself — captured ONCE at message receipt on the
    /// connection-scoped lanes, so slow create/spawn/fork work (or fork-chain
    /// supersession) can never manufacture a later attribution. The writer
    /// rules (the focused-ep4-r5 Finding 1 attach/advance split plus the
    /// monotonicity guard — focused-ep4-r3 Findings 1+2): a `Replace`
    /// ATTACHES whatever MEANINGFUL provenance exists (client+device, plus
    /// tab and the assertion time when present — no triple requirement —
    /// so a legacy client's create/fork leaves an attribution) when the row
    /// has NO prior attribution; a `Replace` ADVANCES an existing one only
    /// with the FULL client+device+tab triple whose `asserted_at` is >= the
    /// row's current value, SETTING stamps+time together (an older delayed
    /// write never drags them back; a tab-less legacy re-assert never
    /// refreshes them against the kept tab); a conn-less `Inherit`
    /// PRESERVES the value (same-key row, or the superseded parent's on a
    /// fork-chain write — the supersession chain keeps the true assertion
    /// time); a weaker or stale `Replace` preserves it likewise; a
    /// marker-stamped `resolve_pending` attributes at the consumed marker's
    /// `asserted_at` field (the focused-ep4-r3 Finding 3 split; the
    /// `spawned_at` fallback covers intermediate-build markers, where that
    /// field carried the assertion time); `Clear` erases the identity
    /// STAMPS but RAISES this clock (focused-ep4-r5 Finding 2):
    /// `max(existing, clear_now)` — the floor rejects a delayed pre-Clear
    /// assertion that could otherwise resurrect the cleared stamps, and the
    /// row stays unofferable while its stamps are `None` (the judgment
    /// gates on the stamps first).
    /// Retire/state transitions and GC/scan
    /// maintenance NEVER touch it. This is what the D8 judgment
    /// (`recovery_inventory.rs`) keys on — and it keys on NOTHING ELSE:
    /// `updated_at` advances on EVERY upsert including conn-less
    /// maintenance, and `created_at` is row-keeping metadata —
    /// resolution-time birth for marker-derived rows, fork-time birth for
    /// fork children — so neither may floor the judgment. Serde-optional
    /// under LEDGER_VERSION 1 (the client/device/tab field precedent):
    /// pre-delta-r4 rows parse to `None` — and `None` is fatal to the offer
    /// (focused-ep4-r4 Finding 1): stamps and this field were introduced
    /// together in the branch, so a stamped-but-fieldless row can only be an
    /// intermediate-branch-build artifact (whose `created_at` can be
    /// invented late); the judgment has NO creation-time fallback and
    /// excludes such rows exactly like unattributed ones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_attributed_at: Option<i64>,
}

/// Evidence that identity establishment was in flight (G1: never a binding).
///
/// Markers ALSO carry spawn-time provenance (delta-r3 Finding 2): the
/// browser client + tab that created the pane, captured at marker write
/// because the identity they guard resolves LATER and conn-less — the
/// locator/candidate resolution hook ([`ledger_resolve_identity`]) runs
/// with [`ProvenancePolicy::Inherit`], and for a dynamically-identified
/// codex/opencode/amplifier CLI pane (no pre-spawn binding; only claude
/// preallocates) there is NO existing row to inherit from.
/// [`PaneLedger::resolve_pending`] derives the ORIGIN lane's policy from the
/// consumed marker (focused-ep3-r2 Finding 2): the resolve's own meaningful
/// provenance, then THESE stamps — and an ALL-NONE marker (headless
/// REST/sink markers are intentionally never stamped, exactly the lane's
/// `Clear` write policy) resolves `Clear`, erasing any prior lane's stamps
/// so a headless lineage can never launder a stale browser attribution via
/// the marker path (and flooring the erased row's attribution clock at
/// `max(existing, resolve_now)`, focused-ep4-r5 Finding 2). Serde-optional
/// under LEDGER_VERSION 1 (the BindingRow
/// precedent): pre-delta-r3 markers parse to all-`None` and take the same
/// `Clear` derivation — conservative (unattributed ⇒ never offered), and
/// immune by construction once the 30-day pending-marker TTL has swept them.
/// Focused-ep4-r3 Finding 3 (the marker carries TWO times, split on
/// purpose): `spawned_at` is the marker's ACTUAL write/creation time — the
/// retention clock (the 30-day TTL, the 7-day orphan rule in
/// `pane_ledger_scan.rs`) keys on it, so a delayed gated create never
/// arrives pre-aged — while `asserted_at` records the provenance value's
/// assertion time, which `resolve_pending`'s marker arm (not the GC) reads.
/// Serde-additive under LEDGER_VERSION 1: markers persisted by the
/// intermediate (ep4-r2) build carry no `assertedAt` — there `spawned_at`
/// WAS the assertion time — and parse to the `0` sentinel, which arms the
/// resolution's `spawned_at` fallback and so reproduces that build's
/// semantics exactly. An unstamped (headless) marker carries `0` here — its
/// resolution derives `Clear` and never consumes a time at all.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMarker {
    pub ledger_version: u32,
    pub terminal_id: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// The marker's write/creation time — the retention clock (see the
    /// struct doc). Never the browser's assertion time.
    pub spawned_at: i64,
    /// The provenance value's assertion time (the browser-asserted time,
    /// captured at message receipt) — consumed by `resolve_pending` only;
    /// `0` = "no assertion recorded" (headless markers, and legacy persisted
    /// markers whose resolution falls back to `spawned_at`).
    #[serde(default)]
    pub asserted_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// `deviceId:tabId` — exactly `src/lib/tab-registry-snapshot.ts`'s record
    /// composition, so the resolved row can rejoin the right restored tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_key: Option<String>,
}

/// D8 (delta-r2 Finding 2) provenance stamps carried by a
/// [`ProvenancePolicy::Replace`] write: the browser client + tab the binding
/// event was caused by. `tab_key` composes as `deviceId:tabId` (exactly
/// `src/lib/tab-registry-snapshot.ts`'s record composition), so the row can
/// rejoin the right restored tab. Focused-ep4-r2 Findings 1+2: the value
/// ALSO carries its own assertion time — `asserted_at` is when the browser
/// ASSERTED this provenance, captured ONCE at message receipt and threaded
/// immutably through the create/respawn/fork/supersede chain; an applying
/// `Replace` records it verbatim as the row's `last_attributed_at` (never
/// the write's own `now_ms` — a post-spawn or resolution-time write must
/// not manufacture freshness). The application gates (focused-ep4-r5
/// Finding 1): with NO prior attribution on the row the value ATTACHES when
/// it is MEANINGFUL (client+device — the tab rides along only when the
/// wire carried one: legacy clients omit it); with an EXISTING attribution
/// it ADVANCES only on the full client+device+tab triple whose
/// `asserted_at` is >= the row's current attribution time (focused-ep4-r3
/// Findings 1+2 — an older delayed write never drags the attribution back).
/// `0` = "no assertion exists" (the headless `default()`; a `0`-timed
/// attach records NO time at all — see [`applied_attribution_time`] — and
/// the row fails CLOSED, never offered).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProvenanceStamps<'a> {
    pub client_instance_id: Option<&'a str>,
    pub device_id: Option<&'a str>,
    pub tab_key: Option<&'a str>,
    pub asserted_at: i64,
}

/// D8 (delta-r2 Finding 2) provenance write policy: every binding write
/// declares what it ASSERTS about attribution. The bare `Option` fields this
/// replaces made `None` ambiguous between "I assert nothing — keep the
/// stamps" (conn-less session-affiliated refresh lanes) and "this lane is
/// HEADLESS and the row is unattributable from it" (REST/MCP lineage) — and
/// the ambiguity laundered: a headless re-bind of a browser-stamped row kept
/// the stamps while refreshing `updated_at`, so after the parent browser's
/// evidence froze the row kept clearing the D8 grace lower bound forever and
/// the not-open session was offered with stale attribution.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ProvenancePolicy<'a> {
    /// Conn-less SESSION-AFFILIATED lanes (auto-resume respawn,
    /// locator/adoption resolution): the write asserts nothing about
    /// attribution, so every existing stamp survives; the fresh-agent body
    /// additionally inherits a superseded PARENT's stamps AND its assertion
    /// time on a fork-chain first write (the fork is, by construction, the
    /// same pane — focused-ep4-r2 Findings 1+2).
    #[default]
    Inherit,
    /// Connection-supplied stamps (the WS create/fresh-agent lanes compose
    /// them from the connection's hello identity + the message's `tabId`):
    /// an adoption lane that KNOWS newer identity replaces it here. The
    /// attribution is ONE atomic fact (focused-ep4-r3 Findings 1+2): the
    /// stamps AND the row's `last_attributed_at` move TOGETHER. Since
    /// focused-ep4-r5 Finding 1 there are two application gates: with NO
    /// prior attribution on the row the value ATTACHES when it is meaningful
    /// (client+device — a legacy client that cannot compose a `tabKey` still
    /// attaches, tab `None`); with an EXISTING attribution it ADVANCES only
    /// when the full client+device+tab triple is present AND the stamps'
    /// `asserted_at` is >= the row's current attribution time (the browser's
    /// assertion, captured at message receipt — the write's own `now_ms`
    /// never enters the attribution clock, focused-ep4-r2 Findings 1+2). A
    /// `Replace` that fails its gate leaves stamps+time untouched while the
    /// write's other fields still land; the pre-finding-2 per-field
    /// keep-when-`None` merge is gone (it mixed stamps from different
    /// assertions and refreshed the time against the row's kept, stale tab).
    Replace(ProvenanceStamps<'a>),
    /// An explicitly HEADLESS writer (the REST/MCP lineage binder — no
    /// browser connection exists at bind time): all identity stamps are
    /// CLEARED. A headless re-bind must never keep an earlier browser stamp
    /// (see the enum doc), so the rebound row becomes unattributed and the
    /// D8 judgment (`recovery_inventory.rs`) correctly never offers it. The
    /// attribution CLOCK is never erased (focused-ep4-r5 Finding 2):
    /// `last_attributed_at` floors at `max(existing, clear_now)`, so a
    /// delayed pre-`Clear` assertion can never sneak through a
    /// no-prior-attribution arm and resurrect the cleared stamps.
    Clear,
}

/// Whether this write's provenance may ATTACH an attribution to a row that
/// has NONE YET (focused-ep4-r5 Finding 1): a `Replace` whose stamps carry
/// the MEANINGFUL halves — client+device (the
/// `freshell_freshagent::BindProvenance::is_meaningful` hollow-guard shape,
/// mirrored here because this crate cannot see that one). No tab
/// requirement: `freshAgent.create`/`freshAgent.fork.tabId` are
/// additive/optional, so a legacy client still composes
/// client+device+`asserted_at` from its hello identity and the message
/// receipt — if the full triple gated here too, a genuinely-open legacy
/// create/fork would be born with no attribution at all: unrecoverable
/// wholesale. (A tab-less attach stays unofferable regardless — the D8
/// placement clause still requires the stamped tabKey to name an open tab;
/// this is the documented ceiling for legacy clients.) The triple
/// requirement below gates only ADVANCING an attribution the row ALREADY
/// has.
fn attaches_attribution(provenance: &ProvenancePolicy<'_>) -> bool {
    match provenance {
        ProvenancePolicy::Replace(stamps) => {
            stamps.client_instance_id.is_some() && stamps.device_id.is_some()
        }
        _ => false,
    }
}

/// Whether this write's provenance may ADVANCE an attribution the row
/// ALREADY has (stamps+time moving as one fact): a `Replace` whose stamps
/// carry the FULL client+device+tab triple. Originally (delta-r4 Finding 1)
/// the client and device halves sufficed; focused-ep4-r3 Finding 2 tightened
/// the gate to the full triple: a legacy client that cannot compose a
/// `tabKey` would otherwise REFRESH the attribution time while the merge
/// kept the row's old tab — laundering freshness onto a stale tab. Both
/// merge bodies consume this ONE predicate only when a prior attribution
/// exists (focused-ep4-r5 Finding 1 split the never-attributed case out to
/// [`attaches_attribution`]), together with the monotonicity guard (see the
/// bodies): the advancing time is the stamps' own `asserted_at` (the
/// provenance value's assertion time, focused-ep4-r2 Findings 1+2), never
/// the write's `now_ms`. A weaker re-assertion over an attributed row
/// updates the row's other fields but leaves stamps+time untouched.
fn advances_attribution(provenance: &ProvenancePolicy<'_>) -> bool {
    match provenance {
        ProvenancePolicy::Replace(stamps) => {
            stamps.client_instance_id.is_some()
                && stamps.device_id.is_some()
                && stamps.tab_key.is_some()
        }
        _ => false,
    }
}

/// The time an applying `Replace` stamps onto the row: the provenance
/// value's own assertion time. The `0` sentinel ("no assertion exists" — the
/// headless `default()` shape) never lands on a row: a 0-timed attach
/// records NO time, leaving the row time-less (and re-attachable — a later
/// real assertion can still land), failing CLOSED at the D8 judgment exactly
/// like a fieldless stamped row (focused-ep4-r4 Finding 1).
fn applied_attribution_time(asserted_at: i64) -> Option<i64> {
    (asserted_at > 0).then_some(asserted_at)
}

/// One identity event's worth of binding-row input.
pub struct BindingWrite<'a> {
    pub provider: &'a str,
    pub session_id: &'a str,
    pub terminal_id: &'a str,
    pub mode: &'a str,
    pub cwd: Option<&'a str>,
    pub create_request_id: Option<&'a str>,
    /// D8 provenance write policy — see [`ProvenancePolicy`] for the
    /// per-lane contract (Replace / Inherit / Clear). A meaningful `Replace`
    /// carries its OWN assertion time on the stamps' `asserted_at` (focused-
    /// ep4-r2 Findings 1+2): the value captured at message receipt flows to
    /// the row unchanged — there is no write-side time override to get wrong.
    pub provenance: ProvenancePolicy<'a>,
    pub now_ms: i64,
}

/// One fresh-agent identity event's worth of binding-row input (P1.13).
/// Settings are a FULL snapshot: callers always know the current values,
/// so writes replace rather than merge.
#[derive(Debug, Clone, Copy)]
pub struct FreshAgentBindingWrite<'a> {
    pub provider: &'a str,
    pub session_id: &'a str,
    pub mode: &'a str,
    pub cwd: Option<&'a str>,
    pub create_request_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub sandbox: Option<&'a str>,
    pub permission_mode: Option<&'a str>,
    pub effort: Option<&'a str>,
    /// G3 supersession (V8/A14): the OLD session id this binding replaces
    /// (codex crash-respawn). When `Some`, the old `(provider, supersedes)`
    /// row is retired and linked AFTER the new row persists.
    pub supersedes: Option<&'a str>,
    /// D8 provenance write policy — see [`ProvenancePolicy`] for the
    /// per-lane contract (Replace / Inherit / Clear; the Inherit merge falls
    /// back to the superseded parent's stamps on a fork-chain write).
    pub provenance: ProvenancePolicy<'a>,
    pub now_ms: i64,
}

/// A chain-terminus lookup result. `corrected == true` means the caller's
/// claimed ref was superseded and this row is the live successor.
#[derive(Debug, Clone)]
pub struct Resolution {
    pub row: BindingRow,
    pub corrected: bool,
}

/// The in-memory write-through index (V1.md / A15). Loaded ONCE at
/// construction by a single directory scan; every successful file write
/// updates it in the same locked section. Unparsable / wrong-version files
/// are skipped here silently — the boot scan (Task 4) is what quarantines
/// them loudly.
#[derive(Default)]
struct LedgerIndex {
    /// (provider, session_id) -> row. Bound AND retired (tombstones stay).
    bindings: std::collections::HashMap<(String, String), BindingRow>,
    /// terminal_id -> marker.
    pending: std::collections::HashMap<String, PendingMarker>,
    /// (provider, session_id) -> rollback payload (kata 1wxv), OPAQUE JSON.
    rollback: std::collections::HashMap<(String, String), serde_json::Value>,
    /// (provider, session_id) -> killed_at_ms (focused-ep5-r1 Finding 2),
    /// the write-through image of the `kill-tombstones/` subtree. Consulted
    /// ONLY by [`PaneLedger::record_fresh_agent_binding`] (plus the GC sweep
    /// and test/diagnostic reads) — never a liveness signal (a tombstoned
    /// session is DEAD; this map says "its write is poison", nothing more).
    kill_tombstones: std::collections::HashMap<(String, String), i64>,
}

/// The ledger store. `root: None` ⇒ feature disabled (no resolvable home) —
/// every write is an `Ok(())` no-op and every read answers empty, mirroring
/// the tabs-snapshots `Option`-wrapped-root precedent (`main.rs:709-711`).
pub struct PaneLedger {
    root: Option<PathBuf>,
    /// ONE lock: serializes read-modify-write cycles AND owns the
    /// write-through index — no cache-vs-file races by construction.
    index: Mutex<LedgerIndex>,
    /// Held for the process lifetime by `new_locked` (single-writer guard,
    /// V2.md); the kernel releases the flock on process death.
    #[allow(dead_code)] // read only by the kernel (flock lifetime)
    lock_file: Option<std::fs::File>,
    /// Rows quarantined by the boot scan, retained for API surfacing.
    #[allow(dead_code)] // populated + read by the boot scan (Task 4)
    quarantined: RwLock<Vec<QuarantinedRow>>,
}

impl PaneLedger {
    /// Lock-free construction — tests and the integration harness use this
    /// (verification handles over a live server's dir must not fight the
    /// server's flock). Production uses [`PaneLedger::new_locked`].
    pub fn new(root: Option<PathBuf>) -> Self {
        let index = root
            .as_ref()
            .map(|r| Self::load_index(r))
            .unwrap_or_default();
        Self {
            root,
            index: Mutex::new(index),
            lock_file: None,
            quarantined: RwLock::new(Vec::new()),
        }
    }

    /// Production construction (V2.md single-writer guard): acquire an
    /// exclusive advisory `flock(2)` on `<root>/lock` (the `ConfigLock`
    /// pattern, `settings_store.rs:385-417`). If another process holds it,
    /// log a loud structured ERROR and come up DISABLED (no-op) — never two
    /// writers on one store. Non-unix: no flock primitive is wired;
    /// construct normally (ConfigLock's non-unix parity).
    pub fn new_locked(root: Option<PathBuf>) -> Self {
        let Some(r) = root.clone() else {
            return Self::new(None);
        };
        match Self::acquire_store_lock(&r) {
            Ok(lock_file) => {
                let mut ledger = Self::new(root);
                ledger.lock_file = lock_file;
                ledger
            }
            Err(err) => {
                tracing::error!(
                    target: "freshell_ws::pane_ledger",
                    root = %r.display(),
                    error = %err,
                    "pane_ledger_lock_unavailable: another writer holds <root>/lock; \
                     ledger DISABLED for this process (never two writers on one store)"
                );
                Self::new(None)
            }
        }
    }

    #[cfg(unix)]
    fn acquire_store_lock(root: &Path) -> std::io::Result<Option<std::fs::File>> {
        use std::os::unix::io::AsRawFd;
        std::fs::create_dir_all(root)?;
        // Content irrelevant (only existence + flock state matter);
        // truncate(false) avoids clippy's suspicious_open_options.
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(root.join("lock"))?;
        // SAFETY: `fd` is a valid open descriptor owned by `file` for the
        // duration of the call; flock only mutates kernel lock state.
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 {
            Ok(Some(file))
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    #[cfg(not(unix))]
    fn acquire_store_lock(_root: &Path) -> std::io::Result<Option<std::fs::File>> {
        Ok(None) // no advisory-lock primitive on this platform (ConfigLock parity)
    }

    /// A ledger that stores nothing — the test/default construction.
    pub fn disabled() -> Self {
        Self::new(None)
    }

    /// Whether this ledger actually stores anything (`root: Some`). The
    /// auto-resume guard needs the distinction: with the ledger DISABLED,
    /// `bound_session_ref_for_terminal` answering `None` means nothing —
    /// only an ENABLED ledger's `None` is evidence the binding was retired.
    pub fn is_enabled(&self) -> bool {
        self.root.is_some()
    }

    fn bindings_dir(root: &Path) -> PathBuf {
        root.join("bindings")
    }

    fn pending_dir(root: &Path) -> PathBuf {
        root.join("pending")
    }

    fn binding_path(root: &Path, provider: &str, session_id: &str) -> PathBuf {
        Self::bindings_dir(root)
            .join(encode_segment(provider))
            .join(format!("{}.json", encode_segment(session_id)))
    }

    /// Rollback rows (kata 1wxv) — fresh-agent conversation-rollback state keyed
    /// (provider, sessionId): `rollback/<enc(provider)>/<enc(sessionId)>.json`.
    /// Payload-OPAQUE to the ledger: freshell_freshagent::rollback_record owns the schema.
    fn rollback_dir(root: &Path) -> PathBuf {
        root.join("rollback")
    }

    /// Kill tombstones (focused-ep5-r1 Finding 2) — see [`KillTombstone`].
    /// `kill-tombstones/<enc(provider)>/<enc(sessionId)>.json`.
    fn kill_tombstone_dir(root: &Path) -> PathBuf {
        root.join("kill-tombstones")
    }

    fn kill_tombstone_path(root: &Path, provider: &str, session_id: &str) -> PathBuf {
        Self::kill_tombstone_dir(root)
            .join(encode_segment(provider))
            .join(format!("{}.json", encode_segment(session_id)))
    }

    fn rollback_path(root: &Path, provider: &str, session_id: &str) -> PathBuf {
        Self::rollback_dir(root)
            .join(encode_segment(provider))
            .join(format!("{}.json", encode_segment(session_id)))
    }

    /// The ONE directory scan — construction-time only (V1.md).
    fn load_index(root: &Path) -> LedgerIndex {
        let mut index = LedgerIndex::default();
        if let Ok(providers) = std::fs::read_dir(Self::bindings_dir(root)) {
            for provider in providers.flatten() {
                let Ok(files) = std::fs::read_dir(provider.path()) else {
                    continue;
                };
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue; // *.tmp-* and *.quarantined-* residue
                    }
                    if let Ok(row) = load_row::<BindingRow>(&path) {
                        if row.ledger_version == LEDGER_VERSION {
                            index
                                .bindings
                                .insert((row.provider.clone(), row.session_id.clone()), row);
                        }
                    }
                }
            }
        }
        if let Ok(files) = std::fs::read_dir(Self::pending_dir(root)) {
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(marker) = load_row::<PendingMarker>(&path) {
                    if marker.ledger_version == LEDGER_VERSION {
                        index.pending.insert(marker.terminal_id.clone(), marker);
                    }
                }
            }
        }
        // Rollback subtree (kata 1wxv): the payload is OPAQUE (`Value`), so the
        // (provider, sessionId) key comes from the PATH — decoded with the
        // inverse of `encode_segment`. JSON-unparsable rows are skipped here
        // silently; the boot scan quarantines them loudly (fail per-row).
        if let Ok(providers) = std::fs::read_dir(Self::rollback_dir(root)) {
            for provider in providers.flatten() {
                let Some(provider_name) = provider.file_name().to_str().and_then(decode_segment)
                else {
                    continue;
                };
                let Ok(files) = std::fs::read_dir(provider.path()) else {
                    continue;
                };
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue;
                    }
                    let Some(session_id) = path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .and_then(decode_segment)
                    else {
                        continue;
                    };
                    if let Ok(value) = load_row::<serde_json::Value>(&path) {
                        index
                            .rollback
                            .insert((provider_name.clone(), session_id), value);
                    }
                }
            }
        }
        // Kill-tombstone subtree (focused-ep5-r1 Finding 2): typed payload,
        // keyed like the bindings subtree; expired entries are loaded anyway
        // and swept by the boot/GC pass or the write consult (mirroring the
        // marker discipline — `load_index` keeps only clean current-version
        // parses; aging is the sweep's job, never the loader's).
        if let Ok(providers) = std::fs::read_dir(Self::kill_tombstone_dir(root)) {
            for provider in providers.flatten() {
                let Ok(files) = std::fs::read_dir(provider.path()) else {
                    continue;
                };
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue; // *.tmp-* / *.quarantined-* residue
                    }
                    if let Ok(tombstone) = load_row::<KillTombstone>(&path) {
                        if tombstone.ledger_version == LEDGER_VERSION {
                            index.kill_tombstones.insert(
                                (tombstone.provider.clone(), tombstone.session_id.clone()),
                                tombstone.killed_at_ms,
                            );
                        }
                    }
                }
            }
        }
        index
    }

    /// Poison-tolerant lock (the `with_persist_lock` idiom) over the
    /// write-through index.
    fn guard(&self) -> std::sync::MutexGuard<'_, LedgerIndex> {
        self.index.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Record (or refresh) a `bound` row for this identity event.
    pub fn record_binding(&self, w: &BindingWrite<'_>) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        self.record_binding_locked(root, &mut index, w)
    }

    fn record_binding_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        w: &BindingWrite<'_>,
    ) -> std::io::Result<()> {
        // Supersession (G3, retire-never-defend): if this terminal already
        // owns a DIFFERENT bound identity, the order is pinned — write the
        // new `bound` row FIRST, then retire the old. A crash between the
        // two leaves two bound rows; the boot-scan repair (Task 4) closes
        // that window. Detection is a memory scan over the index (V1.md).
        let previous = index
            .bindings
            .values()
            .find(|r| {
                r.state == RowState::Bound
                    && r.live_terminal_id.as_deref() == Some(w.terminal_id)
                    && (r.provider != w.provider || r.session_id != w.session_id)
            })
            .cloned();

        let key = (w.provider.to_string(), w.session_id.to_string());
        let existing = index.bindings.get(&key);
        let created_at = existing.map(|r| r.created_at).unwrap_or(w.now_ms);
        if existing.is_some_and(|r| r.retired_reason == Some(RetiredReason::GcExpired)) {
            tracing::info!(
                target: "freshell_ws::pane_ledger",
                provider = %w.provider,
                session_id = %w.session_id,
                "pane_ledger_revived: gc_expired tombstone re-bound by a live identity event"
            );
        }
        // Provenance writer rules (the attribution fact is ONE atomic,
        // MONOTONE unit — stamps+time move together, focused-ep4-r3 Findings
        // 1+2; the tri-state is delta-r2 Finding 2, [`ProvenancePolicy`]):
        //
        // * `Inherit` (conn-less session-affiliated lane): the write asserts
        //   nothing — the row keeps every stamp AND the attribution time.
        // * `Replace` splits on whether the row HAS a prior attribution
        //   (focused-ep4-r5 Finding 1):
        //   - ATTACH (no prior `last_attributed_at`): applies whatever
        //     MEANINGFUL provenance exists — the client+device halves, plus
        //     the tab and the assertion time when present
        //     (`attaches_attribution`; no triple requirement — a legacy
        //     client whose wire message omits `tabId` still attaches).
        //   - ADVANCE (a prior `last_attributed_at` exists): applies stamps
        //     AND time only when it is a COMPLETE, NOT-STALE attribution:
        //     the full client+device+tab triple is present
        //     (`advances_attribution`, focused-ep4-r3 finding 2) AND the
        //     stamps' `asserted_at` is >= the row's current
        //     `last_attributed_at` (finding 1; the exact tie replaces,
        //     keeping semantics deterministic). The assertion time is
        //     captured at message RECEIPT — before gated/async create/fork
        //     work — so an older delayed write can land AFTER a newer
        //     assertion for the same session; without the guard it would
        //     drag stamps+time back to the older tab/moment.
        // * A `Replace` that fails its gate (hollow stamps on a
        //   never-attributed row, or a partial/older assertion over an
        //   attributed one) leaves stamps+time UNTOUCHED while the write's
        //   other fields still land. The pre-finding-2 per-field
        //   keep-when-`None` merge is gone: it mixed marker/write and row
        //   stamps into combinations no single browser assertion ever made.
        // * `Clear` (explicitly-headless lineage lane): the row's IDENTITY
        //   stamps are erased, so a stale browser attribution can never
        //   launder the row into the D8 offer under a refreshed `updated_at`
        //   — but the attribution CLOCK is FLOORED, never erased
        //   (focused-ep4-r5 Finding 2): `last_attributed_at` becomes
        //   `max(existing, clear_now)`, so a delayed pre-Clear assertion can
        //   never pass a no-prior-attribution arm and resurrect the cleared
        //   stamps. The row stays unofferable while the stamps are `None`
        //   (the judgment gates on the stamps first).
        //
        // The advancing TIME is the stamps' own `asserted_at` — the
        // provenance value's assertion time since message receipt
        // (focused-ep4-r2 Findings 1+2); the write's `now_ms` never enters
        // (a slow spawn or a late conn-less resolution must not manufacture
        // freshness; a marker-stamped resolution carries the consumed
        // marker's `asserted_at` in exactly this slot). A conn-less `Inherit`
        // maintenance write (respawn/locator/resolution) refreshes
        // `updated_at` but re-asserts nothing, so neither it nor a weaker
        // `Replace` can launder the row into the D8 offer the way
        // `updated_at` churn did. DELIBERATELY unlike this body's other
        // advisory fields (`create_request_id`), which are
        // wholesale-replaced.
        //
        // The monotonic compare is WALL-CLOCK: after a backward server-clock
        // step a genuinely-later assertion compares as older and is rejected
        // for up to the skew magnitude (until real time outruns the stored
        // value) — the same bounded-skew class as the evidence-clock
        // residual (`UNSNAPSHOTTED_BINDING_GRACE_MS` in
        // `recovery_inventory.rs`), and a sequence counter is deliberately
        // NOT built for it (focused-ep4-r5 Finding 2a).
        let prior_attribution = existing.and_then(|r| r.last_attributed_at);
        let apply = match w.provenance {
            ProvenancePolicy::Replace(stamps) => match prior_attribution {
                None => attaches_attribution(&w.provenance),
                Some(t) => advances_attribution(&w.provenance) && stamps.asserted_at >= t,
            },
            _ => false,
        };
        let (client_instance_id, device_id, tab_key, last_attributed_at) = match w.provenance {
            ProvenancePolicy::Inherit => (
                existing.and_then(|r| r.client_instance_id.clone()),
                existing.and_then(|r| r.device_id.clone()),
                existing.and_then(|r| r.tab_key.clone()),
                existing.and_then(|r| r.last_attributed_at),
            ),
            ProvenancePolicy::Replace(stamps) => {
                if apply {
                    (
                        stamps.client_instance_id.map(str::to_string),
                        stamps.device_id.map(str::to_string),
                        stamps.tab_key.map(str::to_string),
                        applied_attribution_time(stamps.asserted_at),
                    )
                } else {
                    (
                        existing.and_then(|r| r.client_instance_id.clone()),
                        existing.and_then(|r| r.device_id.clone()),
                        existing.and_then(|r| r.tab_key.clone()),
                        existing.and_then(|r| r.last_attributed_at),
                    )
                }
            }
            ProvenancePolicy::Clear => (
                None,
                None,
                None,
                Some(prior_attribution.map_or(w.now_ms, |t| t.max(w.now_ms))),
            ),
        };
        let row = BindingRow {
            ledger_version: LEDGER_VERSION,
            provider: w.provider.to_string(),
            session_id: w.session_id.to_string(),
            mode: w.mode.to_string(),
            cwd: w.cwd.map(str::to_string),
            live_terminal_id: Some(w.terminal_id.to_string()),
            create_request_id: w.create_request_id.map(str::to_string),
            created_at,
            updated_at: w.now_ms,
            last_observed_at: w.now_ms,
            state: RowState::Bound,
            retired_reason: None,
            superseded_by: None,
            pane_kind: None,
            model: None,
            sandbox: None,
            permission_mode: None,
            effort: None,
            client_instance_id,
            device_id,
            tab_key,
            last_attributed_at,
        };
        self.write_binding(root, index, &row)?; // new bound row FIRST (pinned)

        if let Some(old) = previous {
            self.retire_and_link_locked(
                root,
                index,
                old,
                SessionLocator {
                    provider: w.provider.to_string(),
                    session_id: w.session_id.to_string(),
                },
                w.now_ms,
                Some(w.terminal_id),
            )?;
        }
        Ok(())
    }

    /// Retire an old bound row and link it to the session that superseded it
    /// (G3 retire-never-defend; the ONE supersession block shared by
    /// [`Self::record_binding_locked`] and [`Self::record_fresh_agent_binding`]
    /// so the two sites can never drift): state→Retired,
    /// retired_reason→Superseded, superseded_by→the new session's locator,
    /// updated_at→now, one info log, then persist. Callers write the new bound
    /// row FIRST and call this AFTER (order pinned). `terminal_id` is `Some`
    /// for terminal-pane rows (logged) and `None` for fresh-agent rows (which
    /// own no terminal).
    fn retire_and_link_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        mut old: BindingRow,
        superseded_by: SessionLocator,
        now_ms: i64,
        terminal_id: Option<&str>,
    ) -> std::io::Result<()> {
        old.state = RowState::Retired;
        old.retired_reason = Some(RetiredReason::Superseded);
        old.updated_at = now_ms;
        match terminal_id {
            Some(terminal_id) => tracing::info!(
                target: "freshell_ws::pane_ledger",
                terminal_id = %terminal_id,
                old_session_id = %old.session_id,
                new_session_id = %superseded_by.session_id,
                "pane_ledger_superseded: binding moved; old row retired, never defended"
            ),
            None => tracing::info!(
                target: "freshell_ws::pane_ledger",
                old_session_id = %old.session_id,
                new_session_id = %superseded_by.session_id,
                "pane_ledger_superseded: fresh-agent binding moved; \
                 old row retired, never defended"
            ),
        }
        old.superseded_by = Some(superseded_by);
        self.write_binding(root, index, &old) // THEN retire the old
    }

    /// Record (or refresh) a `bound` row for a fresh-agent identity event
    /// (P1.13). Upsert keyed `(provider, session_id)`: settings are a FULL
    /// snapshot (replace, not merge); `created_at` is preserved on rewrite.
    /// When `w.supersedes` names a different old session id, the old row is
    /// retired and linked AFTER the new bound row persists (G3 order pinned,
    /// V8/A14) — a missing old row is a silent no-op.
    ///
    /// Focused-ep5-r1 Finding 2: this is also the kill-tombstone CHECK — the
    /// ONE choke point every fresh-agent binding write flows through
    /// (`LedgerIdentitySink::record_binding`). An identity a fresh kill
    /// tombstone covers is suppressed (never Bound; a stale Bound remnant is
    /// force-retired Closed), so an explicit close can never be undone by a
    /// write that was in flight when the kill landed. Deliberately NOT
    /// consulted by the terminal-lineage lanes (`record_binding`,
    /// `resolve_pending`): those own the mode-pane resume paths, which must
    /// rebind after a terminal kill (natural authority split — see the round
    /// 2 report's writer audit).
    pub fn record_fresh_agent_binding(
        &self,
        w: &FreshAgentBindingWrite<'_>,
    ) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();

        let key = (w.provider.to_string(), w.session_id.to_string());
        // Focused-ep5-r1 Finding 2 — the kill-tombstone consult (state, not
        // scheduling): under the SAME guard the write below runs on. A
        // DOMINANT or FRESH tombstone for this identity
        // ([`classify_kill_tombstone`]) means an explicit close beat this
        // write (the in-flight orphan shape — an aborted consumer's
        // spawn_blocking closure outliving every retire pass, or a
        // detached-lane write racing the kill); the write is SUPPRESSED
        // wholesale (no Bound row is created, and the supersession retire/
        // link below is skipped with it — a dead write must not retire a
        // live parent). A stale Bound remnant (a crash slipped between the
        // kill's tombstone write and its row retire) is force-retired
        // Closed, self-healing it — and focused-ep5-r3 Finding 4: dominance
        // NEVER expires while the remnant reads Bound (an expired tombstone
        // still converges it, TTL notwithstanding). An EXPIRED tombstone over
        // nothing-Bound is swept lazily (index + file) and the write proceeds
        // — the TTL bounds the protection; a genuine late bind (claims also
        // clear explicitly via their commit) is never wedged by stale kills.
        // A CLAIM-RESIDUE tombstone (a committed claim's revive visibly
        // outranks its own crashed clear) is inert: the write proceeds and
        // the residue is pruned.
        if let Some(killed_at) = index.kill_tombstones.get(&key).copied() {
            let row_view = index
                .bindings
                .get(&key)
                .map(|r| (r.state, r.updated_at));
            match classify_kill_tombstone(killed_at, row_view, w.now_ms) {
                KillTombstoneVerdict::Dominant | KillTombstoneVerdict::Fresh => {
                    tracing::info!(
                        target: "freshell_ws::pane_ledger",
                        provider = %w.provider,
                        session_id = %w.session_id,
                        killed_at_ms = killed_at,
                        "pane_ledger_binding_suppressed_by_kill_tombstone: a late write \
                         for an explicitly-closed identity writes nothing (never Bound)"
                    );
                    if let Some(mut remnant) = index.bindings.get(&key).cloned() {
                        if remnant.state == RowState::Bound {
                            remnant.state = RowState::Retired;
                            remnant.retired_reason = Some(RetiredReason::Closed);
                            remnant.updated_at = w.now_ms;
                            tracing::info!(
                                target: "freshell_ws::pane_ledger",
                                provider = %w.provider,
                                session_id = %w.session_id,
                                "pane_ledger_tombstoned_remnant_retired: force-retiring the \
                                 crash-window Bound remnant alongside the suppressed write"
                            );
                            self.write_binding(root, &mut index, &remnant)?;
                        }
                    }
                    return Ok(());
                }
                // Finding 4: an expired tombstone over a missing/Retired row is
                // pruned noise — the write proceeds and the consult sweeps it
                // lazily. Finding 3: a ClaimResidue tombstone (the committed
                // claim's own clear crashed/failed) is inert by construction
                // (the Bound row outranks it) — never suppress the claim's own
                // write; prune the residue instead so it cannot linger.
                KillTombstoneVerdict::Expired | KillTombstoneVerdict::ClaimResidue => {
                    index.kill_tombstones.remove(&key);
                    if let Err(err) = std::fs::remove_file(Self::kill_tombstone_path(
                        root,
                        w.provider,
                        w.session_id,
                    )) {
                        if err.kind() != std::io::ErrorKind::NotFound {
                            // Fail loud, never silent: the sweep prunes at the
                            // next GC pass regardless (a ClaimResidue file left
                            // behind is inert either way — the row outranks it).
                            tracing::warn!(
                                target: "freshell_ws::pane_ledger",
                                provider = %w.provider,
                                session_id = %w.session_id,
                                error = %err,
                                "pane_ledger_stale_tombstone_sweep_failed: file left behind; GC retries"
                            );
                        }
                    }
                }
            }
        }
        let existing = index.bindings.get(&key);
        let created_at = existing.map(|r| r.created_at).unwrap_or(w.now_ms);
        // Advisory field: keep the existing row's value when the new write
        // has none (latest-observed semantics, D4).
        let create_request_id = w
            .create_request_id
            .map(str::to_string)
            .or_else(|| existing.and_then(|r| r.create_request_id.clone()));
        // Provenance writer rules (the SAME atomic, MONOTONE attribution fact
        // as the terminal body — focused-ep4-r3 Findings 1+2, one shared
        // `attaches_attribution`/`advances_attribution` pair; the tri-state
        // is delta-r2 Finding 2):
        //
        // * `Inherit` asserts nothing — conn-less refresh lanes keep the
        //   create's stamps AND time; a fork-chain first write
        //   (`supersedes: Some(parent)`, no same-key row — the claude rollback
        //   adoption and codex crash-respawn lanes) inherits the superseded
        //   PARENT's stamps AND its assertion time (the fork is, by
        //   construction, the same pane; the ep4-r1 repair deleted the
        //   judgment's `created_at` floor that once made an inherited older
        //   value unusable).
        // * `Replace` splits on whether the preserve source HAS a prior
        //   attribution (focused-ep4-r5 Finding 1): ATTACH (none) applies
        //   whatever MEANINGFUL provenance exists — client+device, plus the
        //   tab and the assertion time when present (no triple requirement,
        //   so a legacy client's create/fork — `FreshAgentFork.tab_id` is
        //   additive/optional — no longer leaves the child attribution-less);
        //   ADVANCE (a prior time exists) applies stamps AND time only on a
        //   COMPLETE (full triple, finding 2), NOT-STALE
        //   (`asserted_at >= the preserved attribution time`, exact tie
        //   replaces — finding 1) attribution; otherwise stamps+time stay
        //   with the preserve source while the write's settings/row-keeping
        //   fields still land.
        // * `Clear` (explicitly-headless lineage) erases all stamps and
        //   NEVER inherits the parent's stamps — a headless re-bind must not
        //   keep a browser's attribution under a refreshed `updated_at`, or
        //   the D8 judgment would offer a session that was not open. The
        //   attribution CLOCK is FLOORED, not erased (focused-ep4-r5 Finding
        //   2): `last_attributed_at` becomes `max(preserved, clear_now)`, so
        //   a delayed pre-Clear assertion can never resurrect the cleared
        //   stamps; the row stays unofferable while they are `None`.
        //
        // The preserve/monotonicity source is the merge's `inherit` — the
        // same-key existing row, else the superseded PARENT on a fork-chain
        // first write — so a supersession chain's true assertion time also
        // bounds any later-arriving older write. The advancing time is the
        // stamps' own `asserted_at` (focused-ep4-r2 Findings 1+2), never this
        // conn-less-or-late write's `now_ms`; the `Clear` floor IS this
        // write's `now` (a clear asserts nothing about the browser — its own
        // time is the floor). The monotonic compare is WALL-CLOCK: after a
        // backward server-clock step a genuinely-later assertion can be
        // rejected for up to the skew magnitude — the bounded-skew residual
        // documented in the terminal body (focused-ep4-r5 Finding 2a); no
        // sequence counter is built for it. The retire/link below is
        // unchanged by the policy; this block is stamps+time only.
        let superseded_parent = w
            .supersedes
            .filter(|old| *old != w.session_id)
            .and_then(|old| {
                index
                    .bindings
                    .get(&(w.provider.to_string(), old.to_string()))
                    .cloned()
            });
        let inherit = existing.or(superseded_parent.as_ref());
        let prior_attribution = inherit.and_then(|r| r.last_attributed_at);
        let apply = match w.provenance {
            ProvenancePolicy::Replace(stamps) => match prior_attribution {
                None => attaches_attribution(&w.provenance),
                Some(t) => advances_attribution(&w.provenance) && stamps.asserted_at >= t,
            },
            _ => false,
        };
        let (client_instance_id, device_id, tab_key, last_attributed_at) = match w.provenance {
            ProvenancePolicy::Inherit => (
                inherit.and_then(|r| r.client_instance_id.clone()),
                inherit.and_then(|r| r.device_id.clone()),
                inherit.and_then(|r| r.tab_key.clone()),
                inherit.and_then(|r| r.last_attributed_at),
            ),
            ProvenancePolicy::Replace(stamps) => {
                if apply {
                    (
                        stamps.client_instance_id.map(str::to_string),
                        stamps.device_id.map(str::to_string),
                        stamps.tab_key.map(str::to_string),
                        applied_attribution_time(stamps.asserted_at),
                    )
                } else {
                    (
                        inherit.and_then(|r| r.client_instance_id.clone()),
                        inherit.and_then(|r| r.device_id.clone()),
                        inherit.and_then(|r| r.tab_key.clone()),
                        inherit.and_then(|r| r.last_attributed_at),
                    )
                }
            }
            ProvenancePolicy::Clear => (
                None,
                None,
                None,
                Some(prior_attribution.map_or(w.now_ms, |t| t.max(w.now_ms))),
            ),
        };
        let row = BindingRow {
            ledger_version: LEDGER_VERSION,
            provider: w.provider.to_string(),
            session_id: w.session_id.to_string(),
            mode: w.mode.to_string(),
            cwd: w.cwd.map(str::to_string),
            live_terminal_id: None, // fresh-agent panes have no terminal
            create_request_id,
            created_at,
            updated_at: w.now_ms,
            last_observed_at: w.now_ms,
            state: RowState::Bound,
            retired_reason: None,
            superseded_by: None,
            pane_kind: Some("fresh-agent".into()),
            model: w.model.map(str::to_string),
            sandbox: w.sandbox.map(str::to_string),
            permission_mode: w.permission_mode.map(str::to_string),
            effort: w.effort.map(str::to_string),
            client_instance_id,
            device_id,
            tab_key,
            last_attributed_at,
        };
        self.write_binding(root, &mut index, &row)?; // new bound row FIRST (pinned)

        if let Some(old_id) = w.supersedes {
            if old_id != w.session_id {
                let old_key = (w.provider.to_string(), old_id.to_string());
                if let Some(old) = index.bindings.get(&old_key).cloned() {
                    self.retire_and_link_locked(
                        root,
                        &mut index,
                        old,
                        SessionLocator {
                            provider: w.provider.to_string(),
                            session_id: w.session_id.to_string(),
                        },
                        w.now_ms,
                        None, // fresh-agent rows own no terminal
                    )?;
                }
                // Missing old row: silent no-op.
            }
        }
        Ok(())
    }

    /// One row: durable file FIRST, then the write-through index — in the
    /// same locked section, so readers never see index-ahead-of-disk.
    fn write_binding(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        row: &BindingRow,
    ) -> std::io::Result<()> {
        let dest = Self::binding_path(root, &row.provider, &row.session_id);
        write_row_atomic(&dest, row)?;
        index
            .bindings
            .insert((row.provider.clone(), row.session_id.clone()), row.clone());
        Ok(())
    }

    /// The kill-tombstone record (focused-ep5-r1 Finding 2): file FIRST,
    /// then the write-through index — the `write_binding` discipline. Under
    /// the caller's index guard. Idempotent refresh (a re-kill re-stamps
    /// `killed_at_ms`).
    fn record_kill_tombstone_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        provider: &str,
        session_id: &str,
        now_ms: i64,
    ) -> std::io::Result<()> {
        let tombstone = KillTombstone {
            ledger_version: LEDGER_VERSION,
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            killed_at_ms: now_ms,
        };
        write_row_atomic(&Self::kill_tombstone_path(root, provider, session_id), &tombstone)?;
        index
            .kill_tombstones
            .insert((provider.to_string(), session_id.to_string()), now_ms);
        Ok(())
    }

    /// The recorded kill-tombstone time for this identity, TTL-agnostic (the
    /// binder consult applies the TTL; the GC sweep owns expiry deletion).
    /// Diagnostic/test surface: nothing in production reads tombstones
    /// except the binder consult and the sweep. Memory-only (V1.md read
    /// policy); a disabled ledger answers `None`.
    pub fn kill_tombstone_at(&self, provider: &str, session_id: &str) -> Option<i64> {
        self.root.as_ref()?;
        self.guard()
            .kill_tombstones
            .get(&(provider.to_string(), session_id.to_string()))
            .copied()
    }

    /// The identities whose kill tombstone currently DOMINATES a Bound row
    /// ([`classify_kill_tombstone`]) — the read-side dominance input the
    /// recovery inventory consults (its Bound rows then read as Retired, so
    /// the crash-window split-write remnant is never offered). Dominance has
    /// NO TTL (focused-ep5-r3 Finding 4): a tombstone paired with a still-Bound
    /// row whose liveness predates the close is the unconverged crash evidence
    /// — it answers here forever (until a sweep retires the row), never aging
    /// out at six hours the way a converged or never-Bound pair does.
    /// Claim-residue tombstones (an accepted claim's revived row outranks the
    /// stale name) are deliberately EXCLUDED: the revived session is genuinely
    /// open and its row must stay Bound at the offer boundary. Memory-only
    /// (V1.md read policy); a disabled ledger answers empty.
    pub fn dominant_kill_tombstone_keys(&self) -> std::collections::HashSet<(String, String)> {
        if self.root.is_none() {
            return std::collections::HashSet::new();
        }
        let index = self.guard();
        index
            .kill_tombstones
            .iter()
            .filter(|(key, killed_at)| {
                let row_view = index
                    .bindings
                    .get(*key)
                    .map(|r| (r.state, r.updated_at));
                // Dominance is TTL-free; `now` only disambiguates the
                // non-Bound arms, which this filter never selects anyway.
                classify_kill_tombstone(**killed_at, row_view, i64::MAX)
                    == KillTombstoneVerdict::Dominant
            })
            .map(|(key, _)| key.clone())
            .collect()
    }

    /// The tombstone lifecycle transition (focused-ep5-r1 Finding 2): a NEW
    /// pane/session GENUINELY CLAIMING the identity (an explicit
    /// resume/attach) clears the tombstone, so that claim's own binding
    /// write lands Bound again. Idempotent (a never-killed identity clears
    /// to `Ok`), so claim lanes call it unconditionally. File removal first,
    /// then the write-through index — the `delete_pending` discipline.
    /// Round 4 (focused-ep5-r3) narrowed its callers: the claimed DURABLE's
    /// own fence now moves inside [`Self::commit_claim`]'s conditional
    /// transition; this op remains for the claude claim lane's consumed
    /// PLACEHOLDER-alias fences (secondary identities, cleared only after
    /// the durable's commit accepted).
    pub fn clear_kill_tombstone(&self, provider: &str, session_id: &str) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        let result = match std::fs::remove_file(Self::kill_tombstone_path(root, provider, session_id))
        {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
        if result.is_ok() {
            index
                .kill_tombstones
                .remove(&(provider.to_string(), session_id.to_string()));
        }
        result
    }

    /// Focused-ep5-r3 Findings 1+3 (retire-on-kill round 4) — the claim
    /// lifecycle's COMMIT as ONE CONDITIONAL, crash-atomic transition,
    /// superseding round 3's separate `clear_kill_tombstone` + `revive_closed`
    /// pair (whose two awaited, log-and-continue writes could split both ways:
    /// a crash after the clear left a genuinely reopened session permanently
    /// Closed; a failed clear after a successful revive left a Bound row
    /// dominated by its own stale tombstone — Finding 3):
    ///
    /// * CONDITION (Finding 1): `expect_killed_at_ms` is the identity's
    ///   dead-state snapshot taken at CLAIM START (the tombstone stamp the
    ///   attach/resume read before spending work on the provider). If the
    ///   tombstone ADVANCED past it (a newer [`Self::retire_closed`] landed
    ///   mid-claim — the user closed the pane while the resume awaited its
    ///   response), the commit is REFUSED with NO side effects at all: no
    ///   clear, no revive, no index or file mutation. The resumed session is
    ///   an orphan of a closed pane; the caller tears it down and the row
    ///   stays Retired. An unchanged (or absent, or older) dead-state
    ///   commits.
    /// * TRANSITION (Finding 3): on commit the revived row file (Bound,
    ///   liveness re-stamped at `now_ms`) lands FIRST and the tombstone
    ///   delete lands SECOND, both under the one guard. A crash between them
    ///   leaves a Bound row that visibly POSTDATES the surviving tombstone —
    ///   [`classify_kill_tombstone`] reads that pair as ClaimResidue: inert
    ///   at every consult (never suppresses, never dominates, never offered
    ///   away) and pruned by any sweep. The reverse intermediate (clear
    ///   persisted, revive lost) is impossible by ordering, so NO durable
    ///   observation of a half-committed claim exists.
    ///
    /// Narrowness preserved from round 3's `revive_closed`: ONLY a
    /// Retired(Closed) row flips to Bound (a `Superseded` row's chain
    /// linkage and a `GcExpired`/`SessionMissing` verdict are never
    /// rewritten); a missing row gains nothing (never a laundered row — the
    /// V7/A10 no-laundering discipline survives intact). With NO tombstone
    /// on record the commit is a pure no-op (no row-write churn on an
    /// unfenced re-claim). A disabled ledger is the polite `Committed`
    /// no-op.
    pub fn commit_claim(
        &self,
        provider: &str,
        session_id: &str,
        expect_killed_at_ms: Option<i64>,
        now_ms: i64,
    ) -> std::io::Result<ClaimCommitOutcome> {
        let Some(root) = &self.root else {
            return Ok(ClaimCommitOutcome::Committed);
        };
        let mut index = self.guard();
        let key = (provider.to_string(), session_id.to_string());
        let current = index.kill_tombstones.get(&key).copied();
        let dead_state_advanced = match (current, expect_killed_at_ms) {
            (Some(cur), Some(exp)) => cur > exp,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if dead_state_advanced {
            tracing::info!(
                target: "freshell_ws::pane_ledger",
                provider = %provider,
                session_id = %session_id,
                expected_killed_at_ms = ?expect_killed_at_ms,
                current_killed_at_ms = ?current,
                "pane_ledger_claim_refused_stale_dead_state: a close landed mid-claim; \
                 the resumed session stays torn down and the row stays Retired"
            );
            return Ok(ClaimCommitOutcome::RefusedStale);
        }
        // The durable transition: the ROW carries the committed truth first.
        // The revived/refreshed `updated_at` is what demotes any tombstone
        // that survives the delete below to inert claim residue.
        let tombstone_present = current.is_some();
        if tombstone_present {
            if let Some(mut row) = index.bindings.get(&key).cloned() {
                if row.state == RowState::Retired && row.retired_reason == Some(RetiredReason::Closed)
                {
                    row.state = RowState::Bound;
                    row.retired_reason = None;
                    row.updated_at = now_ms;
                    row.last_observed_at = now_ms;
                    self.write_binding(root, &mut index, &row)?;
                    tracing::info!(
                        target: "freshell_ws::pane_ledger",
                        provider = %provider,
                        session_id = %session_id,
                        "pane_ledger_closed_row_revived: a genuine claim returned the killed identity to Bound"
                    );
                } else if row.state == RowState::Bound {
                    // The crash-remnant claim shape (a Bound row whose retire
                    // write was lost): the claim commits over it, so refresh
                    // its liveness stamps — without this, a tombstone whose
                    // delete fails below would keep dominating it.
                    row.updated_at = now_ms;
                    row.last_observed_at = now_ms;
                    self.write_binding(root, &mut index, &row)?;
                }
                // Superseded / GcExpired / SessionMissing rows keep their
                // verdict verbatim (the round-3 narrowness).
            }
        }
        if tombstone_present {
            let result =
                match std::fs::remove_file(Self::kill_tombstone_path(root, provider, session_id)) {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(e),
                };
            match result {
                Ok(()) => {
                    index.kill_tombstones.remove(&key);
                }
                Err(err) => {
                    // The transition itself already committed durably above; a
                    // failed ONLY-CLEANUP delete leaves claim residue (inert at
                    // every consult, pruned by any sweep). Fail loud, never
                    // silent — but never fail the accepted commit over it.
                    tracing::warn!(
                        target: "freshell_ws::pane_ledger",
                        provider = %provider,
                        session_id = %session_id,
                        error = %err,
                        "pane_ledger_claim_tombstone_delete_failed: inert claim residue left behind; the next sweep prunes it"
                    );
                }
            }
        }
        Ok(ClaimCommitOutcome::Committed)
    }

    /// Best-effort retire on observed clean close (trigger e). Missing or
    /// already-retired rows are Ok — this path is never load-bearing.
    ///
    /// Focused-ep5-r1 Finding 2 (retire-on-kill round 2): an explicit close
    /// is an intentional session END, so this call ALSO records the durable
    /// kill tombstone for the identity BEFORE retiring the row (when one
    /// exists), inside the same guard. The tombstone — not task-abort
    /// ordering — is what fences a binding write already in flight at kill
    /// time (an aborted consumer's orphaned spawn_blocking closure survives
    /// its task and can land after every retire pass over a row that does
    /// not exist yet): [`PaneLedger::record_fresh_agent_binding`] consults
    /// the tombstone under this same index guard, so the write suppresses
    /// itself (or force-retires a stale Bound remnant) instead of restoring
    /// Bound. The tombstone write is attempted even when the row retire is a
    /// no-op (kill-before-row is exactly the finding's shape). Both writes
    /// are attempted on partial failure; the tombstone's error wins the
    /// return (it is the load-bearing half now — a missed row retire was
    /// already this function's accepted outcome, and focused-ep5-r2's
    /// dominance rule keeps the split-write remnant never-offered until the
    /// next sweep converges it durably — see the module doc).
    pub fn retire_closed(
        &self,
        provider: &str,
        session_id: &str,
        now_ms: i64,
    ) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        let tombstone_result =
            self.record_kill_tombstone_locked(root, &mut index, provider, session_id, now_ms);
        let Some(mut row) = index
            .bindings
            .get(&(provider.to_string(), session_id.to_string()))
            .cloned()
        else {
            return tombstone_result;
        };
        if row.state != RowState::Bound {
            return tombstone_result;
        }
        row.state = RowState::Retired;
        row.retired_reason = Some(RetiredReason::Closed);
        row.updated_at = now_ms;
        let retire_result = self.write_binding(root, &mut index, &row);
        tombstone_result.and(retire_result)
    }

    /// Retire a Bound row as SessionMissing (session file not found on disk).
    /// Returns true iff a Bound row was successfully retired; false if the row
    /// does not exist or is already retired (idempotent).
    pub fn retire_missing(&self, provider: &str, session_id: &str) -> bool {
        let Some(root) = &self.root else {
            return false;
        };
        let now_ms = crate::terminal::now_ms();
        let mut index = self.guard();
        let Some(mut row) = index
            .bindings
            .get(&(provider.to_string(), session_id.to_string()))
            .cloned()
        else {
            return false;
        };
        if row.state != RowState::Bound {
            return false;
        }
        row.state = RowState::Retired;
        row.retired_reason = Some(RetiredReason::SessionMissing);
        row.updated_at = now_ms;
        self.write_binding(root, &mut index, &row).is_ok()
    }

    /// Hard-delete one binding row (file first, then index — the mirror of
    /// [`Self::delete_pending`]'s atomic delete; missing file == already
    /// gone). PIN 2 (Step 4b): the ONLY caller is the spawn-failure branch
    /// of a FRESH claude preallocation — its pre-spawn row describes a pane
    /// that never existed. Left in place it could still surface as a ghost
    /// `ledgerOnly` recovery offer across the row's ~30-day lifetime: the D8
    /// parent-relative judgment narrows ghost offers to stamped rows inside
    /// their own parent client's grace window (unattributed rows are never
    /// offered), but this row IS connection-stamped and its bind sits inside
    /// that window by construction — so the durable delete remains the only
    /// guarantee it never surfaces. Never used for resume creates: their row
    /// belongs to the prior epoch and must stay recoverable.
    pub fn delete_binding(&self, provider: &str, session_id: &str) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        let result = match std::fs::remove_file(Self::binding_path(root, provider, session_id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
        if result.is_ok() {
            index
                .bindings
                .remove(&(provider.to_string(), session_id.to_string()));
        }
        result
    }

    /// Retire-on-kill round 5 (focused-ep5-r4 Finding 2): the identity's RAW
    /// row-state answer — true iff a row exists and is currently Bound. The
    /// claude alias-tombstone retention consults it: a placeholder→durable
    /// mapping may only be discarded (TTL expiry / capacity eviction) once
    /// the row it resolves to is Retired-or-GC'd — while the row is Bound,
    /// the pane's close still needs the mapping to reach this row. Note this
    /// deliberately answers the RAW state: a Bound row dominated by a kill
    /// tombstone (the unconverged crash remnant) still answers true, and
    /// retaining that alias is harmless (its kills retire the row anyway).
    /// Memory-only (V1.md read policy), like [`Self::load_binding`].
    pub fn row_is_bound(&self, provider: &str, session_id: &str) -> bool {
        self.load_binding(provider, session_id)
            .is_some_and(|row| row.state == RowState::Bound)
    }

    /// Raw single-row read from the index (no chain following — that is
    /// `lookup_by_session`, Task 2). Memory-only (V1.md read policy).
    pub fn load_binding(&self, provider: &str, session_id: &str) -> Option<BindingRow> {
        self.root.as_ref()?;
        self.guard()
            .bindings
            .get(&(provider.to_string(), session_id.to_string()))
            .cloned()
    }

    /// Fresh-agent Task 3 (`was_recorded` rekeying): true iff a FRESH-AGENT
    /// binding row carrying a SETTINGS-BEARING snapshot exists for this key —
    /// at least one of model/sandbox/permission_mode/effort/cwd set (the exact
    /// complement of the identity sink's `load_settings` blank guard, so the
    /// two predicates can never disagree). A lineage-only row (every settings
    /// column blank) answers false: unconditional lineage recording can never
    /// arm a false SETTINGS_RESET. Terminal-pane rows (no `pane_kind`) never
    /// count. State-agnostic like `load_binding` (tombstones included, V6/A9).
    /// Schema-compatible: no migration; historical blank rows flip to false
    /// (forward-looking tradeoff, accepted by the campaign plan). Memory-only.
    pub fn fresh_agent_settings_recorded(&self, provider: &str, session_id: &str) -> bool {
        self.load_binding(provider, session_id)
            .map(|r| {
                r.pane_kind.as_deref() == Some("fresh-agent")
                    && (r.model.is_some()
                        || r.sandbox.is_some()
                        || r.permission_mode.is_some()
                        || r.effort.is_some()
                        || r.cwd.is_some())
            })
            .unwrap_or(false)
    }

    /// Follow the `supersededBy` chain from a claimed ref to its terminus.
    /// Chains cannot cycle (a supersession write always targets a fresh row
    /// and retires its predecessor in the same act) — the hop cap is a
    /// corruption backstop, loud when hit.
    pub fn lookup_by_session(&self, provider: &str, session_id: &str) -> Option<Resolution> {
        self.root.as_ref()?;
        let index = self.guard(); // memory-only chain walk (V1.md read policy)
        let mut row = index
            .bindings
            .get(&(provider.to_string(), session_id.to_string()))
            .cloned()?;
        let mut corrected = false;
        let mut hops = 0u32;
        while row.state == RowState::Retired {
            let Some(next) = row.superseded_by.clone() else {
                break; // closed / gc_expired terminus — caller applies its reader rule
            };
            hops += 1;
            if hops > 32 {
                tracing::error!(
                    target: "freshell_ws::pane_ledger",
                    provider = %provider,
                    session_id = %session_id,
                    "pane_ledger_chain_overflow: supersession chain exceeded 32 hops (corruption?)"
                );
                return None;
            }
            let Some(next_row) = index
                .bindings
                .get(&(next.provider.clone(), next.session_id.clone()))
                .cloned()
            else {
                break;
            };
            row = next_row;
            corrected = true;
        }
        Some(Resolution { row, corrected })
    }

    /// Whether this server has EVER durably bound this identity — bound or
    /// retired, tombstones included. This is the ledger-backed
    /// `ever_observed` input (spec §4.2 reads). Memory-only.
    pub fn ever_bound(&self, provider: &str, session_id: &str) -> bool {
        if self.root.is_none() {
            return false;
        }
        self.guard()
            .bindings
            .contains_key(&(provider.to_string(), session_id.to_string()))
    }

    /// All indexed binding rows (bound AND retired). Memory-only.
    pub fn list_bindings(&self) -> Vec<BindingRow> {
        if self.root.is_none() {
            return Vec::new();
        }
        self.guard().bindings.values().cloned().collect()
    }

    /// Secondary-index read: the newest BOUND row owned by this terminal.
    pub fn bound_session_ref_for_terminal(&self, terminal_id: &str) -> Option<SessionLocator> {
        self.list_bindings()
            .into_iter()
            .filter(|r| {
                r.state == RowState::Bound && r.live_terminal_id.as_deref() == Some(terminal_id)
            })
            .max_by_key(|r| r.updated_at)
            .map(|r| SessionLocator {
                provider: r.provider,
                session_id: r.session_id,
            })
    }

    /// Advisory-index read for the claude restore ladder: the newest row for
    /// this provider whose latest-observed `createRequestId` matches.
    /// Includes `gc_expired` tombstones (auto-resume is a legal transition);
    /// excludes `closed`/`superseded` rows (retired rows are never used to
    /// answer a restore — reader rule, spec §4.2).
    pub fn lookup_by_create_request_id(
        &self,
        provider: &str,
        create_request_id: &str,
    ) -> Option<BindingRow> {
        self.list_bindings()
            .into_iter()
            .filter(|r| {
                r.provider == provider
                    && r.create_request_id.as_deref() == Some(create_request_id)
                    && (r.state == RowState::Bound
                        || r.retired_reason == Some(RetiredReason::GcExpired))
            })
            .max_by_key(|r| r.updated_at)
    }

    fn pending_path(root: &Path, terminal_id: &str) -> PathBuf {
        Self::pending_dir(root).join(format!("{}.json", encode_segment(terminal_id)))
    }

    /// Durable evidence that identity establishment is in flight for this
    /// terminal (spec §4.2): written at spawn of an identity-bearing pane
    /// whose identity is not yet known. File first, then index (write-through).
    ///
    /// `provenance` is the write's SPAWN-TIME provenance (delta-r3 Finding 2,
    /// see the [`PendingMarker`] doc): the connection-scoped WS create lane
    /// passes the connection's hello identity + the create's `tabId`; the
    /// headless REST lineage binder and the fresh-agent sink pass
    /// [`ProvenanceStamps::default()`] (nothing to attribute — exactly their
    /// binding-write policy). The stamps ride the marker so the conn-less
    /// resolution can still attribute the row it writes.
    ///
    /// Focused-ep4-r3 Finding 3 (the two times are SPLIT — superseding the
    /// ep4-r2 "one canonical flow" that folded them): `spawned_at` is always
    /// the marker's OWN write time (`now_ms`) so retention (the 30-day TTL,
    /// the 7-day orphan rule) never sees a pre-aged marker from a delayed
    /// gated create; the provenance value's `asserted_at` — the browser's
    /// assertion captured at message receipt — rides the marker's dedicated
    /// `asserted_at` field, and `resolve_pending`'s marker arm lands exactly
    /// that time on the row (with the `spawned_at` fallback for a marker an
    /// intermediate build persisted before the field existed). An unstamped
    /// (headless) marker records `asserted_at: 0`; its resolution derives
    /// `Clear` and never consumes a time.
    pub fn record_pending(
        &self,
        terminal_id: &str,
        mode: &str,
        cwd: Option<&str>,
        provenance: ProvenanceStamps<'_>,
        now_ms: i64,
    ) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        let marker = PendingMarker {
            ledger_version: LEDGER_VERSION,
            terminal_id: terminal_id.to_string(),
            mode: mode.to_string(),
            cwd: cwd.map(str::to_string),
            spawned_at: now_ms,
            asserted_at: provenance.asserted_at,
            client_instance_id: provenance.client_instance_id.map(str::to_string),
            device_id: provenance.device_id.map(str::to_string),
            tab_key: provenance.tab_key.map(str::to_string),
        };
        write_row_atomic(&Self::pending_path(root, terminal_id), &marker)?;
        index.pending.insert(terminal_id.to_string(), marker);
        Ok(())
    }

    /// Identity resolved: two independent atomic operations in a PINNED,
    /// load-bearing order — write the sessionRef-keyed binding row FIRST,
    /// then delete the pending marker (spec §4.2, G1/decision 5). A crash
    /// between the two leaves both, which is safe: the reader rule prefers
    /// the binding row and the boot sweep (Task 4) deletes the stale marker.
    /// Idempotent: a second racing resolution finds the marker gone or the
    /// row already bound and no-ops.
    ///
    /// `Err` means the BINDING write failed — the real durability alarm. A
    /// marker-delete failure after a successful binding write is NOT an
    /// error: the durable identity was recorded and the stale marker is
    /// exactly the crash-window shape the boot sweep repairs, so it is
    /// logged at WARN and the fn returns `Ok(())` (never a false
    /// `durability.degraded` alarm).
    pub fn resolve_pending(&self, w: &BindingWrite<'_>) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        // Delta-r3 Finding 2 + focused-ep3-r2 Finding 2 provenance precedence
        // on the marker→binding transition: the resolve's OWN meaningful
        // policy wins (`Replace` asserts, `Clear` erases the stamps and
        // floors the clock). A conn-less
        // `Inherit` resolve instead derives the ORIGIN lane's policy from the
        // consumed marker, exactly the way the origin's direct writes express
        // it:
        //   * a marker carrying ANY spawn-time stamp → `Replace(stamps)` —
        //     the conn-less SESSION-AFFILIATED source rule: the derived
        //     stamps ride the same two-tier attribution rule as any other
        //     `Replace` — with NO prior attribution a MEANINGFUL
        //     (client+device) marker ATTACHES (a legacy client creates such
        //     tab-less markers; focused-ep4-r5 Finding 1); over an existing
        //     attribution a FULL marker triple advances (subject to the
        //     focused-ep4-r3 Finding 1 monotonicity guard) and a weaker one
        //     leaves the row's attribution untouched;
        //   * an ALL-NONE marker → `Clear` — the HEADLESS origin record:
        //     the explicitly-headless REST/headless lineage binder stamps
        //     nothing by design (`pane_identity_binder.rs`, whose direct
        //     writes are `Clear`), so resolution must AGREE with that lane —
        //     stamps → `None` regardless of the marker and the existing row,
        //     and the attribution clock floors at `max(existing, resolve_now)`
        //     (focused-ep4-r5 Finding 2).
        //     Keeping them (`Replace(all-None)` ≡ `Inherit`) laundered a
        //     previously browser-stamped row under a refreshed `updated_at`
        //     when a dynamically-identified headless terminal resolved onto
        //     it: the delta-r2 laundering class via the marker path.
        //   * NO marker at all → plain `Inherit` — the mid-session rebind
        //     shape carries no origin record; the write asserts nothing.
        enum Derived {
            Keep,
            Stamps,
            Clear,
        }
        // Owned stamp clones are hoisted to the function scope so `effective`
        // can borrow them past the `index.pending` lookup's lifetime.
        let mut stamp_client: Option<String> = None;
        let mut stamp_device: Option<String> = None;
        let mut stamp_tab: Option<String> = None;
        let mut stamp_asserted_at: i64 = 0;
        let derived = match &w.provenance {
            ProvenancePolicy::Inherit => match index.pending.get(w.terminal_id) {
                Some(marker)
                    if marker.client_instance_id.is_some()
                        || marker.device_id.is_some()
                        || marker.tab_key.is_some() =>
                {
                    stamp_client.clone_from(&marker.client_instance_id);
                    stamp_device.clone_from(&marker.device_id);
                    stamp_tab.clone_from(&marker.tab_key);
                    // Focused-ep4-r3 Finding 3: the attribution time comes
                    // from the marker's OWN `asserted_at` field. The
                    // `spawned_at` fallback covers markers persisted by the
                    // intermediate (ep4-r2) build — there `spawned_at` WAS
                    // the assertion time, so the fallback reproduces that
                    // build's semantics exactly (an unstamped/headless marker
                    // never reaches this arm; `0` stamps would fail CLOSED
                    // via the empty-triple rule).
                    stamp_asserted_at = if marker.asserted_at > 0 {
                        marker.asserted_at
                    } else {
                        marker.spawned_at
                    };
                    Derived::Stamps
                }
                Some(_headless_origin) => Derived::Clear,
                None => Derived::Keep,
            },
            _ => Derived::Keep,
        };
        let effective;
        let w = match derived {
            Derived::Stamps => {
                // Focused-ep4 Finding: marker-sourced stamps attribute at the
                // browser's ASSERTION time — the browser asserted the pane
                // when it spawned it; this conn-less resolution merely lands
                // the stamps later (the pane may be long closed and omitted
                // from the parent's frozen evidence, and resolve-time
                // attribution would re-launder it into the D8 offer). Since
                // the focused-ep4-r3 Finding 3 split, that time is the
                // marker's `asserted_at` (fallback `spawned_at` for a marker
                // an intermediate build persisted; `spawned_at` itself is now
                // always the marker's write time — the retention clock).
                // Carrying it in the stamps' `asserted_at` slot is the same
                // flow every other connection-scoped provenance takes — and
                // the focused-ep4-r3 Finding 1 monotonicity guard applies to
                // it identically (a row a live connection re-asserted later
                // is never dragged back by an older marker's resolution).
                effective = BindingWrite {
                    provenance: ProvenancePolicy::Replace(ProvenanceStamps {
                        client_instance_id: stamp_client.as_deref(),
                        device_id: stamp_device.as_deref(),
                        tab_key: stamp_tab.as_deref(),
                        asserted_at: stamp_asserted_at,
                    }),
                    ..*w
                };
                &effective
            }
            Derived::Clear => {
                effective = BindingWrite {
                    provenance: ProvenancePolicy::Clear,
                    ..*w
                };
                &effective
            }
            Derived::Keep => w,
        };
        self.record_binding_locked(root, &mut index, w)?; // binding row FIRST
        if let Err(err) = Self::remove_pending(root, &mut index, w.terminal_id) {
            // THEN the marker — cleanup only. The identity IS durably
            // recorded; the leftover marker is swept at the next boot/GC
            // pass (same repair as a crash between the two operations).
            tracing::warn!(
                target: "freshell_ws::pane_ledger",
                terminal_id = %w.terminal_id,
                error = %err,
                "pane_ledger_marker_delete_failed_on_resolve: binding row durably \
                 written; stale marker left for the boot/GC sweep to repair"
            );
        }
        Ok(())
    }

    /// Best-effort marker removal (missing file == already resolved/GC'd).
    pub fn delete_pending(&self, terminal_id: &str) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        Self::remove_pending(root, &mut index, terminal_id)
    }

    fn remove_pending(
        root: &Path,
        index: &mut LedgerIndex,
        terminal_id: &str,
    ) -> std::io::Result<()> {
        let result = match std::fs::remove_file(Self::pending_path(root, terminal_id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
        if result.is_ok() {
            index.pending.remove(terminal_id);
        }
        result
    }

    /// Reader-rule lookup: `None` when no marker exists OR when a binding
    /// row already covers this terminal ("binding row wins; such a marker is
    /// stale"). Memory-only (V1.md read policy).
    pub fn pending_for_terminal(&self, terminal_id: &str) -> Option<PendingMarker> {
        self.root.as_ref()?;
        let index = self.guard();
        let marker = index.pending.get(terminal_id).cloned()?;
        let has_binding = index
            .bindings
            .values()
            .any(|r| r.live_terminal_id.as_deref() == Some(terminal_id));
        if has_binding {
            return None;
        }
        Some(marker)
    }

    /// Raw markers (no reader rule) — boot-sweep + test surface. Memory-only.
    pub fn list_pending_raw(&self) -> Vec<PendingMarker> {
        if self.root.is_none() {
            return Vec::new();
        }
        self.guard().pending.values().cloned().collect()
    }

    /// kata 1wxv: durable rollback-record write (payload OPAQUE — the
    /// `freshell_freshagent::rollback_record` schema). File FIRST, then the
    /// write-through index — in the same locked section, so readers never see
    /// index-ahead-of-disk (the `write_binding` discipline). Callers AWAIT
    /// this BEFORE mutating provider history (durable-BEFORE-mutation; a
    /// pre-write failure refuses the rollback and the provider is untouched).
    ///
    /// DELTA-R1 F4 (disabled-mode honesty): a DISABLED ledger must NOT answer
    /// `Ok(())` here — production enters disabled mode when home resolution
    /// fails or another server holds the store lock, and a false "durable"
    /// answer would let providers destructively mutate conversation history
    /// with NO surviving rollback markers. This is the ONE lane that refuses
    /// loudly (the provider handlers map `Err` to `INTERNAL_ERROR` +
    /// `LEDGER_WRITE_REFUSAL_COPY` with zero provider traffic; the
    /// binding/pending identity lanes keep their silent no-op policy).
    pub fn record_rollback_row(
        &self,
        provider: &str,
        session_id: &str,
        payload: &serde_json::Value,
        _now_ms: i64,
    ) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Err(std::io::Error::other(format!(
                "pane ledger DISABLED (no durable root) — refusing to record the rollback row \
                 for ({provider}, {session_id}): durable-BEFORE-mutation cannot be satisfied"
            )));
        };
        let mut index = self.guard();
        let dest = Self::rollback_path(root, provider, session_id);
        write_row_atomic(&dest, payload)?;
        index.rollback.insert(
            (provider.to_string(), session_id.to_string()),
            payload.clone(),
        );
        Ok(())
    }

    /// kata 1wxv: rollback-record read. Memory-only against the write-through
    /// index (V1.md read policy), loaded ONCE at construction.
    pub fn load_rollback_row(&self, provider: &str, session_id: &str) -> Option<serde_json::Value> {
        self.root.as_ref()?;
        self.guard()
            .rollback
            .get(&(provider.to_string(), session_id.to_string()))
            .cloned()
    }

    /// kata 1wxv Task 4: rollback-row delete — used ONLY by the claude fork
    /// adoption's re-key (the row MOVES old→new inside the same awaited batch
    /// as the binding write: copy under the new id, then drop the old so no
    /// stale row can describe the superseded conversation). A missing
    /// row/file is a silent no-op. File removal first, then the write-through
    /// index — in the same locked section as every other ledger mutation.
    pub fn delete_rollback_row(&self, provider: &str, session_id: &str) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        let dest = Self::rollback_path(root, provider, session_id);
        match std::fs::remove_file(&dest) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        index
            .rollback
            .remove(&(provider.to_string(), session_id.to_string()));
        Ok(())
    }

    /// Rows quarantined by this process's boot scan — the Phase-3 verdict
    /// surfacing (`ledger_quarantined` breadcrumb) reads this.
    pub fn quarantined_rows(&self) -> Vec<QuarantinedRow> {
        self.quarantined
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

/// The write-failure policy (spec §4.2): a ledger write failure NEVER blocks
/// the create/identity event, but it is never silent — structured ERROR +
/// invariant counter + a LIVE `durability.degraded` frame broadcast to all
/// connected clients (frozen clients ignore unknown frame types), at failure
/// time (a verdict-time flag would be posthumous).
pub(crate) fn surface_write_failure(
    state: &crate::WsState,
    terminal_id: &str,
    result: std::io::Result<()>,
) {
    let Err(err) = result else { return };
    crate::invariants::error_pane_ledger_write_failed(terminal_id, &err);
    let msg = freshell_protocol::ServerMessage::DurabilityDegraded(
        freshell_protocol::DurabilityDegraded {
            terminal_id: terminal_id.to_string(),
            reason: "ledger_write_failed".to_string(),
            message: "This pane's identity could not be durably recorded; it may not survive a server restart.".to_string(),
        },
    );
    if let Ok(frame) = serde_json::to_string(&msg) {
        let _ = state.broadcast_tx.send(frame);
    }
}

/// The shared post-locator/candidate resolution hook (write trigger b/c):
/// binding row FIRST, then the pending marker is deleted (`resolve_pending`'s
/// pinned order). `create_request_id` is deliberately None here — it is an
/// advisory field captured at create time; resolution never joins on it (D4).
/// Failures never block the identity event; they surface LIVE.
///
/// `async` + awaited spawn_blocking (V1.md / A1): every caller is an async
/// dispatch/sweep task, and the fsyncing write (~15ms p50) must complete
/// BEFORE the associated broadcast without pinning an async worker.
pub(crate) async fn ledger_resolve_identity(
    state: &crate::WsState,
    terminal_id: &str,
    provider: &str,
    session_id: &str,
    cwd: Option<&str>,
) {
    let ledger = std::sync::Arc::clone(&state.pane_ledger);
    let provider_owned = provider.to_string();
    let session_id_owned = session_id.to_string();
    let terminal_id_owned = terminal_id.to_string();
    let cwd_owned = cwd.map(str::to_string);
    let now = crate::terminal::now_ms();
    let result = tokio::task::spawn_blocking(move || {
        ledger.resolve_pending(&BindingWrite {
            provider: &provider_owned,
            session_id: &session_id_owned,
            terminal_id: &terminal_id_owned,
            mode: &provider_owned,
            cwd: cwd_owned.as_deref(),
            create_request_id: None,
            // Conn-less lane (D8): no provenance in scope and none asserted;
            // `Inherit` keeps any prior row's stamps — and (delta-r3 Finding
            // 2) `resolve_pending` additionally sources the consumed marker's
            // spawn-time stamps, so a dynamically-identified pane whose marker
            // the connection-scoped create stamped is STILL attributable here
            // (no existing row would otherwise exist to inherit from — a
            // tab-less legacy marker now ATTACHES its client+device under the
            // focused-ep4-r5 Finding 1 rule), while
            // (focused-ep3-r2 Finding 2) an unstamped — headless — marker
            // derives `Clear`, so the same resolution can never launder a
            //     stale browser attribution. Focused-ep4-r2 Findings 1+2 (as
            // split by focused-ep4-r3 Finding 3): the assertion TIME rides the
            // stamps — `resolve_pending`'s marker arm carries the consumed
            // marker's OWN `asserted_at` field (the `spawned_at` fallback
            // covering intermediate-build markers) as the derived stamps'
            // `asserted_at` when (and only when) the stamps come FROM the
            // marker (focused-ep4 Finding).
            provenance: ProvenancePolicy::Inherit,
            now_ms: now,
        })
    })
    .await
    .unwrap_or_else(|join_err| Err(std::io::Error::other(join_err)));
    surface_write_failure(state, terminal_id, result);
}

/// The inverse of [`encode_segment`], used by the construction-time scan to
/// rebuild an opaque row's (provider, sessionId) key from its path. Returns
/// `None` on a malformed escape or non-UTF-8 bytes (such a path is skipped;
/// per-row corruption handling lives in the boot scan).
fn decode_segment(encoded: &str) -> Option<String> {
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = encoded.get(i + 1..i + 3)?;
            let byte = u8::from_str_radix(hex, 16).ok()?;
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Path-segment encoding: `[A-Za-z0-9._-]` pass through, everything else
/// (including `%`) becomes `%XX` uppercase hex. Injective and containment-
/// safe (no `/`, and the `.`/`..` specials are fully escaped).
pub(crate) fn encode_segment(raw: &str) -> String {
    if raw.is_empty() {
        return "%00".to_string();
    }
    if raw == "." {
        return "%2E".to_string();
    }
    if raw == ".." {
        return "%2E%2E".to_string();
    }
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'_' | b'-' => out.push(b as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[derive(Debug)]
pub(crate) enum RowLoadError {
    Missing,
    Io(std::io::Error),
    Parse(String),
}

impl std::fmt::Display for RowLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RowLoadError::Missing => write!(f, "missing"),
            RowLoadError::Io(e) => write!(f, "io: {e}"),
            RowLoadError::Parse(e) => write!(f, "parse: {e}"),
        }
    }
}

pub(crate) fn load_row<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, RowLoadError> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(RowLoadError::Missing),
        Err(e) => return Err(RowLoadError::Io(e)),
    };
    serde_json::from_slice(&bytes).map_err(|e| RowLoadError::Parse(e.to_string()))
}

/// One row, atomically: sibling temp (PID+millis unique, the `instance_id.rs`
/// idiom) + `atomic_write_durable` (write, fsync, rename, fsync parent).
pub(crate) fn write_row_atomic<T: Serialize>(dest: &Path, row: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(row)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let file_name = dest.file_name().and_then(|n| n.to_str()).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "row has no file name")
    })?;
    let parent = dest.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "row has no parent")
    })?;
    std::fs::create_dir_all(parent)?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = parent.join(format!("{file_name}.tmp-{}-{millis}", std::process::id()));
    crate::tabs_persist::atomic_write_durable(dest, &tmp, &bytes)
}

#[cfg(test)]
#[path = "pane_ledger_tests.rs"]
mod tests;
