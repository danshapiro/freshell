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
//!   a durable close fence for a `(provider, sessionId)` identity, consulted
//!   by [`PaneLedger::record_fresh_agent_binding`] (a fresh one suppresses
//!   the late in-flight write that would otherwise resurrect a Bound row the
//!   kill just retired; an expired one is swept). Since delta-r6-r4
//!   (focused-episode-6 round 3, Finding 3) close fences are DERIVED from the
//!   close-envelope journal records below (never written as per-identity
//!   files by a close); the `kill-tombstones/` subtree is the LEGACY shape —
//!   loaded, cleared, and swept exactly as before, but no longer written.
//!   Layout: `kill-tombstones/<enc(provider)>/<enc(sessionId)>.json`.
//! * **Alias tombstones** (focused-ep5-r5 Finding 2, retire-on-kill round 6) —
//!   the durable placeholder→durable records the claude lane's kills consult:
//!   a claude pane closes by its ORIGINAL bare placeholder while its ledger
//!   row is keyed on the durable cli UUID, and a process restart killed the
//!   only place the mapping used to live (the provider's in-memory store), so
//!   a post-restart close by placeholder could fence and retire only the
//!   meaningless placeholder. Records are written when an alias is minted
//!   (adoption / resume registration) and re-stamped when it demotes, read
//!   by the kill's retire-set consult, consumed by a claim commit
//!   (`clear_alias_tombstones_for_durable`), and swept by the boot/periodic
//!   GC under the SAME lifetime discipline the round-5 in-memory store uses:
//!   a record outlives the TTL for as long as the row it can resolve to is
//!   Bound. Layout: `alias-tombstones/<enc(provider)>/<enc(placeholder)>.json`.
//! * **Close-envelope journal records** (delta-r6-r4, focused-episode-6
//!   round 3, Finding 3 — THE durability model of every explicit close). One
//!   close = ONE record = ONE atomic file write
//!   (`close-envelopes/<enc(key)>.json`; `pane:<terminalId>` keys the
//!   terminal lane's record, `<provider>:<addressedSessionId>` the
//!   fresh-agent lanes'). The record carries everything the close knows: the
//!   pane linkage (`terminalId`/`createRequestId`) when the close keyed on a
//!   pane, and the FULL identity set's close fences (`kills`). Its write
//!   either lands wholly or not at all (temp+rename), so a failed close can
//!   NEVER leave durable Closed residue over a session the killer then keeps
//!   live — the pre-journal model's split tombstone+row writes could
//!   ([`CloseEnvelopeError`] makes the landed-despite-error case a
//!   persisted-close the caller honors by ending the session, never a
//!   falsely-clean failure). Rollback of a failed envelope is deleting ONE
//!   file (never N best-effort row restores); the row flips to
//!   Retired(Closed) are projections the record dominates until the sweep
//!   converges them, not the close itself. The close fences the record
//!   carries feed the in-memory `kill_tombstones` index at persist and load
//!   time, so every pre-existing consult (the binder's suppress arm, the
//!   dominance sweep, the claim commit's conditional, the recovery
//!   inventory's verdict join) reads them unchanged. `resolve_pending`
//!   consults the record (a closed pane's late resolution lands its row
//!   Retired(Closed), never Bound) and folds the identity into it. The
//!   legacy `close-records/` tree (delta-r6-r2's pane-keyed records) loads
//!   into the same index — the verdict join reads both identically. Layout:
//!   `close-envelopes/<enc(key)>.json` (written) + `close-records/<enc(terminalId)>.json`
//!   (legacy: loaded and swept, never written).
//!
//!   Retire-on-kill round 3 (focused-ep5-r2): the close fence is THE AUTHOR
//!   OF TRUTH for the identity's closedness — a fresh fence DOMINATES a
//!   still-Bound row by ONE rule enforced twice: the boot/periodic sweep
//!   re-applies the retirement durably ([`PaneLedger::gc`]'s per-row pass;
//!   `BootScanReport::kill_tombstone_enforced_retires`), and the recovery
//!   inventory reads a dominated row as Retired at offer-build time (via
//!   [`PaneLedger::dominant_kill_tombstone_keys`]). The claim lifecycle's row
//!   side lives inside [`PaneLedger::commit_claim`]: a successful
//!   resume/attach returns a kill-closed row to Bound and clears the fence
//!   as ONE conditional transition (Closed-only; never creates a row).
//!
//! Deliberately NOT stored: scrollback (own store, P2.19), transcripts
//! (provider-owned), layout (client-owned). NOT keyed on `createRequestId`
//! (D4/V9.md: every restore path that re-creates an anchored pane re-mints
//! it first; only the orphaned in-flight-create replay preserves it) — on
//! BINDING rows it is stored only as an advisory field, never an identity
//! join key. The one sanctioned use beyond that advisory slot is the pane
//! close record's lineage field (delta-r6-r2): the record records WHAT
//! CLOSED (a pane), and the verdict join matches it against the snapshot
//! payload's own `createRequestId` to verdict THAT pane closed — it never
//! re-keys nor joins an identity row by it.
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

/// Focused-ep5-r5 Finding 2 (retire-on-kill round 6): the protective TTL for
/// a DURABLE alias record whose target row is already Retired-or-GC'd — the
/// exact mirror of the claude lane's in-memory `ALIAS_TOMBSTONE_TTL_MS`
/// (crates/freshell-freshagent/src/claude.rs; the crate edge runs the other
/// way, so the constant is duplicated, documented as one rule). A record
/// whose durable row is still BOUND never ages out (the alias lifetime is
/// the row lifetime — the r5 rule the in-memory store enforces via its
/// row-state probe; this sweep reads the ledger's own rows).
pub const ALIAS_TOMBSTONE_TTL_MS: i64 = 6 * 60 * 60 * 1000;

/// A kill tombstone (focused-ep5-r1 Finding 2, restore-open-sessions-only):
/// the durable fence that an explicit close happened for this `(provider,
/// session_id)` identity. [`PaneLedger::record_fresh_agent_binding`] consults
/// it under the SAME index guard as the write it gates, so a binding write
/// that was already in flight when the kill landed (an aborted consumer's
/// orphaned `spawn_blocking` closure — task abort can never cancel it) is
/// suppressed by CONSULTING STATE, never by task-abort ordering: whichever
/// way the lock serializes, a fresh tombstone seen by the write means the
/// identity stays dead. TTL'd (see [`KILL_TOMBSTONE_TTL_MS`]); cleared by
/// [`PaneLedger::clear_kill_tombstone`] when a NEW pane/session genuinely
/// claims the identity (an explicit resume/attach).
///
/// LEGACY SHAPE (delta-r6-r4, focused-episode-6 round 3, Finding 3): the
/// per-identity `kill-tombstones/<enc(provider)>/<enc(sessionId)>.json` file
/// is the PRE-journal durability model — closes since round 3 journal their
/// identities into ONE [`CloseEnvelopeRecord`] instead (the record's `kills`
/// feed the SAME in-memory fence index consults read). Files under this
/// subtree are loaded, cleared, and swept as before, but never written.
///
/// Deliberately separate evidence from binding rows (NOT a row state): the
/// fence must cover identities whose row does NOT EXIST YET (the kill beat
/// the in-flight adoption write), which a row-state marker can never
/// express. The terminal-lineage binder (`record_binding` /
/// `resolve_pending`) deliberately does not consult it (a terminal kill's
/// own resume lanes must rebind freely). Round 3 (focused-ep5-r2) widened
/// the READER set under one rule — a fresh tombstone means the identity is
/// Closed — to the row sweep's dominance repair (`gc_row_locked`) and the
/// recovery inventory's offer-time read
/// ([`PaneLedger::dominant_kill_tombstone_keys`]); see the audit table in
/// usual-sdd/retire-on-kill-r3-fix-report.md.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillTombstone {
    pub ledger_version: u32,
    pub provider: String,
    pub session_id: String,
    /// When the explicit close happened (the close's `now_ms`). The TTL
    /// clock (freshness compare in [`PaneLedger::record_fresh_agent_binding`]
    /// and the GC sweep) keys on this; a backward wall-clock step counts
    /// tombstones as FRESH (the fail-closed direction — subtraction-based
    /// compare, never expiry-sum overflow).
    pub killed_at_ms: i64,
}

/// A durable placeholder→durable alias record (focused-ep5-r5 Finding 2,
/// retire-on-kill round 6), keyed `(provider, placeholder)` — see the module
/// doc. One file carries EVERY durable id the placeholder ever answered to
/// (a same-key re-registration answered to several): the claude lane's kill
/// consult answers all of them for its retire set.
///
/// Retention obeys the round-5 discipline verbatim: a record lives as long
/// as the row it can resolve to — the boot/periodic sweep
/// ([`PaneLedger::gc`]/`boot_scan`) may drop a record only once that row is
/// Retired-or-GC'd AND the record is past [`ALIAS_TOMBSTONE_TTL_MS`]; a
/// still-Bound row's record survives any age. Consumed wholesale (any age)
/// when a genuine claim commits for the durable id
/// ([`PaneLedger::clear_alias_tombstones_for_durable`]) — the reopened
/// identity's known placeholders reopen with it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasTombstoneRecord {
    pub ledger_version: u32,
    pub provider: String,
    pub placeholder: String,
    pub records: Vec<AliasTombstoneEntry>,
}

/// One `(durable, at_ms)` pair inside an [`AliasTombstoneRecord`]: the
/// durable claude UUID the placeholder aliased and the record's stamp (the
/// TTL clock — mint/demotion time, refreshed on a repeat).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasTombstoneEntry {
    pub durable: String,
    pub at_ms: i64,
}

/// One retired (or fenced, post-resolution) session identity inside a
/// [`PaneCloseRecord`]: `(provider, sessionId)` and the close stamp.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneCloseKill {
    pub provider: String,
    pub session_id: String,
    pub at_ms: i64,
}

/// Delta-r6-r4 (focused-episode-6 round 3, Finding 3) — the close envelope's
/// ONE journal record: `close-envelopes/<enc(key)>.json`, THE durable act of
/// every explicit close. ONE file (atomic temp+rename), so the envelope's
/// write either lands wholly or not at all — a failed close can never leave
/// durable Closed residue over a session the killer keeps live (the round-3
/// finding), and rollback of the failed write is deleting the single file,
/// never N best-effort row restores.
///
/// Keys: `pane:<terminalId>` for the terminal lane (`close_pane` — the close
/// keyed by the PANE, with its `terminalId`/`createRequestId` linkage the
/// recovery verdict join's pane-cover arm consumes) and
/// `<provider>:<addressedSessionId>` for the fresh-agent lanes
/// (`close_identities` — the kill's wire id, the identity the close knew
/// first; a later kill naming a different alias journals a second record and
/// the fences merge in the index). The mixed flat subtree cannot collide:
/// every key carries a `:` (encoded), terminal ids are 32-hex.
///
/// What it carries:
/// * `terminal_id` / `create_request_id` — the pane linkage when the close
///   knew it (the terminal lane; absent on fresh-agent records).
/// * `kills` — EVERY session identity this close fenced/retired, with the
///   close stamp. These ARE the close fences: they feed the in-memory
///   `kill_tombstones` index at persist and load time (max stamp wins across
///   records), so the binder's suppress arm, the dominance sweep, the claim
///   commit's conditional, and the recovery verdict join all consume them
///   identically to the legacy per-identity tombstone files.
/// * `closed_at` — the first close's stamp for this key; the retention
///   clock is the newest of it and every `kills.at_ms`.
///
/// The row flip to Retired(Closed) is a PROJECTION the ledger attempts
/// after the record stands (hygiene — never the close): a failed projection
/// leaves a still-Bound row DOMINATED by the record-fed fence (reads closed
/// at every boundary) until the sweep converges it durably.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseEnvelopeRecord {
    pub ledger_version: u32,
    /// The pane linkage when the close knew it (the terminal lane). `None`
    /// on fresh-agent envelope records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_request_id: Option<String>,
    /// The first close's stamp for this key. The sweep's retention clock is
    /// the newest of this and every `kills.at_ms`.
    pub closed_at: i64,
    /// Every session identity this key's closes fenced/retired. Same-key
    /// repeats refresh the stamp.
    #[serde(default)]
    pub kills: Vec<PaneCloseKill>,
}

/// Delta-r6-r2 (focused-episode-6 round 1, Findings 1+2) — the PANE-keyed
/// durable close record: `close-records/<enc(terminalId)>.json`. Every
/// explicit terminal close issues one under the identity the close KNOWS —
/// the pane itself (its `terminalId`, plus the pane's `createRequestId`
/// lineage when the registry carries it) — even when NO binding row exists
/// yet (a kill landing inside the identity-resolution window). Three
/// consumers:
///
/// * **`resolve_pending`'s consult (Finding 2)**: a resolution landing for a
///   closed pane lands its row Retired(Closed), never Bound — the kill
///   retires by pane identity under the ledger's own serialization, so the
///   two order interleavings (resolve-then-close, close-then-resolve) are
///   decided under the ONE index guard: whichever ran second repairs what
///   the first missed.
/// * **The recovery inventory's verdict join (Finding 1)**: a snapshot pane
///   whose `createRequestId` (or `liveTerminal.terminalId`) is covered by a
///   standing record is verdict-`closed` and excluded, never restored — the
///   pre-fix shape restored it because a pre-resolution close left neither a
///   retired row (nothing to correlate to) nor a fenced identity.
/// * **The kill fences list (`kills`)**: every session identity the close
///   retired or fenced for this pane — audit + the resolve-time fold (the
///   record LEARNS the identity the close could not name at kill time).
///
/// Retention: swept by the boot/periodic GC once its newest stamp
/// (`closed_at`, all `kills.at_ms`) ages past [`KILL_TOMBSTONE_TTL_MS`] — the
/// same protective horizon as the kill fences it stands beside; the recovery
/// evidence window (≈ push cadence + staleness) is orders of magnitude
/// shorter. Key-collision honesty: `terminalId`s are 32-hex server mints,
/// never re-minted (see the module doc) — a record can never shadow a later
/// pane reusing an id.
///
/// LEGACY/READ-MODEL (delta-r6-r4): records under `close-records/` are the
/// pre-journal shape — loaded into the same index the close-envelope records
/// live in (and swept by the same retention rule), but never written. The
/// struct survives as (a) that legacy schema and (b) the recovery verdict
/// join's pane-keyed read model (`list_pane_closes` /
/// `pane_close_for_terminal` derive it from the envelope records).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneCloseRecord {
    pub ledger_version: u32,
    pub terminal_id: String,
    /// The pane's creation key when the close knew it (the registry's
    /// stamped createRequestId) — the snapshot payload carries the same key,
    /// which is what lets the recovery verdict join reach this record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_request_id: Option<String>,
    /// The first close's stamp. The sweep's retention clock is the newest of
    /// this and every `kills.at_ms`.
    pub closed_at: i64,
    /// Every session identity this pane's closes retired (or fenced on a
    /// late resolution). Same-key repeats refresh the stamp.
    #[serde(default)]
    pub kills: Vec<PaneCloseKill>,
}

/// Delta-r6-r4 (focused-episode-6 round 3, Finding 3) — the close envelope's
/// failure classes. The envelope's durable act is ONE journal record (one
/// atomic file write), so a failing close has exactly two honest outcomes:
#[derive(Debug)]
pub enum CloseEnvelopeError {
    /// NOTHING this close wrote is durable: the journal record does not
    /// exist (the write never landed, or the rollback delete of the
    /// landed-then-reported-failed record completed). The kill lane leaves
    /// ALL live state untouched and answers failure — the session stays
    /// live and self-consistent, and a retried close re-attempts
    /// idempotently.
    Clean(std::io::Error),
    /// The journal record IS durable although its write reported failure
    /// (the rename-committed / post-rename-fsync / EINTR class whose rollback
    /// delete then failed — the finding's continuing-failure shape), OR a
    /// pre-existing record at the key already covers the close. The kill
    /// lane's contract: the close is durable, so the lane ENDS the session
    /// (live state stays consistent with the durable close — a live session
    /// beside close evidence is exactly what the finding outlawed) while
    /// STILL answering `success:false` — the kill visibly failed; it did
    /// not masquerade as either clean success or clean failure.
    Persisted(std::io::Error),
}

impl CloseEnvelopeError {
    /// The caller-side contract check: `true` means the close evidence is
    /// durable (the session must end; the failure is still reported
    /// visibly).
    pub fn is_persisted(&self) -> bool {
        matches!(self, CloseEnvelopeError::Persisted(_))
    }

    /// The underlying io error, either arm.
    pub fn source_io(&self) -> &std::io::Error {
        match self {
            CloseEnvelopeError::Clean(e) | CloseEnvelopeError::Persisted(e) => e,
        }
    }
}

impl std::fmt::Display for CloseEnvelopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CloseEnvelopeError::Clean(e) => {
                write!(f, "the close envelope failed and nothing of it is durable: {e}")
            }
            CloseEnvelopeError::Persisted(e) => write!(
                f,
                "the close envelope reported failure but its journal record is durable \
                 (persisted-close; the kill must end the session consistently): {e}"
            ),
        }
    }
}

impl std::error::Error for CloseEnvelopeError {}

/// The pane-identifying inputs of [`PaneLedger::close_pane`]: everything the
/// terminal kill knows at close time, captured OUTSIDE the ledger guard and
/// closed under it.
#[derive(Debug)]
pub struct PaneCloseWrite {
    /// The killed pane's terminal id — the record's key and the row
    /// discovery key (`live_terminal_id`).
    pub terminal_id: String,
    /// The pane's createRequestId from the terminal registry when stamped.
    pub create_request_id: Option<String>,
    /// The in-memory-resolved session identity, when the identity registry
    /// had one (the pre-resolution kill's shape has none).
    pub resolved: Vec<SessionLocator>,
    pub now_ms: i64,
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

/// Delta-r6-r4 (focused-episode-6 round 3, Finding 3): feed ONE close-envelope
/// journal record into the write-through index — the SAME discipline at
/// persist time and at load. The record's `kills` ARE the close fences: each
/// folds into the `kill_tombstones` index, max stamp winning across records
/// and legacy files (a re-kill re-stamps forward).
fn feed_close_envelope(
    index: &mut LedgerIndex,
    key: String,
    record: CloseEnvelopeRecord,
) {
    for kill in &record.kills {
        index
            .kill_tombstones
            .entry((kill.provider.clone(), kill.session_id.clone()))
            .and_modify(|stamp| *stamp = (*stamp).max(kill.at_ms))
            .or_insert(kill.at_ms);
    }
    index.close_envelopes.insert(key, record);
}

/// Does any STANDING close-envelope record fence this identity? The fence
/// sweep's retention gate: a record-covered fence lives and dies with its
/// record (the record's own retention rule is the reference-time rule), so
/// the fence sweep never outruns it.
fn any_envelope_fences(index: &LedgerIndex, provider: &str, session_id: &str) -> bool {
    index.close_envelopes.values().any(|record| {
        record
            .kills
            .iter()
            .any(|k| k.provider == provider && k.session_id == session_id)
    })
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

/// Delta-r6-r2 Finding 2 test hook: the armed resolve gate's state. The gate
/// fires INSIDE `resolve_pending`'s guarded section, BEFORE the close-record
/// consult: the test then runs the kill's `close_pane` (which queues on the
/// same guard) and releases the resolver in between — the resolver's consult
/// sees no close (the close has not run), writes the row Bound, and the
/// queued close retires it — the finding's "resolver suspended mid-write"
/// made deterministic.
#[cfg(test)]
struct ResolveGate {
    entered_tx: std::sync::mpsc::Sender<()>,
    release_rx: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

/// The handles [`PaneLedger::arm_resolve_pending_gate`] hands the test.
#[cfg(test)]
pub(crate) struct ResolveGateHandles {
    pub entered: std::sync::mpsc::Receiver<()>,
    pub release: tokio::sync::oneshot::Sender<()>,
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
    /// the write-through image of the durable close fences: the LEGACY
    /// `kill-tombstones/` files PLUS, since delta-r6-r4, every close-envelope
    /// journal record's `kills` (both feed at persist and load; the max
    /// stamp wins). Consulted by [`PaneLedger::record_fresh_agent_binding`]
    /// (the suppress arm), the dominance sweep, the claim commit's
    /// conditional, and the recovery inventory's verdict joins — never a
    /// liveness signal.
    kill_tombstones: std::collections::HashMap<(String, String), i64>,
    /// The fence keys backed by a LEGACY `kill-tombstones/` file (the
    /// pre-journal shape). Tracked so the record sweep's un-feed only ever
    /// drops fences no other durable source carries, and the fence sweep's
    /// file delete targets real files.
    legacy_tombstone_keys: std::collections::HashSet<(String, String)>,
    /// (provider, placeholder) -> [(durable, at_ms)] (focused-ep5-r5 Finding
    /// 2), the write-through image of the `alias-tombstones/` subtree.
    /// Consulted by the claude lane's kill retire-set resolution (a close
    /// names the bare placeholder; the row lives under the durable) and by
    /// the claim commit's consumption — never a liveness answer (a
    /// tombstoned placeholder's session is DEAD; this map answers ids for
    /// retire writes only).
    alias_tombstones: std::collections::HashMap<(String, String), Vec<(String, i64)>>,
    /// Record key -> journal record (delta-r6-r4, focused-episode-6 round
    /// 3), the write-through image of BOTH close-record subtrees: the
    /// `close-envelopes/` journal records (`pane:<terminalId>` keys, or
    /// `<provider>:<addressedSessionId>` for the fresh-agent lanes) and the
    /// legacy `close-records/` pane records (folded in under their `pane:`
    /// key). Consulted by `resolve_pending` (a closed pane's resolution
    /// lands Retired, never Bound), read wholesale by the recovery
    /// inventory's verdict join (and the record-fence retention gate), and
    /// swept by the close-record retention rule. Never a liveness answer: a
    /// standing record says THIS PANE / these identities were closed.
    close_envelopes: std::collections::HashMap<String, CloseEnvelopeRecord>,
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
    /// Test-only staged-failure knob: the next N `write_binding` calls fail
    /// (read-only-dir staging cannot express "first attempt fails, retry
    /// succeeds" without it). Zero in every non-test path.
    #[cfg(test)]
    binding_write_failures: std::sync::atomic::AtomicUsize,
    /// Test-only staged-failure knobs (delta-r6-r4 Finding 3): the next N
    /// close-envelope record writes fail before landing / land-then-report /
    /// and the next N rollback deletes fail. See
    /// [`PaneLedger::fail_next_close_envelope_writes`]. Zero in production.
    #[cfg(test)]
    close_envelope_write_failures: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    close_envelope_land_failures: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    close_envelope_delete_failures: std::sync::atomic::AtomicUsize,
    /// Test-only suspension gate for the kill-vs-resolver interleave pin
    /// (delta-r6-r2 Finding 2): when armed, `resolve_pending` signals it has
    /// entered its guarded section and then BLOCKS on the test's release
    /// before its close-record consult runs — the kill's close queues behind
    /// the held guard while the resolver is provably mid-write.
    #[cfg(test)]
    resolve_gate: Mutex<Option<ResolveGate>>,
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
            #[cfg(test)]
            binding_write_failures: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            close_envelope_write_failures: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            close_envelope_land_failures: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            close_envelope_delete_failures: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            resolve_gate: Mutex::new(None),
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

    /// Alias tombstones (focused-ep5-r5 Finding 2) — see
    /// [`AliasTombstoneRecord`].
    /// `alias-tombstones/<enc(provider)>/<enc(placeholder)>.json`.
    fn alias_tombstone_dir(root: &Path) -> PathBuf {
        root.join("alias-tombstones")
    }

    fn alias_tombstone_path(root: &Path, provider: &str, placeholder: &str) -> PathBuf {
        Self::alias_tombstone_dir(root)
            .join(encode_segment(provider))
            .join(format!("{}.json", encode_segment(placeholder)))
    }

    /// Legacy pane close records (delta-r6-r2) — see [`PaneCloseRecord`].
    /// Loaded and swept, never written since delta-r6-r4 (closes journal into
    /// `close-envelopes/`). `close-records/<enc(terminalId)>.json`.
    fn pane_close_dir(root: &Path) -> PathBuf {
        root.join("close-records")
    }

    fn pane_close_path(root: &Path, terminal_id: &str) -> PathBuf {
        Self::pane_close_dir(root).join(format!("{}.json", encode_segment(terminal_id)))
    }

    /// Delta-r6-r4 (focused-episode-6 round 3, Finding 3): the close-envelope
    /// journal subtree — THE durable act of every explicit close.
    /// `close-envelopes/<enc(key)>.json`.
    fn close_envelope_dir(root: &Path) -> PathBuf {
        root.join("close-envelopes")
    }

    fn close_envelope_path(root: &Path, key: &str) -> PathBuf {
        Self::close_envelope_dir(root).join(format!("{}.json", encode_segment(key)))
    }

    /// The envelope record's key. `pane:<terminalId>` for the terminal lane
    /// (`close_pane`), `<provider>:<addressedSessionId>` for the fresh-agent
    /// lanes (`close_identities` — the kill's wire id; a later kill naming a
    /// different alias journals a second record and the fences merge). The
    /// `:` never collides with the 32-hex terminal ids, and legacy
    /// `close-records/` files fold in under their `pane:` key.
    fn pane_envelope_key(terminal_id: &str) -> String {
        format!("pane:{terminal_id}")
    }

    /// The fresh-agent lane's envelope key (see [`Self::pane_envelope_key`]).
    fn agent_envelope_key(provider: &str, addressed_session_id: &str) -> String {
        format!("{provider}:{addressed_session_id}")
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
        // parses; aging is the sweep's job, never the loader's). LEGACY
        // (delta-r6-r4): closes no longer write here — the load keeps the
        // pre-journal files' fences alive; `legacy_tombstone_keys` tracks
        // their provenance so the record sweep's un-feed never drops what a
        // real file still carries.
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
                            let key = (
                                tombstone.provider.clone(),
                                tombstone.session_id.clone(),
                            );
                            index.legacy_tombstone_keys.insert(key.clone());
                            index
                                .kill_tombstones
                                .entry(key)
                                .and_modify(|stamp| *stamp = (*stamp).max(tombstone.killed_at_ms))
                                .or_insert(tombstone.killed_at_ms);
                        }
                    }
                }
            }
        }
        // Alias-tombstone subtree (focused-ep5-r5 Finding 2): the same
        // discipline — every clean current-version record loads (expiry is
        // the sweep's call, never the loader's: a still-Bound row's record
        // answers at any age).
        if let Ok(providers) = std::fs::read_dir(Self::alias_tombstone_dir(root)) {
            for provider in providers.flatten() {
                let Ok(files) = std::fs::read_dir(provider.path()) else {
                    continue;
                };
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue; // *.tmp-* / *.quarantined-* residue
                    }
                    if let Ok(record) = load_row::<AliasTombstoneRecord>(&path) {
                        if record.ledger_version == LEDGER_VERSION {
                            index.alias_tombstones.insert(
                                (record.provider.clone(), record.placeholder.clone()),
                                record
                                    .records
                                    .iter()
                                    .map(|e| (e.durable.clone(), e.at_ms))
                                    .collect(),
                            );
                        }
                    }
                }
            }
        }
        // Legacy close-record subtree (delta-r6-r2): the pre-journal
        // pane-keyed records — folded into the SAME envelope index under
        // their `pane:<terminalId>` key, their `kills` feeding the fence
        // index exactly like a journal record's. Retention is the sweep's
        // call, never the loader's.
        if let Ok(files) = std::fs::read_dir(Self::pane_close_dir(root)) {
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue; // *.tmp-* / *.quarantined-* residue
                }
                if let Ok(record) = load_row::<PaneCloseRecord>(&path) {
                    if record.ledger_version == LEDGER_VERSION {
                        let envelope = CloseEnvelopeRecord {
                            ledger_version: record.ledger_version,
                            terminal_id: Some(record.terminal_id.clone()),
                            create_request_id: record.create_request_id.clone(),
                            closed_at: record.closed_at,
                            kills: record.kills.clone(),
                        };
                        feed_close_envelope(
                            &mut index,
                            Self::pane_envelope_key(&record.terminal_id),
                            envelope,
                        );
                    }
                }
            }
        }
        // The close-envelope journal subtree (delta-r6-r4): every clean
        // current-version record loads; the map key comes from the FILENAME
        // (encoded `pane:<terminalId>` / `<provider>:<addressedSessionId>`).
        if let Ok(files) = std::fs::read_dir(Self::close_envelope_dir(root)) {
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue; // *.tmp-* / *.quarantined-* residue
                }
                let Some(key) = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(decode_segment)
                else {
                    continue;
                };
                if let Ok(record) = load_row::<CloseEnvelopeRecord>(&path) {
                    if record.ledger_version == LEDGER_VERSION {
                        feed_close_envelope(&mut index, key, record);
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
                    if let Err(err) =
                        Self::clear_kill_fence_locked(root, &mut index, w.provider, w.session_id)
                    {
                        // Fail loud, never silent: the sweep prunes at the
                        // next GC pass regardless (a ClaimResidue fence left
                        // behind is inert either way — the row outranks it;
                        // a record-fed fence simply re-derives at the next
                        // load and dies with its record).
                        tracing::warn!(
                            target: "freshell_ws::pane_ledger",
                            provider = %w.provider,
                            session_id = %w.session_id,
                            error = %err,
                            "pane_ledger_stale_tombstone_sweep_failed: fence left behind; GC retries"
                        );
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
        #[cfg(test)]
        {
            let left = self
                .binding_write_failures
                .load(std::sync::atomic::Ordering::SeqCst);
            if left > 0 {
                self.binding_write_failures
                    .store(left - 1, std::sync::atomic::Ordering::SeqCst);
                return Err(std::io::Error::other(format!(
                    "injected binding write failure ({left} armed)"
                )));
            }
        }
        let dest = Self::binding_path(root, &row.provider, &row.session_id);
        write_row_atomic(&dest, row)?;
        index
            .bindings
            .insert((row.provider.clone(), row.session_id.clone()), row.clone());
        Ok(())
    }

    /// Test-only knob (delta-r6-r2 Finding 6): the next `n` binding-row writes
    /// fail — the compensated close's bounded retry needs a deterministic
    /// first-write failure that filesystem permissions cannot express.
    #[cfg(test)]
    pub(crate) fn fail_next_binding_writes(&self, n: usize) {
        self.binding_write_failures
            .store(n, std::sync::atomic::Ordering::SeqCst);
    }

    /// Test-only knob (delta-r6-r2 Finding 2): see [`ResolveGate`]. One-shot
    /// — the next `resolve_pending` on this ledger suspends inside its
    /// guarded section until released.
    #[cfg(test)]
    pub(crate) fn arm_resolve_pending_gate(&self) -> ResolveGateHandles {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        *self
            .resolve_gate
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(ResolveGate {
            entered_tx,
            release_rx: Mutex::new(Some(release_rx)),
        });
        ResolveGateHandles {
            entered: entered_rx,
            release: release_tx,
        }
    }

    /// Delta-r6-r4 (focused-episode-6 round 3): drop ONE identity's close
    /// fence — the claim-lifecycle clear, the binder's lazy sweep, and the
    /// fence sweep's prune all share it. The fence's durable sources: the
    /// LEGACY per-identity file (deleted when present) and any standing
    /// close-envelope journal records (append-only — never edited here; a
    /// fence that re-derives from its record at the next load lands beside
    /// the committed claim's newer row stamps and classifies inert
    /// [`KillTombstoneVerdict::ClaimResidue`], or sweeps with the record).
    /// The index drops only when the file delete succeeded-or-was-absent —
    /// the file-first-then-index delete discipline.
    fn clear_kill_fence_locked(
        root: &Path,
        index: &mut LedgerIndex,
        provider: &str,
        session_id: &str,
    ) -> std::io::Result<()> {
        let result = match std::fs::remove_file(Self::kill_tombstone_path(root, provider, session_id))
        {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
        if result.is_ok() {
            let key = (provider.to_string(), session_id.to_string());
            index.kill_tombstones.remove(&key);
            index.legacy_tombstone_keys.remove(&key);
        }
        result
    }

    /// Focused-ep5-r5 Finding 2 (retire-on-kill round 6): record (or refresh)
    /// the placeholder→durable alias — written when the claude lane MINTS
    /// the alias (the adoption / resume registration) and re-stamped when it
    /// DEMOTES it (the exit/kill eviction funnel). File first, then the
    /// write-through index (the `write_binding` discipline); the upsert
    /// refreshes an existing (placeholder, durable) stamp. Durability-side
    /// expiry is the sweep's call (never the writer's).
    pub fn record_alias_tombstone(
        &self,
        provider: &str,
        placeholder: &str,
        durable: &str,
        at_ms: i64,
    ) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        let key = (provider.to_string(), placeholder.to_string());
        let mut records = index.alias_tombstones.get(&key).cloned().unwrap_or_default();
        if let Some(existing) = records.iter_mut().find(|(d, _)| d == durable) {
            existing.1 = at_ms;
        } else {
            records.push((durable.to_string(), at_ms));
        }
        let row = AliasTombstoneRecord {
            ledger_version: LEDGER_VERSION,
            provider: provider.to_string(),
            placeholder: placeholder.to_string(),
            records: records
                .iter()
                .map(|(d, at)| AliasTombstoneEntry {
                    durable: d.clone(),
                    at_ms: *at,
                })
                .collect(),
        };
        write_row_atomic(&Self::alias_tombstone_path(root, provider, placeholder), &row)?;
        index.alias_tombstones.insert(key, records);
        Ok(())
    }

    /// The placeholder's recorded durable ids, TTL-agnostic (the sweep owns
    /// expiry; the claude kill consult applies the row-state rule).
    /// Memory-only (V1.md read policy); a disabled ledger answers empty.
    pub fn alias_tombstone_records(
        &self,
        provider: &str,
        placeholder: &str,
    ) -> Vec<(String, i64)> {
        if self.root.is_none() {
            return Vec::new();
        }
        self.guard()
            .alias_tombstones
            .get(&(provider.to_string(), placeholder.to_string()))
            .cloned()
            .unwrap_or_default()
    }

    /// The claim lifecycle's consumption (Finding 2): a genuine claim of
    /// `durable` consumed every alias record pointing at it — the reopened
    /// identity can no longer be retired through those old placeholders.
    /// Returns the placeholder keys whose records pointed at `durable`
    /// (sorted, for a stable caller contract; the caller clears their own
    /// kill fences), with holes cleaned UP: a placeholder left with no
    /// records has its file deleted; a partially-consumed one is rewritten.
    /// Best-effort per file (fail loud, never silent): a failed rewrite is
    /// reported `Err` after the successful ones still landed (the index
    /// tracks exactly the file states that persisted).
    pub fn clear_alias_tombstones_for_durable(
        &self,
        provider: &str,
        durable: &str,
    ) -> std::io::Result<Vec<String>> {
        let Some(root) = &self.root else {
            return Ok(Vec::new());
        };
        let mut index = self.guard();
        let placeholders: Vec<String> = index
            .alias_tombstones
            .iter()
            .filter(|((p, _), records)| {
                p == provider && records.iter().any(|(d, _)| d == durable)
            })
            .map(|((_, placeholder), _)| placeholder.clone())
            .collect();
        let mut first_err: Option<std::io::Error> = None;
        let mut cleared: Vec<String> = Vec::new();
        for placeholder in placeholders {
            let key = (provider.to_string(), placeholder.clone());
            let Some(records) = index.alias_tombstones.get(&key).cloned() else {
                continue;
            };
            let kept: Vec<(String, i64)> =
                records.iter().filter(|(d, _)| d != durable).cloned().collect();
            let outcome = if kept.is_empty() {
                match std::fs::remove_file(Self::alias_tombstone_path(root, provider, &placeholder))
                {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(e),
                }
            } else {
                let row = AliasTombstoneRecord {
                    ledger_version: LEDGER_VERSION,
                    provider: provider.to_string(),
                    placeholder: placeholder.clone(),
                    records: kept
                        .iter()
                        .map(|(d, at)| AliasTombstoneEntry {
                            durable: d.clone(),
                            at_ms: *at,
                        })
                        .collect(),
                };
                write_row_atomic(&Self::alias_tombstone_path(root, provider, &placeholder), &row)
            };
            match outcome {
                Ok(()) => {
                    if kept.is_empty() {
                        index.alias_tombstones.remove(&key);
                    } else {
                        index.alias_tombstones.insert(key, kept);
                    }
                    cleared.push(placeholder);
                }
                Err(e) => {
                    tracing::warn!(
                        target: "freshell_ws::pane_ledger",
                        provider = %provider,
                        placeholder = %placeholder,
                        durable = %durable,
                        error = %e,
                        "pane_ledger_alias_tombstone_clear_failed: record left behind; the next claim re-consumes it"
                    );
                    if first_err.is_none() {
                        first_err = Some(e);
                    }
                }
            }
        }
        cleared.sort();
        match first_err {
            Some(e) => Err(e),
            None => Ok(cleared),
        }
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
        Self::clear_kill_fence_locked(root, &mut index, provider, session_id)
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
    /// no-op. Delegates to [`Self::commit_claim_aliased`] with no alias
    /// consult (round 6 keeps ONE transition implementation).
    pub fn commit_claim(
        &self,
        provider: &str,
        session_id: &str,
        expect_killed_at_ms: Option<i64>,
        now_ms: i64,
    ) -> std::io::Result<ClaimCommitOutcome> {
        self.commit_claim_aliased(provider, session_id, expect_killed_at_ms, &[], now_ms)
    }

    /// Focused-ep5-r5 Finding 2 (retire-on-kill round 6): the claim commit
    /// with the PLACEHOLDER-fence consult. `fence_checked_aliases` are the
    /// one-shot pane-seat placeholders the claude claim's identity resolves
    /// through (the attach lane registers the durable under the attaching
    /// pane's seat, the create lane under the just-minted one). A close
    /// fence recorded under ANY of them blocks the commit exactly like one
    /// recorded under the durable id — same `RefusedStale` refusal, same
    /// side-effect freedom, loudly logged naming the offending alias — with
    /// one DELIBERATE simplification: the alias compare is EXISTENCE-based,
    /// not snapshot-based. A durable id supports the genuine reopen (the
    /// snapshot compare's whole point — a resume the user meant), but a
    /// placeholder seat never does: it is sidecar-minted/requestId-derived,
    /// one-shot by construction, and a fence under it means THAT seat's pane
    /// was closed — any later claim riding it is the finding's disconnected
    /// late attach, never a genuine reopen this decision must admit. After
    /// the alias gate passes the transition is byte-for-byte
    /// [`Self::commit_claim`]'s.
    pub fn commit_claim_aliased(
        &self,
        provider: &str,
        session_id: &str,
        expect_killed_at_ms: Option<i64>,
        fence_checked_aliases: &[String],
        now_ms: i64,
    ) -> std::io::Result<ClaimCommitOutcome> {
        let Some(root) = &self.root else {
            return Ok(ClaimCommitOutcome::Committed);
        };
        let mut index = self.guard();
        for alias in fence_checked_aliases {
            let alias_key = (provider.to_string(), alias.clone());
            if let Some(killed_at) = index.kill_tombstones.get(&alias_key).copied() {
                tracing::info!(
                    target: "freshell_ws::pane_ledger",
                    provider = %provider,
                    session_id = %session_id,
                    placeholder = %alias,
                    killed_at_ms = killed_at,
                    "pane_ledger_claim_refused_placeholder_fence: a close landed under the \
                     one-shot pane seat this claim rides; the claim commits nothing"
                );
                return Ok(ClaimCommitOutcome::RefusedStale);
            }
        }
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
            // Delta-r6-r4: the fence's LEGACY file delete + the index drop
            // ride one helper; a fence a standing journal record re-feeds at
            // the next load lands beside this transition's refreshed row
            // stamps and classifies ClaimResidue — inert at every consult,
            // prunable with its record (never the accepted commit's undo).
            if let Err(err) = Self::clear_kill_fence_locked(root, &mut index, provider, session_id)
            {
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
        Ok(ClaimCommitOutcome::Committed)
    }

    /// Retire a row Closed on an explicit close (trigger e): the envelope of
    /// one — the identity journals into its close-envelope record and its
    /// Bound row flips Retired(Closed) as the projection. Missing or
    /// already-retired rows are idempotent no-ops. Delta-r6: this close is
    /// load-bearing for the kill/close lanes that call it — the durable
    /// write precedes any live-state teardown, and the callers fail the
    /// close (never a success acknowledgement) on `Err` — with
    /// [`CloseEnvelopeError::Persisted`] telling the lane the close IS
    /// durable despite the reported error (the lane ends the session
    /// consistently and fails visibly).
    ///
    /// Focused-ep5-r1 Finding 2 (retire-on-kill round 2): an explicit close
    /// is an intentional session END — the fence the record carries
    /// suppresses a binding write already in flight at kill time (an aborted
    /// consumer's orphaned `spawn_blocking` closure survives its task and
    /// can land over a row that does not exist yet):
    /// [`PaneLedger::record_fresh_agent_binding`] consults the fence under
    /// the same index guard, so the write suppresses itself (or
    /// force-retires a stale Bound remnant) instead of restoring Bound.
    ///
    /// Delta-r6-r4 (focused-episode-6 round 3, Finding 3): ONE close = ONE
    /// journal record (see [`CloseEnvelopeRecord`]); the two-write
    /// tombstone/then-retire split (and its compensation/rollback machinery)
    /// is gone — there is no second write to fail past the first.
    pub fn retire_closed(
        &self,
        provider: &str,
        session_id: &str,
        now_ms: i64,
    ) -> Result<(), CloseEnvelopeError> {
        self.close_identities(provider, &[session_id.to_string()], &[], now_ms)
    }

    /// The close envelope's shared engine (delta-r6-r4, focused-episode-6
    /// round 3, Finding 3): under the caller's index guard, merge the
    /// identity set into the key's journal record, persist it (THE durable
    /// act — ONE atomic file write), feed the write-through index, then
    /// project the row flips as hygiene. The failure protocol:
    ///
    /// * write OK ⇒ the close is durable (`Ok`). The row flips are
    ///   PROJECTIONS: a projection failure is logged (struct ERROR), never a
    ///   close failure — the still-Bound row is dominated by the record-fed
    ///   fence (reads closed at every boundary) until the sweep converges
    ///   it. This is exactly the finding's continuing-failure staging, now
    ///   consistent: the close stands, the kill proceeds, the session ends.
    /// * write error ⇒ rollback = deleting the ONE file — but ONLY when
    ///   this op created it (a pre-existing record at the key is prior close
    ///   evidence, never this op's to erase). The delete succeeding (or the
    ///   file never landing) ⇒ [`CloseEnvelopeError::Clean`] and NOTHING is
    ///   durable. The delete failing while the covering record stands ⇒
    ///   [`CloseEnvelopeError::Persisted`]: the caller's error reports
    ///   persisted-close, and the index is fed to match the disk truth.
    // The arity allowance mirrors `tabs_persist::persist_generation`'s: the
    // record's optional pane linkage travels as two slots.
    #[allow(clippy::too_many_arguments)]
    fn close_envelope_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        key: &str,
        identities: &[(String, String)],
        terminal_id: Option<&str>,
        create_request_id: Option<&str>,
        now_ms: i64,
    ) -> Result<(), CloseEnvelopeError> {
        let prior = index.close_envelopes.get(key).cloned();
        let mut record = prior.clone().unwrap_or(CloseEnvelopeRecord {
            ledger_version: LEDGER_VERSION,
            terminal_id: terminal_id.map(str::to_string),
            create_request_id: create_request_id.map(str::to_string),
            closed_at: now_ms,
            kills: Vec::new(),
        });
        if record.create_request_id.is_none() {
            record.create_request_id = create_request_id.map(str::to_string);
        }
        for (provider, session_id) in identities {
            match record
                .kills
                .iter_mut()
                .find(|k| &k.provider == provider && &k.session_id == session_id)
            {
                Some(existing) => existing.at_ms = now_ms,
                None => record.kills.push(PaneCloseKill {
                    provider: provider.clone(),
                    session_id: session_id.clone(),
                    at_ms: now_ms,
                }),
            }
        }
        let outcome =
            self.persist_close_envelope_locked(root, index, key, &record, prior.is_some());
        if outcome.is_ok() || outcome.as_ref().err().is_some_and(|e| e.is_persisted()) {
            // The close stands (durably). Project the row flips — hygiene,
            // never the close: a failed projection leaves a fence-dominated
            // Bound row (reads closed at every boundary) until the sweep
            // converges it durably. Loud, never silent.
            self.project_row_flips_locked(root, index, identities, now_ms);
        }
        outcome
    }

    /// THE durable act of the close envelope: write the ONE journal record.
    /// See [`PaneLedger::close_envelope_locked`] for the failure protocol.
    fn persist_close_envelope_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        key: &str,
        record: &CloseEnvelopeRecord,
        had_prior: bool,
    ) -> Result<(), CloseEnvelopeError> {
        let path = Self::close_envelope_path(root, key);
        match self.envelope_write_outcome(&path, record) {
            Ok(()) => {
                feed_close_envelope(index, key.to_string(), record.clone());
                Ok(())
            }
            Err(write_err) => {
                if had_prior {
                    // A close record at this key stood BEFORE this op: the
                    // pane/addressed-identity's close evidence is durable
                    // regardless of whether our write landed (ours lands as
                    // its superset; a missed write leaves the prior intact).
                    // Deleting is NEVER legal here (that would erase the
                    // prior close) — the honest answer is persisted-close.
                    // Feed the index from the disk truth.
                    if let Some(probed) = Self::probe_close_envelope(&path) {
                        feed_close_envelope(index, key.to_string(), probed);
                    }
                    tracing::error!(
                        target: "freshell_ws::pane_ledger",
                        key = %key,
                        error = %write_err,
                        "pane_ledger_close_envelope_repersist_failed: the write reported an                          error, but a close record at this key already stands — reporting                          persisted-close (the kill ends its session consistently)"
                    );
                    return Err(CloseEnvelopeError::Persisted(write_err));
                }
                // No prior record: rollback = deleting the ONE file.
                match self.envelope_delete_outcome(&path) {
                    Ok(()) => {
                        // Rolled back (or never landed): NOTHING durable
                        // survives — no record, no fence, no projection.
                        Err(CloseEnvelopeError::Clean(write_err))
                    }
                    Err(delete_err) => {
                        // The rollback target itself failed (the finding's
                        // continuing failure). Probe the durable truth: a
                        // record that stands AND covers this envelope's whole
                        // close set is a PERSISTED close — reported as such,
                        // never again "Err as though rollback completed".
                        match Self::probe_close_envelope(&path) {
                            Some(probed) if Self::record_covers(&probed, record) => {
                                feed_close_envelope(index, key.to_string(), probed);
                                tracing::error!(
                                    target: "freshell_ws::pane_ledger",
                                    key = %key,
                                    error = %write_err,
                                    rollback_error = %delete_err,
                                    "pane_ledger_close_envelope_rollback_failed_but_durable:                                      the write landed despite its error and the rollback                                      delete failed — the close is DURABLE; reporting                                      persisted-close (the kill ends its session consistently)"
                                );
                                Err(CloseEnvelopeError::Persisted(write_err))
                            }
                            _ => {
                                // No covering record stands (the temp+rename
                                // never committed): the delete error was
                                // noise on an absent path. Nothing durable.
                                tracing::error!(
                                    target: "freshell_ws::pane_ledger",
                                    key = %key,
                                    error = %write_err,
                                    rollback_error = %delete_err,
                                    "pane_ledger_close_envelope_rollback_failed_nothing_durable:                                      probe found no covering record — reporting a clean failure"
                                );
                                Err(CloseEnvelopeError::Clean(write_err))
                            }
                        }
                    }
                }
            }
        }
    }

    /// Read + parse a close-envelope record (the rollback probe). A version
    /// mismatch or a parse failure answers `None` — never mistaken for
    /// covering evidence.
    fn probe_close_envelope(path: &Path) -> Option<CloseEnvelopeRecord> {
        let record = load_row::<CloseEnvelopeRecord>(path).ok()?;
        (record.ledger_version == LEDGER_VERSION).then_some(record)
    }

    /// Does the on-disk `probed` record cover everything this envelope meant
    /// to close? Every intended identity fenced (any stamp — the close FACT
    /// is what covers) and the same pane linkage.
    fn record_covers(probed: &CloseEnvelopeRecord, intended: &CloseEnvelopeRecord) -> bool {
        probed.terminal_id == intended.terminal_id
            && intended.kills.iter().all(|k| {
                probed
                    .kills
                    .iter()
                    .any(|p| p.provider == k.provider && p.session_id == k.session_id)
            })
    }

    /// The row-projection half of a durable close: flip every still-Bound
    /// row the close covers to Retired(Closed). HYGIENE, never the close —
    /// failures log a structured ERROR; the fence-dominates-Bound shape it
    /// leaves reads closed at every boundary (the sweep converges it).
    fn project_row_flips_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        identities: &[(String, String)],
        now_ms: i64,
    ) {
        for (provider, session_id) in identities {
            let key = (provider.clone(), session_id.clone());
            if let Some(mut row) = index.bindings.get(&key).cloned() {
                if row.state != RowState::Bound {
                    continue;
                }
                row.state = RowState::Retired;
                row.retired_reason = Some(RetiredReason::Closed);
                row.updated_at = now_ms;
                if let Err(err) = self.write_binding(root, index, &row) {
                    tracing::error!(
                        target: "freshell_ws::pane_ledger",
                        provider = %provider,
                        session_id = %session_id,
                        error = %err,
                        "pane_ledger_close_row_projection_failed: the close IS durable (its                          journal record stands); the still-Bound row is dominated by the                          close fence and the next sweep converges it durably"
                    );
                }
            }
        }
    }

    /// The envelope record's write step (the temp+rename). Test builds can
    /// stage the two failure shapes: fail-before-landing ("doesn't exist"
    /// side) and land-then-report-failure (the rename-committed class).
    #[cfg(not(test))]
    fn envelope_write_outcome(
        &self,
        path: &Path,
        record: &CloseEnvelopeRecord,
    ) -> std::io::Result<()> {
        write_row_atomic(path, record)
    }

    /// The rollback's delete step. Test builds can fail it (the continuing
    /// failure AT the rollback target). `NotFound` is already-gone.
    #[cfg(not(test))]
    fn envelope_delete_outcome(&self, path: &Path) -> std::io::Result<()> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    #[cfg(test)]
    fn envelope_write_outcome(
        &self,
        path: &Path,
        record: &CloseEnvelopeRecord,
    ) -> std::io::Result<()> {
        let land_then_fail = self
            .close_envelope_land_failures
            .load(std::sync::atomic::Ordering::SeqCst);
        if land_then_fail > 0 {
            self.close_envelope_land_failures
                .store(land_then_fail - 1, std::sync::atomic::Ordering::SeqCst);
            write_row_atomic(path, record)?;
            return Err(std::io::Error::other(
                "injected post-landing close-envelope write failure",
            ));
        }
        let fail = self
            .close_envelope_write_failures
            .load(std::sync::atomic::Ordering::SeqCst);
        if fail > 0 {
            self.close_envelope_write_failures
                .store(fail - 1, std::sync::atomic::Ordering::SeqCst);
            return Err(std::io::Error::other("injected close-envelope write failure"));
        }
        write_row_atomic(path, record)
    }

    #[cfg(test)]
    fn envelope_delete_outcome(&self, path: &Path) -> std::io::Result<()> {
        let fail = self
            .close_envelope_delete_failures
            .load(std::sync::atomic::Ordering::SeqCst);
        if fail > 0 {
            self.close_envelope_delete_failures
                .store(fail - 1, std::sync::atomic::Ordering::SeqCst);
            return Err(std::io::Error::other("injected close-envelope delete failure"));
        }
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Test-only knob (delta-r6-r4 Finding 3): the next `n` close-envelope
    /// record writes fail BEFORE anything lands — the "doesn't exist" side
    /// of the forward-write failure.
    #[cfg(test)]
    pub(crate) fn fail_next_close_envelope_writes(&self, n: usize) {
        self.close_envelope_write_failures
            .store(n, std::sync::atomic::Ordering::SeqCst);
    }

    /// Test-only knob (delta-r6-r4 Finding 3): the next `n` close-envelope
    /// record writes genuinely LAND, then report failure — the
    /// rename-committed class that engages the rollback.
    #[cfg(test)]
    pub(crate) fn land_then_fail_next_close_envelope_writes(&self, n: usize) {
        self.close_envelope_land_failures
            .store(n, std::sync::atomic::Ordering::SeqCst);
    }

    /// Test-only knob (delta-r6-r4 Finding 3): the next `n` close-envelope
    /// rollback deletes fail — the continuing failure AT the rollback target.
    #[cfg(test)]
    pub(crate) fn fail_next_close_envelope_deletes(&self, n: usize) {
        self.close_envelope_delete_failures
            .store(n, std::sync::atomic::Ordering::SeqCst);
    }

    /// Delta-r6-r3 (focused-episode-6 round 2, Findings 4+5), re-durabled by
    /// delta-r6-r4 (round 3, Finding 3) — the fresh-agent kill lanes' ONE
    /// durable close: every session identity the kill covers (the wire id
    /// FIRST — it addresses the record's key — followed by every
    /// alias-resolved durable id) journals into ONE close-envelope record in
    /// ONE guarded op. `Ok` means the whole close set is durable; `Err` is
    /// split by [`CloseEnvelopeError`]: `Clean` leaves NOTHING durable (a
    /// retried kill re-attempts idempotently; the lane touches no live
    /// state), `Persisted` means the close IS durable despite the reported
    /// error (the lane ends the session consistently and fails visibly).
    /// The pending markers delete LAST, once the close is durable, and
    /// marker failures are warn-only hygiene: markers are never
    /// recovery-offer inputs (the verdict join reads rows, close records,
    /// and fences), a stale one TTL-sweeps, and every resolve lane consults
    /// the close evidence first.
    ///
    /// Identities are deduped; unknown ids are idempotent. An EMPTY
    /// identity set writes no record (there is nothing to close — the lanes'
    /// own contract since round 3 is that a kill always names itself).
    pub fn close_identities(
        &self,
        provider: &str,
        session_ids: &[String],
        pending_ids: &[String],
        now_ms: i64,
    ) -> Result<(), CloseEnvelopeError> {
        let Some(root) = self.root.clone() else {
            return Ok(());
        };
        let mut index = self.guard();
        let mut keys: Vec<(String, String)> = Vec::new();
        for id in session_ids {
            let key = (provider.to_string(), id.clone());
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
        if let Some((_, first_id)) = keys.first() {
            self.close_envelope_locked(
                &root,
                &mut index,
                &Self::agent_envelope_key(provider, first_id),
                &keys,
                None,
                None,
                now_ms,
            )?;
        }
        for pending_id in pending_ids {
            if let Err(err) = Self::remove_pending(&root, &mut index, pending_id) {
                tracing::warn!(
                    target: "freshell_ws::pane_ledger",
                    provider = %provider,
                    pending_id = %pending_id,
                    error = %err,
                    "pane_ledger_close_envelope_marker_delete_failed: the closes are durable;                      the stale marker TTL-sweeps (resolve lanes consult the close evidence first)"
                );
            }
        }
        Ok(())
    }

    /// Delta-r6-r2 (focused-episode-6 round 1, Findings 1+2+6) — the terminal
    /// kill's ONE durable act: close the PANE by the identity the close
    /// knows. Under ONE index-guard hold:
    ///
    /// 1. The identity set is `resolved` (the identity registry's answer,
    ///    when the kill captured one) UNION every binding row this pane owns
    ///    (`live_terminal_id == terminal_id`) — discovered under the guard,
    ///    so a resolution that beat the kill's in-memory capture but not its
    ///    ledger turn closes under it (Finding 2's race, kill-side).
    /// 2. The pane's close-envelope journal record is merged (re-kills
    ///    re-stamp; a record carrying the pane's earlier close gains the new
    ///    identities) and persisted — THE ONE durable act (delta-r6-r4):
    ///    pane cover AND identity fences are the same single file, written
    ///    BEFORE the pending marker is deleted (for a pre-resolution close
    ///    the marker is the ONLY pre-existing evidence tying the pane to the
    ///    attempted creation). The [`CloseEnvelopeError`] split drives the
    ///    caller: `Clean` means nothing durable (the terminal kill leaves
    ///    the process running and answers failure); `Persisted` means the
    ///    close IS durable despite the reported error (the kill proceeds and
    ///    fails visibly).
    /// 3. The row flips land as projections (hygiene, never the close).
    /// 4. The pending marker is deleted (a live marker must not outlive the
    ///    pane it names). After step 2 the close IS durable: a
    ///    marker-delete failure here is warn-only hygiene (markers never
    ///    feed recovery offers; every resolve lane consults the close
    ///    evidence first; TTL sweeps the rest).
    ///
    /// Every choice is idempotent: a retried kill re-derives the same set,
    /// re-stamps the same record, and re-merges the same fences.
    pub fn close_pane(&self, w: &PaneCloseWrite) -> Result<(), CloseEnvelopeError> {
        let Some(root) = self.root.clone() else {
            return Ok(());
        };
        let mut index = self.guard();
        // Step 1 — the identity set, resolved ∪ pane-owned rows.
        let mut keys: Vec<(String, String)> = w
            .resolved
            .iter()
            .map(|l| (l.provider.clone(), l.session_id.clone()))
            .collect();
        for row in index.bindings.values() {
            if row.live_terminal_id.as_deref() == Some(w.terminal_id.as_str()) {
                let key = (row.provider.clone(), row.session_id.clone());
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
        }
        // Step 2 — THE durable act: the pane's journal record.
        self.close_envelope_locked(
            &root,
            &mut index,
            &Self::pane_envelope_key(&w.terminal_id),
            &keys,
            Some(&w.terminal_id),
            w.create_request_id.as_deref(),
            w.now_ms,
        )?;
        // Step 4 — the marker (LAST; warn-only hygiene — the close is
        // durable by now).
        if let Err(err) = Self::remove_pending(&root, &mut index, &w.terminal_id) {
            tracing::warn!(
                target: "freshell_ws::pane_ledger",
                terminal_id = %w.terminal_id,
                error = %err,
                "pane_ledger_close_pane_marker_delete_failed: the close is durable (record                  persisted); the stale marker TTL-sweeps and every resolve lane consults the                  close record first"
            );
        }
        Ok(())
    }

    /// Every standing pane-keyed close record (the recovery inventory's
    /// verdict join input), derived from the journal records — the
    /// fresh-agent envelopes carry no pane linkage and never surface here.
    /// Memory-only (V1.md read policy); a disabled ledger answers empty.
    pub fn list_pane_closes(&self) -> Vec<PaneCloseRecord> {
        if self.root.is_none() {
            return Vec::new();
        }
        self.guard()
            .close_envelopes
            .values()
            .filter_map(|record| {
                record
                    .terminal_id
                    .clone()
                    .map(|terminal_id| PaneCloseRecord {
                        ledger_version: record.ledger_version,
                        terminal_id,
                        create_request_id: record.create_request_id.clone(),
                        closed_at: record.closed_at,
                        kills: record.kills.clone(),
                    })
            })
            .collect()
    }

    /// One pane's standing close record (`resolve_pending`'s consult shape).
    /// Memory-only; a disabled ledger answers `None`.
    pub fn pane_close_for_terminal(&self, terminal_id: &str) -> Option<PaneCloseRecord> {
        self.root.as_ref()?;
        let record = self
            .guard()
            .close_envelopes
            .get(&Self::pane_envelope_key(terminal_id))
            .cloned()?;
        Some(PaneCloseRecord {
            ledger_version: record.ledger_version,
            terminal_id: record.terminal_id.clone().unwrap_or_default(),
            create_request_id: record.create_request_id.clone(),
            closed_at: record.closed_at,
            kills: record.kills.clone(),
        })
    }

    /// Every standing kill-tombstone key, TTL- and class-agnostic — the
    /// recovery inventory's claim-arm verdict consult (a claimed identity
    /// with NO row anywhere and a standing tombstone was closed before its
    /// identity ever resolved as a row). Memory-only; a disabled ledger
    /// answers empty.
    pub fn all_kill_tombstone_keys(&self) -> std::collections::HashSet<(String, String)> {
        if self.root.is_none() {
            return std::collections::HashSet::new();
        }
        self.guard().kill_tombstones.keys().cloned().collect()
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
        #[cfg(test)]
        {
            let armed = self
                .resolve_gate
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .take();
            if let Some(gate) = armed {
                let release = gate.release_rx.lock().unwrap().take();
                let _ = gate.entered_tx.send(());
                if let Some(release) = release {
                    // Blocking inside the guard is the point of the hook: the
                    // test's close op queues behind THIS hold while the
                    // resolver is provably between its guard acquisition and
                    // its consult.
                    let _ = release.blocking_recv();
                }
            }
        }
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
        // Delta-r6-r2 (focused-episode-6 round 1, F1+F2) — the close-record
        // CONSULT: a resolution landing for a pane whose close already
        // recorded durably NEVER re-binds Bound. The pane close is keyed by
        // what the kill knew (the terminal id, always), and this consult runs
        // under the same index guard as the close pane's own act, so the two
        // interleavings are decided here: the close ran first ⇒ the record
        // stands and this arm fires; the close lands later ⇒ it discovers
        // this row by `live_terminal_id` and closes it under ITS guard.
        // Delta-r6-r4 ordering: the record LEARNS the now-known identity key
        // FIRST (the journal act — the fence it feeds is what dominates the
        // row-write window), then the row is written Bound and immediately
        // flipped Retired(Closed) — a crash between leaves the row Bound
        // beside the standing fence (the dominance rule converges it, never
        // offers it). A record-rewrite failure that landed nothing (`Clean`)
        // fails the resolve with NO new evidence written; a persisted-close
        // (`Persisted`) means the fold IS durable and the resolve proceeds.
        if let Some(mut close) = index
            .close_envelopes
            .get(&Self::pane_envelope_key(w.terminal_id))
            .cloned()
        {
            if !close
                .kills
                .iter()
                .any(|k| k.provider == w.provider && k.session_id == w.session_id)
            {
                close.kills.push(PaneCloseKill {
                    provider: w.provider.to_string(),
                    session_id: w.session_id.to_string(),
                    at_ms: w.now_ms,
                });
            }
            match self.persist_close_envelope_locked(
                root,
                &mut index,
                &Self::pane_envelope_key(w.terminal_id),
                &close,
                true, // a record stands by construction on this arm
            ) {
                Ok(()) | Err(CloseEnvelopeError::Persisted(_)) => {}
                Err(CloseEnvelopeError::Clean(err)) => return Err(err),
            }
            self.record_binding_locked(root, &mut index, w)?; // the row
            if let Some(mut row) = index
                .bindings
                .get(&(w.provider.to_string(), w.session_id.to_string()))
                .cloned()
            {
                if row.state == RowState::Bound {
                    row.state = RowState::Retired;
                    row.retired_reason = Some(RetiredReason::Closed);
                    row.updated_at = w.now_ms;
                    self.write_binding(root, &mut index, &row)?;
                }
            }
            if let Err(err) = Self::remove_pending(root, &mut index, w.terminal_id) {
                tracing::warn!(
                    target: "freshell_ws::pane_ledger",
                    terminal_id = %w.terminal_id,
                    error = %err,
                    "pane_ledger_marker_delete_failed_on_resolve: retired row durably \
                     written; stale marker left for the boot/GC sweep to repair"
                );
            }
            return Ok(());
        }
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
