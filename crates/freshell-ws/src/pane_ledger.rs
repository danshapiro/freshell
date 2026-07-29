//! P1.8 — the server-side pane-identity ledger (restart-resilience campaign
//! §4.2): a small per-row disk store under `<home>/.freshell/pane-ledger/`,
//! written durably at identity events with atomic temp+rename
//! (`crate::tabs_persist::atomic_write_durable`).
//!
//! Two row types with different keys and different rights:
//!
//! * **Binding rows** — durable identity facts, keyed by the complete
//!   [`RecoveryOwnerKey`], with `terminalId` as a secondary index. A binding
//!   row is *the resume-invocation record*: it stores exactly what re-issuing
//!   the provider's resume needs (for terminal panes: provider, sessionId,
//!   mode, cwd). New rows use bounded, collision-verified v2 names:
//!   `bindings/v2/owner-v2-<sha256>.json`. Pre-v2
//!   `bindings/<enc(provider)>/<enc(sessionId)>.json` rows remain read-only
//!   compatibility aliases.
//! * **Pending markers** — evidence that identity establishment was in
//!   flight, keyed on `terminalId` (the only stable server-minted id that
//!   exists pre-identity). NEVER promoted, never joined (G1): resolution
//!   writes a fresh binding row FIRST, then deletes the marker. Layout:
//!   `pending/<enc(terminalId)>.json`.
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
//! Write-failure policy: legacy create/identity events surface degradation and
//! proceed — see [`surface_write_failure`]. Exact recovery is stricter:
//! persisting an Allocated→Observed transition is part of the positive proof,
//! so [`PaneLedger::mark_materialized_many`] propagates failure for the caller
//! to return retry.
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
use freshell_recovery::{MaterializationState, RecoveryOwnerKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
}

/// A durable identity fact — see the module doc for the schema contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingRow {
    pub ledger_version: u32,
    pub provider: String,
    pub session_id: String,
    /// Provider-normalized owner scope. Global providers leave this absent;
    /// Amplifier exact recovery supplies the normalized project-store scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_scope: Option<String>,
    /// Positive provider observation is monotonic. Rows written before this
    /// field existed load as Unknown and never fabricate recovery authority.
    #[serde(default)]
    pub materialization: MaterializationState,
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
    pub superseded_by: Option<RecoveryOwnerKey>,
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
}

impl BindingRow {
    fn owner_key(&self) -> RecoveryOwnerKey {
        RecoveryOwnerKey {
            provider: self.provider.clone(),
            session_id: self.session_id.clone(),
            provider_scope: self.provider_scope.clone(),
        }
    }
}

/// Evidence that identity establishment was in flight (G1: never a binding).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMarker {
    pub ledger_version: u32,
    pub terminal_id: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub spawned_at: i64,
}

/// One identity event's worth of binding-row input.
pub struct BindingWrite<'a> {
    pub provider: &'a str,
    pub session_id: &'a str,
    pub provider_scope: Option<&'a str>,
    pub materialization: MaterializationState,
    pub terminal_id: &'a str,
    pub mode: &'a str,
    pub cwd: Option<&'a str>,
    pub create_request_id: Option<&'a str>,
    pub now_ms: i64,
}

/// One fresh-agent identity event's worth of binding-row input (P1.13).
/// Settings are a FULL snapshot: callers always know the current values,
/// so writes replace rather than merge.
#[derive(Debug, Clone, Copy)]
pub struct FreshAgentBindingWrite<'a> {
    pub provider: &'a str,
    pub session_id: &'a str,
    pub provider_scope: Option<&'a str>,
    pub materialization: MaterializationState,
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
    /// Complete provider owner -> effective row. Bound AND retired
    /// (tombstones stay). A v2 row replaces an equal legacy key in memory,
    /// but the legacy file remains untouched on disk.
    bindings: std::collections::HashMap<RecoveryOwnerKey, BindingRow>,
    /// Read-only compatibility rows shadowed by a v2 successor. Retained so
    /// deleting a future v2 tombstone cannot mutate or lose the old file.
    legacy_bindings: std::collections::HashMap<RecoveryOwnerKey, BindingRow>,
    /// Owners whose effective row came from the verified v2 digest path.
    v2_owners: std::collections::HashSet<RecoveryOwnerKey>,
    /// terminal_id -> marker.
    pending: std::collections::HashMap<String, PendingMarker>,
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

const OWNER_V2_DIGEST_DOMAIN: &[u8] = b"freshell-recovery-owner-v2\0";

fn digest_frame(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

/// Stable, bounded filename for a complete canonical recovery owner.
///
/// The digest is domain-separated and every variable-length component is
/// length-framed. The optional scope also carries an explicit presence byte,
/// so no concatenation or None/empty ambiguity can collide structurally.
pub fn owner_v2_filename(owner: &RecoveryOwnerKey) -> String {
    let mut hasher = Sha256::new();
    hasher.update(OWNER_V2_DIGEST_DOMAIN);
    digest_frame(&mut hasher, owner.provider.as_bytes());
    digest_frame(&mut hasher, owner.session_id.as_bytes());
    match &owner.provider_scope {
        Some(scope) => {
            hasher.update([1]);
            digest_frame(&mut hasher, scope.as_bytes());
        }
        None => hasher.update([0]),
    }
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("owner-v2-{hex}.json")
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

    fn v2_bindings_dir(root: &Path) -> PathBuf {
        Self::bindings_dir(root).join("v2")
    }

    fn pending_dir(root: &Path) -> PathBuf {
        root.join("pending")
    }

    fn owner_v2_path(root: &Path, owner: &RecoveryOwnerKey) -> PathBuf {
        Self::v2_bindings_dir(root).join(owner_v2_filename(owner))
    }

    /// The ONE directory scan — construction-time only (V1.md).
    fn load_index(root: &Path) -> LedgerIndex {
        let mut index = LedgerIndex::default();
        if let Ok(providers) = std::fs::read_dir(Self::bindings_dir(root)) {
            for provider in providers.flatten() {
                if provider.file_name() == "v2" {
                    continue;
                }
                let Ok(files) = std::fs::read_dir(provider.path()) else {
                    continue;
                };
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue; // *.tmp-* and *.quarantined-* residue
                    }
                    if let Ok(mut row) = load_row::<BindingRow>(&path) {
                        if row.ledger_version == LEDGER_VERSION {
                            // A legacy Amplifier row has no trustworthy
                            // provider-normalized scope, even if a manually
                            // edited JSON file claims one. It remains a
                            // read-only, Unknown compatibility alias.
                            let legacy_amplifier = row.provider == "amplifier";
                            row.provider_scope = None;
                            if let Some(successor) = &mut row.superseded_by {
                                successor.provider_scope = None;
                            }
                            if legacy_amplifier {
                                row.materialization = MaterializationState::Unknown;
                            }
                            // Global providers never had a meaningful scope
                            // in the legacy path. Canonicalizing it away above
                            // cannot manufacture a second owner.
                            if Self::validate_row_owner_scopes(&row).is_err() {
                                continue;
                            }
                            let owner = row.owner_key();
                            index.legacy_bindings.insert(owner.clone(), row.clone());
                            index.bindings.entry(owner).or_insert(row);
                        }
                    }
                }
            }
        }
        if let Ok(files) = std::fs::read_dir(Self::v2_bindings_dir(root)) {
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                    continue;
                }
                let Ok(mut row) = load_row::<BindingRow>(&path) else {
                    continue;
                };
                if row.ledger_version != LEDGER_VERSION {
                    continue;
                }
                let owner = row.owner_key();
                let expected_name = owner_v2_filename(&owner);
                if path.file_name().and_then(|name| name.to_str()) != Some(&expected_name) {
                    continue;
                }
                if Self::validate_row_owner_scopes(&row).is_err() {
                    tracing::warn!(
                        target: "freshell_ws::pane_ledger",
                        path = %path.display(),
                        provider = %row.provider,
                        session_id = %row.session_id,
                        "pane_ledger_noncanonical_owner_scope_ignored: v2 row cannot enter the effective index"
                    );
                    continue;
                }
                if row.provider == "amplifier" && row.provider_scope.is_none() {
                    tracing::warn!(
                        target: "freshell_ws::pane_ledger",
                        path = %path.display(),
                        session_id = %row.session_id,
                        "pane_ledger_unscoped_amplifier_v2_degraded: v2 row cannot grant project-scoped authority"
                    );
                    row.materialization = MaterializationState::Unknown;
                }
                index.bindings.insert(owner.clone(), row);
                index.v2_owners.insert(owner);
            }
        }
        let scoped_amplifier_owners = index
            .bindings
            .keys()
            .filter(|owner| owner.provider == "amplifier" && owner.provider_scope.is_some())
            .cloned()
            .collect::<Vec<_>>();
        for owner in scoped_amplifier_owners {
            Self::suppress_unscoped_amplifier_alias(&mut index, &owner);
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
        index
    }

    /// Poison-tolerant lock (the `with_persist_lock` idiom) over the
    /// write-through index.
    fn guard(&self) -> std::sync::MutexGuard<'_, LedgerIndex> {
        self.index.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn write_owner(
        provider: &str,
        session_id: &str,
        provider_scope: Option<&str>,
    ) -> RecoveryOwnerKey {
        RecoveryOwnerKey {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            provider_scope: provider_scope.map(str::to_string),
        }
    }

    fn owner_scope_is_ledger_compatible(owner: &RecoveryOwnerKey) -> bool {
        owner.has_canonical_provider_scope()
            || (owner.provider == "amplifier" && owner.provider_scope.is_none())
    }

    fn validate_owner_scope(owner: &RecoveryOwnerKey) -> std::io::Result<()> {
        if Self::owner_scope_is_ledger_compatible(owner) {
            return Ok(());
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "noncanonical pane ledger provider scope for {}/{}",
                owner.provider, owner.session_id
            ),
        ))
    }

    fn successor_scope_is_ledger_compatible(row: &BindingRow) -> bool {
        row.superseded_by.as_ref().is_none_or(|successor| {
            successor.provider == row.provider
                && (successor.has_canonical_provider_scope()
                    || (row.provider == "amplifier"
                        && row.provider_scope.is_none()
                        && successor.provider_scope.is_none()))
        })
    }

    fn validate_row_owner_scopes(row: &BindingRow) -> std::io::Result<()> {
        Self::validate_owner_scope(&row.owner_key())?;
        if Self::successor_scope_is_ledger_compatible(row) {
            Ok(())
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "noncanonical pane ledger successor scope for {}/{}",
                    row.provider, row.session_id
                ),
            ))
        }
    }

    fn unscoped_amplifier_alias(owner: &RecoveryOwnerKey) -> Option<RecoveryOwnerKey> {
        (owner.provider == "amplifier" && owner.provider_scope.is_some())
            .then(|| Self::write_owner(&owner.provider, &owner.session_id, None))
    }

    fn suppress_unscoped_amplifier_alias(index: &mut LedgerIndex, owner: &RecoveryOwnerKey) {
        if let Some(alias) = Self::unscoped_amplifier_alias(owner) {
            index.bindings.remove(&alias);
        }
    }

    fn has_scoped_amplifier_successor(index: &LedgerIndex, owner: &RecoveryOwnerKey) -> bool {
        owner.provider == "amplifier"
            && owner.provider_scope.is_none()
            && index.bindings.keys().any(|candidate| {
                candidate.provider == owner.provider
                    && candidate.session_id == owner.session_id
                    && candidate.provider_scope.is_some()
            })
    }

    fn has_shadowed_legacy_alias(index: &LedgerIndex, owner: &RecoveryOwnerKey) -> bool {
        index.legacy_bindings.contains_key(owner)
            || Self::unscoped_amplifier_alias(owner).is_some_and(|alias| {
                index.legacy_bindings.contains_key(&alias) || index.v2_owners.contains(&alias)
            })
    }

    fn advanced_materialization(
        owner: &RecoveryOwnerKey,
        existing: Option<&BindingRow>,
        requested: MaterializationState,
    ) -> MaterializationState {
        // Until an exact provider resolves a project scope, an unscoped
        // Amplifier identity is only a compatibility alias. It cannot become
        // allocation or observation authority.
        if owner.provider == "amplifier" && owner.provider_scope.is_none() {
            return MaterializationState::Unknown;
        }
        existing
            .map(|row| row.materialization)
            .unwrap_or_default()
            .advance(requested)
    }

    /// Record (or refresh) a `bound` row for this identity event.
    pub fn record_binding(&self, w: &BindingWrite<'_>) -> std::io::Result<()> {
        Self::validate_owner_scope(&Self::write_owner(
            w.provider,
            w.session_id,
            w.provider_scope,
        ))?;
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
        let owner = Self::write_owner(w.provider, w.session_id, w.provider_scope);
        if Self::has_scoped_amplifier_successor(index, &owner) {
            tracing::warn!(
                target: "freshell_ws::pane_ledger",
                terminal_id = %w.terminal_id,
                session_id = %w.session_id,
                "pane_ledger_unscoped_amplifier_write_ignored: scoped owner already exists"
            );
            return Ok(());
        }
        let unscoped_alias = Self::unscoped_amplifier_alias(&owner);
        let is_predecessor = |row: &BindingRow| {
            row.state == RowState::Bound
                && row.live_terminal_id.as_deref() == Some(w.terminal_id)
                && row.owner_key() != owner
                && unscoped_alias
                    .as_ref()
                    .is_none_or(|alias| row.owner_key() != *alias)
        };
        // Preflight the provider boundary across every same-terminal row.
        // Selecting one HashMap predecessor first would make rejection depend
        // on randomized iteration order whenever crash residue contains both
        // same-provider and foreign-provider rows.
        if index
            .bindings
            .values()
            .any(|row| is_predecessor(row) && row.provider != owner.provider)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "pane ledger terminal {} cannot supersede across providers",
                    w.terminal_id
                ),
            ));
        }
        let previous = index
            .bindings
            .values()
            .find(|row| is_predecessor(row) && row.provider == owner.provider)
            .cloned();

        let existing = index.bindings.get(&owner);
        let created_at = existing.map(|r| r.created_at).unwrap_or(w.now_ms);
        let materialization = Self::advanced_materialization(&owner, existing, w.materialization);
        if existing.is_some_and(|r| r.retired_reason == Some(RetiredReason::GcExpired)) {
            tracing::info!(
                target: "freshell_ws::pane_ledger",
                provider = %w.provider,
                session_id = %w.session_id,
                "pane_ledger_revived: gc_expired tombstone re-bound by a live identity event"
            );
        }
        let row = BindingRow {
            ledger_version: LEDGER_VERSION,
            provider: w.provider.to_string(),
            session_id: w.session_id.to_string(),
            provider_scope: owner.provider_scope.clone(),
            materialization,
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
        };
        self.write_binding(root, index, &row)?; // new bound row FIRST (pinned)

        if let Some(old) = previous {
            self.retire_and_link_locked(
                root,
                index,
                old,
                owner.clone(),
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
    /// retired_reason→Superseded, superseded_by→the complete new owner,
    /// updated_at→now, one info log, then persist. Callers write the new bound
    /// row FIRST and call this AFTER (order pinned). `terminal_id` is `Some`
    /// for terminal-pane rows (logged) and `None` for fresh-agent rows (which
    /// own no terminal).
    fn retire_and_link_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        mut old: BindingRow,
        superseded_by: RecoveryOwnerKey,
        now_ms: i64,
        terminal_id: Option<&str>,
    ) -> std::io::Result<()> {
        if old.provider != superseded_by.provider {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "pane ledger owner {}/{} cannot be superseded by provider {}",
                    old.provider, old.session_id, superseded_by.provider
                ),
            ));
        }
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
    pub fn record_fresh_agent_binding(
        &self,
        w: &FreshAgentBindingWrite<'_>,
    ) -> std::io::Result<()> {
        Self::validate_owner_scope(&Self::write_owner(
            w.provider,
            w.session_id,
            w.provider_scope,
        ))?;
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();

        let owner = Self::write_owner(w.provider, w.session_id, w.provider_scope);
        if Self::has_scoped_amplifier_successor(&index, &owner) {
            tracing::warn!(
                target: "freshell_ws::pane_ledger",
                session_id = %w.session_id,
                "pane_ledger_unscoped_amplifier_write_ignored: scoped fresh-agent owner already exists"
            );
            return Ok(());
        }
        let existing = index.bindings.get(&owner);
        let created_at = existing.map(|r| r.created_at).unwrap_or(w.now_ms);
        let materialization = Self::advanced_materialization(&owner, existing, w.materialization);
        // Advisory field: keep the existing row's value when the new write
        // has none (latest-observed semantics, D4).
        let create_request_id = w
            .create_request_id
            .map(str::to_string)
            .or_else(|| existing.and_then(|r| r.create_request_id.clone()));
        let row = BindingRow {
            ledger_version: LEDGER_VERSION,
            provider: w.provider.to_string(),
            session_id: w.session_id.to_string(),
            provider_scope: owner.provider_scope.clone(),
            materialization,
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
        };
        self.write_binding(root, &mut index, &row)?; // new bound row FIRST (pinned)

        if let Some(old_id) = w.supersedes {
            if old_id != w.session_id {
                let old_key = Self::write_owner(w.provider, old_id, w.provider_scope);
                if let Some(old) = index.bindings.get(&old_key).cloned() {
                    self.retire_and_link_locked(
                        root,
                        &mut index,
                        old,
                        owner.clone(),
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
        Self::validate_row_owner_scopes(row)?;
        let owner = row.owner_key();
        let dest = Self::owner_v2_path(root, &owner);
        if dest.exists() {
            let stored = load_row::<BindingRow>(&dest).map_err(|error| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "cannot verify pane ledger owner at {}: {error}",
                        dest.display()
                    ),
                )
            })?;
            if stored.ledger_version != LEDGER_VERSION || stored.owner_key() != owner {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "pane ledger owner digest collision/corruption at {}",
                        dest.display()
                    ),
                ));
            }
            Self::validate_row_owner_scopes(&stored).map_err(|error| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "cannot verify pane ledger row at {}: {error}",
                        dest.display()
                    ),
                )
            })?;
        }
        write_row_atomic(&dest, row)?;
        index.bindings.insert(owner.clone(), row.clone());
        index.v2_owners.insert(owner.clone());
        if owner.provider_scope.is_some() {
            Self::suppress_unscoped_amplifier_alias(index, &owner);
        } else if owner.provider == "amplifier" {
            let has_scoped_successor = index.bindings.keys().any(|candidate| {
                candidate.provider == owner.provider
                    && candidate.session_id == owner.session_id
                    && candidate.provider_scope.is_some()
            });
            if has_scoped_successor {
                index.bindings.remove(&owner);
            }
        }
        Ok(())
    }

    /// Best-effort retire on observed clean close (trigger e). Missing or
    /// already-retired rows are Ok — this path is never load-bearing.
    pub fn retire_closed(
        &self,
        provider: &str,
        session_id: &str,
        now_ms: i64,
    ) -> std::io::Result<()> {
        self.retire_closed_owner(&Self::write_owner(provider, session_id, None), now_ms)
    }

    /// Scope-aware close transition for exact recovery owners.
    pub fn retire_closed_owner(
        &self,
        owner: &RecoveryOwnerKey,
        now_ms: i64,
    ) -> std::io::Result<()> {
        Self::validate_owner_scope(owner)?;
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        let Some(mut row) = index.bindings.get(owner).cloned() else {
            return Ok(());
        };
        if row.state != RowState::Bound {
            return Ok(());
        }
        row.state = RowState::Retired;
        row.retired_reason = Some(RetiredReason::Closed);
        row.updated_at = now_ms;
        self.write_binding(root, &mut index, &row)
    }

    /// Raw single-row read from the index (no chain following — that is
    /// `lookup_by_session`, Task 2). Memory-only (V1.md read policy).
    pub fn load_binding(&self, provider: &str, session_id: &str) -> Option<BindingRow> {
        self.load_binding_for_owner(&Self::write_owner(provider, session_id, None))
    }

    /// Exact owner read. In particular, a scoped Amplifier request never
    /// falls back to an unscoped compatibility alias.
    pub fn load_binding_for_owner(&self, owner: &RecoveryOwnerKey) -> Option<BindingRow> {
        self.root.as_ref()?;
        self.guard().bindings.get(owner).cloned()
    }

    /// One-lock materialization lookup for a complete reconcile request.
    /// Results preserve request order and duplicate cardinality.
    pub fn materializations_for_owners(
        &self,
        owners: &[RecoveryOwnerKey],
    ) -> Vec<MaterializationState> {
        if self.root.is_none() {
            return vec![MaterializationState::Unknown; owners.len()];
        }
        let index = self.guard();
        owners
            .iter()
            .map(|owner| {
                if owner.provider == "amplifier" && owner.provider_scope.is_none() {
                    return MaterializationState::Unknown;
                }
                index
                    .bindings
                    .get(owner)
                    .map(|row| row.materialization)
                    .unwrap_or_default()
            })
            .collect()
    }

    pub fn materialization_for_owner(&self, owner: &RecoveryOwnerKey) -> MaterializationState {
        self.materializations_for_owners(std::slice::from_ref(owner))[0]
    }

    /// Persist provider-owned positive evidence. Missing rows fail rather
    /// than manufacturing incomplete resume metadata.
    pub fn mark_materialized(&self, owner: &RecoveryOwnerKey, now_ms: i64) -> std::io::Result<()> {
        self.mark_materialized_many(std::slice::from_ref(owner), now_ms)
    }

    /// One serialized ledger transaction for all positive proofs in a
    /// reconcile batch. Each row retains the store's atomic file discipline;
    /// a partial I/O failure is safe to retry because Observed is monotonic.
    pub fn mark_materialized_many(
        &self,
        owners: &[RecoveryOwnerKey],
        now_ms: i64,
    ) -> std::io::Result<()> {
        if owners.is_empty() {
            return Ok(());
        }
        let Some(root) = &self.root else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "pane ledger is disabled; materialization cannot be persisted",
            ));
        };
        let mut index = self.guard();
        let mut seen = std::collections::HashSet::new();
        for owner in owners {
            if !seen.insert(owner) {
                continue;
            }
            Self::validate_owner_scope(owner)?;
            let Some(mut row) = index.bindings.get(owner).cloned() else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!(
                        "no pane ledger row for recovery owner {}/{}",
                        owner.provider, owner.session_id
                    ),
                ));
            };
            if owner.provider == "amplifier" && owner.provider_scope.is_none() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "unscoped Amplifier aliases cannot be marked materialized",
                ));
            }
            if row.materialization == MaterializationState::Observed {
                continue;
            }
            row.materialization = MaterializationState::Observed;
            row.updated_at = now_ms;
            row.last_observed_at = now_ms;
            self.write_binding(root, &mut index, &row)?;
        }
        Ok(())
    }

    /// Follow the `supersededBy` chain from a claimed ref to its terminus.
    /// Chains cannot cycle (a supersession write always targets a fresh row
    /// and retires its predecessor in the same act) — the hop cap is a
    /// corruption backstop, loud when hit.
    pub fn lookup_by_session(&self, provider: &str, session_id: &str) -> Option<Resolution> {
        self.lookup_by_owner(&Self::write_owner(provider, session_id, None))
    }

    /// Scope-aware supersession-chain lookup for exact recovery owners.
    pub fn lookup_by_owner(&self, initial_owner: &RecoveryOwnerKey) -> Option<Resolution> {
        self.root.as_ref()?;
        let index = self.guard(); // memory-only chain walk (V1.md read policy)
        let mut row = index.bindings.get(initial_owner).cloned()?;
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
                    provider = %initial_owner.provider,
                    session_id = %initial_owner.session_id,
                    "pane_ledger_chain_overflow: supersession chain exceeded 32 hops (corruption?)"
                );
                return None;
            }
            let Some(next_row) = index.bindings.get(&next).cloned() else {
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
        self.ever_bound_owner(&Self::write_owner(provider, session_id, None))
    }

    /// Scope-aware durable-observation lookup for exact recovery owners.
    pub fn ever_bound_owner(&self, owner: &RecoveryOwnerKey) -> bool {
        if self.root.is_none() {
            return false;
        }
        self.guard().bindings.contains_key(owner)
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
    pub fn record_pending(
        &self,
        terminal_id: &str,
        mode: &str,
        cwd: Option<&str>,
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
            provider_scope: None,
            materialization: MaterializationState::Observed,
            terminal_id: &terminal_id_owned,
            mode: &provider_owned,
            cwd: cwd_owned.as_deref(),
            create_request_id: None,
            now_ms: now,
        })
    })
    .await
    .unwrap_or_else(|join_err| Err(std::io::Error::other(join_err)));
    surface_write_failure(state, terminal_id, result);
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
