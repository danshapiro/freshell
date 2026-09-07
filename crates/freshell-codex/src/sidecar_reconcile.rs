//! Boot-time **sidecar reconciler** — loads the durable
//! `rust-codex-sidecars` records a previous server generation left behind
//! ([`crate::sidecar_store`]), prunes rows whose identity evidence no longer
//! matches live `/proc` (Dead / Mismatch — remove only, NEVER signal), and
//! holds the survivors as one-shot claimable by codex session id for
//! restore-time reattach (katas ynfn/da92; the adopt/sweep sides land in
//! Tasks 6–9).
//!
//! Every prune/claim decision emits structured tracing with the ownership id
//! and identity verdict — auditability is half the invariant.
//!
//! The plan-aware reattach-vs-spawn selection OVER a claim lives in the
//! sibling [`crate::runtime_select`] (Task 7).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use crate::app_server::{BoxFuture, CodexAppServerClient};
use crate::launch_lifecycle::{CodexLaunchRuntime, CodexRuntimeReady};
use crate::sidecar_store::{
    verify_sidecar_identity, CodexSidecarRecord, CodexSidecarStore, IdentityVerdict, SidecarLane,
    SidecarRecordState,
};
use crate::sidecar_sweep::kill_verified_sidecar_tree;
use crate::transport::TungsteniteTransport;

/// Per-candidate budget for the duplicate-arm writer probe (connect + the
/// `initialize`/`initialized` handshake + one `thread/loaded/list` round
/// trip). Bounded so a wedged survivor cannot stall a restore; on timeout
/// the candidate is simply NOT the writer.
const WRITER_PROBE_BUDGET: Duration = Duration::from_millis(1000);

/// Reattach `ensure_ready` probe budget: ONE bounded connect against the
/// survivor's recorded `ws_url` (the spawn path's A6-fixed probe shape,
/// `launch_lifecycle.rs:1088-1131`, but a single short attempt) — reattach
/// must fail FAST into the structural fresh-spawn fallback, never sit out
/// the 45s spawn budget.
const REATTACH_PROBE_BUDGET: Duration = Duration::from_secs(3);

/// Boot-log summary returned by [`SidecarReconciler::boot_reconcile`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootReconcileReport {
    /// Healthy rows loaded from the store (corrupt rows were quarantined by
    /// `load_all`, not counted here).
    pub loaded: usize,
    /// Dead-verdict rows removed (stale records of exited sidecars).
    pub pruned_dead: usize,
    /// Mismatch-verdict rows removed (pid reuse — the pid is NOT ours; the
    /// row is dropped and the process is NEVER signalled).
    pub pruned_mismatch: usize,
    /// Rows held for claim/sweep (Verified + Unverifiable).
    pub held: usize,
}

/// The boot reconciler: holds every surviving record until a restore claims
/// it (by session id) or the sweep (Task 9) disposes of it.
pub struct SidecarReconciler {
    /// pub(crate): shared with the [`crate::sidecar_sweep`] sibling (the
    /// pre-authorized 1,000-line split) — one logical brick, two files.
    pub(crate) store: Arc<CodexSidecarStore>,
    /// ALL held records, keyed by ownership_id — NOT by session id. Two live
    /// records can legitimately share a session id (a mid-turn survivor
    /// retained at sweep + a later fresh spawn enriched with the same session;
    /// validated reachable — reports/V3.md), and Verified-without-session /
    /// Unverifiable records must also be held for the sweep. Keying by
    /// session_id would silently drop records (a fifth-fate ynfn violation).
    pub(crate) held: Mutex<HashMap<String /*ownership_id*/, CodexSidecarRecord>>,
    /// Secondary index for restore-time claims.
    pub(crate) by_session: Mutex<HashMap<String /*session_id*/, Vec<String /*ownership_id*/>>>,
}

/// Outcome of the sync (lock-holding) phase of a claim. The `Claimed` record
/// is boxed to keep the enum small (clippy `large_enum_variant`).
enum FastClaim {
    /// No claimable candidate for this session.
    Empty,
    /// Exactly one verified candidate — claimed under the locks, no probe.
    Claimed(Box<CodexSidecarRecord>),
    /// Two or more verified candidates, snapshotted OUT of the locks for the
    /// async writer probe.
    Duplicates(Vec<CodexSidecarRecord>),
}

impl SidecarReconciler {
    /// Boot: load_all(); prune records whose identity verdict is Dead
    /// (remove) or Mismatch (remove — the pid is NOT ours, never signal);
    /// hold every remaining record by ownership_id (Verified with session =
    /// claimable via the index; Verified without session and Unverifiable =
    /// held for the sweep only). Returns a summary for boot logs.
    pub fn boot_reconcile(store: Arc<CodexSidecarStore>) -> (Self, BootReconcileReport) {
        let records = store.load_all();
        let loaded = records.len();
        let mut pruned_dead = 0;
        let mut pruned_mismatch = 0;
        let mut held: HashMap<String, CodexSidecarRecord> = HashMap::new();
        let mut by_session: HashMap<String, Vec<String>> = HashMap::new();

        for record in records {
            let verdict = verify_sidecar_identity(&record);
            match verdict {
                IdentityVerdict::Dead => {
                    pruned_dead += 1;
                    tracing::info!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %record.ownership_id,
                        verdict = ?verdict,
                        "sidecar_record_pruned: recorded sidecar exited; stale row removed"
                    );
                    remove_pruned(&store, &record.ownership_id);
                }
                IdentityVerdict::Mismatch => {
                    pruned_mismatch += 1;
                    tracing::warn!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %record.ownership_id,
                        verdict = ?verdict,
                        "sidecar_record_pruned: pid reuse — the pid is NOT ours; \
                         row removed, process NEVER signalled"
                    );
                    remove_pruned(&store, &record.ownership_id);
                }
                IdentityVerdict::Verified | IdentityVerdict::Unverifiable => {
                    // Verified with a session id is claimable via the index;
                    // Verified without one and Unverifiable are held for the
                    // sweep only. freshagent-lane records are sweep-only:
                    // they are never claimed by terminal-pane restores (wfah).
                    let claimable = verdict == IdentityVerdict::Verified
                        && record.session_id.is_some()
                        && record.lane != Some(SidecarLane::FreshAgent);
                    if claimable {
                        by_session
                            .entry(record.session_id.clone().expect("claimable has a session"))
                            .or_default()
                            .push(record.ownership_id.clone());
                    }
                    tracing::info!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %record.ownership_id,
                        verdict = ?verdict,
                        session_id = record.session_id.as_deref().unwrap_or("<none>"),
                        claimable,
                        "sidecar_record_held: survivor held for claim/sweep"
                    );
                    held.insert(record.ownership_id.clone(), record);
                }
            }
        }

        let report = BootReconcileReport {
            loaded,
            pruned_dead,
            pruned_mismatch,
            held: held.len(),
        };
        (
            Self {
                store,
                held: Mutex::new(held),
                by_session: Mutex::new(by_session),
            },
            report,
        )
    }

    /// Restore-time claim: re-verify identity at claim time and return ONE
    /// record for this session. With duplicates, pick the WRITER: prefer the
    /// candidate whose live sidecar reports this session in
    /// thread/loaded/list (a bounded ws probe — duplicate arm only, ~1s per
    /// candidate), else newest updated_at. Losers
    /// STAY held (they keep their sweep fate — never silently dropped).
    /// Retained-state records ARE claimable (re-verified; adopt flips them
    /// back to Active) — a late restore after the sweep must still reattach
    /// a mid-turn survivor instead of reproducing the -32600 (reports/V3.md).
    /// Only the returned record leaves `held`; each record is claimable ONCE.
    /// ASYNC because of the writer probe (Task 7's factory is async-aware and
    /// awaits this): the 0/1-candidate fast path opens no connection; the
    /// duplicate arm snapshots candidates OUT of the `held`/`by_session`
    /// locks before any await (std Mutex guards must never be held across an
    /// await point — clippy `await_holding_lock`).
    /// After the probe await, the winner is claimed by re-acquiring the
    /// locks and removing it from `held`/`by_session` ONLY if still present;
    /// a candidate the sweep consumed during the await is skipped (fall
    /// through to the remaining candidates, else None). Membership in
    /// `held` is the single source of truth for claim-vs-sweep ownership —
    /// every exit from `held` happens under its lock (Task 9's sweep
    /// TOCTOU guard is the mirror of this rule).
    pub async fn claim_for_session(&self, session_id: &str) -> Option<CodexSidecarRecord> {
        let candidates = match self.verify_and_fast_claim(session_id) {
            FastClaim::Empty => return None,
            FastClaim::Claimed(record) => return Some(*record),
            FastClaim::Duplicates(candidates) => candidates,
        };

        // Duplicate arm — NO locks held across these awaits.
        let mut ranked: Vec<(bool, CodexSidecarRecord)> = Vec::with_capacity(candidates.len());
        for record in candidates {
            let is_writer = writer_probe(&record.ws_url, session_id).await;
            tracing::info!(
                target: "freshell_codex::sidecar_reconcile",
                ownership_id = %record.ownership_id,
                session_id,
                is_writer,
                "sidecar_claim_probe: duplicate-arm writer probe result"
            );
            ranked.push((is_writer, record));
        }
        // Writers first, then newest updated_at; ownership_id is a
        // deterministic final tiebreak.
        ranked.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then(b.1.updated_at.cmp(&a.1.updated_at))
                .then(a.1.ownership_id.cmp(&b.1.ownership_id))
        });

        self.claim_first_still_held(session_id, &ranked)
    }

    /// Records still held (unclaimed) — the sweep's future workload.
    pub fn unclaimed_len(&self) -> usize {
        self.held.lock().unwrap().len()
    }

    /// Sync phase of a claim (all lock work, no awaits): re-verify every
    /// indexed candidate, prune Dead/Mismatch rows (store + held), skip
    /// Unverifiable ones (held for the sweep), and either claim a single
    /// verified candidate outright or snapshot the duplicates for the probe.
    fn verify_and_fast_claim(&self, session_id: &str) -> FastClaim {
        let mut held = self.held.lock().unwrap();
        let mut by_session = self.by_session.lock().unwrap();
        let Some(indexed_ids) = by_session.get(session_id).cloned() else {
            return FastClaim::Empty;
        };

        let mut retained_ids: Vec<String> = Vec::new();
        let mut candidates: Vec<CodexSidecarRecord> = Vec::new();
        for ownership_id in indexed_ids {
            let Some(record) = held.get(&ownership_id) else {
                // Consumed by an earlier claim or the sweep — membership in
                // `held` is the single source of truth; drop the stale index
                // entry.
                continue;
            };
            let verdict = verify_sidecar_identity(record);
            match verdict {
                IdentityVerdict::Verified => {
                    candidates.push(record.clone());
                    retained_ids.push(ownership_id);
                }
                IdentityVerdict::Dead => {
                    tracing::info!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %ownership_id,
                        verdict = ?verdict,
                        session_id,
                        "sidecar_claim_pruned: candidate died since boot; row removed"
                    );
                    remove_pruned(&self.store, &ownership_id);
                    held.remove(&ownership_id);
                }
                IdentityVerdict::Mismatch => {
                    tracing::warn!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %ownership_id,
                        verdict = ?verdict,
                        session_id,
                        "sidecar_claim_pruned: pid reuse since boot — the pid is NOT \
                         ours; row removed, process NEVER signalled"
                    );
                    remove_pruned(&self.store, &ownership_id);
                    held.remove(&ownership_id);
                }
                IdentityVerdict::Unverifiable => {
                    // Not provably ours ⇒ not claimable; not provably stale
                    // ⇒ stays held for the sweep (never silently dropped).
                    tracing::warn!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %ownership_id,
                        verdict = ?verdict,
                        session_id,
                        "sidecar_claim_skipped: identity unverifiable at claim time; \
                         record stays held for the sweep"
                    );
                    retained_ids.push(ownership_id);
                }
            }
        }

        if candidates.len() == 1 {
            let claimed = candidates.remove(0);
            held.remove(&claimed.ownership_id);
            retained_ids.retain(|id| id != &claimed.ownership_id);
            tracing::info!(
                target: "freshell_codex::sidecar_reconcile",
                ownership_id = %claimed.ownership_id,
                verdict = ?IdentityVerdict::Verified,
                session_id,
                decided_by = "single_candidate",
                "sidecar_record_claimed: sole verified candidate claimed (no probe)"
            );
            rewrite_index(&mut by_session, session_id, retained_ids);
            return FastClaim::Claimed(Box::new(claimed));
        }

        rewrite_index(&mut by_session, session_id, retained_ids);
        if candidates.is_empty() {
            FastClaim::Empty
        } else {
            FastClaim::Duplicates(candidates)
        }
    }

    /// Post-probe phase (locks re-acquired, no awaits): claim the first
    /// ranked candidate still present in `held`; skip candidates consumed
    /// during the probe await.
    fn claim_first_still_held(
        &self,
        session_id: &str,
        ranked: &[(bool, CodexSidecarRecord)],
    ) -> Option<CodexSidecarRecord> {
        let mut held = self.held.lock().unwrap();
        let mut by_session = self.by_session.lock().unwrap();
        for (is_writer, candidate) in ranked {
            let Some(record) = held.remove(&candidate.ownership_id) else {
                tracing::info!(
                    target: "freshell_codex::sidecar_reconcile",
                    ownership_id = %candidate.ownership_id,
                    session_id,
                    "sidecar_claim_candidate_consumed: candidate left `held` during \
                     the probe await; skipped"
                );
                continue;
            };
            if let Some(ids) = by_session.get_mut(session_id) {
                ids.retain(|id| id != &record.ownership_id);
                if ids.is_empty() {
                    by_session.remove(session_id);
                }
            }
            tracing::info!(
                target: "freshell_codex::sidecar_reconcile",
                ownership_id = %record.ownership_id,
                verdict = ?IdentityVerdict::Verified,
                session_id,
                decided_by = if *is_writer { "writer_probe" } else { "updated_at_fallback" },
                "sidecar_record_claimed: duplicate-arm winner claimed; losers stay held"
            );
            return Some(record);
        }
        None
    }
}

/// Remove a pruned row from the store; a removal failure is logged loudly
/// (the row will be re-pruned next boot) and never fails the reconcile.
pub(crate) fn remove_pruned(store: &CodexSidecarStore, ownership_id: &str) {
    if let Err(error) = store.remove(ownership_id) {
        tracing::error!(
            target: "freshell_codex::sidecar_reconcile",
            ownership_id = %ownership_id,
            error = %error,
            "sidecar_record_prune_remove_failed: row removal failed; retried next boot"
        );
    }
}

/// Rewrite (or drop, when empty) a session's index entry.
fn rewrite_index(
    by_session: &mut HashMap<String, Vec<String>>,
    session_id: &str,
    retained_ids: Vec<String>,
) {
    if retained_ids.is_empty() {
        by_session.remove(session_id);
    } else {
        by_session.insert(session_id.to_string(), retained_ids);
    }
}

/// Bounded writer probe (duplicate arm only): does the candidate's live
/// sidecar report `session_id` in `thread/loaded/list`? Reuses the crate's
/// own client ([`CodexAppServerClient`] over [`TungsteniteTransport`], the
/// sweep-probe shape, `sidecar_sweep.rs::probe_mid_turn`) so the
/// `initialize`/`initialized` handshake ALWAYS precedes the list RPC — real
/// codex gates pre-initialize RPCs, and a hand-rolled first-frame list would
/// silently degrade every probe to the newest-`updated_at` fallback (final
/// review F1). All under a single [`WRITER_PROBE_BUDGET`]; any error/timeout
/// ⇒ NOT the writer (the fallback decides). The positive arm is pinned by
/// `duplicate_claim_prefers_the_live_writer_over_newer_updated_at` (this
/// module's tests, against an initialize-gated fixture); the other
/// duplicate-claim tests use `sleep` children that speak no ws, so their
/// probes fail fast.
async fn writer_probe(ws_url: &str, session_id: &str) -> bool {
    tokio::time::timeout(WRITER_PROBE_BUDGET, writer_probe_inner(ws_url, session_id))
        .await
        .unwrap_or(false)
}

async fn writer_probe_inner(ws_url: &str, session_id: &str) -> bool {
    let Ok(transport) = TungsteniteTransport::connect(ws_url).await else {
        return false;
    };
    // Keep the notification receiver alive for the probe's lifetime; the
    // client Drop aborts the background consumer (even on the outer timeout).
    let (client, _notifications) = CodexAppServerClient::connect(Arc::new(transport));
    // `list_loaded_threads` runs the initialize/initialized handshake first
    // (every non-initialize request gates on it, app_server.rs).
    let is_writer = match client.list_loaded_threads().await {
        Ok(loaded) => loaded.iter().any(|id| id == session_id),
        Err(_) => false,
    };
    client.close().await;
    is_writer
}

// ---------------------------------------------------------------------------
// The reattach runtime (Task 6): a second `CodexLaunchRuntime` impl over a
// CLAIMED record — adopt the surviving app-server instead of spawning.
// `plan_create`'s existing cleanup-on-plan-failure (`launch_lifecycle.rs:373-380`
// calls `sidecar.shutdown()` on `ensure_ready` error) composes with the
// failure arms here: a failed reattach tears down via the SAME conservative
// path, and the retry loop (`plan_create_with_retry`,
// `launch_lifecycle.rs:389-416`) re-invokes the factory, which — the claim
// being consumed — mints a fresh `SpawnedCodexAppServerRuntime`: fallback is
// structural, not special-cased.
// ---------------------------------------------------------------------------

/// A second [`CodexLaunchRuntime`]: wraps a record claimed from the
/// [`SidecarReconciler`] and reattaches to the surviving app-server instead
/// of spawning a fresh one (kata da92).
pub struct ReattachedCodexAppServerRuntime {
    /// The claimed record. Interior mutability (std `Mutex`) because the
    /// trait's enrich hooks (`update_ownership_metadata`/`note_session_id`)
    /// rewrite it through `&self`; the guard is NEVER held across an await —
    /// every async path clones the record out first (the
    /// [`kill_verified_sidecar_tree`] caller contract).
    record: Mutex<CodexSidecarRecord>,
    store: Arc<CodexSidecarStore>,
    /// Set by a successful `ensure_ready`; gates `shutdown`'s kill.
    verified_usable: AtomicBool,
}

impl ReattachedCodexAppServerRuntime {
    /// Wrap a record claimed via [`SidecarReconciler::claim_for_session`]
    /// (Task 7's factory constructs this when a claim succeeds).
    pub fn new(record: CodexSidecarRecord, store: Arc<CodexSidecarStore>) -> Self {
        Self {
            record: Mutex::new(record),
            store,
            verified_usable: AtomicBool::new(false),
        }
    }
}

impl CodexLaunchRuntime for ReattachedCodexAppServerRuntime {
    /// Reattach readiness: `cwd` is IGNORED — the survivor already has one
    /// (it was spawned with the original create cwd). Re-verify identity,
    /// then probe-dial `record.ws_url` with ONE bounded connect
    /// ([`REATTACH_PROBE_BUDGET`]). On success: mark `verified_usable` and
    /// return the survivor's ws url. On failure:
    /// - `Mismatch`/`Unverifiable` → `store.remove`, `Err` — **no signal is
    ///   ever sent** (this pid is not provably ours).
    /// - `Dead` → `store.remove`, `Err`.
    /// - `Verified` but probe failed (dead port / handshake failure) → the
    ///   survivor is unusable: [`kill_verified_sidecar_tree`],
    ///   `store.remove`, `Err`. An unusable tracked sidecar must not leak;
    ///   killing it releases codex's per-thread writer-lock files on exit,
    ///   so the retry's fresh spawn can resume the thread (reports/V1.md).
    fn ensure_ready(
        &self,
        _cwd: Option<String>,
    ) -> BoxFuture<'_, Result<CodexRuntimeReady, String>> {
        Box::pin(async move {
            let record = self.record.lock().unwrap().clone();
            let verdict = verify_sidecar_identity(&record);
            match verdict {
                IdentityVerdict::Mismatch | IdentityVerdict::Unverifiable => {
                    tracing::warn!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %record.ownership_id,
                        pid = record.pid,
                        verdict = ?verdict,
                        "sidecar_reattach_refused: identity not provably ours; \
                         record removed, process NEVER signalled"
                    );
                    remove_pruned(&self.store, &record.ownership_id);
                    Err(format!(
                        "codex sidecar reattach refused: identity {verdict:?} for pid {}; \
                         record removed, process never signalled",
                        record.pid
                    ))
                }
                IdentityVerdict::Dead => {
                    tracing::info!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %record.ownership_id,
                        pid = record.pid,
                        verdict = ?verdict,
                        "sidecar_reattach_failed: recorded sidecar is dead; stale row removed"
                    );
                    remove_pruned(&self.store, &record.ownership_id);
                    Err(
                        "codex sidecar reattach failed: recorded sidecar is dead; record removed"
                            .to_string(),
                    )
                }
                IdentityVerdict::Verified => {
                    let probe_error = match tokio::time::timeout(
                        REATTACH_PROBE_BUDGET,
                        tokio_tungstenite::connect_async(&record.ws_url),
                    )
                    .await
                    {
                        Ok(Ok((probe, _response))) => {
                            drop(probe);
                            self.verified_usable.store(true, Ordering::SeqCst);
                            tracing::info!(
                                target: "freshell_codex::sidecar_reconcile",
                                ownership_id = %record.ownership_id,
                                pid = record.pid,
                                ws_url = %record.ws_url,
                                "sidecar_reattached: surviving app-server adopted; no spawn"
                            );
                            return Ok(CodexRuntimeReady {
                                ws_url: record.ws_url.clone(),
                            });
                        }
                        Ok(Err(error)) => error.to_string(),
                        Err(_elapsed) => "probe timed out awaiting the WS handshake".to_string(),
                    };
                    // Verified but unusable (dead port / handshake failure):
                    // the survivor must not leak — reap the whole tree.
                    let outcome = kill_verified_sidecar_tree(&record).await;
                    tracing::warn!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %record.ownership_id,
                        pid = record.pid,
                        probe_error = %probe_error,
                        outcome = ?outcome.outcomes,
                        "sidecar_reattach_reaped: verified survivor unusable; \
                         tree reaped, record removed"
                    );
                    remove_pruned(&self.store, &record.ownership_id);
                    Err(format!(
                        "codex sidecar reattach failed: verified survivor unusable \
                         ({probe_error}); tree reaped, record removed"
                    ))
                }
            }
        })
    }

    /// Adopt-time enrich: rewrite the record (new terminal id, updated_at)
    /// and flip a claimed `Retained{..}` row back to `Active` — the sidecar
    /// is pane-owned again; a stale retention reason would lie to auditors
    /// (final review H3a).
    fn update_ownership_metadata(
        &self,
        terminal_id: String,
        _generation: u64,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let snapshot = {
                let mut record = self.record.lock().unwrap();
                record.terminal_id = Some(terminal_id);
                record.state = SidecarRecordState::Active;
                record.updated_at = unix_millis();
                record.clone()
            };
            write_record_loudly(&self.store, &snapshot);
            Ok(())
        })
    }

    /// Session enrich: rewrite the record (new session id, updated_at);
    /// `Active` for the same H3a reason as `update_ownership_metadata`.
    fn note_session_id(&self, session_id: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let snapshot = {
                let mut record = self.record.lock().unwrap();
                record.session_id = Some(session_id);
                record.state = SidecarRecordState::Active;
                record.updated_at = unix_millis();
                record.clone()
            };
            write_record_loudly(&self.store, &snapshot);
            Ok(())
        })
    }

    /// Task 10: server-shutdown retention — the reattached survivor stays
    /// alive across ANOTHER restart. A reattached runtime always wraps a
    /// persisted record (claims only exist over an enabled store), so
    /// retention applies unconditionally: NO signal is ever sent, the record
    /// flips to `Retained{reason}`, and the `verified_usable` gate drops so
    /// no later teardown path can kill the retained survivor.
    fn prepare_retention(&self, reason: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.verified_usable.store(false, Ordering::SeqCst);
            let snapshot = {
                let mut record = self.record.lock().unwrap();
                record.state = SidecarRecordState::Retained { reason };
                record.updated_at = unix_millis();
                record.clone()
            };
            write_record_loudly(&self.store, &snapshot);
            tracing::info!(
                target: "freshell_codex::sidecar_reconcile",
                ownership_id = %snapshot.ownership_id,
                pid = snapshot.pid,
                "sidecar_retained: reattached sidecar left running across \
                 server shutdown (kata ynfn); record state = Retained"
            );
            Ok(())
        })
    }

    /// Teardown (pane closed, or the plan raced the planner's shutdown):
    /// [`kill_verified_sidecar_tree`] + `store.remove`. Gated on
    /// `verified_usable` — if `ensure_ready` never positively adopted this
    /// survivor (or its failure arm already disposed of it), shutdown
    /// removes the record ONLY and never signals. The kill helper re-verifies
    /// identity immediately before each signal, so `Mismatch`/`Dead`/
    /// `Unverifiable` at kill time ⇒ remove record only.
    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let record = self.record.lock().unwrap().clone();
            if !self.verified_usable.swap(false, Ordering::SeqCst) {
                tracing::info!(
                    target: "freshell_codex::sidecar_reconcile",
                    ownership_id = %record.ownership_id,
                    pid = record.pid,
                    "sidecar_reattach_shutdown_skipped_kill: survivor never verified \
                     usable by this runtime; record removed, nothing signalled"
                );
                remove_pruned(&self.store, &record.ownership_id);
                return Ok(());
            }
            let outcome = kill_verified_sidecar_tree(&record).await;
            tracing::info!(
                target: "freshell_codex::sidecar_reconcile",
                ownership_id = %record.ownership_id,
                pid = record.pid,
                outcome = ?outcome.outcomes,
                "sidecar_reattach_shutdown: reattached sidecar torn down; record removed"
            );
            remove_pruned(&self.store, &record.ownership_id);
            Ok(())
        })
    }
}

/// Rewrite the runtime's record durably; write failures are logged LOUDLY,
/// never propagated (the pane-ledger write-failure policy,
/// `launch_lifecycle.rs:1211-1219` precedent) — the in-memory record stays
/// authoritative for teardown.
pub(crate) fn write_record_loudly(store: &CodexSidecarStore, record: &CodexSidecarRecord) {
    if let Err(error) = store.write(record) {
        tracing::error!(
            target: "freshell_codex::sidecar_reconcile",
            ownership_id = %record.ownership_id,
            error = %error,
            "sidecar_record_rewrite_failed: reattached record kept in memory only \
             (pane-ledger write-failure policy)"
        );
    }
}

/// Wall-clock unix millis for record `updated_at` stamps. Deliberate
/// duplicate of the private `launch_lifecycle::unix_millis`
/// (`launch_lifecycle.rs:988-993`) — a one-liner not worth a shared-helper
/// dependency; keep the two bodies in sync.
pub(crate) fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Process-global reconciler handle (wired at server boot in Task 10). A
// re-settable RwLock seam, mirroring `sidecar_store`'s store global.
// ---------------------------------------------------------------------------

static GLOBAL_SIDECAR_RECONCILER: RwLock<Option<Arc<SidecarReconciler>>> = RwLock::new(None);

/// Install the process-wide reconciler (server boot, after
/// [`SidecarReconciler::boot_reconcile`]). Later calls replace the handle.
pub fn set_codex_sidecar_reconciler(r: Arc<SidecarReconciler>) {
    *GLOBAL_SIDECAR_RECONCILER.write().unwrap() = Some(r);
}

/// The installed process-wide reconciler, if any. `None` (nothing installed)
/// means restore-time callers have nothing to claim from — behavior identical
/// to the pre-reconciler world.
pub fn codex_sidecar_reconciler() -> Option<Arc<SidecarReconciler>> {
    GLOBAL_SIDECAR_RECONCILER.read().unwrap().clone()
}

#[cfg(test)]
#[path = "sidecar_reconcile_tests.rs"]
mod tests;
