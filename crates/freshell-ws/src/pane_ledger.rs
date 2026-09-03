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
    /// when a browser connection last ASSERTED this identity+tab. Set ONLY by
    /// a write applying MEANINGFUL connection-scoped provenance — `Replace`
    /// with both `client_instance_id` and `device_id` present (the hollow
    /// guard's shape): the connection-scoped create/stamp lanes, attributed
    /// re-binds, marker-stamped resolutions, and connection-scoped fork
    /// stamps. The time stamped is the ASSERTION's time: the write's own
    /// `now_ms` for a direct connection-scoped write — but for a
    /// marker-stamped resolution it is the consumed marker's `spawned_at`
    /// (focused-ep4 Finding: the stamps came from a spawn-time connection,
    /// while the conn-less resolution lands them arbitrarily later, possibly
    /// after the pane closed and the parent's evidence froze). NEVER set by
    /// conn-less `Inherit` maintenance writes (auto-resume respawn,
    /// locator/resolution re-binds — they refresh `updated_at` but re-assert
    /// nothing), by retire/state transitions, or by GC/scan maintenance;
    /// ERASED by `Clear` (the row is then unattributed wholesale). This is
    /// what the D8 judgment (`recovery_inventory.rs`) keys on — and it keys
    /// on NOTHING ELSE: `updated_at` advances on EVERY upsert including
    /// conn-less maintenance, and `created_at` is resolution-time row birth
    /// for marker-derived rows, so neither may floor the judgment. Serde-
    /// optional under LEDGER_VERSION 1 (the client/device/tab field
    /// precedent): pre-delta-r4 rows parse to `None` and keep the
    /// creation-time key.
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
/// the marker path. Serde-optional under LEDGER_VERSION 1 (the BindingRow
/// precedent): pre-delta-r3 markers parse to all-`None` and take the same
/// `Clear` derivation — conservative (unattributed ⇒ never offered), and
/// immune by construction once the 30-day pending-marker TTL has swept them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMarker {
    pub ledger_version: u32,
    pub terminal_id: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub spawned_at: i64,
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
/// rejoin the right restored tab.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProvenanceStamps<'a> {
    pub client_instance_id: Option<&'a str>,
    pub device_id: Option<&'a str>,
    pub tab_key: Option<&'a str>,
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
    /// additionally inherits a superseded PARENT's stamps on a fork-chain
    /// first write (the fork is, by construction, the same pane).
    #[default]
    Inherit,
    /// Connection-supplied stamps (the WS create/fresh-agent lanes compose
    /// them from the connection's hello identity + the message's `tabId`):
    /// an adoption lane that KNOWS newer identity replaces it here. Each
    /// `Some` field replaces the row's value; a `None` field asserts nothing
    /// about ITSELF and keeps the row's value (a connection that cannot
    /// compose one stamp — e.g. `tabKey` without a `tabId` on the wire —
    /// must not erase the row's existing one).
    Replace(ProvenanceStamps<'a>),
    /// An explicitly HEADLESS writer (the REST/MCP lineage binder — no
    /// browser connection exists at bind time): all stamps are CLEARED.
    /// A headless re-bind must never keep an earlier browser stamp (see the
    /// enum doc), so the rebound row becomes unattributed and the D8
    /// judgment (`recovery_inventory.rs`) correctly never offers it.
    Clear,
}

/// Delta-r4 Finding 1: whether this write's provenance is a MEANINGFUL
/// connection-scoped application — `Replace` whose stamps carry BOTH the
/// client and device halves (the `freshell_freshagent::BindProvenance::
/// is_meaningful` hollow-guard shape, mirrored here because this crate cannot
/// see that one). This is the ONE predicate deciding whether a write advances
/// a row's `last_attributed_at`: both merge bodies consume it.
fn advances_attribution(provenance: &ProvenancePolicy<'_>) -> bool {
    match provenance {
        ProvenancePolicy::Replace(stamps) => {
            stamps.client_instance_id.is_some() && stamps.device_id.is_some()
        }
        _ => false,
    }
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
    /// per-lane contract (Replace / Inherit / Clear).
    pub provenance: ProvenancePolicy<'a>,
    /// Focused-ep4 Finding: the time stamped into `last_attributed_at` when
    /// this write ADVANCES attribution. `None` = the write's own `now_ms` —
    /// a connection-scoped write asserts the identity when it writes. The one
    /// override is [`PaneLedger::resolve_pending`]'s marker-stamp arm: marker
    /// stamps were asserted by the browser at the pending MARKER's creation
    /// (`spawned_at`); the conn-less identity resolution merely LANDS them
    /// later (arbitrarily later for a codex/opencode locator resolution —
    /// possibly after the pane already closed and the parent's evidence
    /// froze, where resolve-time attribution would re-launder the row into
    /// the D8 offer). Ignored unless the provenance meaningfully advances
    /// attribution (`advances_attribution`).
    pub attributed_at: Option<i64>,
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
        // D8 provenance merge (delta-r2 Finding 2 tri-state,
        // [`ProvenancePolicy`]): `Inherit` is the conn-less session-affiliated
        // lane — the write asserts nothing, so the row keeps every stamp.
        // `Replace` is the connection-supplied lane — each `Some` field
        // replaces, a `None` field asserts nothing about itself and is kept
        // (a connection that cannot compose that stamp must not erase the
        // row's value; DELIBERATELY unlike this body's other advisory fields
        // such as `create_request_id`, which are wholesale-replaced).
        // `Clear` is the explicitly-headless lineage lane — the row's stamps
        // are erased so a stale browser attribution can never launder the row
        // into the D8 offer under a refreshed `updated_at`.
        let (client_instance_id, device_id, tab_key) = match w.provenance {
            ProvenancePolicy::Inherit => (
                existing.and_then(|r| r.client_instance_id.clone()),
                existing.and_then(|r| r.device_id.clone()),
                existing.and_then(|r| r.tab_key.clone()),
            ),
            ProvenancePolicy::Replace(stamps) => (
                stamps
                    .client_instance_id
                    .map(str::to_string)
                    .or_else(|| existing.and_then(|r| r.client_instance_id.clone())),
                stamps
                    .device_id
                    .map(str::to_string)
                    .or_else(|| existing.and_then(|r| r.device_id.clone())),
                stamps
                    .tab_key
                    .map(str::to_string)
                    .or_else(|| existing.and_then(|r| r.tab_key.clone())),
            ),
            ProvenancePolicy::Clear => (None, None, None),
        };
        // Delta-r4 Finding 1: the LAST-ATTRIBUTION time rides the same
        // tri-state (`advances_attribution` is the single predicate). A
        // meaningful connection-scoped application SETS it to the write's
        // attribution time — `attributed_at`, defaulting to the write's own
        // now (focused-ep4 Finding: a marker-STAMPED resolution overrides it
        // to the consumed marker's `spawned_at`, because the browser asserted
        // the pane at spawn and the conn-less resolution landed later); a
        // conn-less `Inherit` maintenance write (respawn/locator/resolution —
        // it refreshes `updated_at` but re-asserts nothing) and a
        // hollow/partial `Replace` PRESERVE it; `Clear` ERASES it
        // (unattributed wholesale), so a stale attribution time can never
        // launder the row into the D8 offer the way `updated_at` churn did.
        let last_attributed_at = if advances_attribution(&w.provenance) {
            Some(w.attributed_at.unwrap_or(w.now_ms))
        } else {
            match w.provenance {
                ProvenancePolicy::Clear => None,
                _ => existing.and_then(|r| r.last_attributed_at),
            }
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
    pub fn record_fresh_agent_binding(
        &self,
        w: &FreshAgentBindingWrite<'_>,
    ) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();

        let key = (w.provider.to_string(), w.session_id.to_string());
        let existing = index.bindings.get(&key);
        let created_at = existing.map(|r| r.created_at).unwrap_or(w.now_ms);
        // Advisory field: keep the existing row's value when the new write
        // has none (latest-observed semantics, D4).
        let create_request_id = w
            .create_request_id
            .map(str::to_string)
            .or_else(|| existing.and_then(|r| r.create_request_id.clone()));
        // D8 provenance merge (delta-r2 Finding 2 tri-state,
        // [`ProvenancePolicy`]): `Inherit` asserts nothing — conn-less
        // refresh lanes keep the create's stamps; a fork-chain first write
        // (`supersedes: Some(parent)`, no same-key row — the claude rollback
        // adoption and codex crash-respawn lanes) inherits the superseded
        // PARENT's stamps (the fork is, by construction, the same pane).
        // `Replace` fields replace independently (a `None` field keeps the
        // inherited value). `Clear` (explicitly-headless lineage) erases all
        // stamps and NEVER inherits — a headless re-bind must not keep a
        // browser's attribution under a refreshed `updated_at`, or the D8
        // judgment would offer a session that was not open. The retire/link
        // below is unchanged by the policy; this block is stamps-only.
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
        let (client_instance_id, device_id, tab_key) = match w.provenance {
            ProvenancePolicy::Inherit => (
                inherit.and_then(|r| r.client_instance_id.clone()),
                inherit.and_then(|r| r.device_id.clone()),
                inherit.and_then(|r| r.tab_key.clone()),
            ),
            ProvenancePolicy::Replace(stamps) => (
                stamps
                    .client_instance_id
                    .map(str::to_string)
                    .or_else(|| inherit.and_then(|r| r.client_instance_id.clone())),
                stamps
                    .device_id
                    .map(str::to_string)
                    .or_else(|| inherit.and_then(|r| r.device_id.clone())),
                stamps
                    .tab_key
                    .map(str::to_string)
                    .or_else(|| inherit.and_then(|r| r.tab_key.clone())),
            ),
            ProvenancePolicy::Clear => (None, None, None),
        };
        // Delta-r4 Finding 1 (same predicate as the terminal body,
        // `advances_attribution`): a meaningful connection-scoped application
        // (the conn-scoped upsert lanes, connection-resolved fork stamps) SETS
        // the last-attribution time; conn-less `Inherit` refreshes (settings
        // refresh, crash-recover, attach-resume) and hollow `Replace`s
        // PRESERVE it; `Clear` ERASES it. The preserve source is strictly the
        // same-key existing row — a fork-chain child never takes the
        // superseded PARENT's attribution time (only its stamps): the child
        // was born at fork time, and the D8 judgment's defensive
        // `created_at` floor already dominates any older inherited value, so
        // inheriting it would record a time the judgment can never use.
        let last_attributed_at = if advances_attribution(&w.provenance) {
            Some(w.now_ms)
        } else {
            match w.provenance {
                ProvenancePolicy::Clear => None,
                _ => existing.and_then(|r| r.last_attributed_at),
            }
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

    /// Best-effort retire on observed clean close (trigger e). Missing or
    /// already-retired rows are Ok — this path is never load-bearing.
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
        let Some(mut row) = index
            .bindings
            .get(&(provider.to_string(), session_id.to_string()))
            .cloned()
        else {
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
        // policy wins (`Replace` asserts, `Clear` erases). A conn-less
        // `Inherit` resolve instead derives the ORIGIN lane's policy from the
        // consumed marker, exactly the way the origin's direct writes express
        // it:
        //   * a marker carrying ANY spawn-time stamp → `Replace(stamps)` —
        //     the conn-less SESSION-AFFILIATED source rule: each `Some`
        //     field attributes the row, each `None` field asserts nothing,
        //     so `Replace`'s per-field keep-when-`None` yields exactly
        //     (marker stamps, else the existing row's stamps);
        //   * an ALL-NONE marker → `Clear` — the HEADLESS origin record:
        //     the explicitly-headless REST/headless lineage binder stamps
        //     nothing by design (`pane_identity_binder.rs`, whose direct
        //     writes are `Clear`), so resolution must AGREE with that lane —
        //     stamps → `None` regardless of the marker and the existing row.
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
        let mut stamp_spawned_at: Option<i64> = None;
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
                    stamp_spawned_at = Some(marker.spawned_at);
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
                // MARKER's `spawned_at` — the browser asserted the pane when
                // it spawned it; this conn-less resolution merely lands the
                // stamps later (the pane may be long closed and omitted from
                // the parent's frozen evidence, and resolve-time attribution
                // would re-launder it into the D8 offer).
                effective = BindingWrite {
                    provenance: ProvenancePolicy::Replace(ProvenanceStamps {
                        client_instance_id: stamp_client.as_deref(),
                        device_id: stamp_device.as_deref(),
                        tab_key: stamp_tab.as_deref(),
                    }),
                    attributed_at: stamp_spawned_at,
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
            // (no existing row would otherwise exist to inherit from), while
            // (focused-ep3-r2 Finding 2) an unstamped — headless — marker
            // derives `Clear`, so the same resolution can never launder a
            // stale browser attribution. `attributed_at: None` = "assert when
            // writing" — `resolve_pending` overrides it to the consumed
            // marker's `spawned_at` when (and only when) the stamps come FROM
            // the marker (focused-ep4 Finding).
            provenance: ProvenancePolicy::Inherit,
            attributed_at: None,
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
