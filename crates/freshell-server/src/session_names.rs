//! Durable canonical coding-agent name authority (unified-agent-names plan,
//! Task 1).
//!
//! One version-1 document (`session-names.json` in the configured Freshell
//! data directory) holds every piece of naming state: `documentGeneration`,
//! `nextRevision`, accepted records, pending→durable redirects, internal
//! native locations/location revisions, generation state, native-write state,
//! the fair-scheduling cursor and migration receipts. Every persisted
//! mutation — including initialization, bookkeeping and receipts without
//! visible text changes — advances `documentGeneration`.
//!
//! Strict cross-process transaction policy, under local serialization: this
//! process's transactions first take a FIFO turn on the store's local queue,
//! and only the turn holder touches the stable private sidecar
//! (`.session-names.lock`, opened create+read+write, never replaced or
//! unlinked). It is `try_lock`ed on a fresh private handle per transaction,
//! retrying contention for at most one monotonic second before
//! [`NameError::LockUnavailable`] — so that bounded budget measures only
//! contention with another participant (normally another process), never a
//! wait behind this store's own (bounded-IO) transactions. Under that lock
//! the complete current document is re-read and validated, any newly
//! encountered generation's durability is reconciled (file + parent sync)
//! before adoption or mutation, the decision is applied, and the
//! replacement is written with
//! `freshell_ws::tabs_persist::atomic_write_durable` (sibling temp, file
//! sync, rename, Unix parent sync) BEFORE the read model swaps and anything
//! publishes. Pre-replace failures leave the old state intact
//! ([`NameError::Persistence`]); post-replace uncertainty fences the writer
//! and every other participant until durability reconciliation succeeds
//! ([`NameError::CommitUncertain`]). A missing document initializes only a
//! store with no established view — for an established store a vanished
//! document fences every operation instead of silently reinitializing over
//! accepted names. The executing blocking-IO owner retains its guard until
//! completion even if an outer caller stops waiting (transactions run on
//! detached `spawn_blocking` tasks), and releasing the guard unlocks the
//! sidecar explicitly, so a child process forked mid-transaction (which
//! holds an inherited descriptor until it execs) never keeps it locked.
//!
//! `session.name.updated` publishes only after successful commit/adoption,
//! in local generation order (publication happens while the lock is held).
//! Neither settings dirty-merging nor a process mutex is sufficient — two
//! real processes serialize through the file lock alone.
//!
//! Name reads take no lock (name-reliability Task 11,
//! `session_name_store_view`): they answer from the adopted view after a
//! stat of the document against the stamp the view was adopted from; only
//! a changed stamp (or an elapsed 30 s full-check window) runs the locked
//! full-read adoption above, and a read never queues behind a commit. It
//! takes this store's local turn only if the turn is free (a turn held by
//! one of this process's own transactions means that transaction is about
//! to adopt or replace the document and update the view itself), then
//! tries the document lock for at most 10 ms, which rides out a momentary
//! hold by another participant. When either is busy it answers from the
//! adopted view (`class` `local_turn_busy` or `lock_busy`), and a later
//! read or the 2 s tick adopts the change; the tick's full read queues for
//! the local turn like every transaction.
//!
//! Task 2 constructs this store in `main.rs`; Tasks 3–4 consume
//! [`SessionNames::try_background_guard`] for the serial worker.

// Unified agent names Task 2: the store is constructed and wired in `main`
// (routes/sinks/tick/publisher), so no module-level dead-code allow remains.
// The Tasks 3–4 seams below (`offer`'s automatic-name path, the generation
// series, the background worker guard) carry item-level allows until their
// wiring tasks land.
//
// `NameError::Conflict` deliberately carries the accepted record so route
// callers can answer a CAS conflict with the current winner instead of an
// invisible overwrite — the large Err payload is the design (same rationale
// as `terminal_tabs.rs`'s `Response`).
#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;
use std::fs::TryLockError;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use freshell_freshagent::naming::{
    BindNameInput, NameActivity, NameActivityReason, NameError, NameFuture, NativeNameObservation,
    NativeNameOrigin, PendingNameInput, RenameNameInput, SessionNaming,
};
use freshell_protocol::native_location::{NativeAcquisition, NativeLocation, NativePersistence};
use freshell_protocol::session_names::{
    LegacyCandidateScope, LegacyImportResult, LegacyNameCandidate, LegacyNameImport,
    LegacyNameTarget, LegacyProtectionEvidence, NameIntent, NameRevision, NameSource,
    NamedProvider, RenameOutcome, RenameOutcomeReason, SessionNameRecord, SessionNameRedirect,
    SessionNameRef, SessionNameUpdate, MAX_NAME_REVISION,
};
use freshell_ws::tabs_persist::atomic_write_durable;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::auto_title::basename_segment;
use crate::session_name_generation::{
    GenerationClaim, GenerationOutcome, GenerationWorkItem, IndexedNameInput,
};

// Name-reliability Task 3: the post-migration import policy and the
// import-owned bind-collision rule. A child module so it reads the document
// internals without widening their visibility.
#[path = "session_name_import_policy.rs"]
mod session_name_import_policy;

// Name-reliability Task 4: the native-observation, automation-rename and
// self-heal rules, and the batched sweep maintenance transaction. Child
// modules for the same reason as the import policy.
#[path = "session_name_apply.rs"]
mod session_name_apply;
#[path = "session_name_policy.rs"]
mod session_name_policy;
#[path = "session_name_sweep_batch.rs"]
mod session_name_sweep_batch;
// Name-reliability Task 5: the first-message fallback, re-absorb at rest
// and the prompt-input guard.
#[path = "session_name_first_message.rs"]
mod session_name_first_message;
// Name-reliability Task 6: claim/fold attempt accounting (refunds, fold-side
// exhaustion).
#[path = "session_name_generation_series.rs"]
mod session_name_generation_series;
// Name-reliability Task 11: lock-free name reads served from the adopted
// view, and the cheap cross-process stamp peek.
#[path = "session_name_store_view.rs"]
mod session_name_store_view;
// Name-reliability Task 12: the `session_names.name_changed` event log.
#[path = "session_name_continuation.rs"]
mod session_name_continuation;
#[path = "session_name_events.rs"]
mod session_name_events;
#[path = "session_name_publish.rs"]
mod session_name_publish;
use session_name_apply::{indexed_key, replace_automatic, wire_source, with_outcome};
use session_name_events::{AdoptedChanges, NameChangeCause, NameChangeEvent, UncertainCommits};
use session_name_first_message::{first_message_fallback, InputRefusals, RefusalSite, SeriesPlan};
use session_name_store_view::{DocumentStamp, FullCheck};
use session_name_sweep_batch::StagedNativeBaselines;
pub(crate) use session_name_sweep_batch::{
    SweepMaintenanceItem, SweepMaintenanceQueue, SweepMaintenanceReport, SweepWork,
};

#[cfg(test)]
#[path = "session_names_tests.rs"]
mod tests;
// Name-reliability Task 5: the first-message fallback, wrapper-text and
// generation-input rules, end to end through the store and the sweep.
#[cfg(test)]
#[path = "session_name_plan_activity_tests.rs"]
mod plan_activity_tests;

#[cfg(test)]
#[path = "session_name_continuation_tests.rs"]
mod continuation_tests;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCUMENT_VERSION: u32 = 1;
const DOCUMENT_FILE_NAME: &str = "session-names.json";
const DOCUMENT_TMP_NAME: &str = ".session-names.json.tmp";
const LOCK_FILE_NAME: &str = ".session-names.lock";
const WORKER_LOCK_FILE_NAME: &str = ".session-names-worker.lock";
/// Contention retry cadence for the strict document lock.
const LOCK_POLL_INTERVAL: Duration = Duration::from_millis(10);
/// The bounded monotonic retry budget before `LockUnavailable` — spent only
/// on contention with another participant (this store's own transactions
/// queue on its local turn first). A local-turn wait that reaches this long
/// logs `session_names.local_turn_slow` while the caller is still queued.
const LOCK_RETRY_BUDGET: Duration = Duration::from_secs(1);
/// Hard accepted-name cap: 200 Unicode scalar values.
const MAX_NAME_SCALARS: usize = 200;
/// Generation series exhaust after three consumed starts.
pub(crate) const MAX_GENERATION_STARTS: u32 = 3;
/// Task 4: after failure 1 the generation retry becomes due in 30 seconds.
pub(crate) const GENERATION_RETRY_1_MS: i64 = 30_000;
/// Task 4: after failure 2 the generation retry becomes due in five minutes.
pub(crate) const GENERATION_RETRY_2_MS: i64 = 300_000;
/// Task 3: a desired canonical revision gets at most three native cycles.
pub(crate) const MAX_NATIVE_CYCLES: u32 = 3;
/// Task 3: each desired revision permits at most three writes and six reads
/// (one pre-reconciliation read + one write + one confirming read per cycle).
pub(crate) const MAX_NATIVE_READS: u32 = 6;
/// Task 3: cycle 2 becomes ready at least this long after a cycle-1 failure.
const NATIVE_CYCLE_RETRY_1_MS: i64 = 5_000;
/// Task 3: cycle 3 becomes ready at least this long after a cycle-2 failure.
const NATIVE_CYCLE_RETRY_2_MS: i64 = 30_000;
/// Broadcast history retained for slow subscribers (lag recovers by refresh).
const NAME_BROADCAST_CAPACITY: usize = 4096;
/// Task 7: the one-time consolidation's evidence/backup directory under the
/// Freshell data directory.
pub(crate) const NAME_MIGRATION_DIR_NAME: &str = "name-migration-v1";
/// Task 7: the immutable per-import backup subdirectory
/// (`name-migration-v1/imports/<SHA-256 of importId>.json`).
pub(crate) const NAME_MIGRATION_IMPORTS_DIR_NAME: &str = "imports";
/// Task 7: the reserved import id of the trusted server-boot evidence
/// import. Only this lane may carry `explicit_rename` (manual) and
/// accepted-Freshell-AI classifications; the HTTP route rejects the id so
/// arbitrary callers can never assert them.
pub(crate) const NAME_MIGRATION_BOOT_IMPORT_ID: &str = "server-boot-v1";
/// Task 7: an import batches at most this many candidates (the client
/// chunks; the server refuses oversized envelopes).
pub(crate) const NAME_MIGRATION_IMPORT_CANDIDATE_LIMIT: usize = 100;

// ---------------------------------------------------------------------------
// Document schema (version 1)
// ---------------------------------------------------------------------------

/// Verified routing evidence for one naming target. `location_revision` is
/// assigned by the store whenever verified evidence changes — independent of
/// the visible name revision and never a public identity namespace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifiedLocation {
    pub location: NativeLocation,
    pub location_revision: NameRevision,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLocation {
    #[serde(skip_serializing_if = "Option::is_none")]
    verified: Option<VerifiedLocation>,
    /// Live routing hint retained without binding; never a verified route.
    #[serde(skip_serializing_if = "Option::is_none")]
    prospective: Option<NativeLocation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum GenerationStatus {
    Idle,
    Eligible,
    InFlight,
    Exhausted,
}

/// Per-record durable generation series: status, series id, input fingerprint,
/// bounded first-message excerpt, persisted attempt identities/start times,
/// consumed count, nextDue and exhaustion time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerationState {
    status: GenerationStatus,
    series_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    input_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attempt_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attempt_starts: Vec<i64>,
    #[serde(default)]
    consumed: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_due: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exhausted_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum NativeSyncStatus {
    #[default]
    Pending,
    Synced,
    Unsynced,
    Unsupported,
}

/// Provenance record of the last native observation (never a name authority).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredObservation {
    origin: String,
    location_revision: NameRevision,
    #[serde(skip_serializing_if = "Option::is_none")]
    event_id: Option<String>,
    at: i64,
    /// An old-location observation: retained, never treated as current.
    stale: bool,
}

/// Per-record native writeback state: desired revision/name/source, attempted
/// location and receipts, consumed cycles/reads, and last-observation
/// provenance. Task 3 drives the cycle machine; Task 1 owns the durable
/// schema and the bind-transfer policy.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeWriteState {
    status: NativeSyncStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    desired_revision: Option<NameRevision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    desired_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    desired_source: Option<NameSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempted_location: Option<NativeLocation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempted_location_revision: Option<NameRevision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    receipt_id: Option<String>,
    #[serde(default)]
    cycles_consumed: u32,
    #[serde(default)]
    reads_consumed: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attempted_receipts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_confirmed_receipt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unsynced_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_observation: Option<StoredObservation>,
    /// Task 3: the last dispatched write result was AMBIGUOUS — a later
    /// matching readback records `observed_current` but can never establish
    /// `synced` for this desired revision (an older external request may
    /// still land). Cleared by a new name decision or a confirmed ack.
    #[serde(default)]
    ambiguous: bool,
    /// Task 3: when the next remaining cycle becomes eligible again (ms
    /// epoch). `None` = ready subject to `settled`. Set by failure folds
    /// (5s after cycle 1, 30s after cycle 2) and honored by rearm events
    /// ("subject to any already-recorded failure nextDue").
    #[serde(skip_serializing_if = "Option::is_none")]
    next_due: Option<i64>,
    /// Task 3: the series holds no further work for this desired revision —
    /// set by synchronization (unused cycles paused), by a matching readback
    /// after ambiguity, and by exhaustion/unsupported. Cleared by a differing
    /// current-location observation, a genuine location reacquisition, or a
    /// new name decision. Never replenishes consumed counts.
    #[serde(default)]
    settled: bool,
    /// Task 3: a matching current-location readback was observed while the
    /// series stayed `unsynced` (ambiguity) — projected as `observedCurrent`.
    #[serde(skip_serializing_if = "Option::is_none")]
    observed_current: Option<bool>,
    /// Task 3 fix round (M5): the series identity — the revision the series
    /// was last ARMED at (stamped by `reset_native_series`; a bind transfer
    /// keeps it, binding is not a new name decision). Every claim captures it
    /// and every fold/read-charge carries it, so operations dispatched by a
    /// series superseded by a newer name decision are provenance only — never
    /// a state change, never a charged allowance. Backfilled from the desired
    /// revision at claim time for documents written before the stamp existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    series_epoch: Option<NameRevision>,
    /// Name-reliability Task 4: the last valid, current-location native
    /// title the provider reported for this record (never a placeholder or
    /// other default label). A native observation equal to it is an echo —
    /// provenance only, even when it would raise rank — so an echo can never
    /// undo an automation or user rename. Internal; never on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_native_title: Option<String>,
}

/// Persisted fair-scheduling cursor (Task 3/4's serial worker alternates
/// generation/native classes when both have ready work).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchedulingCursor {
    #[serde(skip_serializing_if = "Option::is_none")]
    last_class: Option<String>,
}

/// Migration receipts (Task 7). `completed` commits once the consolidation
/// runner finishes importing EVERY boot chunk (see
/// [`SessionNames::complete_legacy_migration`]): once committed, canonical
/// readers stop consulting migrated legacy fields even if physical cleanup
/// is still pending (cleanup is idempotently retried at boot), and a boot
/// interrupted between chunks leaves the receipt open so the next boot
/// resumes. `winning_evidence` retains, per record key, the winning
/// migration candidate — while a record is migration-owned, a later
/// pre-completion import (a browser import that arrived before the boot
/// finished, or a resumed boot chunk) compares against this retained
/// evidence and replaces it only on a strict win, and a bind
/// collision consults it to let an import-owned default label give way.
/// Once `completed` is committed, browser imports are acknowledged without
/// any effect (`session_name_import_policy`), so no later import compares
/// against it. The bookkeeping (`acknowledged_candidate_ids`, the evidence)
/// is never pruned: an older binary sharing the document still relies on it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationReceipts {
    #[serde(default)]
    completed: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    acknowledged_candidate_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    winning_evidence: BTreeMap<String, StoredMigrationEvidence>,
}

/// The retained winning migration evidence for one record: the candidate
/// core the total order compares against, plus the revision the migration
/// installed (a later revision means the record moved post-migration — a
/// post-migration explicit rename or accepted Freshell AI name protects it
/// from every later legacy candidate).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredMigrationEvidence {
    candidate_id: String,
    name: String,
    source: NameSource,
    scope: LegacyCandidateScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    explicit_rename_at: Option<i64>,
    evidence_key: String,
    installed_revision: NameRevision,
}

/// Retained losing evidence (bind collisions, migration losers). A recovery
/// copy only — never an active competing override.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryEntry {
    record: SessionNameRecord,
    #[serde(skip_serializing_if = "Option::is_none")]
    evidence: Option<serde_json::Value>,
    retained_at: i64,
    reason: String,
}

/// The version-1 name document. Core fields (version, generation, revision
/// cursor, records, redirects) are required; internal bookkeeping sections
/// default when absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDocument {
    version: u32,
    document_generation: u64,
    next_revision: NameRevision,
    records: BTreeMap<String, SessionNameRecord>,
    redirects: BTreeMap<String, SessionNameRedirect>,
    #[serde(default)]
    locations: BTreeMap<String, StoredLocation>,
    #[serde(default)]
    generation: BTreeMap<String, GenerationState>,
    #[serde(default)]
    native_write: BTreeMap<String, NativeWriteState>,
    #[serde(default)]
    scheduling_cursor: SchedulingCursor,
    #[serde(default)]
    migration: MigrationReceipts,
    #[serde(default)]
    recovery: BTreeMap<String, RecoveryEntry>,
}

impl StoredDocument {
    /// The pre-initialization shape: generation 0 is never written; the first
    /// committed transaction persists generation 1.
    fn initial() -> Self {
        Self {
            version: DOCUMENT_VERSION,
            document_generation: 0,
            next_revision: 1,
            records: BTreeMap::new(),
            redirects: BTreeMap::new(),
            locations: BTreeMap::new(),
            generation: BTreeMap::new(),
            native_write: BTreeMap::new(),
            scheduling_cursor: SchedulingCursor::default(),
            migration: MigrationReceipts::default(),
            recovery: BTreeMap::new(),
        }
    }

    /// Allocate the next JS-safe monotonically increasing revision.
    fn allocate_revision(&mut self) -> Result<NameRevision, NameError> {
        let revision = self.next_revision;
        if revision > MAX_NAME_REVISION {
            return Err(NameError::Persistence(
                "name revision budget exhausted (JS-safe ceiling)".into(),
            ));
        }
        self.next_revision = revision + 1;
        Ok(revision)
    }

    /// Follow a pending→durable redirect (one hop; redirects only ever point
    /// at durable session refs). Returns the resolved ref plus the traversed
    /// redirect.
    fn resolve_ref(
        &self,
        target: &SessionNameRef,
    ) -> (SessionNameRef, Option<SessionNameRedirect>) {
        let key = name_ref_key(target);
        if let Some(redirect) = self.redirects.get(&key) {
            return (redirect.to.clone(), Some(redirect.clone()));
        }
        (target.clone(), None)
    }

    fn record_at(&self, key: &str) -> Option<&SessionNameRecord> {
        self.records.get(key)
    }
}

/// The stable encoded key for a naming ref — the JSON encoding of a
/// discriminated tuple (`["pending","<id>"]` /
/// `["session","<provider>","<sessionId>"]`), mirroring the TS
/// `sessionNameRefKey`. Never colon-splits opaque provider session IDs.
pub(crate) fn name_ref_key(target: &SessionNameRef) -> String {
    match target {
        SessionNameRef::Pending { id } => {
            serde_json::to_string(&serde_json::json!(["pending", id]))
                .expect("pending ref key serializes")
        }
        SessionNameRef::Session {
            provider,
            session_id,
        } => serde_json::to_string(&serde_json::json!([
            "session",
            provider.as_str(),
            session_id
        ]))
        .expect("session ref key serializes"),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The data-dir-keyed test clock offset ([`TestHook::ClockOffsetMs`]) — the
/// store's internal clock injection for the generation retry arithmetic.
fn clock_offset_ms(data_dir: &Path) -> i64 {
    #[cfg(test)]
    {
        take_matching_hook(data_dir, |h| matches!(h, TestHook::ClockOffsetMs(_)))
            .map(|hook| match hook {
                TestHook::ClockOffsetMs(offset) => offset,
                _ => 0,
            })
            .unwrap_or(0)
    }
    #[cfg(not(test))]
    {
        let _ = data_dir;
        0
    }
}

/// The store's decision clock for `data_dir`: wall-clock now plus the
/// data-dir-keyed test offset.
fn effective_now_ms(data_dir: &Path) -> i64 {
    now_ms() + clock_offset_ms(data_dir)
}

/// Test-visible read of the data-dir clock offset (the generation tests'
/// `decision_now` helper mirrors the store's decision clock).
#[cfg(test)]
pub(crate) fn clock_offset_ms_for_tests(data_dir: &Path) -> i64 {
    clock_offset_ms(data_dir)
}

pub(crate) fn digest_bytes(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

// ---------------------------------------------------------------------------
// Transaction plumbing
// ---------------------------------------------------------------------------

/// What a transaction decided.
enum Decision<T> {
    /// No persisted state changed; the (possibly newly adopted) document is
    /// returned unchanged.
    Read(T),
    /// Persist: advance `documentGeneration`, durably replace, then publish
    /// the listed records in order.
    Write { value: T, publish: Vec<PublishSpec> },
}

/// One record to broadcast after a successful commit (`changed` reflects the
/// accepted record vs the store's previously established state).
struct PublishSpec {
    key: String,
    changed: bool,
    /// Name-reliability Task 12: why the saved name changed, logged after
    /// the commit (`session_name_events`). `None` for status-only publishes.
    change: Option<NameChangeEvent>,
}

impl PublishSpec {
    /// A record whose saved name changed for `change`'s reason.
    fn changed(key: String, change: NameChangeEvent) -> Self {
        Self {
            key,
            changed: true,
            change: Some(change),
        }
    }

    fn change_entry(&self) -> Option<(&str, &NameChangeEvent)> {
        self.change
            .as_ref()
            .map(|change| (self.key.as_str(), change))
    }
}

/// Context handed to every decision closure.
struct TxnMeta {
    now_ms: i64,
    /// The data-dir-keyed native retry-floor override
    /// ([`TestHook::NativeRetryFloorMs`]); always `None` in production (the
    /// helper is test-only).
    native_retry_floor: Option<i64>,
    /// Name-reliability Task 4: the store's staged native baselines (read
    /// as if persisted; written by the decisions that only stage).
    staged_baselines: Arc<StagedNativeBaselines>,
    /// Name-reliability Task 5: the prompt-input guard's drops in this
    /// transaction, logged once it commits.
    input_refusals: InputRefusals,
}

/// The adopted read model: the parsed document plus a digest of the exact
/// bytes it was adopted from (equal-generation-different-content detection)
/// and the stamp of the file they came from (name-reliability Task 11: the
/// lock-free reads' cross-process peek; `None` until stamped).
struct Adopted {
    document: StoredDocument,
    digest: [u8; 32],
    stamp: Option<DocumentStamp>,
}

struct NamesCore {
    data_dir: PathBuf,
    doc_path: PathBuf,
    tmp_path: PathBuf,
    lock_path: PathBuf,
    worker_lock_path: PathBuf,
    /// Local serialization: every transaction of this store takes a turn
    /// here (FIFO) before contending for the cross-process sidecar lock.
    local_turn: Arc<tokio::sync::Mutex<()>>,
    view: RwLock<Arc<Adopted>>,
    /// Name-reliability Task 11: when the view was last confirmed against
    /// the whole document (bounds how long an equal stamp is trusted).
    full_check: FullCheck,
    tx: broadcast::Sender<SessionNameUpdate>,
    /// Name-reliability Task 4: native baselines observed but not yet
    /// persisted (the sweep maintenance batch persists them).
    staged_baselines: Arc<StagedNativeBaselines>,
    /// This store's last commit whose durable replace ended uncertain, so
    /// the transaction that confirms it logs its name changes with their own
    /// causes (`session_name_events`).
    uncertain_commits: UncertainCommits,
}

/// Proof that the holder owns this store's local transaction turn; the strict
/// runner requires it, so no transaction reaches the sidecar lock unqueued.
type LocalTurn = tokio::sync::OwnedMutexGuard<()>;

impl NamesCore {
    fn current_view(&self) -> Arc<Adopted> {
        self.view.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Install the view the whole document was just read or written as
    /// (always under the document lock), which also confirms it.
    fn set_view(&self, document: StoredDocument, digest: [u8; 32], stamp: Option<DocumentStamp>) {
        *self.view.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(Adopted {
            document,
            digest,
            stamp,
        });
        self.full_check.mark();
    }

    fn publish(&self, updates: Vec<SessionNameUpdate>) {
        for update in updates {
            let _ = self.tx.send(update);
        }
    }
}

/// The durable name authority. `Arc`-shared; all methods are safe under
/// concurrency — the sidecar file lock is the only serialization point.
pub struct SessionNames {
    core: Arc<NamesCore>,
}

/// Ownership of the `.session-names-worker.lock` sidecar (Tasks 3–4): one
/// actual ready background operation across cooperating same-home processes
/// holds it. Acquire worker THEN document, never the reverse. The guard
/// never acquires the document lock, cannot be cloned, and is never
/// released through a detached timeout — it lives until its owner drops it.
// Tasks 3–4 seam: no caller until the background worker lands.
#[allow(dead_code)]
pub(crate) struct BackgroundGuard {
    _lock: HeldSidecarLock,
}

/// A held `flock` on one of the store's sidecar lock files.
///
/// The lock belongs to the open file description, and every descriptor that
/// shares that description keeps it alive. A child process forked by ANY
/// thread of this server (PTYs, provider sidecars, Git) while the lock is
/// held inherits such a descriptor and keeps it until the child execs, so
/// closing only this process's descriptor would leave the lock held after
/// the transaction (or worker hold) has ended — another participant, or
/// this store's own next transaction, would find it busy. Dropping the
/// guard therefore unlocks the description explicitly, which releases it
/// for every descriptor that shares it, and only then closes the handle.
struct HeldSidecarLock {
    file: std::fs::File,
    path: PathBuf,
}

impl Drop for HeldSidecarLock {
    fn drop(&mut self) {
        if let Err(error) = self.file.unlock() {
            // Closing the handle below still releases the lock once every
            // inherited descriptor is gone; report the slower path.
            tracing::warn!(
                target: "freshell_server::session_names",
                op = "unlock_sidecar",
                name_ref = "-",
                revision = 0,
                class = "sidecar_unlock_failed",
                lock_path = %self.path.display(),
                error = %error,
                "session_names.sidecar_unlock_failed: explicit unlock failed; the lock \
                 releases when the last inherited descriptor closes"
            );
        }
    }
}

impl std::fmt::Debug for BackgroundGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BackgroundGuard")
    }
}

impl SessionNames {
    /// Open (or initialize) the name document in `data_dir`, reconciling the
    /// current document's durability before success. Construction in
    /// `main.rs` is Task 2; legacy import is Task 7.
    pub fn open(data_dir: PathBuf) -> Result<Arc<Self>, NameError> {
        std::fs::create_dir_all(&data_dir).map_err(|e| {
            NameError::Persistence(format!(
                "cannot create session-names data dir {}: {e}",
                data_dir.display()
            ))
        })?;
        let canonical = std::fs::canonicalize(&data_dir).map_err(|e| {
            NameError::Persistence(format!(
                "cannot canonicalize session-names data dir {}: {e}",
                data_dir.display()
            ))
        })?;
        let (tx, _rx) = broadcast::channel(NAME_BROADCAST_CAPACITY);
        let core = Arc::new(NamesCore {
            doc_path: canonical.join(DOCUMENT_FILE_NAME),
            tmp_path: canonical.join(DOCUMENT_TMP_NAME),
            lock_path: canonical.join(LOCK_FILE_NAME),
            worker_lock_path: canonical.join(WORKER_LOCK_FILE_NAME),
            data_dir: canonical,
            local_turn: Arc::new(tokio::sync::Mutex::new(())),
            view: RwLock::new(Arc::new(Adopted {
                document: StoredDocument::initial(),
                digest: [0; 32],
                stamp: None,
            })),
            full_check: FullCheck::default(),
            tx,
            staged_baselines: Arc::new(StagedNativeBaselines::default()),
            uncertain_commits: UncertainCommits::default(),
        });
        // Reconcile/initialize the current document before success — the same
        // strict path every transaction takes (this is a blocking boot call).
        // The store is not shared yet, so its local turn is free.
        let turn = Arc::clone(&core.local_turn)
            .try_lock_owned()
            .expect("a store under construction has no other local transaction");
        run_txn_sync(&core, &turn, |_doc, _meta| {
            // Initialization is itself a persisted mutation: an absent
            // document is written at generation 1 (the runner forces the
            // write when the file was missing); an existing document is
            // reconciled and adopted.
            Ok(Decision::Read(()))
        })?;
        Ok(Arc::new(Self { core }))
    }

    /// Live canonical-name updates: own commits and adopted external changes,
    /// published in local generation order. Lag recovers by refresh/diff.
    pub fn subscribe(&self) -> broadcast::Receiver<SessionNameUpdate> {
        self.core.tx.subscribe()
    }

    /// Try to take the background worker lock (Tasks 3–4). `Ok(None)` means
    /// another cooperating process holds it; lock failures are errors.
    // Tasks 3–4 seam: no caller until the background worker lands.
    #[allow(dead_code)]
    pub(crate) fn try_background_guard(&self) -> Result<Option<BackgroundGuard>, NameError> {
        let file = open_lock_file(&self.core.worker_lock_path)?;
        match file.try_lock() {
            Ok(()) => Ok(Some(BackgroundGuard {
                _lock: HeldSidecarLock {
                    file,
                    path: self.core.worker_lock_path.clone(),
                },
            })),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(e)) => Err(NameError::LockUnavailable(format!(
                "worker lock error: {e}"
            ))),
        }
    }

    /// Internal automatic/migration offer seam: arbitrary callers cannot
    /// reach this through HTTP (routes land in Task 2 and never accept
    /// `freshell_ai`/`legacy_protected` from clients).
    // Tasks 3–4 seam: the automatic-name pipeline (first-message/AI offers)
    // is the next wiring task.
    #[allow(dead_code)]
    pub(crate) fn offer(
        &self,
        target: SessionNameRef,
        name: String,
        source: NameSource,
    ) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            offer_decision(doc, meta, &target, &name, source)
        }))
    }

    /// The unconditional full-document adoption: re-read the entire
    /// document under the lock (no stamp shortcut), reconcile an unfamiliar
    /// generation's durability, adopt it, and publish the delta to
    /// subscribers. Returns every record as updates (bootstrap/snapshot
    /// shape: each carries the full redirect list). The publisher's lag
    /// recovery uses it; name reads and the 2 s tick use the cheap stamp
    /// peek instead (`session_name_store_view`, name-reliability Task 11).
    pub(crate) fn refresh_current(&self) -> NameFuture<Vec<SessionNameUpdate>> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, _meta| {
            let updates: Vec<SessionNameUpdate> = doc
                .records
                .keys()
                .filter_map(|key| update_for_key(doc, key, false, RedirectScope::All))
                .collect();
            Ok(Decision::Read(updates))
        }))
    }

    /// Task 7: whether the one-time legacy-name consolidation receipt has
    /// committed. Once true, canonical readers stop consulting the migrated
    /// legacy title fields even while physical cleanup is still pending
    /// (boot retries the cleanup idempotently).
    pub(crate) fn migration_completed(&self) -> bool {
        self.core.current_view().document.migration.completed
    }

    /// Task 7 (review I1): commit the one-time consolidation's completion
    /// receipt. The consolidation runner calls this only after EVERY import
    /// chunk acknowledged — winner installs and acknowledged candidate ids
    /// commit per chunk (the plan's batching rule caps one import at
    /// [`NAME_MIGRATION_IMPORT_CANDIDATE_LIMIT`] candidates), while
    /// `completed` — the receipt the canonical readers and the next boot's
    /// gate consult — commits once, at the end, so a boot interrupted between
    /// chunks never marks an unfinished consolidation complete. Idempotent:
    /// committing an already-completed receipt is a pure read.
    pub(crate) fn complete_legacy_migration(&self) -> NameFuture<()> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, _meta| {
            if doc.migration.completed {
                return Ok(Decision::Read(()));
            }
            doc.migration.completed = true;
            Ok(Decision::Write {
                value: (),
                publish: Vec::new(),
            })
        }))
    }

    /// Task 7: import one captured legacy-evidence envelope. Every raw
    /// envelope gets its own immutable per-import backup
    /// (`name-migration-v1/imports/<SHA-256 of importId>.json`, create-once)
    /// BEFORE anything is acknowledged; the result acknowledges candidates
    /// one at a time (never an early whole-import shortcut) and carries the
    /// updates for the records the import touched — only after the backup
    /// and the canonical commit. The reserved
    /// [`NAME_MIGRATION_BOOT_IMPORT_ID`] family (the id itself and its
    /// `--N` chunk derivations, see [`is_boot_import_id`]) is the trusted
    /// server-boot lane: only it may honor `explicit_rename` (manual) and
    /// accepted-Freshell-AI classifications; the HTTP route rejects the
    /// whole family, so an arbitrary caller can never assert them. The
    /// import itself never completes the migration — the runner's final
    /// [`SessionNames::complete_legacy_migration`] does. Once that receipt
    /// has committed, a non-boot import is acknowledged in full and writes
    /// nothing at all (no backup, record or stored id; name-reliability
    /// Task 3).
    pub(crate) fn import_legacy(&self, input: LegacyNameImport) -> NameFuture<LegacyImportResult> {
        // `completed` never reverts, so once this store's view shows it a
        // browser import is answered without the document lock or a
        // re-read; a stale view falls through to the transaction, whose
        // decision applies the same rule.
        if !is_boot_import_id(&input.import_id) && self.migration_completed() {
            let result = session_name_import_policy::post_completion_acknowledge(&input);
            return Box::pin(async move { result });
        }
        let core = Arc::clone(&self.core);
        let backup_dir = core
            .data_dir
            .join(NAME_MIGRATION_DIR_NAME)
            .join(NAME_MIGRATION_IMPORTS_DIR_NAME);
        Box::pin(spawn_txn(core, move |doc, meta| {
            import_legacy_decision(doc, meta, &backup_dir, input)
        }))
    }

    /// Durable generation work-claim seam (Task 4's worker dispatches through
    /// this): persist an attempt's start before any provider call, charging
    /// one of the bounded three starts. The claim never exhausts the series
    /// or drops its input — the fold decides (name-reliability Task 6).
    /// `Ok(None)` = the series is not claimable right now (absent, not yet
    /// due, already in flight, exhausted, or the record's accepted source
    /// is protected) — nothing was consumed.
    // Tasks 3–4 seam: the generation worker lands next.
    #[allow(dead_code)]
    pub(crate) fn claim_generation_start(
        &self,
        target: SessionNameRef,
        attempt_id: String,
    ) -> NameFuture<Option<GenerationClaim>> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            claim_generation_start_decision(doc, meta, &target, &attempt_id)
        }))
    }

    /// Durable generation completion seam (Task 4's worker folds answers
    /// through this): accept a Freshell AI answer only if that same series
    /// is current, the captured input fingerprint still matches the
    /// persisted series (a re-armed series keeps its series id, so a late
    /// answer generated from older input must not be accepted), and the
    /// accepted source is below Freshell AI; empty/failed outcomes schedule
    /// the bounded retry (30s after failure 1, five minutes after failure
    /// 2) without consuming another start, or exhaust the series at the
    /// cap; capability and quota outcomes refund the start
    /// (name-reliability Task 6).
    // Tasks 3–4 seam: the generation worker lands next.
    #[allow(dead_code)]
    pub(crate) fn fold_generation_outcome(
        &self,
        target: SessionNameRef,
        series_id: String,
        input_fingerprint: String,
        outcome: GenerationOutcome,
    ) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            fold_generation_outcome_decision(
                doc,
                meta,
                &target,
                &series_id,
                &input_fingerprint,
                outcome,
            )
        }))
    }

    /// Task 4: the generation selector's snapshot — every ARMED generation
    /// series that is due now, from the currently adopted view (the claim
    /// itself is the strict transaction; this read never takes the document
    /// lock). Protected records and exhausted/absent/not-yet-due series are
    /// omitted.
    pub(crate) fn generation_work_snapshot(&self) -> Vec<GenerationWorkItem> {
        let view = self.core.current_view();
        let document = &view.document;
        let now = effective_now_ms(&self.core.data_dir);
        let mut items = Vec::new();
        for (key, series) in &document.generation {
            if series.status != GenerationStatus::Eligible
                || series.consumed >= MAX_GENERATION_STARTS
            {
                continue;
            }
            if let Some(due) = series.next_due {
                if due > now {
                    continue;
                }
            }
            let Some(record) = document.record_at(key) else {
                continue;
            };
            if source_is_protected(record.source) {
                continue;
            }
            items.push(GenerationWorkItem {
                target: record.name_ref.clone(),
                series_id: series.series_id.clone(),
                input_fingerprint: series.input_fingerprint.clone().unwrap_or_default(),
                excerpt: series.excerpt.clone(),
                consumed: series.consumed,
                next_due: series.next_due,
            });
        }
        items
    }

    /// Task 4: how many series are currently InFlight (a start was persisted
    /// but never folded — a dispatch interrupted by process death). The
    /// worker recovers each once while holding the background guard.
    pub(crate) fn interrupted_generation_count(&self) -> usize {
        let view = self.core.current_view();
        view.document
            .generation
            .values()
            .filter(|series| series.status == GenerationStatus::InFlight)
            .count()
    }

    /// Task 4: recover every interrupted generation start ONCE as failed at
    /// recovery time, scheduling the remaining delay from this fold. Only a
    /// background-guard holder ever dispatches, so an InFlight series seen
    /// under the guard is provably dead. Returns the recovered count.
    pub(crate) fn recover_interrupted_generation(&self) -> NameFuture<usize> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            recover_interrupted_generation_decision(doc, meta)
        }))
    }

    /// Task 4: the persisted alternating class cursor's last-served class
    /// (`"native"`/`"generation"`) — the worker alternates classes when both
    /// have ready work.
    pub(crate) fn scheduling_cursor_last_class(&self) -> Option<String> {
        self.core
            .current_view()
            .document
            .scheduling_cursor
            .last_class
            .clone()
    }

    /// Task 4: whether a scoped session's record can still use generation
    /// input — true when no record exists yet (hydration needs the message)
    /// or the record's accepted source is below protection and its series
    /// is not exhausted AND has not yet captured an input fingerprint
    /// (review M4: first messages are immutable, so once a series carries
    /// its input fingerprint the targeted first-message lookup has no
    /// remaining eligibility value — an armed-unexhausted named opencode
    /// session never pays the transcript read again on every pass).
    /// One of the two conditions that gate the sweep's targeted
    /// first-message lookups (with [`Self::needs_first_message_input`],
    /// name-reliability Task 5): an input-carrying, exhausted, or protected
    /// session pays a transcript read only while its NAME can still use the
    /// message, and the sweep remembers each answer across passes.
    pub(crate) fn needs_generation_input(&self, target: &SessionNameRef) -> bool {
        let view = self.core.current_view();
        let document = &view.document;
        let (resolved, _) = document.resolve_ref(target);
        let key = name_ref_key(&resolved);
        let Some(record) = document.record_at(&key) else {
            return true;
        };
        if source_is_protected(record.source) {
            return false;
        }
        match document.generation.get(&key) {
            None => true,
            Some(series) => {
                series.status != GenerationStatus::Exhausted && series.input_fingerprint.is_none()
            }
        }
    }

    /// Name-reliability Task 5 (C5): whether a scoped session's record can
    /// still use its first user message as a NAME — true when no record
    /// exists yet, the record is below `first_message`, or the record is a
    /// self-heal record (a junk default label) under the index row's folder
    /// `cwd`. The sweep's targeted OpenCode first-message lookup runs when
    /// this OR [`Self::needs_generation_input`] holds, so a session stuck on
    /// its folder name gets the lookup even after generation stopped
    /// needing input. A lock-free read of the adopted view.
    pub(crate) fn needs_first_message_input(
        &self,
        target: &SessionNameRef,
        cwd: Option<&str>,
    ) -> bool {
        let view = self.core.current_view();
        let document = &view.document;
        let (resolved, _) = document.resolve_ref(target);
        document
            .record_at(&name_ref_key(&resolved))
            .is_none_or(|record| {
                session_name_first_message::record_needs_first_message(record, cwd)
            })
    }

    /// Task 4 dispatch re-check: whether the target's CURRENT accepted
    /// record is a protected winner (manual / migration-protected /
    /// accepted Freshell AI). The generation worker consults this between
    /// its claim and the provider call — a MANUAL pending winner can bind
    /// in that window (the materialization race), and a protected winner
    /// stops generation, so the paid call is skipped and the fold's
    /// protected arm closes the series.
    pub(crate) fn generation_blocked_by_protected_winner(&self, target: &SessionNameRef) -> bool {
        let view = self.core.current_view();
        let (resolved, _) = view.document.resolve_ref(target);
        view.document
            .record_at(&name_ref_key(&resolved))
            .map(|record| source_is_protected(record.source))
            .unwrap_or(false)
    }

    /// Task 4: index hydration for one scoped CLI session — install the free
    /// fallbacks (provider title > first message > directory basename) as a
    /// durable record when absent, WITHOUT scheduling any paid title across
    /// history. With `absorb`, a present first user message populates the
    /// series' input fingerprint/excerpt at rest (Idle — never eligible):
    /// the boot snapshot must not arm generation for every historical
    /// session. Wrapper or derived text is never absorbed (name-reliability
    /// Task 5). The absorbed series arms only on an explicit open — the
    /// bind's explicit-open hook, or the `Opened` edge of a session open in
    /// a live terminal; a changed message that a later pass's index feeds
    /// re-absorbs at rest instead (`session_name_first_message::plan_series`),
    /// and a newly observed message arms only a session with no series yet.
    /// An existing record is returned unchanged — except a self-heal record
    /// (name-reliability Task 4: a junk default label), which the ladder's
    /// first allowed rung replaces (no series is created or absorbed on that
    /// path).
    pub(crate) fn hydrate_indexed(
        &self,
        input: IndexedNameInput,
        absorb: bool,
    ) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            hydrate_indexed_decision(doc, meta, input, absorb)
        }))
    }

    /// Delta-review round 3, finding 2 — the adopted-view pre-check for the
    /// sweep's hydration feed, in the [`Self::needs_generation_input`] pattern (a
    /// lock-free read of the current in-memory view). Any answer but
    /// [`SweepWork::None`] means the strict hydrate transaction is still
    /// needed; `None` means the view PROVES it would be a no-op Read, so the
    /// sweep skips transacting. Runs the SAME
    /// `plan_hydrate` the transaction applies (name-reliability Task 4, C2),
    /// so the pre-check and the apply can never drift.
    ///
    /// Staleness (name-reliability Task 4, C3): a record's stored rank CAN
    /// decrease — a heal moves a junk `provider_ai` name to `first_message`
    /// and a junk `first_message` name to `directory` — so "settled on the
    /// view" is not permanent. The remaining safety direction: a stale
    /// adopted view only DELAYS work, it never loses it. A record present in
    /// the view is present in every later generation (durable session keys
    /// are never removed; a foreign document lacking the record would need a
    /// lower or content-rewritten equal generation, both fenced as loud
    /// Persistence errors), so the insert is never skipped wrongly; and a
    /// foreign writer that stores a junk name (in practice only an older
    /// binary sharing the data dir) is seen at the next adopted-view refresh
    /// — the unconditional 2 s tick, a bootstrap read, or any local
    /// transaction — after which the pre-check reports the heal. A
    /// first-boot fsync per genuinely-new record remains — real durable
    /// work, paid once per session ever, not once per pass.
    ///
    /// The answer classifies the work for the sweep: an insert of a new
    /// record is per-row work ([`SweepWork::Immediate`]); a self-heal
    /// replacement rides the pass's maintenance batch
    /// ([`SweepWork::Maintenance`]).
    pub(crate) fn hydrate_work(&self, input: &IndexedNameInput) -> SweepWork {
        let view = self.core.current_view();
        match session_name_policy::plan_hydrate(&view.document, input) {
            None => SweepWork::None,
            Some(session_name_policy::HydratePlan::Insert { .. }) => SweepWork::Immediate,
            Some(session_name_policy::HydratePlan::Heal { .. }) => SweepWork::Maintenance,
        }
    }

    /// Delta-review round 3, finding 2 — the adopted-view pre-check for the
    /// sweep's activity feed: any answer but [`SweepWork::None`] means the
    /// strict activity transaction would still change something (or the
    /// target has no record, so the transaction must surface its NotFound
    /// exactly as before); `None` means the view PROVES a no-op Read. Runs
    /// the SAME
    /// [`plan_activity`] policy the transaction applies — the activity's
    /// folder included (name-reliability Task 4, C1) — so the pre-check and
    /// the apply can never drift.
    ///
    /// Cross-process staleness (name-reliability Task 4, C3): a record's
    /// stored rank CAN decrease (the self-heal rule replaces a junk
    /// `provider_ai` name with the first message), so a foreign commit can
    /// turn a plan-noop into plan-pending through the offer arm — in
    /// practice only an older binary storing a junk name. The safety
    /// direction that remains: a stale view only DELAYS that work; the next
    /// pass after any adopted-view refresh (the unconditional 2 s tick,
    /// bootstrap reads, or any local transaction's adoption) sees the junk
    /// name and heals it. The arming arm becomes pending only when the
    /// series' input fingerprint differs from the fed message — a foreign
    /// process moving the fingerprint away means ITS transaction armed the
    /// series with a newer message (work exists and will run; the input
    /// changed, not lost). A genuinely new record is always "pending" here,
    /// so a foreign process's hydration is never skipped over.
    ///
    /// The answer classifies the work for the sweep: a plan that is only
    /// maintenance — a self-heal replacement (Task 4), a re-derived first
    /// message re-absorbed at rest, or refused wrapper input dropped
    /// (Task 5) — rides the pass's maintenance batch
    /// ([`SweepWork::Maintenance`]); anything that arms generation, raises a
    /// real name's rank, or must surface NotFound transacts on its own
    /// ([`SweepWork::Immediate`]). Every non-boot pass feeds each indexed
    /// session's first message, and an open or resumed session's message
    /// now offers the fallback too, so the plan settles (None) once the
    /// name and the series' input agree with the message.
    pub(crate) fn activity_work(&self, input: &NameActivity) -> SweepWork {
        let view = self.core.current_view();
        let Ok((key, _record)) = required_record(&view.document, &input.target) else {
            return SweepWork::Immediate;
        };
        if !freshell_freshagent::naming::is_unified_agent_mode(Some(&input.mode), None) {
            return SweepWork::None;
        }
        let plan = plan_activity(
            &view.document,
            &key,
            input.reason,
            input.first_user_message.as_deref(),
            input.cwd.as_deref(),
        );
        if plan.is_noop() {
            SweepWork::None
        } else if plan.is_maintenance() {
            SweepWork::Maintenance
        } else {
            SweepWork::Immediate
        }
    }

    /// Test seam: whether [`Self::hydrate_work`] reports any work.
    #[cfg(test)]
    pub(crate) fn hydrate_indexed_pending(&self, input: &IndexedNameInput) -> bool {
        self.hydrate_work(input) != SweepWork::None
    }

    /// Test seam: whether [`Self::activity_work`] reports any work.
    #[cfg(test)]
    pub(crate) fn activity_pending(&self, input: &NameActivity) -> bool {
        self.activity_work(input) != SweepWork::None
    }

    /// Task 3: the store's CURRENT verified location revision for `target`
    /// (0 when none exists) — the stamp live provider lanes fold their
    /// observations with, so an old-location observation can never masquerade
    /// as current.
    pub(crate) fn location_revision_of(&self, target: &SessionNameRef) -> NameRevision {
        let view = self.core.current_view();
        let doc = &view.document;
        let (resolved, _) = doc.resolve_ref(target);
        let key = name_ref_key(&resolved);
        doc.locations
            .get(&key)
            .and_then(|location| location.verified.as_ref())
            .map(|verified| verified.location_revision)
            .unwrap_or(0)
    }

    /// Task 3: the native work selector's snapshot — every ARMED native series
    /// whose next cycle is due now, from the currently adopted view (the claim
    /// itself is the strict transaction; this read never takes the document
    /// lock). Missing routes are omitted (paused, consuming nothing).
    pub(crate) fn native_work_snapshot(&self) -> Vec<crate::session_name_native::NativeWorkItem> {
        let view = self.core.current_view();
        let document = &view.document;
        // Delta-review round 3, finding 7: the offset-aware decision clock,
        // exactly like generation_work_snapshot — the real-clock now_ms()
        // made the due filter ignore the test ClockOffsetMs hook its
        // clock-controlled sibling tests rely on.
        let now = effective_now_ms(&self.core.data_dir);
        let mut items = Vec::new();
        for (key, state) in &document.native_write {
            if state.settled || state.cycles_consumed >= MAX_NATIVE_CYCLES {
                continue;
            }
            if state.status == NativeSyncStatus::Synced
                || state.status == NativeSyncStatus::Unsupported
            {
                continue;
            }
            if let Some(due) = state.next_due {
                if due > now {
                    continue;
                }
            }
            let Some(record) = document.records.get(key) else {
                continue;
            };
            if state.desired_revision != Some(record.revision) || !source_is_writable(record.source)
            {
                continue;
            }
            let Some(location) = document.locations.get(key).and_then(|location| {
                location
                    .verified
                    .as_ref()
                    .map(|verified| (verified.location.clone(), verified.location_revision))
                    .or_else(|| {
                        location
                            .prospective
                            .as_ref()
                            .map(|prospective| (prospective.clone(), 0))
                    })
            }) else {
                // No route: the series pauses before consuming a cycle.
                continue;
            };
            items.push(crate::session_name_native::NativeWorkItem {
                target: record.name_ref.clone(),
                location: location.0,
                location_revision: location.1,
                desired_revision: record.revision,
                desired_name: state
                    .desired_name
                    .clone()
                    .unwrap_or_else(|| record.name.clone()),
                desired_source: state.desired_source.unwrap_or(record.source),
                cycles_consumed: state.cycles_consumed,
                next_due: state.next_due,
            });
        }
        items
    }

    /// Unified agent names (Task 8 acceptance): claude session refs whose
    /// native write series is ARMED but has NO route (no verified or
    /// prospective location). The index-adopted flow — the auto-title
    /// sweep's hydration creates the record — attaches no location; only a
    /// pane's runtime lane does. The native worker's on-demand discovery
    /// resolves these by session id before the series can run.
    pub(crate) fn paused_claude_series_without_route(&self) -> Vec<SessionNameRef> {
        let view = self.core.current_view();
        let document = &view.document;
        let mut refs = Vec::new();
        for (key, state) in &document.native_write {
            if state.settled || state.cycles_consumed >= MAX_NATIVE_CYCLES {
                continue;
            }
            if state.status == NativeSyncStatus::Synced
                || state.status == NativeSyncStatus::Unsupported
            {
                continue;
            }
            let Some(record) = document.records.get(key) else {
                continue;
            };
            if !matches!(
                record.name_ref,
                SessionNameRef::Session {
                    provider: NamedProvider::Claude,
                    ..
                }
            ) {
                continue;
            }
            if document.locations.get(key).is_some_and(|location| {
                location.verified.is_some() || location.prospective.is_some()
            }) {
                continue;
            }
            refs.push(record.name_ref.clone());
        }
        refs
    }

    /// Task 3: charge one native cycle before dispatch — persisting the
    /// desired revision/name/source, the attempted location/locationRevision,
    /// and the unique own-write receipt BEFORE the provider call, re-resolved
    /// from the CURRENT document (never a queued stale value). `None` means
    /// the series is not claimable right now (exhausted, settled, not yet
    /// due, or no route — nothing was consumed).
    pub(crate) fn claim_native_cycle(
        &self,
        target: SessionNameRef,
        receipt_id: String,
    ) -> NameFuture<Option<crate::session_name_native::NativeCycleClaim>> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            claim_native_cycle_decision(doc, meta, &target, &receipt_id)
        }))
    }

    /// Task 3: charge one read against the six-per-revision allowance,
    /// persisted before the read dispatch, carrying the dispatching series'
    /// epoch. `false` = the allowance is exhausted (or the series was
    /// superseded) and the read must not run.
    pub(crate) fn charge_native_read(
        &self,
        target: SessionNameRef,
        series_epoch: NameRevision,
    ) -> NameFuture<bool> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, _meta| {
            charge_native_read_decision(doc, &target, series_epoch)
        }))
    }

    /// Task 3: fold one classified native outcome into the durable series,
    /// stamped with the dispatching series' epoch. Stale outcomes (a newer
    /// name decision, a superseded series, or a relocated target) can never
    /// change the saved winner or mark anything synchronized; ordinary
    /// confirmed success plus a current-revision readback synchronizes the
    /// EXACT revision/location. Folds that move the projection publish a
    /// status-only frame (`changed: false`).
    pub(crate) fn fold_native_outcome(
        &self,
        target: SessionNameRef,
        attempted_location_revision: NameRevision,
        series_epoch: NameRevision,
        outcome: crate::session_name_native::NativeOutcomeFold,
    ) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            fold_native_outcome_decision(
                doc,
                meta,
                &target,
                attempted_location_revision,
                series_epoch,
                outcome,
            )
        }))
    }
}

impl SessionNames {
    /// Name-reliability Task 4 (test seam): the native baseline staged in
    /// memory for `target`, if any.
    #[cfg(test)]
    pub(crate) fn staged_native_baseline(&self, target: &SessionNameRef) -> Option<String> {
        let (resolved, _) = self.core.current_view().document.resolve_ref(target);
        self.core.staged_baselines.title(&name_ref_key(&resolved))
    }

    /// Name-reliability Task 4: whether any native baseline waits for the
    /// sweep maintenance batch.
    pub(crate) fn has_staged_native_baselines(&self) -> bool {
        !self.core.staged_baselines.is_empty()
    }

    /// Name-reliability Task 4 (LB-B1): the sweep pass's ONE maintenance
    /// transaction — the queued self-heal items (at most
    /// [`SWEEP_MAINTENANCE_BATCH`]; the queue counts the rest as deferred)
    /// re-planned on the fresh document, then staged native baselines in
    /// the remaining room, summarized in one INFO line once it committed.
    /// Nothing queued and nothing staged answers at once, without a
    /// transaction.
    pub(crate) fn sweep_maintenance(
        &self,
        batch: impl Into<SweepMaintenanceQueue>,
    ) -> NameFuture<SweepMaintenanceReport> {
        let batch = batch.into();
        if batch.is_empty() && !self.has_staged_native_baselines() {
            return Box::pin(async { Ok(SweepMaintenanceReport::default()) });
        }
        let core = Arc::clone(&self.core);
        Box::pin(async move {
            let data_dir = core.data_dir.clone();
            let report = spawn_txn(core, move |doc, meta| {
                session_name_sweep_batch::sweep_maintenance_decision(doc, meta, batch)
            })
            .await?;
            // Summarized only once committed (or settled as a Read).
            report.log_committed(&data_dir);
            Ok(report)
        })
    }
}

impl SessionNaming for SessionNames {
    /// Name-reliability Task 11: served from the adopted view after the
    /// stamp peek — no document lock, no re-parse while nothing changed
    /// (`session_name_store_view`).
    fn get(&self, refs: Vec<SessionNameRef>) -> NameFuture<Vec<SessionNameUpdate>> {
        Box::pin(session_name_store_view::read_names(
            Arc::clone(&self.core),
            refs,
        ))
    }

    fn ensure_pending(&self, input: PendingNameInput) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            ensure_pending_decision(doc, meta, input)
        }))
    }

    fn bind_pending(&self, input: BindNameInput) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            bind_pending_decision(doc, meta, input)
        }))
    }

    fn ensure_session(
        &self,
        target: SessionNameRef,
        cwd: Option<String>,
    ) -> NameFuture<SessionNameUpdate> {
        Box::pin(spawn_txn(Arc::clone(&self.core), move |doc, _meta| {
            session_name_continuation::ensure_session(doc, target, cwd)
        }))
    }

    fn continue_session(
        &self,
        source: SessionNameRef,
        target: SessionNameRef,
    ) -> NameFuture<Option<SessionNameUpdate>> {
        Box::pin(spawn_txn(Arc::clone(&self.core), move |doc, meta| {
            session_name_continuation::continue_session(doc, meta.now_ms, source, target)
        }))
    }

    fn rename(&self, input: RenameNameInput) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            rename_decision(doc, meta, input)
        }))
    }

    fn activity(&self, input: NameActivity) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            activity_decision(doc, meta, input)
        }))
    }

    fn observe_native(&self, input: NativeNameObservation) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            observe_native_decision(doc, meta, input)
        }))
    }

    fn current_location_revision(&self, target: &SessionNameRef) -> NameFuture<NameRevision> {
        let revision = self.location_revision_of(target);
        Box::pin(async move { Ok(revision) })
    }

    fn record_acquisition(
        &self,
        target: SessionNameRef,
        acquisition: NativeAcquisition,
    ) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            record_acquisition_decision(doc, meta, &target, acquisition)
        }))
    }
}

// ---------------------------------------------------------------------------
// Naming publisher (Task 2 wiring)
// ---------------------------------------------------------------------------

/// Unified agent names (Task 2): the naming publisher task body — every
/// committed update (this process's own writes and adopted external ones)
/// reaches WS clients as the canonical `session.name.updated` frame, refreshes
/// the registry display caches of every terminal bound to the record (title
/// write-through), and invalidates the session directory (`sessions.changed`)
/// for title-overriding changes — manual and migration-protected renames, the
/// only commit class that moves a served row's `title` (see
/// [`overrides_directory_title`]) — so renamed rows re-read immediately.
/// Automatic installs and status-only updates never invalidate the directory:
/// they never move a served title, and every client surface converges them
/// through the canonical frame itself (the sidebar reads the canonical cache
/// before the row's string projection), so an invalidation there would be
/// refetch churn — session09's content-identical-rewrite quiet window pins
/// the live case (a freshly created session's hydration commit lands up to
/// one auto-title tick after the sweep already invalidated the create).
/// Extracted from `main`'s spawned block so the subscription-lag recovery is
/// testable against the real store.
///
/// Subscription-lag recovery (plan rule 8): a `Lagged` recv — a burst of
/// commits overran the broadcast history while this task was slow —
/// re-adopts the full document (`refresh_current`, a strict Read that does
/// NOT re-publish to the channel) and re-diffs EVERY record through the
/// same push, so a missed frame cannot leave a registry display cache or a
/// WS client stale until the record changes again. A `Closed` channel ends
/// the task — never a busy-loop.
pub(crate) async fn run_naming_publisher(
    names: Arc<SessionNames>,
    mut updates: broadcast::Receiver<SessionNameUpdate>,
    registry: freshell_terminal::TerminalRegistry,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    sessions_revision: Arc<std::sync::atomic::AtomicI64>,
) {
    async fn push(
        registry: &freshell_terminal::TerminalRegistry,
        broadcast_tx: &tokio::sync::broadcast::Sender<String>,
        sessions_revision: &std::sync::atomic::AtomicI64,
        update: SessionNameUpdate,
    ) {
        for terminal_id in registry.terminals_bound_to(&update.record.name_ref) {
            registry.update_session_name(&terminal_id, &update.record);
        }
        let frame = freshell_protocol::ServerMessage::SessionNameUpdated(
            freshell_protocol::session_names::SessionNameUpdated {
                record: update.record.clone(),
                document_generation: update.document_generation,
                redirects: update.redirects.clone(),
                changed: update.changed,
                native_sync: update.native_sync.clone(),
            },
        );
        if let Ok(serialized) = serde_json::to_string(&frame) {
            let _ = broadcast_tx.send(serialized);
        }
        // The unified revision advances for EVERY push (the lag-recovery
        // pin: a recovered burst re-diffs every record through this same
        // path, and a skipped token is harmless — frame revisions only
        // need to be strictly monotonic).
        let revision = sessions_revision.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        // Directory invalidation rides ONLY on a commit that can move a
        // served row's `title` — the same override rule the read-side
        // projection applies. The canonical frame above already converges
        // every client surface for the remaining commit classes.
        if update.changed && overrides_directory_title(update.record.source) {
            let _ = broadcast_tx.send(
                serde_json::json!({ "type": "sessions.changed", "revision": revision }).to_string(),
            );
        }
    }

    loop {
        match updates.recv().await {
            Ok(update) => {
                push(&registry, &broadcast_tx, &sessions_revision, update).await;
            }
            Err(broadcast::error::RecvError::Lagged(missed)) => {
                tracing::warn!(
                    target: "freshell_server::session_names",
                    op = "publisher_lag",
                    name_ref = "-",
                    revision = 0,
                    class = "lagged",
                    missed = missed,
                    "session_names.operation_failed: publisher lagged behind {missed} \
                     update(s); re-adopting the document and re-diffing every record"
                );
                match names.refresh_current().await {
                    Ok(recovered) => {
                        // The recovery re-pushes every record (bootstrap
                        // shape: `changed` is false for all of them), so the
                        // per-push gate above cannot fire — the publisher
                        // decides the invalidation for the WHOLE re-diff:
                        // one `sessions.changed` iff any recovered record is
                        // title-overriding, so a missed manual rename still
                        // invalidates the directory. An automatic-only
                        // document never does — its canonical frames above
                        // already converge every client surface.
                        let directory_visible = recovered
                            .iter()
                            .any(|update| overrides_directory_title(update.record.source));
                        for update in recovered {
                            push(&registry, &broadcast_tx, &sessions_revision, update).await;
                        }
                        if directory_visible {
                            let revision = sessions_revision
                                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                                + 1;
                            let _ = broadcast_tx.send(
                                serde_json::json!({
                                    "type": "sessions.changed",
                                    "revision": revision
                                })
                                .to_string(),
                            );
                        }
                    }
                    Err(error) => {
                        tracing::warn!(
                            target: "freshell_server::session_names",
                            op = "refresh_current",
                            name_ref = "-",
                            revision = 0,
                            class = %error.code(),
                            "session_names.operation_failed: {error}"
                        );
                    }
                }
            }
            Err(broadcast::error::RecvError::Closed) => {
                // The store is gone (its Arc dropped with it): the publisher
                // ends.
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Transaction runner
// ---------------------------------------------------------------------------

async fn spawn_txn<T, F>(core: Arc<NamesCore>, f: F) -> Result<T, NameError>
where
    T: Send + 'static,
    F: FnOnce(&mut StoredDocument, &TxnMeta) -> Result<Decision<T>, NameError> + Send + 'static,
{
    // Local serialization: wait (FIFO) for this store's turn before touching
    // the cross-process lock. Turn holders run document IO only (no provider
    // call happens under a transaction), so the wait normally ends when the
    // local queue ahead of us drains; the one-second retry budget below is
    // left for contention with another process. A caller that stops waiting
    // here simply leaves the queue — nothing has started.
    let turn = await_local_turn(&core).await;
    // The blocking-IO owner retains its turn and lock guard until completion
    // even if the caller stops waiting: dropping this handle detaches the
    // spawn_blocking task, which runs to completion on its own.
    let handle = tokio::task::spawn_blocking(move || run_txn_sync(&core, &turn, f));
    match handle.await {
        Ok(result) => result,
        Err(join_err) => Err(NameError::Persistence(format!(
            "naming transaction task failed: {join_err}"
        ))),
    }
}

/// Take this store's local turn (FIFO). Nothing bounds this wait — a queued
/// caller must not fail just because this process's own durable writes are
/// slow — so a wait that crosses [`LOCK_RETRY_BUDGET`] is reported WHILE it
/// lasts (`session_names.local_turn_slow`, the caller still queued), and its
/// end is reported once the turn arrives (`session_names.local_turn_resumed`).
/// A turn holder that never finishes (a durable write wedged on a stalled
/// disk) therefore shows up in the log within a second instead of silently
/// hanging every naming caller.
async fn await_local_turn(core: &NamesCore) -> LocalTurn {
    let queued_at = Instant::now();
    // One pinned acquisition future for the whole wait: re-creating it after
    // the timeout would give up this caller's place in the FIFO queue.
    let mut acquire = std::pin::pin!(Arc::clone(&core.local_turn).lock_owned());
    if let Ok(turn) = tokio::time::timeout(LOCK_RETRY_BUDGET, acquire.as_mut()).await {
        return turn;
    }
    let waited = queued_at.elapsed();
    tracing::warn!(
        target: "freshell_server::session_names",
        op = "local_turn",
        name_ref = "-",
        revision = 0,
        class = "slow_local_turn",
        queued_ms = waited.as_millis() as u64,
        data_dir = %core.data_dir.display(),
        "session_names.local_turn_slow: a naming transaction has waited {} ms behind \
         this process's own naming transactions and is still queued (a slow or \
         stalled durable write holds the turn)",
        waited.as_millis()
    );
    let turn = acquire.await;
    let queued = queued_at.elapsed();
    tracing::info!(
        target: "freshell_server::session_names",
        op = "local_turn",
        name_ref = "-",
        revision = 0,
        class = "slow_local_turn_resumed",
        queued_ms = queued.as_millis() as u64,
        data_dir = %core.data_dir.display(),
        "session_names.local_turn_resumed: a naming transaction got its turn after \
         waiting {} ms behind this process's own naming transactions",
        queued.as_millis()
    );
    turn
}

fn run_txn_sync<T, F>(core: &NamesCore, turn: &LocalTurn, f: F) -> Result<T, NameError>
where
    F: FnOnce(&mut StoredDocument, &TxnMeta) -> Result<Decision<T>, NameError>,
{
    let guard = acquire_document_lock(&core.lock_path)?;
    run_txn_locked(core, turn, guard, f)
}

/// The transaction body, run while the caller holds this store's local turn
/// and `_guard` holds the document lock (the reads' short-wait adoption
/// takes both its own way, `session_name_store_view`).
fn run_txn_locked<T, F>(
    core: &NamesCore,
    _turn: &LocalTurn,
    _guard: HeldSidecarLock,
    f: F,
) -> Result<T, NameError>
where
    F: FnOnce(&mut StoredDocument, &TxnMeta) -> Result<Decision<T>, NameError>,
{
    count_store_transaction_for_test(&core.data_dir);
    test_hold_once(&core.data_dir);

    let raw = session_name_store_view::read_with_stamp(&core.doc_path);
    let (mut document, raw_digest, raw_stamp, first_init) = match raw {
        Ok((bytes, stamp)) => {
            let digest = digest_bytes(&bytes);
            (parse_document(&bytes)?, digest, Some(stamp), false)
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            // A missing document is initialization ONLY for a store with no
            // established view. Once a snapshot has been adopted, a vanished
            // document is external data loss: silently reinitializing would
            // permanently discard every accepted name (and a cooperating
            // second process could adopt the empty lineage). Fence instead
            // and keep the established view.
            if core.current_view().document.document_generation > 0 {
                return Err(NameError::Persistence(
                    "the session-names document vanished while this store held an established view; refusing to reinitialize over it"
                        .into(),
                ));
            }
            (StoredDocument::initial(), [0u8; 32], None, true)
        }
        Err(e) => {
            return Err(NameError::Persistence(format!(
                "cannot read session-names document {}: {e}",
                core.doc_path.display()
            )))
        }
    };

    if !first_init {
        let prior = core.current_view();
        if document.document_generation < prior.document.document_generation {
            return Err(NameError::Persistence(
                "session-names document generation decreased".into(),
            ));
        }
        if document.document_generation == prior.document.document_generation
            && raw_digest != prior.digest
        {
            return Err(NameError::Persistence(
                "session-names document changed content at an equal generation".into(),
            ));
        }
        if document.document_generation != prior.document.document_generation {
            reconcile_durability(&core.doc_path, &core.data_dir)?;
        }
    }
    // The name changes since the adopted view — another participant's
    // commits, and this store's own uncertain one — captured before this
    // decision mutates the document (name-reliability Task 12).
    let adopted = if first_init {
        AdoptedChanges::default()
    } else {
        core.uncertain_commits.adopted_changes(
            &core.current_view().document,
            &document,
            &raw_digest,
        )
    };

    let meta = TxnMeta {
        now_ms: effective_now_ms(&core.data_dir),
        native_retry_floor: take_native_retry_floor(&core.data_dir),
        staged_baselines: Arc::clone(&core.staged_baselines),
        input_refusals: InputRefusals::default(),
    };
    let decision = f(&mut document, &meta)?;

    match decision {
        Decision::Read(value) => {
            if first_init {
                // Initialization is a persisted mutation: establish the
                // document at generation 1 (no visible records to publish).
                document.document_generation += 1;
                let bytes = serialize_document(&document)?;
                let digest = digest_bytes(&bytes);
                write_durable(core, &document, &bytes, digest)?;
                return Ok(value);
            }
            // A staged baseline another participant already persisted (or
            // whose record is gone) is no longer pending work.
            core.staged_baselines.prune_persisted(&document);
            if adopt_if_newer(core, document, raw_digest, raw_stamp, true) {
                core.uncertain_commits.log_adopted(adopted);
            } else {
                // The file still holds the adopted generation.
                session_name_store_view::confirm_view(core, raw_stamp);
            }
            Ok(value)
        }
        Decision::Write { value, publish } => {
            let prior = core.current_view();
            document.document_generation += 1;
            let bytes = serialize_document(&document)?;
            let digest = digest_bytes(&bytes);
            if let Err(error) = write_durable(core, &document, &bytes, digest) {
                if matches!(error, NameError::CommitUncertain(_)) {
                    // The replacement landed but is unconfirmed: its name
                    // changes are logged by the transaction that confirms it.
                    core.uncertain_commits.remember(
                        adopted,
                        document,
                        digest,
                        publish.iter().filter_map(PublishSpec::change_entry),
                    );
                }
                return Err(error);
            }
            core.staged_baselines.prune_persisted(&document);
            // Committed: log the adopted and the own name changes.
            core.uncertain_commits.log_adopted(adopted);
            session_name_events::log_name_changes(
                &document,
                publish.iter().filter_map(PublishSpec::change_entry),
            );
            meta.input_refusals.log_committed();
            // Publish while the lock is still held: local generation order.
            let updates =
                session_name_publish::committed_updates(&prior.document, &document, &publish);
            core.publish(updates);
            Ok(value)
        }
    }
}

/// Serialize, then durably replace — classifying pre-replace failure (old
/// state intact) from post-replace uncertainty. On any write failure the
/// previously established snapshot is retained and nothing publishes.
fn write_durable(
    core: &NamesCore,
    document: &StoredDocument,
    bytes: &[u8],
    digest: [u8; 32],
) -> Result<(), NameError> {
    if test_pre_replace_failure(&core.data_dir) {
        return Err(NameError::Persistence(
            "injected pre-replace failure: the previous document is intact".into(),
        ));
    }
    if let Err(err) = atomic_write_durable(&core.doc_path, &core.tmp_path, bytes) {
        // Classify: did the replacement land despite the reported error?
        let installed = peek_generation(&core.doc_path);
        if installed == Some(document.document_generation) {
            return Err(NameError::CommitUncertain(format!(
                "the document replacement landed but durability is unproven: {err}"
            )));
        }
        return Err(NameError::Persistence(format!(
            "durable document replacement failed (previous document intact): {err}"
        )));
    }
    if test_post_replace_failure(&core.data_dir) {
        return Err(NameError::CommitUncertain(
            "injected post-replace failure: the replacement may not be durable".into(),
        ));
    }
    // Still under the lock, so the stamp is the file just written (a failed
    // stat leaves the view unstamped: the next peek re-reads).
    let stamp = session_name_store_view::stat_stamp(&core.doc_path).ok();
    core.set_view(document.clone(), digest, stamp);
    Ok(())
}

/// Swap the read model to a newer adopted document and publish the delta.
/// A stale (older-generation) adoption is refused: queued stale projections
/// can never overwrite newer state.
fn adopt_if_newer(
    core: &NamesCore,
    document: StoredDocument,
    digest: [u8; 32],
    stamp: Option<DocumentStamp>,
    publish_delta: bool,
) -> bool {
    let prior = core.current_view();
    if document.document_generation <= prior.document.document_generation {
        return false;
    }
    let delta = delta_updates(&prior.document, &document);
    core.set_view(document, digest, stamp);
    if publish_delta {
        core.publish(delta);
    }
    true
}

/// The adopted-change delta: records whose revision changed or appeared,
/// plus each record's current inbound redirects. Round-2 carried finding F5
/// (adjudicated): a record whose nativeSync PROJECTION moved (a foreign
/// same-home process's status-only transition — a native fold/rearm with no
/// visible name change) is republished too, with `changed:false` — the
/// status-only fold discipline clients already apply by documentGeneration.
/// Without it, the adopting process's own subscribers stayed blind to the
/// foreign status until a bootstrap or a later revision change.
fn delta_updates(prior: &StoredDocument, next: &StoredDocument) -> Vec<SessionNameUpdate> {
    let mut updates = Vec::new();
    for (key, record) in &next.records {
        let changed = match prior.records.get(key) {
            None => true,
            Some(old) => old.revision != record.revision || old.source != record.source,
        };
        if changed {
            if let Some(update) = update_for_key(next, key, true, RedirectScope::ToRecord) {
                updates.push(update);
            }
        } else if native_sync_projection(prior, key) != native_sync_projection(next, key) {
            if let Some(update) = update_for_key(next, key, false, RedirectScope::ToRecord) {
                updates.push(update);
            }
        }
    }
    updates
}

fn materialize_publish(document: &StoredDocument, specs: &[PublishSpec]) -> Vec<SessionNameUpdate> {
    specs
        .iter()
        .filter_map(|spec| {
            update_for_key(document, &spec.key, spec.changed, RedirectScope::ToRecord)
        })
        .collect()
}

#[derive(Clone, Copy)]
enum RedirectScope {
    /// No redirects.
    None,
    /// Redirects pointing AT this record (own-commit/commit-delta shape).
    ToRecord,
    /// The document's full redirect list (bootstrap/snapshot shape).
    All,
}

fn update_for_key(
    document: &StoredDocument,
    key: &str,
    changed: bool,
    scope: RedirectScope,
) -> Option<SessionNameUpdate> {
    let record = document.record_at(key)?;
    let redirects = match scope {
        RedirectScope::None => Vec::new(),
        RedirectScope::ToRecord => document
            .redirects
            .values()
            .filter(|r| name_ref_key(&r.to) == key)
            .cloned()
            .collect(),
        RedirectScope::All => document.redirects.values().cloned().collect(),
    };
    Some(SessionNameUpdate {
        record: record.clone(),
        document_generation: document.document_generation,
        redirects,
        changed,
        native_sync: native_sync_projection(document, key),
        // Rename responses set their own outcome; nothing else carries one.
        outcome: None,
    })
}

/// The additive Task 3 status projection: present only for records that CARRY
/// a native writeback series (manual and accepted-Freshell-AI names —
/// directory/first-message/provider fallbacks are never written back, so
/// they project no native status at all). An entry can exist purely to
/// retain observation provenance for a non-writable record (live providers
/// observe fallback-named sessions); such an entry is not a series.
fn native_sync_projection(
    document: &StoredDocument,
    key: &str,
) -> Option<freshell_protocol::session_names::NativeSyncProjection> {
    let state = document.native_write.get(key)?;
    let record = document.record_at(key)?;
    // Gate on series existence AND writability: an observation-only entry
    // (no desired revision) or a record whose accepted source is never
    // written back projects no native status — a permanently-`pending` badge
    // for work that will never run is a contract violation.
    if state.desired_revision.is_none() || !source_is_writable(record.source) {
        return None;
    }
    let location_revision = document
        .locations
        .get(key)
        .and_then(|location| location.verified.as_ref())
        .map(|verified| verified.location_revision)
        .or(state.attempted_location_revision)
        .unwrap_or(0);
    let status = match state.status {
        NativeSyncStatus::Pending => freshell_protocol::session_names::NativeSyncStatus::Pending,
        NativeSyncStatus::Synced => freshell_protocol::session_names::NativeSyncStatus::Synced,
        NativeSyncStatus::Unsynced => freshell_protocol::session_names::NativeSyncStatus::Unsynced,
        NativeSyncStatus::Unsupported => {
            freshell_protocol::session_names::NativeSyncStatus::Unsupported
        }
    };
    Some(freshell_protocol::session_names::NativeSyncProjection {
        status,
        desired_revision: state.desired_revision.unwrap_or(record.revision),
        location_revision,
        observed_current: state.observed_current,
        reason: state.unsynced_reason.clone(),
    })
}

fn serialize_document(document: &StoredDocument) -> Result<Vec<u8>, NameError> {
    serde_json::to_vec(document).map_err(|e| {
        NameError::Persistence(format!("cannot serialize session-names document: {e}"))
    })
}

fn parse_document(bytes: &[u8]) -> Result<StoredDocument, NameError> {
    let document: StoredDocument = serde_json::from_slice(bytes)
        .map_err(|e| NameError::Persistence(format!("session-names document is corrupt: {e}")))?;
    if document.version != DOCUMENT_VERSION {
        return Err(NameError::Persistence(format!(
            "session-names document version {} is unsupported (expected {DOCUMENT_VERSION})",
            document.version
        )));
    }
    if document.document_generation == 0 {
        return Err(NameError::Persistence(
            "session-names document generation must be at least 1".into(),
        ));
    }
    if document.next_revision == 0 {
        return Err(NameError::Persistence(
            "session-names revision cursor must be at least 1".into(),
        ));
    }
    Ok(document)
}

/// Minimal generation peek used to classify pre- vs post-replace failures.
fn peek_generation(doc_path: &Path) -> Option<u64> {
    let bytes = std::fs::read(doc_path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value.get("documentGeneration")?.as_u64()
}

fn open_lock_file(path: &Path) -> Result<std::fs::File, NameError> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| {
            NameError::LockUnavailable(format!("cannot open sidecar lock {}: {e}", path.display()))
        })
}

/// Acquire the strict document lock: a fresh private handle per transaction,
/// retrying contention for at most one monotonic second. Callers hold their
/// store's [`LocalTurn`], so contention seen here comes from another
/// participant (another process, or another store opened on the same
/// directory), never from this store's own queue — nor from a child process
/// forked during an earlier transaction, because every release unlocks
/// explicitly ([`HeldSidecarLock`]). The sidecar is never replaced or
/// unlinked — its inode lives as long as the data dir.
fn acquire_document_lock(path: &Path) -> Result<HeldSidecarLock, NameError> {
    let file = open_lock_file(path)?;
    let deadline = Instant::now() + LOCK_RETRY_BUDGET;
    loop {
        match file.try_lock() {
            Ok(()) => {
                return Ok(HeldSidecarLock {
                    file,
                    path: path.to_path_buf(),
                })
            }
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err(NameError::LockUnavailable(
                        "session-names document lock stayed busy for the bounded retry budget"
                            .into(),
                    ));
                }
                std::thread::sleep(LOCK_POLL_INTERVAL);
            }
            Err(TryLockError::Error(e)) => {
                return Err(NameError::LockUnavailable(format!(
                    "session-names document lock error: {e}"
                )))
            }
        }
    }
}

/// Reconcile an unfamiliar generation's durability under the sidecar before
/// adopting or mutating from it: the installed file and its parent directory
/// are synced on THIS machine. Failure is uncertainty, never adoption.
fn reconcile_durability(doc_path: &Path, _data_dir: &Path) -> Result<(), NameError> {
    if test_fail_reconcile(_data_dir) {
        return Err(NameError::CommitUncertain(
            "injected reconciliation failure: the installed document's durability is unproven"
                .into(),
        ));
    }
    let file = std::fs::File::open(doc_path).map_err(|e| {
        NameError::CommitUncertain(format!(
            "cannot open the installed document for durability reconciliation: {e}"
        ))
    })?;
    file.sync_all().map_err(|e| {
        NameError::CommitUncertain(format!(
            "cannot sync the installed document for durability reconciliation: {e}"
        ))
    })?;
    drop(file);
    #[cfg(unix)]
    {
        let parent = std::fs::File::open(doc_path.parent().unwrap_or_else(|| Path::new(".")))
            .map_err(|e| {
                NameError::CommitUncertain(format!(
                    "cannot open the data dir for durability reconciliation: {e}"
                ))
            })?;
        parent.sync_all().map_err(|e| {
            NameError::CommitUncertain(format!(
                "cannot sync the data dir for durability reconciliation: {e}"
            ))
        })?;
    }
    // No extra Windows directory-sync guarantee is asserted (the platform
    // durability contract of `atomic_write_durable`).
    Ok(())
}

// ---------------------------------------------------------------------------
// Test hooks (compiled only into the test binary; keyed by data dir so
// parallel test threads never cross-contaminate)
// ---------------------------------------------------------------------------

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TestHook {
    PreReplace,
    PostReplace,
    FailReconcile,
    HoldLock(u64),
    /// Hold the document lock (and with it this store's local turn) from
    /// inside a transaction until the test calls [`release_held_lock`]: a
    /// stalled durable write whose end the test controls. Fires once, like
    /// `HoldLock`, and gives up after [`HELD_LOCK_RELEASE_BOUND`] so a test
    /// that never releases cannot wedge the lane.
    HoldLockUntilReleased,
    /// Task 3: override the native cycle retry floors (both delays) for the
    /// data dir — the bounded-allowance tests pin exhaustion without
    /// wall-clock waits. Persists until cleared (like the failure injections).
    NativeRetryFloorMs(i64),
    /// Task 4: a persistent wall-clock OFFSET for the data dir — the store's
    /// decision clock (`TxnMeta::now_ms` and the generation due-reads)
    /// reports `system_now + offset`, so clock-controlled tests pin the
    /// retry-schedule arithmetic (immediately ready / +30s / +5min) and
    /// advance virtual time without sleeping. Data-dir-keyed like every
    /// other hook, so parallel tests never cross-contaminate.
    ClockOffsetMs(i64),
    /// Name-reliability Task 11: shorten (or lengthen) the stamp peek's
    /// periodic full-check interval for the data dir. Persists until
    /// cleared, like the clock offset.
    FullCheckIntervalMs(u64),
    /// Name-reliability Task 11: lengthen (or shorten) how long a name read
    /// waits for a busy document lock before answering from the adopted
    /// view. Persists until cleared, like the clock offset.
    ReadLockWaitMs(u64),
}

/// Readiness sentinel written by `HoldLock` hooks while the document lock is
/// held: cooperating cross-process tests synchronize on proven lock
/// ownership instead of a fixed post-spawn delay.
#[cfg(test)]
const LOCK_HELD_SENTINEL_NAME: &str = ".session-names-lock-held";

/// Release sentinel for a `HoldLockUntilReleased` hold: the holder polls for
/// it and returns once it exists.
#[cfg(test)]
const LOCK_RELEASE_SENTINEL_NAME: &str = ".session-names-lock-release";

/// The longest a `HoldLockUntilReleased` hold waits for its release.
#[cfg(test)]
const HELD_LOCK_RELEASE_BOUND: Duration = Duration::from_secs(30);

/// End a `HoldLockUntilReleased` hold for `data_dir`.
#[cfg(test)]
pub(crate) fn release_held_lock(data_dir: &Path) {
    std::fs::write(data_dir.join(LOCK_RELEASE_SENTINEL_NAME), b"release")
        .expect("write the session-names lock release sentinel");
}

#[cfg(test)]
pub(crate) fn set_test_hooks(data_dir: &Path, hooks: Vec<TestHook>) {
    test_hook_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(data_dir.to_path_buf(), std::sync::Mutex::new(hooks));
}

#[cfg(test)]
pub(crate) fn clear_test_hooks(data_dir: &Path) {
    test_hook_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(data_dir);
}

#[cfg(test)]
fn test_hook_registry(
) -> &'static std::sync::Mutex<BTreeMap<PathBuf, std::sync::Mutex<Vec<TestHook>>>> {
    static REGISTRY: std::sync::OnceLock<
        std::sync::Mutex<BTreeMap<PathBuf, std::sync::Mutex<Vec<TestHook>>>>,
    > = std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()))
}

#[cfg(test)]
fn take_matching_hook(data_dir: &Path, predicate: impl Fn(&TestHook) -> bool) -> Option<TestHook> {
    let registry = test_hook_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let bucket = registry.get(data_dir)?;
    let mut hooks = bucket.lock().unwrap_or_else(|p| p.into_inner());
    let index = hooks.iter().position(predicate)?;
    // HoldLock fires once; failure injections persist until cleared so a
    // whole write window stays broken deterministically.
    if matches!(
        hooks[index],
        TestHook::HoldLock(_) | TestHook::HoldLockUntilReleased
    ) {
        Some(hooks.remove(index))
    } else {
        Some(hooks[index].clone())
    }
}

fn test_hold_once(_data_dir: &Path) {
    #[cfg(test)]
    {
        match take_matching_hook(_data_dir, |h| {
            matches!(h, TestHook::HoldLock(_) | TestHook::HoldLockUntilReleased)
        }) {
            Some(TestHook::HoldLock(ms)) => {
                write_lock_held_sentinel(_data_dir);
                std::thread::sleep(Duration::from_millis(ms));
            }
            Some(TestHook::HoldLockUntilReleased) => {
                write_lock_held_sentinel(_data_dir);
                let release = _data_dir.join(LOCK_RELEASE_SENTINEL_NAME);
                let deadline = Instant::now() + HELD_LOCK_RELEASE_BOUND;
                while !release.exists() {
                    if Instant::now() >= deadline {
                        eprintln!(
                            "session-names held lock was never released for {}",
                            _data_dir.display()
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            _ => {}
        }
    }
}

/// Write the lock-held readiness sentinel from inside a held transaction
/// (right after lock acquisition). A failed write only degrades a test's
/// synchronization — it never fails the transaction under test.
#[cfg(test)]
fn write_lock_held_sentinel(data_dir: &Path) {
    let sentinel = data_dir.join(LOCK_HELD_SENTINEL_NAME);
    if let Err(err) = std::fs::write(&sentinel, b"held") {
        eprintln!(
            "cannot write session-names lock-held sentinel {}: {err}",
            sentinel.display()
        );
    }
}

fn test_pre_replace_failure(data_dir: &Path) -> bool {
    #[cfg(test)]
    {
        take_matching_hook(data_dir, |h| matches!(h, TestHook::PreReplace)).is_some()
    }
    #[cfg(not(test))]
    {
        let _ = data_dir;
        false
    }
}

fn test_post_replace_failure(data_dir: &Path) -> bool {
    #[cfg(test)]
    {
        take_matching_hook(data_dir, |h| matches!(h, TestHook::PostReplace)).is_some()
    }
    #[cfg(not(test))]
    {
        let _ = data_dir;
        false
    }
}

fn test_fail_reconcile(data_dir: &Path) -> bool {
    #[cfg(test)]
    {
        take_matching_hook(data_dir, |h| matches!(h, TestHook::FailReconcile)).is_some()
    }
    #[cfg(not(test))]
    {
        let _ = data_dir;
        false
    }
}

/// The data-dir-keyed native retry-floor override (Task 3 tests only).
fn take_native_retry_floor(data_dir: &Path) -> Option<i64> {
    #[cfg(test)]
    {
        take_matching_hook(data_dir, |h| matches!(h, TestHook::NativeRetryFloorMs(_))).and_then(
            |hook| match hook {
                TestHook::NativeRetryFloorMs(ms) => Some(ms),
                _ => None,
            },
        )
    }
    #[cfg(not(test))]
    {
        let _ = data_dir;
        None
    }
}

/// Test-only store-transaction counter (delta-review round 3, finding 2):
/// every strict cross-process transaction — lock acquisition through
/// [`run_txn_sync`] — increments the data-dir-keyed tally. The sweep
/// pre-check tests prove a settled scoped session transacts ZERO times on a
/// later pass by reading this counter, in the same data-dir-keyed style as
/// the test hooks (parallel tests never cross-contaminate). A no-op body in
/// non-test builds, exactly like the failure-injection seams above.
fn count_store_transaction_for_test(data_dir: &Path) {
    #[cfg(test)]
    {
        test_transaction_tallies()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(data_dir.to_path_buf())
            .or_insert_with(|| std::sync::atomic::AtomicU64::new(0))
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    #[cfg(not(test))]
    {
        let _ = data_dir;
    }
}

/// The current test tally of store transactions against `data_dir`.
#[cfg(test)]
pub(crate) fn test_store_transaction_count(data_dir: &Path) -> u64 {
    test_transaction_tallies()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(data_dir)
        .map(|count| count.load(std::sync::atomic::Ordering::SeqCst))
        .unwrap_or(0)
}

#[cfg(test)]
fn test_transaction_tallies(
) -> &'static std::sync::Mutex<std::collections::BTreeMap<PathBuf, std::sync::atomic::AtomicU64>> {
    static TALLIES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::BTreeMap<PathBuf, std::sync::atomic::AtomicU64>>,
    > = std::sync::OnceLock::new();
    TALLIES.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeMap::new()))
}

// ---------------------------------------------------------------------------
// Acceptance helpers
// ---------------------------------------------------------------------------

/// Resolve a target through redirects and require its record to exist,
/// returning its stable key and the current record.
fn required_record(
    document: &StoredDocument,
    target: &SessionNameRef,
) -> Result<(String, SessionNameRecord), NameError> {
    let (resolved, _) = document.resolve_ref(target);
    let key = name_ref_key(&resolved);
    let record = document
        .record_at(&key)
        .cloned()
        .ok_or_else(|| NameError::NotFound(format!("no naming record for {key}")))?;
    Ok((key, record))
}

/// The unchanged-winner answer shape for Read decisions.
fn read_update(document: &StoredDocument, key: &str) -> SessionNameUpdate {
    update_for_key(document, key, false, RedirectScope::ToRecord).expect("the winner resolves")
}

/// The commit-decision shape: the post-commit value update plus the publish
/// list (records publish only when their accepted value changed — `change`
/// says why; bookkeeping-only generations pass `None` and publish nothing).
fn commit_decision(
    document: &StoredDocument,
    key: &str,
    change: Option<NameChangeEvent>,
) -> Decision<SessionNameUpdate> {
    let value = update_after_commit(document, key, change.is_some(), RedirectScope::ToRecord)
        .expect("the record resolves");
    let publish = change
        .map(|change| vec![PublishSpec::changed(key.to_string(), change)])
        .unwrap_or_default();
    Decision::Write { value, publish }
}

/// The Task 3 status-only commit: the accepted record is UNCHANGED but its
/// nativeSync projection moved, so the frame still publishes (`changed:
/// false`) — clients fold status by `documentGeneration`, not name revision.
fn commit_decision_publishing_status(
    document: &StoredDocument,
    key: &str,
) -> Decision<SessionNameUpdate> {
    let value = update_after_commit(document, key, false, RedirectScope::ToRecord)
        .expect("the record resolves");
    Decision::Write {
        value,
        publish: vec![PublishSpec {
            key: key.to_string(),
            changed: false,
            change: None,
        }],
    }
}

/// Contract rank for new operations:
/// manual > legacy_protected > freshell_ai > provider_ai > first_message >
/// directory. `legacy_protected` preserves a migration-protected label above
/// every automatic source and below a proven manual name; only migration
/// assigns it, and it never claims human origin.
fn source_rank(source: NameSource) -> u8 {
    match source {
        NameSource::Directory => 0,
        NameSource::FirstMessage => 1,
        NameSource::ProviderAi => 2,
        NameSource::FreshellAi => 3,
        NameSource::LegacyProtected => 4,
        NameSource::Manual => 5,
    }
}

/// Sources that stop automatic generation and reject late automatic output.
fn source_is_protected(source: NameSource) -> bool {
    matches!(
        source,
        NameSource::Manual | NameSource::LegacyProtected | NameSource::FreshellAi
    )
}

/// The directory-title override rule, ONE source of truth for both the
/// read-side projection (`session_directory::apply_naming_projection`) and
/// the naming publisher's `sessions.changed` gate: only a manual or
/// migration-protected record replaces a served row's `title`. Every
/// lower-rank name (directory/first-message/provider fallbacks, Freshell
/// AI) never shadows the provider-native title, so a commit carrying only
/// those sources cannot change what the directory serves — invalidating it
/// would be refetch churn.
pub(crate) fn overrides_directory_title(source: NameSource) -> bool {
    matches!(source, NameSource::Manual | NameSource::LegacyProtected)
}

/// Trim surrounding whitespace; reject an empty/control-bearing name or one
/// over 200 Unicode scalar values with a visible 400-class error. Names are
/// otherwise kept as entered (the short-AI-title normalization is NOT applied
/// here).
fn validate_name(raw: &str) -> Result<String, NameError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(NameError::InvalidName(
            "a session name cannot be empty or whitespace-only".into(),
        ));
    }
    if trimmed.chars().count() > MAX_NAME_SCALARS {
        return Err(NameError::InvalidName(format!(
            "a session name cannot exceed {MAX_NAME_SCALARS} characters"
        )));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(NameError::InvalidName(
            "a session name cannot contain control characters".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// The immediate `ensure_pending` fallback: the existing directory-basename
/// derivation for a usable cwd, otherwise the provider display label —
/// always at directory rank. A pathological basename (control characters or
/// oversize) is validated away before it can reach a record: the
/// always-valid provider label is used instead.
fn directory_fallback_name(cwd: Option<&str>, provider: &NamedProvider) -> String {
    let label = provider.display_label().to_string();
    let candidate = cwd
        .and_then(basename_segment)
        .unwrap_or_else(|| label.clone());
    validate_name(&candidate).unwrap_or(label)
}

/// Bounded first-message excerpt retained for generation (existing prompt cap).
fn excerpt_of(message: &str) -> String {
    message
        .chars()
        .take(crate::ai_title::PROMPT_MESSAGE_CHAR_CAP)
        .collect()
}

/// Input fingerprint for duplicate-activity folding: a digest of the bounded
/// excerpt — stable across duplicate event delivery.
fn fingerprint_message(message: &str) -> String {
    digest_bytes(excerpt_of(message).as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// An update stamped with the generation this transaction is about to commit
/// (Write-decision values only; Read values carry the current generation).
fn update_after_commit(
    document: &StoredDocument,
    key: &str,
    changed: bool,
    scope: RedirectScope,
) -> Option<SessionNameUpdate> {
    update_for_key(document, key, changed, scope).map(|update| SessionNameUpdate {
        document_generation: document.document_generation + 1,
        ..update
    })
}

/// The acceptance rule core: an automatic offer only RAISES rank (equal-rank
/// automatic observations preserve the accepted value); an explicit user
/// rename always wins and may change any record or promote the same text to
/// manual. Returns whether the offer was accepted.
fn offer_mut(
    document: &mut StoredDocument,
    key: &str,
    name: String,
    source: NameSource,
    now: i64,
) -> Result<bool, NameError> {
    let Some(record) = document.record_at(key).cloned() else {
        return Err(NameError::NotFound(format!("no naming record for {key}")));
    };
    if source == NameSource::Manual {
        // Delta-review round 3, finding 3: an equal unchanged manual request
        // is NOT a new name decision — repeating the exact same explicit
        // rename on an already-manual record must allocate no revision and
        // re-arm no fresh bounded native series ("equal unchanged requests
        // cannot", the plan's native policy). The response still carries the
        // unchanged winner. A same-text rename that RAISES rank to manual
        // (any lower source) remains a real decision and proceeds.
        if record.source == NameSource::Manual && record.name == name {
            return Ok(false);
        }
        let revision = document.allocate_revision()?;
        document.records.insert(
            key.to_string(),
            SessionNameRecord {
                name_ref: record.name_ref,
                name,
                source,
                revision,
                manual_revision: Some(revision),
                renamed_at: Some(now),
                legacy_origin: None,
            },
        );
        return Ok(true);
    }
    if source_rank(source) > source_rank(record.source) {
        let revision = document.allocate_revision()?;
        document.records.insert(
            key.to_string(),
            SessionNameRecord {
                name_ref: record.name_ref,
                name,
                source,
                revision,
                manual_revision: None,
                renamed_at: None,
                legacy_origin: None,
            },
        );
        return Ok(true);
    }
    Ok(false)
}

/// Sources eligible for native writeback: accepted manual names and accepted
/// Freshell AI names. Migration-protected labels are preserved canonically
/// WITHOUT claiming a native manual origin, and directory/first-message/
/// provider fallbacks are never written back.
fn source_is_writable(source: NameSource) -> bool {
    matches!(source, NameSource::Manual | NameSource::FreshellAi)
}

/// Arm a fresh bounded native series for a newly accepted name decision (a
/// deliberate user rename or an accepted Freshell AI answer — the only
/// writable sources). Equal unchanged requests never reach here (a losing
/// offer answers unchanged), so this only fires on a real decision. A fresh
/// series restores the three-cycle/six-read allowance; own-write receipts
/// survive as provenance (late echoes of older attempted writes must never be
/// mistaken for external observations), and every settled/ambiguous marker
/// from the superseded series clears.
fn reset_native_series(document: &mut StoredDocument, key: &str, record: &SessionNameRecord) {
    let entry = document.native_write.entry(key.to_string()).or_default();
    entry.status = NativeSyncStatus::Pending;
    entry.desired_revision = Some(record.revision);
    entry.desired_name = Some(record.name.clone());
    entry.desired_source = Some(record.source);
    // The series identity: stamped at the ARMING revision. Folds and read
    // charges dispatched by a superseded series (a newer name decision
    // re-armed this key) carry an older epoch and are provenance only.
    entry.series_epoch = Some(record.revision);
    entry.ambiguous = false;
    entry.observed_current = None;
    entry.settled = false;
    entry.next_due = None;
    entry.cycles_consumed = 0;
    entry.reads_consumed = 0;
    entry.receipt_id = None;
    entry.unsynced_reason = None;
}

/// Record/advance verified routing evidence. `location_revision` is assigned
/// whenever the verified evidence CHANGES; identical evidence is a no-op.
/// Returns whether the verified evidence changed.
fn apply_verified_location(
    document: &mut StoredDocument,
    key: &str,
    location: NativeLocation,
) -> bool {
    let entry = document.locations.entry(key.to_string()).or_default();
    match &entry.verified {
        None => {
            entry.verified = Some(VerifiedLocation {
                location,
                location_revision: 1,
            });
            true
        }
        Some(existing) if existing.location == location => false,
        Some(existing) => {
            entry.verified = Some(VerifiedLocation {
                location,
                location_revision: existing.location_revision + 1,
            });
            true
        }
    }
}

/// Union the colliding generation budgets on bind: combined consumed counts
/// capped at the three-start allowance, unioned attempt identities, one
/// unaccepted series kept deterministically (the existing durable series if
/// present) so completions for the superseded series are discarded by the
/// series-id guard.
fn union_generation_state(document: &mut StoredDocument, from_key: &str, to_key: &str, now: i64) {
    let Some(pending_series) = document.generation.remove(from_key) else {
        return;
    };
    match document.generation.get_mut(to_key) {
        Some(durable) => {
            durable.consumed =
                (durable.consumed + pending_series.consumed).min(MAX_GENERATION_STARTS);
            for attempt in pending_series.attempt_ids {
                if !durable.attempt_ids.contains(&attempt) {
                    durable.attempt_ids.push(attempt);
                }
            }
            durable.attempt_starts.extend(pending_series.attempt_starts);
            durable.attempt_starts.sort_unstable();
            if durable.input_fingerprint.is_none() {
                durable.input_fingerprint = pending_series.input_fingerprint;
            }
            if durable.excerpt.is_none() {
                durable.excerpt = pending_series.excerpt;
            }
            if durable.consumed >= MAX_GENERATION_STARTS {
                durable.status = GenerationStatus::Exhausted;
                durable.exhausted_at = Some(now);
                durable.excerpt = None;
            }
        }
        None => {
            document
                .generation
                .insert(to_key.to_string(), pending_series);
        }
    }
}

/// Transfer native-write state on bind: consumed cycles and read allowance
/// move conservatively — the summed counts CAP at the per-revision
/// allowances (the persisted counters never read past three cycles / six
/// reads) — the desired revision rebases to the bound record (binding is
/// not a new name decision, so the series EPOCH transfers with the series),
/// and original receipts are retained.
fn transfer_native_write(
    document: &mut StoredDocument,
    from_key: &str,
    to_key: &str,
    record: &SessionNameRecord,
) {
    if let Some(mut pending_state) = document.native_write.remove(from_key) {
        match document.native_write.get_mut(to_key) {
            Some(durable) => {
                durable.cycles_consumed = (durable.cycles_consumed + pending_state.cycles_consumed)
                    .min(MAX_NATIVE_CYCLES);
                durable.reads_consumed =
                    (durable.reads_consumed + pending_state.reads_consumed).min(MAX_NATIVE_READS);
                for receipt in pending_state.attempted_receipts {
                    if !durable.attempted_receipts.contains(&receipt) {
                        durable.attempted_receipts.push(receipt);
                    }
                }
                if durable.last_confirmed_receipt.is_none() {
                    durable.last_confirmed_receipt = pending_state.last_confirmed_receipt;
                }
                // The surviving series keeps its own epoch; if only the
                // transferred series ever armed, its identity rides along.
                if durable.series_epoch.is_none() {
                    durable.series_epoch = pending_state.series_epoch;
                }
            }
            None => {
                pending_state.desired_revision = Some(record.revision);
                pending_state.desired_name = Some(record.name.clone());
                pending_state.desired_source = Some(record.source);
                document
                    .native_write
                    .insert(to_key.to_string(), pending_state);
            }
        }
    }
    if let Some(state) = document.native_write.get_mut(to_key) {
        state.desired_revision = Some(record.revision);
        state.desired_name = Some(record.name.clone());
        state.desired_source = Some(record.source);
    }
}

/// Move pending-key location evidence onto the bound record (keeping any
/// already-verified target evidence) before the bind's own acquisition lands.
fn move_location_evidence(document: &mut StoredDocument, from_key: &str, to_key: &str) {
    if let Some(pending_location) = document.locations.remove(from_key) {
        let entry = document.locations.entry(to_key.to_string()).or_default();
        if entry.verified.is_none() {
            entry.verified = pending_location.verified;
        }
        if entry.prospective.is_none() {
            entry.prospective = pending_location.prospective;
        }
    }
}

// ---------------------------------------------------------------------------
// Decision closures
// ---------------------------------------------------------------------------

fn ensure_pending_decision(
    document: &mut StoredDocument,
    _meta: &TxnMeta,
    input: PendingNameInput,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    if input.handle.trim().is_empty() {
        return Err(NameError::InvalidName(
            "a naming handle cannot be empty".into(),
        ));
    }
    let pending_ref = SessionNameRef::Pending { id: input.handle };
    let key = name_ref_key(&pending_ref);

    // Already bound: resolve through the redirect (idempotent re-ensure of
    // the durable record, never a second pending admission).
    if let Some(redirect) = document.redirects.get(&key).cloned() {
        let target_key = name_ref_key(&redirect.to);
        if let Some(mut update) =
            update_for_key(document, &target_key, false, RedirectScope::ToRecord)
        {
            update.redirects.push(redirect);
            return Ok(Decision::Read(update));
        }
        // Dangling redirect (its target record vanished): drop it and admit
        // the handle afresh.
        document.redirects.remove(&key);
    }

    // Existing pending record: creation/recovery retries preserve it.
    if let Some(update) = update_for_key(document, &key, false, RedirectScope::None) {
        return Ok(Decision::Read(update));
    }

    let name = directory_fallback_name(input.cwd.as_deref(), &input.provider);
    let revision = document.allocate_revision()?;
    let record = SessionNameRecord {
        name_ref: pending_ref,
        name,
        source: NameSource::Directory,
        revision,
        manual_revision: None,
        renamed_at: None,
        legacy_origin: None,
    };
    document.records.insert(key.clone(), record);
    let value = update_after_commit(document, &key, true, RedirectScope::None)
        .expect("the freshly inserted record resolves");
    let change = NameChangeEvent::new(NameChangeCause::EnsurePending, None, None);
    Ok(Decision::Write {
        value,
        publish: vec![PublishSpec::changed(key, change)],
    })
}

fn rename_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    input: RenameNameInput,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let (key, record) = required_record(document, &input.target)?;
    let name = validate_name(&input.name)?;
    if let Some(expected) = input.if_revision {
        if record.revision != expected {
            return Err(NameError::Conflict {
                message: format!(
                    "the record moved to revision {} while the editor held {expected}",
                    record.revision
                ),
                current: Some(Box::new(record)),
            });
        }
    }
    if input.intent == NameIntent::User {
        // UI Rename always conveys user intent: it always wins (an identical
        // manual rename is not a new decision and changes nothing).
        let change = NameChangeEvent::new(NameChangeCause::ManualRename, Some(&record), None);
        let outcome = if offer_mut(document, &key, name, NameSource::Manual, meta.now_ms)? {
            let record = document
                .record_at(&key)
                .cloned()
                .expect("the accepted record resolves");
            reset_native_series(document, &key, &record);
            return Ok(with_outcome(
                commit_decision(document, &key, Some(change)),
                RenameOutcome {
                    applied: true,
                    reason: None,
                },
            ));
        } else {
            RenameOutcome {
                applied: true,
                reason: Some(RenameOutcomeReason::Unchanged),
            }
        };
        return Ok(with_outcome(
            Decision::Read(read_update(document, &key)),
            outcome,
        ));
    }
    // Automation (omitted/`automatic` intent): recorded at `provider_ai`,
    // equal rank allowed, never over a protected name and never a default
    // label for the target (name-reliability Task 4).
    let verdict =
        session_name_policy::automation_rename_decision(&record, &name, input.cwd.as_deref());
    match verdict {
        session_name_policy::AutomationRenameVerdict::Apply => {
            let change = NameChangeEvent::new(
                NameChangeCause::AutomationRename,
                Some(&record),
                input.cwd.as_deref(),
            );
            replace_automatic(document, &key, name, NameSource::ProviderAi)?;
            Ok(with_outcome(
                commit_decision(document, &key, Some(change)),
                verdict.outcome(),
            ))
        }
        session_name_policy::AutomationRenameVerdict::Unchanged => Ok(with_outcome(
            Decision::Read(read_update(document, &key)),
            verdict.outcome(),
        )),
        session_name_policy::AutomationRenameVerdict::Refused(reason) => {
            tracing::info!(
                target: "freshell_server::session_names",
                op = "rename",
                name_ref = %key,
                source = %wire_source(record.source),
                reason = ?reason,
                "session_names.automation_rename_refused"
            );
            Ok(with_outcome(
                Decision::Read(read_update(document, &key)),
                verdict.outcome(),
            ))
        }
    }
}

fn offer_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    target: &SessionNameRef,
    name: &str,
    source: NameSource,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let (key, prior) = required_record(document, target)?;
    let name = validate_name(name)?;
    if offer_mut(document, &key, name, source, meta.now_ms)? {
        let record = document
            .record_at(&key)
            .cloned()
            .expect("the accepted record resolves");
        if source_is_writable(record.source) {
            reset_native_series(document, &key, &record);
        }
        let change = NameChangeEvent::new(NameChangeCause::of_offer(source), Some(&prior), None);
        Ok(commit_decision(document, &key, Some(change)))
    } else {
        Ok(Decision::Read(read_update(document, &key)))
    }
}

fn bind_pending_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    input: BindNameInput,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let BindNameInput {
        pending,
        target,
        acquisition,
    } = input;
    if !matches!(pending, SessionNameRef::Pending { .. }) {
        return Err(NameError::InvalidName(
            "a bind source must be a pending handle".into(),
        ));
    }
    if !matches!(target, SessionNameRef::Session { .. }) {
        return Err(NameError::InvalidName(
            "a bind target must be a durable provider/session ref".into(),
        ));
    }
    if acquisition.persistence != NativePersistence::Verified {
        return Err(NameError::IdentityAmbiguous(
            "prospective evidence cannot authorize a pending→durable binding".into(),
        ));
    }

    let pending_key = name_ref_key(&pending);
    let target_key = name_ref_key(&target);

    // Already bound: idempotent for the same target, a conflict otherwise.
    if let Some(existing) = document.redirects.get(&pending_key).cloned() {
        if existing.to == target {
            return Ok(Decision::Read(
                update_for_key(document, &target_key, false, RedirectScope::ToRecord)
                    .expect("the bound target resolves"),
            ));
        }
        return Err(NameError::Conflict {
            message: "the pending handle is already bound to a different durable session".into(),
            current: document.record_at(&target_key).cloned().map(Box::new),
        });
    }

    let pending_record = document
        .record_at(&pending_key)
        .cloned()
        .ok_or_else(|| NameError::NotFound(format!("no pending record for {pending_key}")))?;
    let existing = document.record_at(&target_key).cloned();

    // Rank decides the collision: manual/manual compares actual manual
    // revisions; equal automatic ranks favor the durable record; migration
    // protection rides the rank order — except that an import-owned default
    // label ("Tab 4") always gives way to the live pending record (Task 3).
    // Losing evidence is retained in recovery, never active.
    let (winner, loser) = match &existing {
        None => (pending_record.clone(), None),
        Some(current) => {
            let pending_wins = if pending_record.source == NameSource::Manual
                && current.source == NameSource::Manual
            {
                pending_record.manual_revision.unwrap_or(0) > current.manual_revision.unwrap_or(0)
            } else {
                source_rank(pending_record.source) > source_rank(current.source)
                    || session_name_import_policy::import_owned_label_loses_bind(
                        document,
                        &target_key,
                    )
            };
            if pending_wins {
                (pending_record.clone(), Some(current.clone()))
            } else {
                (current.clone(), Some(pending_record.clone()))
            }
        }
    };

    // Binding allocates a record revision even with unchanged text, plus a
    // redirect revision for the pending→durable edge.
    let record_revision = document.allocate_revision()?;
    let record = SessionNameRecord {
        name_ref: target.clone(),
        name: winner.name.clone(),
        source: winner.source,
        revision: record_revision,
        manual_revision: winner.manual_revision,
        renamed_at: winner.renamed_at,
        legacy_origin: winner.legacy_origin,
    };
    document.records.insert(target_key.clone(), record.clone());
    if let Some(loser) = loser {
        document.recovery.insert(
            format!("{}#{}", name_ref_key(&loser.name_ref), loser.revision),
            RecoveryEntry {
                record: loser,
                evidence: None,
                retained_at: meta.now_ms,
                reason: "bind_collision_loser".to_string(),
            },
        );
    }
    let redirect_revision = document.allocate_revision()?;
    document.redirects.insert(
        pending_key.clone(),
        SessionNameRedirect {
            from: pending.clone(),
            to: target.clone(),
            revision: redirect_revision,
        },
    );
    document.records.remove(&pending_key);

    // Internal state transfers (never user-visible wire fields).
    move_location_evidence(document, &pending_key, &target_key);
    union_generation_state(document, &pending_key, &target_key, meta.now_ms);
    transfer_native_write(document, &pending_key, &target_key, &record);
    apply_verified_location(document, &target_key, acquisition.location);

    // Task 4 — the explicit-open hook: a pending handle exists only through
    // an explicit create/open/resume lane, so this bind IS the user opening
    // the session. An unattempted absorbed series (hydration installed the
    // fingerprint at rest so history alone never schedules the paid title)
    // becomes eligible now; an attempted series keeps its own schedule, and
    // a protected winner keeps generation stopped. Name-reliability Task 5:
    // a series whose stored input is wrapper or derived text stays Idle and
    // drops it (never armed from it).
    if !source_is_protected(record.source) {
        if let Some(series) = document.generation.get_mut(&target_key) {
            session_name_first_message::explicit_open(series, &meta.input_refusals);
        }
    }

    // The session's saved name before the bind (none: the bind creates it).
    let cause = if existing.is_some() {
        NameChangeCause::BindCollision
    } else {
        NameChangeCause::Bind
    };
    let change = NameChangeEvent::new(cause, existing.as_ref(), None).with_from_ref(&pending_key);
    Ok(commit_decision(document, &target_key, Some(change)))
}

/// The pure pre-evaluation of one activity against a document snapshot:
/// exactly what the strict activity transaction would change, without
/// mutating. Shared by [`activity_decision`] (the transaction's apply path)
/// and the sweep's adopted-view pre-check ([`SessionNames::activity_work`]),
/// so the apply and the skip can never drift apart.
struct ActivityPlan {
    /// The first-message fallback that would replace the record's name.
    offer_fallback: Option<String>,
    /// The fallback replaces a self-heal record WITHOUT raising its rank
    /// (name-reliability Task 4): maintenance work the sweep may batch.
    offer_heals: bool,
    /// What the activity does to the generation series
    /// (`session_name_first_message::plan_series`).
    series: Option<SeriesPlan>,
}

impl ActivityPlan {
    fn is_noop(&self) -> bool {
        self.offer_fallback.is_none() && self.series.is_none()
    }

    /// Only maintenance (name-reliability Tasks 4–5): a self-heal
    /// replacement, an input re-absorbed at rest, a refused input dropped —
    /// nothing that arms generation or raises a real name. The sweep may
    /// batch it.
    fn is_maintenance(&self) -> bool {
        let series_maintenance = self.series.as_ref().is_none_or(|plan| !plan.arms());
        let offer_maintenance = self.offer_fallback.is_none() || self.offer_heals;
        !self.is_noop() && series_maintenance && offer_maintenance
    }
}

/// Evaluate the activity acceptance/arming conditions (delta-review round 3,
/// finding 2: the pre-check and the transaction share ONE policy). Callers
/// apply the unified-mode scope admission BEFORE planning:
/// - the first-message fallback is offered for EVERY reason that carries a
///   first user message — accepted, indexed, opened and resumed alike
///   (name-reliability Task 5, D4: an open terminal pane's session no longer
///   keeps its folder name when AI naming fails) — only when the extraction
///   is a valid name that is not a default or derived label (never wrapper
///   text, RC12), and only when the automatic-offer rule accepts it
///   (`session_name_policy`): it RAISES a real name's rank, or it replaces a
///   self-heal record (a junk default label, classified with the activity's
///   own `cwd`) — Task 4 — the latter only when the message can be the
///   session's first (`session_name_first_message::fallback_may_self_heal`:
///   an accepted send carries the current message, not the first);
/// - the series plan (`session_name_first_message::plan_series`) is skipped
///   for protected sources; it arms on new input or an explicit open of an
///   unattempted series, re-absorbs a re-derived indexed message at rest,
///   and drops refused (wrapper) input — Task 5.
fn plan_activity(
    document: &StoredDocument,
    key: &str,
    reason: NameActivityReason,
    first_user_message: Option<&str>,
    cwd: Option<&str>,
) -> ActivityPlan {
    let mut plan = ActivityPlan {
        offer_fallback: None,
        offer_heals: false,
        series: None,
    };
    let Some(record) = document.record_at(key) else {
        return plan;
    };
    if let Some(fallback) = first_user_message.and_then(first_message_fallback) {
        let applies = if session_name_first_message::fallback_may_self_heal(document, key, reason) {
            session_name_policy::automatic_offer_applies
        } else {
            session_name_policy::rank_raise_applies
        };
        if validate_name(&fallback).is_ok()
            && applies(record, &fallback, NameSource::FirstMessage, cwd)
        {
            plan.offer_heals = source_rank(NameSource::FirstMessage) <= source_rank(record.source);
            plan.offer_fallback = Some(fallback);
        }
    }
    if !source_is_protected(record.source) {
        plan.series =
            session_name_first_message::plan_series(document, key, reason, first_user_message);
    }
    plan
}

/// What applying one activity changed (shared by the per-row transaction
/// and the sweep maintenance batch).
struct ActivityApplied {
    key: String,
    /// The saved name changed, and why (name-reliability Task 12).
    change: Option<NameChangeEvent>,
    /// Generation bookkeeping changed (a persisted, invisible advance).
    bookkeeping: bool,
}

fn activity_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    input: NameActivity,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let applied = apply_activity(document, meta, input)?;
    if let Some(change) = applied.change {
        Ok(commit_decision(document, &applied.key, Some(change)))
    } else if applied.bookkeeping {
        // Bookkeeping-only commit: a generation advance with no visible text.
        Ok(commit_decision(document, &applied.key, None))
    } else {
        Ok(Decision::Read(read_update(document, &applied.key)))
    }
}

/// Apply one activity exactly as [`plan_activity`] planned it: the planned
/// fallback is installed as decided — never re-offered through the strict
/// raise, which refuses the equal-rank self-heal the plan allowed (C1) —
/// and the planned arm advances the series.
fn apply_activity(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    input: NameActivity,
) -> Result<ActivityApplied, NameError> {
    let NameActivity {
        target,
        mode,
        event_id: _event_id,
        reason,
        first_user_message,
        cwd,
    } = input;
    let (key, prior) = required_record(document, &target)?;
    let mut applied = ActivityApplied {
        key: key.clone(),
        change: None,
        bookkeeping: false,
    };

    // Scope admission (Task 4): only the unified coding-agent modes ever
    // enter the generator — kilroy (despite sharing the Claude runtime),
    // excluded providers, and shells keep their existing naming approach.
    if !freshell_freshagent::naming::is_unified_agent_mode(Some(&mode), None) {
        return Ok(applied);
    }

    let plan = plan_activity(
        document,
        &key,
        reason,
        first_user_message.as_deref(),
        cwd.as_deref(),
    );
    if plan.is_noop() {
        return Ok(applied);
    }

    if let Some(fallback) = plan.offer_fallback {
        replace_automatic(document, &key, fallback, NameSource::FirstMessage)?;
        applied.change = Some(NameChangeEvent::new(
            NameChangeCause::FirstMessageFallback,
            Some(&prior),
            cwd.as_deref(),
        ));
    }

    if let Some(series_plan) = plan.series {
        applied.bookkeeping = session_name_first_message::apply_series_plan(
            document,
            &key,
            series_plan,
            &meta.input_refusals,
        );
    }
    Ok(applied)
}

fn observe_native_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    input: NativeNameObservation,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let NativeNameObservation {
        target,
        title,
        origin,
        location_revision,
        event_id,
    } = input;
    let (key, record) = required_record(document, &target)?;

    // An old-location observation is provenance only: it can never mark the
    // current location synchronized or fold a stale title into the name.
    let verified_revision = document
        .locations
        .get(&key)
        .and_then(|location| location.verified.as_ref())
        .map(|verified| verified.location_revision)
        .unwrap_or(0);
    let stale = location_revision < verified_revision;

    let mut changed = false;
    // Name-reliability Task 4: the baseline this observation records, if
    // any (a valid, current-location, non-placeholder title that differs
    // from the record's last one).
    let mut new_baseline: Option<String> = None;
    // An invalid observation title (an external rename over the accepted-name
    // cap, or control characters) never fails the transaction: only the
    // offer and the divergence rearm are skipped for the invalid text.
    let valid_title = validate_name(&title).ok();
    match origin {
        // An own-write echo is provenance only: same-name or late echoes never
        // promote the source or revision.
        NativeNameOrigin::OwnWrite => {}
        NativeNameOrigin::Snapshot | NativeNameOrigin::ProviderAi => {
            if !stale {
                if let Some(name) = valid_title.clone() {
                    // The native rule (`session_name_policy`): placeholders
                    // and other default labels are provenance only, an echo
                    // of the baseline never changes the name, the first
                    // observation only records the baseline, and a changed
                    // title replaces an unprotected provider-level name.
                    let baseline = meta.staged_baselines.effective(document, &key);
                    let plan = session_name_policy::native_offer_decision(
                        &record,
                        baseline.as_deref(),
                        &name,
                    );
                    if plan.replace {
                        replace_automatic(document, &key, name, NameSource::ProviderAi)?;
                        changed = true;
                    }
                    new_baseline = plan.new_baseline;
                }
            }
        }
    }

    // Task 3 native-series policy: a DIFFERING current-location observation
    // makes the next remaining cycle ready — the provider's live value moved
    // away from the desired name, so a paused/settled writable series re-arms
    // its REMAINING cycles. Matching observations never schedule work;
    // exhaustion stays final for the revision; an `unsupported` series re-arms
    // only through a genuine capability/lifecycle change
    // (`record_acquisition_decision`), never through an observation; and no
    // observation ever replenishes consumed counts. An invalid title skips the
    // rearm too (it is not a trustable observation of a name).
    let mut status_changed = false;
    if let Some(observed_name) = valid_title.as_deref() {
        if !stale {
            let record_revision = document
                .record_at(&key)
                .map(|record| record.revision)
                .expect("the record exists");
            if let Some(state) = document.native_write.get_mut(&key) {
                let has_series = state.desired_revision.is_some() && state.desired_name.is_some();
                let current_series = state.desired_revision == Some(record_revision);
                let diverged = state
                    .desired_name
                    .as_deref()
                    .is_some_and(|d| d != observed_name);
                if has_series
                    && current_series
                    && diverged
                    && state.cycles_consumed < MAX_NATIVE_CYCLES
                {
                    let rearm = state.settled && state.status != NativeSyncStatus::Unsupported;
                    if rearm {
                        state.status = NativeSyncStatus::Unsynced;
                        state.settled = false;
                        state.unsynced_reason = Some("native divergence observed".to_string());
                        status_changed = true;
                        // Delta-review round 4, finding 2: the due-stamp
                        // rides ONLY a change this transaction commits. The
                        // stamp used to fire outside the rearm guard too,
                        // mutating the in-transaction document on the early
                        // `Decision::Read` path — and when that transaction
                        // was the first to adopt a newer external
                        // generation, `adopt_if_newer` installed the
                        // locally-mutated copy while the stored digest
                        // described the unmutated disk bytes. The stamp is
                        // semantically inert on the non-rearm paths anyway:
                        // a `None` due is immediately ready (the work
                        // snapshot's convention), and an unsupported series
                        // never enters the snapshot.
                        if state.next_due.is_none() {
                            state.next_due = Some(meta.now_ms);
                        }
                    }
                }
            }
        }
    }

    // Delta-review round 3, finding 5: an observation-only delta (nothing
    // user-visible moved) must not rewrite the document merely to persist
    // `last_observation.at` — that was a full-document replace + fsync per
    // observation during active provider conversations. The provenance
    // stages only when a real change is committing anyway, so the latest
    // observation's timestamp rides the next real write instead.
    if changed || status_changed {
        let entry = document.native_write.entry(key.clone()).or_default();
        entry.last_observation = Some(StoredObservation {
            origin: match origin {
                NativeNameOrigin::Snapshot => "snapshot".to_string(),
                NativeNameOrigin::ProviderAi => "provider_ai".to_string(),
                NativeNameOrigin::OwnWrite => "own_write".to_string(),
            },
            location_revision,
            event_id,
            at: meta.now_ms,
            stale,
        });
        // A new baseline rides this real commit (and supersedes any staged
        // one for the record).
        if let Some(baseline) = new_baseline {
            entry.last_native_title = Some(baseline);
            meta.staged_baselines.remove(&key);
        }
    } else {
        // A baseline that changes nothing else never makes its own commit:
        // it is staged in memory, and the sweep maintenance batch persists it
        // (LB-B1). Losing it at a restart only means the next observation
        // records it again.
        if let Some(baseline) = new_baseline {
            tracing::debug!(
                target: "freshell_server::session_names",
                op = "observe_native",
                name_ref = %key,
                "session_names.native_baseline_staged"
            );
            meta.staged_baselines.stage(document, &key, baseline);
        }
        return Ok(Decision::Read(read_update(document, &key)));
    }

    if changed {
        let change = NameChangeEvent::new(NameChangeCause::NativeObservation, Some(&record), None);
        Ok(commit_decision(document, &key, Some(change)))
    } else {
        // A status-only update publishes the unchanged record with its new
        // nativeSync projection; clients fold it by documentGeneration.
        Ok(commit_decision_publishing_status(document, &key))
    }
}

fn record_acquisition_decision(
    document: &mut StoredDocument,
    _meta: &TxnMeta,
    target: &SessionNameRef,
    acquisition: NativeAcquisition,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let (key, _record) = required_record(document, target)?;
    match acquisition.persistence {
        NativePersistence::Verified => {
            let changed = apply_verified_location(document, &key, acquisition.location);
            // Task 3: a genuine capability/lifecycle change — the verified
            // routing evidence MOVED — makes the next remaining cycle of a
            // paused (`synced`/`settled`) or capability-failed (`unsupported`)
            // series usable again at the new route. Consumed counts are never
            // replenished; a differing current-location observation governs
            // beyond this point.
            if changed {
                let record_revision = document
                    .record_at(&key)
                    .map(|record| record.revision)
                    .expect("the record exists");
                if let Some(state) = document.native_write.get_mut(&key) {
                    let current_series = state.desired_revision == Some(record_revision);
                    let usable_cycles = state.cycles_consumed < MAX_NATIVE_CYCLES;
                    if current_series
                        && usable_cycles
                        && (state.status == NativeSyncStatus::Unsupported
                            || (state.settled && state.status != NativeSyncStatus::Unsupported))
                    {
                        state.status = NativeSyncStatus::Unsynced;
                        state.settled = false;
                        state.unsynced_reason =
                            Some("native route reacquired; remaining cycles re-armed".to_string());
                    }
                }
            }
            if changed {
                Ok(commit_decision_publishing_status(document, &key))
            } else {
                Ok(Decision::Read(read_update(document, &key)))
            }
        }
        NativePersistence::Prospective => {
            let entry = document.locations.entry(key.clone()).or_default();
            let changed = entry.prospective.as_ref() != Some(&acquisition.location);
            if changed {
                entry.prospective = Some(acquisition.location);
                Ok(Decision::Write {
                    value: update_after_commit(document, &key, false, RedirectScope::ToRecord)
                        .expect("the record resolves"),
                    publish: Vec::new(),
                })
            } else {
                Ok(Decision::Read(
                    update_for_key(document, &key, false, RedirectScope::ToRecord)
                        .expect("the record resolves"),
                ))
            }
        }
    }
}

/// Task 4: the remaining-generation retry delay ("after failure 1 retry
/// becomes due in 30 seconds, after failure 2 in five minutes"). These are
/// eligibility delays, not queue latency guarantees. A consumed count at
/// the cap answers `None` (exhaustion is final).
fn generation_retry_delay_ms(consumed: u32) -> Option<i64> {
    match consumed {
        1 => Some(GENERATION_RETRY_1_MS),
        2 => Some(GENERATION_RETRY_2_MS),
        _ => None,
    }
}

fn claim_generation_start_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    target: &SessionNameRef,
    attempt_id: &str,
) -> Result<Decision<Option<GenerationClaim>>, NameError> {
    let (key, record) = required_record(document, target)?;
    let Some(series) = document.generation.get_mut(&key) else {
        return Ok(Decision::Read(None));
    };
    // Claimable right now: an armed Eligible series that is due, below the
    // cap, on a record whose accepted source is below Freshell AI. Anything
    // else is a bounded no-op — nothing is consumed.
    if series.status != GenerationStatus::Eligible
        || series.consumed >= MAX_GENERATION_STARTS
        || source_is_protected(record.source)
    {
        return Ok(Decision::Read(None));
    }
    if let Some(due) = series.next_due {
        if due > meta.now_ms {
            return Ok(Decision::Read(None));
        }
    }
    // Name-reliability Task 5, the prompt-input guard's last line: wrapper
    // or derived text is never sent to the model. The claim refuses it
    // without consuming a start and drops the input, so the series rests
    // and the worker is never offered it again.
    if session_name_first_message::drop_refused_input(
        series,
        RefusalSite::Claim,
        &meta.input_refusals,
    ) {
        return Ok(Decision::Write {
            value: None,
            publish: Vec::new(),
        });
    }
    // Persist the start before dispatch; the fold decides whether it
    // counted (name-reliability Task 6).
    let series_id = series.series_id.clone();
    let input_fingerprint = series.input_fingerprint.clone();
    let excerpt = series.excerpt.clone();
    let consumed = session_name_generation_series::charge_start(series, attempt_id, meta.now_ms);
    // The persisted alternating class cursor: this claim served generation.
    document.scheduling_cursor.last_class = Some("generation".to_string());
    let _value = update_after_commit(document, &key, false, RedirectScope::ToRecord)
        .expect("the record resolves");
    Ok(Decision::Write {
        value: Some(GenerationClaim {
            target: record.name_ref.clone(),
            series_id,
            input_fingerprint: input_fingerprint.unwrap_or_default(),
            excerpt,
            attempt_id: attempt_id.to_string(),
            consumed,
        }),
        publish: Vec::new(),
    })
}

fn fold_generation_outcome_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    target: &SessionNameRef,
    series_id: &str,
    input_fingerprint: &str,
    outcome: GenerationOutcome,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let (key, record) = required_record(document, target)?;
    let Some(series) = document.generation.get_mut(&key) else {
        return Err(NameError::NotFound(format!(
            "no generation series is armed for {key}"
        )));
    };
    // Accept only if that same series is current: superseded-series
    // completions are discarded.
    if series.series_id != series_id {
        return Ok(Decision::Read(read_update(document, &key)));
    }
    // The input-fingerprint guard: a re-armed series keeps its series id, so
    // a late answer generated from older input must not be accepted — but
    // the start it was charged still settles (name-reliability Task 6).
    if series.input_fingerprint.as_deref() != Some(input_fingerprint) {
        return Ok(
            if session_name_generation_series::settle_superseded_start(
                series,
                &outcome,
                meta.now_ms,
            ) {
                commit_decision(document, &key, None)
            } else {
                Decision::Read(read_update(document, &key))
            },
        );
    }
    // A protected winner (manual, migration-protected, accepted Freshell AI)
    // rejects late output — and stops the series for good.
    if source_is_protected(record.source) {
        series.status = GenerationStatus::Idle;
        series.next_due = None;
        series.excerpt = None;
        return Ok(commit_decision(document, &key, None));
    }
    // An INVALID answer — a control character inside the reply (the
    // transport trims and caps but never strips them), an oversize or
    // empty-after-trim candidate — consumes the already-charged attempt
    // and schedules the bounded retry exactly like an empty answer
    // (review I2). Propagating `Err` here would error the transaction and
    // strand the series `InFlight` with no retry — the interrupted-start
    // shape, permanently when the series is the only work.
    let outcome = match outcome {
        GenerationOutcome::Answer(answer) => match validate_name(&answer) {
            Ok(_) => GenerationOutcome::Answer(answer),
            Err(_) => GenerationOutcome::Empty,
        },
        other => other,
    };
    match outcome {
        GenerationOutcome::Answer(answer) => {
            let name = validate_name(&answer)?;
            let change = NameChangeEvent::new(NameChangeCause::Generation, Some(&record), None)
                .with_series(series_id);
            if offer_mut(document, &key, name, NameSource::FreshellAi, meta.now_ms)? {
                {
                    let series = document
                        .generation
                        .get_mut(&key)
                        .expect("the series still exists");
                    series.status = GenerationStatus::Idle;
                    series.excerpt = None;
                    series.next_due = None;
                }
                // An accepted Freshell AI name is a writable name decision:
                // arm its bounded native writeback series.
                let record = document
                    .record_at(&key)
                    .cloned()
                    .expect("the accepted record resolves");
                reset_native_series(document, &key, &record);
                Ok(commit_decision(document, &key, Some(change)))
            } else {
                Ok(Decision::Read(read_update(document, &key)))
            }
        }
        GenerationOutcome::Empty | GenerationOutcome::Failed(_) => {
            // The attempt was charged at the claim and counted: exhaust at
            // the cap, else schedule the remaining delay from this fold.
            session_name_generation_series::settle_consumed_start(series, meta.now_ms);
            Ok(commit_decision(document, &key, None))
        }
        GenerationOutcome::CapabilityUnavailable { attempt_id }
        | GenerationOutcome::Throttled { attempt_id } => {
            // Name-reliability Task 6: the request never had a fair chance
            // (refused credential, permission, proxy or quota): give the
            // start back and keep the input.
            if session_name_generation_series::refund_start(series, &attempt_id, meta.now_ms) {
                Ok(commit_decision(document, &key, None))
            } else {
                Ok(Decision::Read(read_update(document, &key)))
            }
        }
    }
}

fn recover_interrupted_generation_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
) -> Result<Decision<usize>, NameError> {
    let mut recovered = 0usize;
    for series in document.generation.values_mut() {
        if series.status != GenerationStatus::InFlight {
            continue;
        }
        // Recover the interrupted start ONCE as failed at recovery time and
        // schedule the remaining delay from this fold. The claim already
        // charged the attempt; the recovered series is Eligible again (or
        // exhausted at the cap).
        if series.consumed >= MAX_GENERATION_STARTS {
            series.status = GenerationStatus::Exhausted;
            series.exhausted_at = Some(meta.now_ms);
            series.excerpt = None;
        } else {
            series.status = GenerationStatus::Eligible;
        }
        series.next_due =
            Some(meta.now_ms + generation_retry_delay_ms(series.consumed).unwrap_or(0));
        recovered += 1;
    }
    if recovered == 0 {
        return Ok(Decision::Read(0));
    }
    Ok(Decision::Write {
        value: recovered,
        publish: Vec::new(),
    })
}

fn hydrate_indexed_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    input: IndexedNameInput,
    absorb: bool,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let key = indexed_key(&input);
    // The ONE hydration plan (name-reliability Task 4, C2), shared with the
    // sweep's pre-check. The free fallbacks: a provider-authored title, then
    // the first-message extraction, then the directory basename (the
    // ensure_pending fallback). Round-2 carried finding F2 (adjudicated): a
    // provider title that FAILS accepted-name validation (over the
    // 200-scalar cap, or control characters) is an unusable rung, not a
    // failed hydration — the ladder falls through exactly like an absent
    // title. An abort would leave the session with NO canonical record while
    // the ~5s sweep re-failed and re-logged it every pass.
    let (name, source) = match session_name_policy::plan_hydrate(document, &input) {
        // An established record (or a pending handle already bound to this
        // durable session through a redirect) is returned unchanged.
        None => return Ok(Decision::Read(read_update(document, &key))),
        // A self-heal record: the allowed rung replaces the junk name; no
        // generation series is created or absorbed on this path.
        Some(session_name_policy::HydratePlan::Heal { name, source }) => {
            let change = NameChangeEvent::new(
                NameChangeCause::Hydrate,
                document.record_at(&key),
                input.cwd.as_deref(),
            );
            replace_automatic(document, &key, name, source)?;
            return Ok(commit_decision(document, &key, Some(change)));
        }
        Some(session_name_policy::HydratePlan::Insert { name, source }) => (name, source),
    };
    let IndexedNameInput {
        provider,
        session_id,
        first_user_message,
        ..
    } = input;
    let target = SessionNameRef::Session {
        provider,
        session_id,
    };
    let revision = document.allocate_revision()?;
    document.records.insert(
        key.clone(),
        SessionNameRecord {
            name_ref: target.clone(),
            name,
            source,
            revision,
            manual_revision: None,
            renamed_at: None,
            legacy_origin: None,
        },
    );
    // Absorb the observed first message at rest: the series keeps the input
    // fingerprint/excerpt so a later pass re-feeding the SAME message is a
    // no-op, but it rests Idle — the boot snapshot never schedules paid
    // titles across history. Without absorption (a later pass observing a
    // genuinely new session), no series is created here: the activity feed
    // right after arms it with the newly observed message.
    if absorb {
        // Name-reliability Task 5: wrapper or derived text is never absorbed
        // as AI-naming input.
        if let Some(message) = first_user_message
            .as_deref()
            .map(str::trim)
            .filter(|m| session_name_first_message::is_generation_input(m))
        {
            document.generation.insert(
                key.clone(),
                GenerationState {
                    status: GenerationStatus::Idle,
                    series_id: Uuid::new_v4().to_string(),
                    input_fingerprint: Some(fingerprint_message(message)),
                    excerpt: Some(excerpt_of(message)),
                    attempt_ids: Vec::new(),
                    attempt_starts: Vec::new(),
                    consumed: 0,
                    next_due: None,
                    exhausted_at: None,
                },
            );
        }
    }
    let _ = meta;
    let value = update_after_commit(document, &key, true, RedirectScope::None)
        .expect("the freshly inserted record resolves");
    let change = NameChangeEvent::new(NameChangeCause::Hydrate, None, None);
    Ok(Decision::Write {
        value,
        publish: vec![PublishSpec::changed(key, change)],
    })
}

// ---------------------------------------------------------------------------
// Task 3: native cycle machine decisions (claim / read charge / outcome fold)
// ---------------------------------------------------------------------------

/// The live route for a series: the verified location when one exists, else
/// the retained prospective hint. `None` = no route is known yet.
fn native_route_of(document: &StoredDocument, key: &str) -> Option<(NativeLocation, NameRevision)> {
    document.locations.get(key).and_then(|location| {
        location
            .verified
            .as_ref()
            .map(|verified| (verified.location.clone(), verified.location_revision))
            .or_else(|| {
                location
                    .prospective
                    .as_ref()
                    .map(|prospective| (prospective.clone(), 0))
            })
    })
}

/// The retry delay that makes the next remaining cycle eligible after the
/// cycle-1/cycle-2 failure ("minimum five seconds after cycle 1 failure, then
/// 30 seconds after cycle 2 failure"). These are eligibility delays, not
/// queue latency guarantees. Tests override the floor through the data-dir
/// keyed [`TestHook::NativeRetryFloorMs`] so the bounded-allowance math is
/// pinnable without wall-clock waits.
fn native_retry_delay_ms(meta: &TxnMeta, cycles_consumed: u32) -> Option<i64> {
    if let Some(floor) = meta.native_retry_floor {
        return (cycles_consumed < MAX_NATIVE_CYCLES).then_some(floor);
    }
    match cycles_consumed {
        1 => Some(NATIVE_CYCLE_RETRY_1_MS),
        2 => Some(NATIVE_CYCLE_RETRY_2_MS),
        _ => None,
    }
}

/// Whether an armed series is claimable RIGHT NOW: a current writable series
/// with remaining cycles, not settled, and due. Consumes nothing on refusal.
fn native_series_claimable(
    document: &StoredDocument,
    key: &str,
    now: i64,
) -> Option<(SessionNameRecord, NameSource)> {
    let state = document.native_write.get(key)?;
    if state.settled || state.cycles_consumed >= MAX_NATIVE_CYCLES {
        return None;
    }
    if state.status == NativeSyncStatus::Synced || state.status == NativeSyncStatus::Unsupported {
        return None;
    }
    if let Some(due) = state.next_due {
        if due > now {
            return None;
        }
    }
    let record = document.record_at(key)?.clone();
    if state.desired_revision != Some(record.revision) || !source_is_writable(record.source) {
        return None;
    }
    let source = record.source;
    Some((record, source))
}

fn claim_native_cycle_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    target: &SessionNameRef,
    receipt_id: &str,
) -> Result<Decision<Option<crate::session_name_native::NativeCycleClaim>>, NameError> {
    let (key, _record) = required_record(document, target)?;
    let Some((record, source)) = native_series_claimable(document, &key, meta.now_ms) else {
        return Ok(Decision::Read(None));
    };
    // Missing location/capability pauses BEFORE consuming a cycle.
    let Some((location, location_revision)) = native_route_of(document, &key) else {
        return Ok(Decision::Read(None));
    };
    // Charge the cycle and persist the full attempt before dispatch: desired
    // revision, attempted location/locationRevision, title, source, and the
    // unique own-write receipt. A restart discovering this interrupted cycle
    // consumes it exactly once.
    {
        let entry = document
            .native_write
            .get_mut(&key)
            .expect("claimable series exists");
        // Backfill a legacy series' epoch (documents written before the
        // stamp existed): the claimable series' desired revision IS its
        // arming revision.
        if entry.series_epoch.is_none() {
            entry.series_epoch = Some(record.revision);
        }
        entry.cycles_consumed += 1;
        entry.receipt_id = Some(receipt_id.to_string());
        if !entry.attempted_receipts.contains(&receipt_id.to_string()) {
            entry.attempted_receipts.push(receipt_id.to_string());
        }
        entry.attempted_location = Some(location.clone());
        entry.attempted_location_revision = Some(location_revision);
    }
    // The persisted alternating class cursor: this claim served native.
    document.scheduling_cursor.last_class = Some("native".to_string());
    let series_epoch = document
        .native_write
        .get(&key)
        .expect("the series exists")
        .series_epoch
        .expect("stamped above");
    let claim = crate::session_name_native::NativeCycleClaim {
        target: record.name_ref.clone(),
        location,
        location_revision,
        desired_revision: record.revision,
        series_epoch,
        title: record.name.clone(),
        source,
        receipt_id: receipt_id.to_string(),
        cycle: document
            .native_write
            .get(&key)
            .expect("the series exists")
            .cycles_consumed,
    };
    // Bookkeeping-only generation (the in-flight receipt): publishes nothing.
    let _value = update_after_commit(document, &key, false, RedirectScope::ToRecord)
        .expect("the record resolves");
    Ok(Decision::Write {
        value: Some(claim),
        publish: Vec::new(),
    })
}

fn charge_native_read_decision(
    document: &mut StoredDocument,
    target: &SessionNameRef,
    series_epoch: NameRevision,
) -> Result<Decision<bool>, NameError> {
    let (key, record) = required_record(document, target)?;
    let Some(state) = document.native_write.get_mut(&key) else {
        return Ok(Decision::Read(false));
    };
    // Only the CURRENT series' reads charge the allowance — a superseded
    // series' late operations are provenance, never budget. The desired-
    // revision guard catches a series superseded by a newer record revision;
    // the EPOCH guard catches a series superseded by a newer name decision on
    // the same record.
    if state.desired_revision != Some(record.revision) {
        return Ok(Decision::Read(false));
    }
    if state.series_epoch != Some(series_epoch) {
        return Ok(Decision::Read(false));
    }
    if state.reads_consumed >= MAX_NATIVE_READS {
        return Ok(Decision::Read(false));
    }
    state.reads_consumed += 1;
    // Bookkeeping-only generation (the read charge): publishes nothing.
    let _value = update_after_commit(document, &key, false, RedirectScope::ToRecord)
        .expect("the record resolves");
    Ok(Decision::Write {
        value: true,
        publish: Vec::new(),
    })
}

/// The Task 3 outcome fold. Guards: an old acknowledgement (or read) can never
/// synchronize a newer revision or a relocated target — the series'
/// `desired_revision` must still be the accepted record's revision, the fold's
/// SERIES EPOCH must still be the armed series' identity (a superseded
/// dispatch's late operations are provenance only), AND the attempted location
/// revision must still be the record's current verified route. Classification
/// is preserved (`Undelivered` vs `Ambiguous` vs `Unsupported` keep their own
/// reasons); provider failures never roll the canonical name back.
fn fold_native_outcome_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    target: &SessionNameRef,
    attempted_location_revision: NameRevision,
    series_epoch: NameRevision,
    outcome: crate::session_name_native::NativeOutcomeFold,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    use crate::session_name_native::NativeOutcomeFold;

    let (key, record) = required_record(document, target)?;
    let before = native_sync_projection(document, &key);
    let verified_revision = document
        .locations
        .get(&key)
        .and_then(|location| location.verified.as_ref())
        .map(|verified| verified.location_revision);
    let Some(state) = document.native_write.get_mut(&key) else {
        // No series (or a pure observation-only entry): a stale late outcome.
        return Ok(Decision::Read(read_update(document, &key)));
    };
    // Stale fold guards: a newer name decision superseded the series, or the
    // target relocated since the attempt. Nothing changes — unknown old
    // outcomes cannot change the saved winner.
    let series_current =
        state.desired_revision == Some(record.revision) && state.series_epoch == Some(series_epoch);
    let location_current = match verified_revision {
        Some(current) => attempted_location_revision == current,
        // No verified route: the attempt targeted a prospective route that is
        // still the series' attempted evidence.
        None => state
            .attempted_location_revision
            .is_none_or(|attempted| attempted == attempted_location_revision),
    };
    if !series_current || !location_current {
        return Ok(Decision::Read(read_update(document, &key)));
    }

    let now = meta.now_ms;
    let desired_name = state
        .desired_name
        .clone()
        .unwrap_or_else(|| record.name.clone());
    let cycles_consumed = state.cycles_consumed;
    let exhausted = cycles_consumed >= MAX_NATIVE_CYCLES;

    fn schedule_native_retry(
        state: &mut NativeWriteState,
        now: i64,
        exhausted: bool,
        cycles_consumed: u32,
        meta: &TxnMeta,
    ) {
        if exhausted {
            // Exhaustion is FINAL for this revision.
            state.settled = true;
            state.next_due = None;
        } else if let Some(delay) = native_retry_delay_ms(meta, cycles_consumed) {
            state.next_due = Some(now + delay);
        }
    }

    match outcome {
        NativeOutcomeFold::Read { observed, receipt } => {
            let matching = observed.as_deref() == Some(desired_name.as_str());
            if matching {
                if state.ambiguous {
                    // Matching readback after ambiguity: provenance only — it
                    // is not proof an older external request cannot land.
                    state.observed_current = Some(true);
                    state.settled = true;
                    state.next_due = None;
                    state.unsynced_reason = Some(
                        "ambiguous native write; matching readback observed but not proof an older external request cannot land"
                            .to_string(),
                    );
                } else {
                    // A current-revision readback at the attempted target is
                    // the ONLY thing that establishes synchronization — of
                    // this exact name and location revision.
                    state.status = NativeSyncStatus::Synced;
                    state.settled = true;
                    state.next_due = None;
                    state.unsynced_reason = None;
                    state.observed_current = Some(true);
                    if let Some(receipt) = receipt {
                        state.last_confirmed_receipt = Some(receipt);
                    }
                }
            } else {
                state.status = NativeSyncStatus::Unsynced;
                state.unsynced_reason = Some(if observed.is_none() {
                    // A `None` readback is an EXISTING target holding no
                    // title (a missing target is diagnosed through the
                    // adapter's error paths) — the attempted write did not
                    // stick.
                    "the native target holds no title at the attempted location".to_string()
                } else {
                    "divergent native title at the attempted location".to_string()
                });
                schedule_native_retry(state, now, exhausted, cycles_consumed, meta);
            }
        }
        NativeOutcomeFold::WriteAcknowledged { receipt } => {
            // A confirmed ack clears ambiguity for THIS dispatch — the
            // confirming readback (folded as a `Read`) decides synchronization.
            state.ambiguous = false;
            if !state.attempted_receipts.contains(&receipt) {
                state.attempted_receipts.push(receipt);
            }
        }
        NativeOutcomeFold::Undelivered { reason } => {
            state.status = NativeSyncStatus::Unsynced;
            state.unsynced_reason = Some(reason);
            schedule_native_retry(state, now, exhausted, cycles_consumed, meta);
        }
        NativeOutcomeFold::Ambiguous { reason } => {
            state.ambiguous = true;
            state.status = NativeSyncStatus::Unsynced;
            state.unsynced_reason = Some(reason);
            schedule_native_retry(state, now, exhausted, cycles_consumed, meta);
        }
        NativeOutcomeFold::Unsupported { reason } => {
            state.status = NativeSyncStatus::Unsupported;
            state.unsynced_reason = Some(reason);
            state.settled = true;
            state.next_due = None;
        }
    }

    let after = native_sync_projection(document, &key);
    if before != after {
        Ok(commit_decision_publishing_status(document, &key))
    } else {
        Ok(commit_decision(document, &key, None))
    }
}

// ---------------------------------------------------------------------------
// Task 7 — legacy-name import
// ---------------------------------------------------------------------------

/// The server-authoritative classification of one legacy candidate: the
/// effective name source, protection evidence, scope and trustworthy
/// explicit-rename time the total order compares against. Raw-evidence
/// classification is authoritative — a legacy flag establishes protection
/// with UNKNOWN historic origin (never recovered human intent), and only
/// the trusted server-boot lane may honor `explicit_rename` (manual) or an
/// accepted-Freshell-AI source; an imported claim is capped below both.
#[derive(Debug, Clone, PartialEq)]
struct ClassifiedLegacyCandidate {
    name: String,
    source: NameSource,
    scope: LegacyCandidateScope,
    protection: LegacyProtectionEvidence,
    explicit_rename_at: Option<i64>,
    evidence_key: String,
    candidate_id: String,
}

fn classify_legacy_candidate(
    trusted_boot: bool,
    candidate: &LegacyNameCandidate,
) -> ClassifiedLegacyCandidate {
    let (source, protection) = match candidate.protection_evidence {
        LegacyProtectionEvidence::ExplicitRename => {
            if trusted_boot {
                // The one reliable explicit-rename evidence: the old durable
                // session-rename ladder (`titleSource:"user"`), which only
                // the user-facing session Rename could write.
                (NameSource::Manual, LegacyProtectionEvidence::ExplicitRename)
            } else {
                // Browser evidence can never prove a human author: the old
                // automation→manual-flag path wrote the same flags. The
                // claim keeps the label protected, with unknown origin.
                (
                    NameSource::LegacyProtected,
                    LegacyProtectionEvidence::LegacyFlag,
                )
            }
        }
        LegacyProtectionEvidence::LegacyFlag => (
            NameSource::LegacyProtected,
            LegacyProtectionEvidence::LegacyFlag,
        ),
        LegacyProtectionEvidence::None => {
            // A known automatic origin keeps its rank — except that an
            // untrusted import can never assert accepted Freshell AI (a
            // display mirror is not an accepted generation result), and a
            // claimed manual/protected source without protection evidence
            // degrades to the strongest automatic evidence it can carry.
            let source = match candidate.source {
                NameSource::Manual | NameSource::LegacyProtected => NameSource::ProviderAi,
                NameSource::FreshellAi if !trusted_boot => NameSource::ProviderAi,
                other => other,
            };
            (source, LegacyProtectionEvidence::None)
        }
    };
    ClassifiedLegacyCandidate {
        name: candidate.name.trim().to_string(),
        source,
        scope: candidate.scope,
        protection,
        explicit_rename_at: candidate.explicit_rename_at,
        evidence_key: candidate.evidence_key.clone(),
        candidate_id: candidate.id.clone(),
    }
}

/// The core the candidate order compares. `Less` means `a` wins.
///
/// Order: source rank (manual > legacy_protected > freshell_ai >
/// provider_ai > first_message > directory), then — within proven manual —
/// trustworthy explicit-rename recency (later first, dated ahead of
/// undated), then scope (session > pane > source_tab > terminal >
/// derived). Nothing else orders: candidates equal on all three compare
/// `Equal`, and the apply path replaces only on a strict win, so the
/// incumbent stays — a browser window or device id (the evidence key and
/// candidate id carry them) never displaces an installed name (Task 3).
/// Within one boot an id can still pick among exact equals:
/// [`order_boot_legacy_candidates`] breaks comparator ties by candidate id,
/// so the lowest id for a target installs first and stays (the same one on
/// every boot). Generic updatedAt/mtime/layout timestamps never reach
/// `explicit_rename_at`, so they can never order here.
fn compare_classified_candidates(
    a: &ClassifiedLegacyCandidate,
    b: &ClassifiedLegacyCandidate,
) -> std::cmp::Ordering {
    let rank = source_rank(b.source).cmp(&source_rank(a.source));
    if rank != std::cmp::Ordering::Equal {
        return rank;
    }
    if a.source == NameSource::Manual && b.source == NameSource::Manual {
        match (a.explicit_rename_at, b.explicit_rename_at) {
            (Some(x), Some(y)) => {
                let recency = y.cmp(&x);
                if recency != std::cmp::Ordering::Equal {
                    return recency;
                }
            }
            (Some(_), None) => return std::cmp::Ordering::Less,
            (None, Some(_)) => return std::cmp::Ordering::Greater,
            (None, None) => {}
        }
    }
    legacy_scope_rank(b.scope).cmp(&legacy_scope_rank(a.scope))
}

/// Scope tie-break: session > pane > source_tab > terminal > derived.
fn legacy_scope_rank(scope: LegacyCandidateScope) -> u8 {
    match scope {
        LegacyCandidateScope::Session => 4,
        LegacyCandidateScope::Pane => 3,
        LegacyCandidateScope::SourceTab => 2,
        LegacyCandidateScope::Terminal => 1,
        LegacyCandidateScope::Derived => 0,
    }
}

/// Write one import's immutable backup (create-once): the raw evidence
/// envelopes verbatim plus the candidates as the STORE receives them —
/// for the HTTP lane that is route-resolved (`legacy_terminal` targets the
/// route already mapped through the identity ledger; the literal received
/// bytes live on in the route's request body, and the raw evidence
/// envelopes carry the original payload verbatim). A present file is
/// never rewritten — the first receipt of an import id owns the copy. The
/// write happens BEFORE anything is acknowledged, so a later commit failure
/// leaves the backup (and the retry reuses it) without any ack.
fn write_import_backup_once(
    backup_dir: &Path,
    input: &LegacyNameImport,
    received_at: i64,
) -> Result<(), NameError> {
    let digest = digest_bytes(input.import_id.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let path = backup_dir.join(format!("{hex}.json"));
    if path.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(backup_dir).map_err(|e| {
        NameError::Persistence(format!(
            "cannot create legacy import backup dir {}: {e}",
            backup_dir.display()
        ))
    })?;
    let body = serde_json::json!({
        "version": 1,
        "importId": input.import_id,
        "receivedAt": received_at,
        "evidence": input.evidence,
        "candidates": input.candidates,
    });
    let bytes = serde_json::to_vec(&body).map_err(|e| {
        NameError::Persistence(format!("cannot serialize legacy import backup: {e}"))
    })?;
    let tmp = backup_dir.join(format!(".{hex}.json.tmp"));
    atomic_write_durable(&path, &tmp, &bytes).map_err(|e| {
        NameError::Persistence(format!(
            "legacy import backup write failed (originals retained, nothing acknowledged): {e}"
        ))
    })
}

/// What applying one candidate did.
struct LegacyCandidateOutcome {
    /// The canonical record key the candidate targeted — `None` means the
    /// evidence was unresolved/ambiguous/invalid and stays recovery-only
    /// (its immutable backup retains it).
    key: Option<String>,
    changed: bool,
}

/// Resolve a legacy target to the canonical ref the store applies it
/// through. Canonical refs resolve through pending→durable redirects;
/// `legacy_session` maps through the structured provider/session identity
/// for the three scoped providers (a non-scoped provider is out of
/// migration scope — recovery-only); `legacy_terminal` is resolved at the
/// composition boundary (route/boot identity ledger) — what reaches the
/// store unresolved stays recovery-only.
fn resolve_legacy_target(
    document: &StoredDocument,
    target: &LegacyNameTarget,
) -> Option<SessionNameRef> {
    match target {
        LegacyNameTarget::Canonical(reference) => {
            let (resolved, _) = document.resolve_ref(reference);
            Some(resolved)
        }
        LegacyNameTarget::LegacySession { session_ref, .. } => {
            let named =
                freshell_freshagent::naming::named_provider_for(Some(&session_ref.provider), None)?;
            let reference = SessionNameRef::Session {
                provider: named,
                session_id: session_ref.session_id.clone(),
            };
            let (resolved, _) = document.resolve_ref(&reference);
            Some(resolved)
        }
        LegacyNameTarget::LegacyTerminal { .. } => None,
    }
}

/// Apply one classified candidate against the current document state:
/// install a missing record, or compare against the existing record /
/// retained winning migration evidence, replacing only on a strict win.
/// Post-migration protection: a record whose accepted source is manual,
/// legacy-protected or accepted Freshell AI (or which moved after the
/// migration installed it through a protected decision) can never be
/// replaced by a later legacy candidate.
fn apply_legacy_candidate(
    document: &mut StoredDocument,
    resolved: SessionNameRef,
    classified: &ClassifiedLegacyCandidate,
) -> Result<LegacyCandidateOutcome, NameError> {
    let key = name_ref_key(&resolved);
    let Some(current) = document.records.get(&key).cloned() else {
        // No record yet: install the migrated record (and its evidence).
        install_migration_record(document, resolved, classified)?;
        return Ok(LegacyCandidateOutcome {
            key: Some(key),
            changed: true,
        });
    };

    // An equal-or-losing candidate never disturbs the current winner.
    let candidate_wins = match document.migration.winning_evidence.get(&key) {
        Some(evidence) if current.revision == evidence.installed_revision => {
            // Still migration-owned: compare against the retained winning
            // evidence. Only a strict win (higher rank, a later proven
            // rename, or a wider scope) replaces it; an equal candidate —
            // e.g. the same label kind from another window — leaves the
            // incumbent.
            let retained = ClassifiedLegacyCandidate {
                name: evidence.name.clone(),
                source: evidence.source,
                scope: evidence.scope,
                protection: LegacyProtectionEvidence::LegacyFlag,
                explicit_rename_at: evidence.explicit_rename_at,
                evidence_key: evidence.evidence_key.clone(),
                candidate_id: evidence.candidate_id.clone(),
            };
            compare_classified_candidates(classified, &retained) == std::cmp::Ordering::Less
        }
        Some(_) => {
            // The record moved after the migration installed it. A
            // post-migration explicit rename or accepted Freshell AI name
            // is protected; otherwise the rank order still decides.
            if source_is_protected(current.source) {
                false
            } else {
                candidate_beats_current(classified, &current)
            }
        }
        None => {
            // No migration evidence: a record created by the normal flows.
            if source_is_protected(current.source) {
                false
            } else {
                candidate_beats_current(classified, &current)
            }
        }
    };
    if !candidate_wins {
        return Ok(LegacyCandidateOutcome {
            key: Some(key),
            changed: false,
        });
    }

    install_migration_record(document, resolved, classified)?;
    Ok(LegacyCandidateOutcome {
        key: Some(key),
        changed: true,
    })
}

/// The one install path: allocate the record revision, install the record,
/// arm native writeback for a writable accepted source, and retain the
/// winning migration evidence for later previously-offline imports.
fn install_migration_record(
    document: &mut StoredDocument,
    resolved: SessionNameRef,
    classified: &ClassifiedLegacyCandidate,
) -> Result<(), NameError> {
    let key = name_ref_key(&resolved);
    let revision = document.allocate_revision()?;
    let record = migration_record(&resolved, classified, revision);
    document.records.insert(key.clone(), record.clone());
    if source_is_writable(record.source) {
        reset_native_series(document, &key, &record);
    }
    retain_migration_evidence(document, &key, classified, revision);
    Ok(())
}

/// Rank comparison against a current (unprotected, post-migration) record.
fn candidate_beats_current(
    classified: &ClassifiedLegacyCandidate,
    current: &SessionNameRecord,
) -> bool {
    // Equal automatic ranks preserve the accepted value; a candidate only
    // ever RAISES rank (the same rule as `offer_mut`).
    source_rank(classified.source) > source_rank(current.source)
}

/// Build the record a migration installs. Unknown-origin candidates get no
/// fabricated renamedAt/manualRevision — only a proven manual rename
/// carries manual_revision (the revision of this manual decision); a
/// trustworthy historical rename time would be retained as evidence, never
/// fabricated from activity/layout timestamps (none of the legacy sources
/// carry one, so `renamed_at` is never set here).
fn migration_record(
    resolved: &SessionNameRef,
    classified: &ClassifiedLegacyCandidate,
    revision: NameRevision,
) -> SessionNameRecord {
    SessionNameRecord {
        name_ref: resolved.clone(),
        name: classified.name.clone(),
        source: classified.source,
        revision,
        manual_revision: (classified.source == NameSource::Manual).then_some(revision),
        renamed_at: None,
        legacy_origin: (classified.source == NameSource::LegacyProtected)
            .then_some(freshell_protocol::session_names::LegacyOrigin::Unknown),
    }
}

fn retain_migration_evidence(
    document: &mut StoredDocument,
    key: &str,
    classified: &ClassifiedLegacyCandidate,
    installed_revision: NameRevision,
) {
    document.migration.winning_evidence.insert(
        key.to_string(),
        StoredMigrationEvidence {
            candidate_id: classified.candidate_id.clone(),
            name: classified.name.clone(),
            source: classified.source,
            scope: classified.scope,
            explicit_rename_at: classified.explicit_rename_at,
            evidence_key: classified.evidence_key.clone(),
            installed_revision,
        },
    );
}

/// Task 7: whether an import id belongs to the trusted server-boot lane —
/// the reserved [`NAME_MIGRATION_BOOT_IMPORT_ID`] itself or one of its
/// `--N` chunk derivations (the consolidation runner batches more than
/// [`NAME_MIGRATION_IMPORT_CANDIDATE_LIMIT`] gathered candidates into
/// ≤100-candidate imports, per the plan's own batching rule). The HTTP
/// route refuses this whole family, so only the in-process boot runner can
/// ever send them.
pub(crate) fn is_boot_import_id(import_id: &str) -> bool {
    import_id == NAME_MIGRATION_BOOT_IMPORT_ID
        || import_id
            .strip_prefix(NAME_MIGRATION_BOOT_IMPORT_ID)
            .is_some_and(|rest| rest.starts_with("--"))
}

/// Order the trusted boot lane's gathered candidates best-first by the
/// candidate order (`compare_classified_candidates`), then by candidate id,
/// so the consolidation's ≤100-candidate import chunks keep a stable
/// membership across boots (the create-once per-import backups and the
/// per-candidate acknowledgment replay both key off the chunk ids). Higher
/// rank or scope wins whatever the arrival order; among comparator-equal
/// candidates the first one applied stays (strict-win apply). The
/// candidate-id key makes that order, and so the batching, the same on
/// every boot, and it also decides which of several comparator-equal
/// candidates for one target is applied first: the lowest candidate id
/// installs and stays. Candidate ids embed storage keys and device ids, so
/// among exact equals this one choice is made by an id; it never displaces
/// a name that is already installed.
pub(crate) fn order_boot_legacy_candidates(candidates: &mut [LegacyNameCandidate]) {
    let mut classified: Vec<(ClassifiedLegacyCandidate, LegacyNameCandidate)> = candidates
        .iter()
        .map(|candidate| {
            (
                classify_legacy_candidate(true, candidate),
                candidate.clone(),
            )
        })
        .collect();
    classified.sort_by(|a, b| {
        compare_classified_candidates(&a.0, &b.0)
            .then_with(|| a.0.candidate_id.cmp(&b.0.candidate_id))
    });
    for (slot, (_, candidate)) in candidates.iter_mut().zip(classified) {
        *slot = candidate;
    }
}

/// The Task 7 import transaction body: immutable per-import backup first,
/// then per-candidate classification/resolution/application — each candidate
/// is acknowledged individually (never an early whole-import shortcut), and
/// winners, winning migration evidence and acknowledged candidate ids commit
/// in the SAME document transaction. A trusted boot-lane import (see
/// [`is_boot_import_id`]) never completes the migration by itself — the
/// consolidation runner commits the completion receipt only after every
/// chunk acknowledged ([`SessionNames::complete_legacy_migration`]), so
/// canonical readers stop consulting migrated legacy fields exactly when
/// the whole consolidation finished (the physical cleanup that follows is
/// idempotently retried at boot). After completion a non-boot import never
/// reaches the backup or the candidates: it is a `Read` that acknowledges
/// every candidate id (`session_name_import_policy::post_completion_acknowledge`).
fn import_legacy_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    backup_dir: &Path,
    input: LegacyNameImport,
) -> Result<Decision<LegacyImportResult>, NameError> {
    session_name_import_policy::validate_import_envelope(&input)?;

    let trusted_boot = is_boot_import_id(&input.import_id);
    // Name-reliability Task 3: after the consolidation completed, a browser
    // import is acknowledged and writes nothing (no backup, no stored ids).
    if document.migration.completed && !trusted_boot {
        return session_name_import_policy::post_completion_acknowledge(&input).map(Decision::Read);
    }

    // Immutable create-once backup BEFORE any acknowledgment: a failure
    // here retains every original and acknowledges nothing.
    write_import_backup_once(backup_dir, &input, meta.now_ms)?;

    let mut acknowledged: Vec<String> = Vec::with_capacity(input.candidates.len());
    let mut newly_acknowledged = false;
    let mut publish: Vec<PublishSpec> = Vec::new();
    let mut names: Vec<SessionNameUpdate> = Vec::new();

    for candidate in &input.candidates {
        if candidate.id.trim().is_empty() {
            return Err(NameError::InvalidName(
                "a legacy-name candidate must carry its stable id".into(),
            ));
        }
        // Per-candidate idempotency: an already-acknowledged candidate id is
        // re-acknowledged without re-application.
        if document
            .migration
            .acknowledged_candidate_ids
            .contains(&candidate.id)
        {
            acknowledged.push(candidate.id.clone());
            continue;
        }
        document
            .migration
            .acknowledged_candidate_ids
            .push(candidate.id.clone());
        newly_acknowledged = true;
        acknowledged.push(candidate.id.clone());

        // An invalid/oversize/control-bearing name is retained by the
        // immutable backup and acknowledged, never applied.
        if validate_name(&candidate.name).is_err() {
            continue;
        }
        let Some(resolved) = resolve_legacy_target(document, &candidate.target) else {
            // Unresolved/ambiguous evidence remains recovery-only.
            continue;
        };
        let classified = classify_legacy_candidate(trusted_boot, candidate);
        let change = NameChangeEvent::new(
            NameChangeCause::Import,
            document.record_at(&name_ref_key(&resolved)),
            None,
        )
        .with_import(&input.import_id, &classified.evidence_key);
        let outcome = apply_legacy_candidate(document, resolved, &classified)?;
        if let Some(key) = outcome.key {
            if outcome.changed {
                publish.push(PublishSpec::changed(key.clone(), change));
                names.push(
                    update_after_commit(document, &key, true, RedirectScope::ToRecord)
                        .expect("the winning record resolves"),
                );
            } else {
                names.push(
                    update_for_key(document, &key, false, RedirectScope::ToRecord)
                        .expect("the standing record resolves"),
                );
            }
        }
    }

    if !newly_acknowledged && publish.is_empty() {
        // A fully idempotent re-delivery: nothing persisted, nothing
        // published.
        return Ok(Decision::Read(LegacyImportResult {
            acknowledged,
            names,
        }));
    }
    Ok(Decision::Write {
        value: LegacyImportResult {
            acknowledged,
            names,
        },
        publish,
    })
}
