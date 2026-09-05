//! P1.8 — boot-scan / GC internals for [`PaneLedger`], split verbatim out of
//! `pane_ledger.rs` (repo 1K-line file limit). Declared as a child module of
//! `pane_ledger` (see the `#[path]` mod there), so this code keeps the
//! parent's privacy scope: direct access to the write-through index, private
//! row-write helpers, and the `quarantined` field. The types below are
//! re-exported from `pane_ledger`, so every existing path
//! (`crate::pane_ledger::BootScanReport`, ...) compiles unchanged.

use super::*;
use std::collections::HashSet;

/// A pending marker whose terminal is not live and which is older than this
/// is orphaned (server death before resolution -- the exit hook never ran).
/// HONEST RATIONALE (validated A11, 2026-07-28): this rule is safe because
/// NO production reader of pending markers exists at ANY age -- the only
/// semantic read APIs (`pending_for_terminal`, pane_ledger.rs:779-791, and
/// `list_pending_raw`, :794) have ZERO non-test callers (grep-verified); the
/// often-cited boot_scan "fresh-by-race vs fresh-by-intent" reader is
/// comments only, not implemented. The live-set guard does real work only in
/// the PERIODIC sweep (protecting a live-but-unresolved pane, e.g. one
/// starved by the Task 8 census shape). TTL is 7 DAYS for FORENSICS: the
/// starvation diagnosis this plan is built on relied on multi-day-old
/// on-disk markers (DirectorDeck, 2026-07-28); after the TTL, loud sweep
/// logs are the remaining trail. If a real marker reader is ever
/// implemented, this wall-clock TTL must be revisited (server-down time is
/// indistinguishable from server-up time).
pub const PENDING_MARKER_ORPHAN_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// A row the boot scan renamed aside because it could not be parsed.
#[derive(Debug, Clone)]
pub struct QuarantinedRow {
    pub original_path: PathBuf,
    pub quarantined_path: PathBuf,
    pub error: String,
}

/// What one boot scan / GC pass did — every field is also loudly logged.
#[derive(Debug, Default)]
pub struct BootScanReport {
    pub quarantined: Vec<QuarantinedRow>,
    pub stale_markers_removed: Vec<String>,
    /// (retired old ref, winning new ref) pairs from the crash-window repair.
    pub supersession_repairs: Vec<(SessionLocator, SessionLocator)>,
    pub gc_tombstoned: Vec<SessionLocator>,
    pub tombstones_deleted: Vec<SessionLocator>,
}

impl PaneLedger {
    /// Boot-time hygiene (spec §4.2): per-row quarantine, stale-marker
    /// sweep, supersession crash-window repair, then a GC pass. Fail loud
    /// per-row, never per-store. The directory walks here are BOOT-ONLY —
    /// steady-state reads stay on the in-memory index (V1.md).
    pub fn boot_scan(
        &self,
        now_ms: i64,
        transcript_absent: &dyn Fn(&str, &str) -> bool,
    ) -> BootScanReport {
        let Some(root) = self.root.clone() else {
            return BootScanReport::default();
        };
        let mut index = self.guard();
        let mut report = BootScanReport::default();

        // 1. Quarantine unparsable / wrong-version rows (bindings + pending).
        //    These never made it into the index (load_index keeps only clean
        //    current-version parses), so no index maintenance is needed here.
        self.quarantine_unparsable(&root, now_ms, &mut report);
        {
            let mut q = self.quarantined.write().unwrap_or_else(|p| p.into_inner());
            q.extend(report.quarantined.iter().cloned());
        }

        // 2. Stale-marker sweep — two cases, both loud:
        //    (a) a marker whose terminalId already has a binding row is
        //        stale — the crash-between-write-and-delete shape;
        //    (b) a marker older than PENDING_MARKER_TTL_MS is aged out
        //        (A8/V7: bounds leaked markers from panes that died WITH the
        //        server — no exit hook will ever fire for them and terminal
        //        ids are never re-minted).
        //    Markers that are neither are PRESERVED (fresh-by-race
        //    evidence), never swept merely because the terminal isn't live.
        let markers: Vec<PendingMarker> = index.pending.values().cloned().collect();
        for marker in markers {
            let covered = index
                .bindings
                .values()
                .any(|r| r.live_terminal_id.as_deref() == Some(marker.terminal_id.as_str()));
            let aged_out = now_ms - marker.spawned_at > PENDING_MARKER_TTL_MS;
            if covered || aged_out {
                match Self::remove_pending(&root, &mut index, &marker.terminal_id) {
                    Ok(()) => {
                        tracing::warn!(
                            target: "freshell_ws::pane_ledger",
                            terminal_id = %marker.terminal_id,
                            covered_by_binding = covered,
                            aged_out = aged_out,
                            "pane_ledger_stale_marker_swept: crash-window residue or aged past TTL"
                        );
                        report.stale_markers_removed.push(marker.terminal_id);
                    }
                    Err(err) => {
                        // Fail loud, never silent: the marker stays; the
                        // next boot/GC pass retries naturally.
                        tracing::warn!(
                            target: "freshell_ws::pane_ledger",
                            terminal_id = %marker.terminal_id,
                            covered_by_binding = covered,
                            aged_out = aged_out,
                            error = %err,
                            "pane_ledger_stale_marker_sweep_failed: marker removal failed; will retry next pass"
                        );
                    }
                }
            }
        }

        // 3. Supersession crash-window repair: two bound rows on one pane
        //    lineage — newer updatedAt wins, older auto-retired, loud.
        let mut by_terminal: std::collections::HashMap<String, Vec<BindingRow>> =
            std::collections::HashMap::new();
        for row in index.bindings.values() {
            if row.state == RowState::Bound {
                if let Some(tid) = &row.live_terminal_id {
                    by_terminal
                        .entry(tid.clone())
                        .or_default()
                        .push(row.clone());
                }
            }
        }
        for (terminal_id, mut rows) in by_terminal {
            if rows.len() < 2 {
                continue;
            }
            // Tiebreak rationale (A16, strategist report): both rows were
            // written by a SINGLE process run, milliseconds apart — the only
            // hazard is a wall-clock step landing INSIDE that ms-wide window.
            // Accepted: wall-clock updatedAt is the tiebreak. If this ever
            // bites, stamp an in-process AtomicU64 sequence into rows as a
            // secondary tiebreak (schema addition, P1.13-compatible).
            rows.sort_by_key(|r| std::cmp::Reverse(r.updated_at));
            let winner = SessionLocator {
                provider: rows[0].provider.clone(),
                session_id: rows[0].session_id.clone(),
            };
            for mut loser in rows.into_iter().skip(1) {
                loser.state = RowState::Retired;
                loser.retired_reason = Some(RetiredReason::Superseded);
                loser.superseded_by = Some(winner.clone());
                loser.updated_at = now_ms;
                tracing::warn!(
                    target: "freshell_ws::pane_ledger",
                    terminal_id = %terminal_id,
                    loser_session_id = %loser.session_id,
                    winner_session_id = %winner.session_id,
                    "pane_ledger_supersession_repair: two bound rows on one lineage; newer updatedAt wins"
                );
                let loser_ref = SessionLocator {
                    provider: loser.provider.clone(),
                    session_id: loser.session_id.clone(),
                };
                match self.write_binding(&root, &mut index, &loser) {
                    Ok(()) => {
                        report
                            .supersession_repairs
                            .push((loser_ref, winner.clone()));
                    }
                    Err(err) => {
                        // Fail loud, never silent: the loser stays bound on
                        // disk; the repair re-runs at the next boot scan.
                        tracing::error!(
                            target: "freshell_ws::pane_ledger",
                            terminal_id = %terminal_id,
                            loser_session_id = %loser_ref.session_id,
                            winner_session_id = %winner.session_id,
                            error = %err,
                            "pane_ledger_supersession_repair_failed: retire write failed; row left bound"
                        );
                    }
                }
            }
        }

        // 4. GC pass (also runs periodically via `gc`).
        let gc_report = self.gc_locked(&root, &mut index, now_ms, transcript_absent);
        report.gc_tombstoned = gc_report.gc_tombstoned;
        report.tombstones_deleted = gc_report.tombstones_deleted;
        report
    }

    /// The periodic subset: expire unobserved bound rows TO TOMBSTONES,
    /// delete old tombstones ONLY when the transcript is definitively gone —
    /// per the caller's DIRECT-STAT closure (V10.md: probe Absent alone is
    /// not definitive; see the boot_scan contract) — and sweep aged-out
    /// pending markers (the leaked-marker lifetime bound must hold on a
    /// long-running server, not only across restarts).
    ///
    /// Lock granularity: unlike the pre-serve boot scan, this path runs
    /// CONCURRENTLY with async readers (handshake stamping, restore rung,
    /// ever_bound), so it never holds the index guard across the whole
    /// batch of fsyncing writes (~15-64ms each). It snapshots the work list
    /// under the guard, then drops and re-acquires the guard per item; each
    /// per-item helper re-reads current index state under the re-acquired
    /// guard and skips items that no longer qualify. The write-through
    /// invariant is preserved: every file mutation and its index update
    /// still happen under ONE guard acquisition.
    ///
    /// `live_terminal_ids` feeds the orphan rule: the periodic caller passes
    /// `Some(registry terminal ids)` (a terminal is live iff it appears in
    /// the registry); `None` disables the orphan rule entirely (the boot
    /// path — see `gc_locked`).
    pub fn gc(
        &self,
        now_ms: i64,
        transcript_absent: &dyn Fn(&str, &str) -> bool,
        live_terminal_ids: Option<&HashSet<String>>,
    ) -> BootScanReport {
        let Some(root) = self.root.clone() else {
            return BootScanReport::default();
        };
        let mut report = BootScanReport::default();
        let (marker_ids, row_keys) = {
            let index = self.guard();
            (
                index.pending.keys().cloned().collect::<Vec<String>>(),
                index
                    .bindings
                    .keys()
                    .cloned()
                    .collect::<Vec<(String, String)>>(),
            )
        };
        for terminal_id in marker_ids {
            let mut index = self.guard();
            self.gc_marker_locked(
                &root,
                &mut index,
                &terminal_id,
                now_ms,
                live_terminal_ids,
                &mut report,
            );
        }
        for key in row_keys {
            let mut index = self.guard();
            self.gc_row_locked(
                &root,
                &mut index,
                &key,
                now_ms,
                transcript_absent,
                &mut report,
            );
        }
        report
    }

    /// The boot-time GC pass: same per-item helpers as `gc`, driven under
    /// the caller's single guard (boot_scan runs pre-serve — no concurrent
    /// readers exist, so batch-holding the guard is free and minimal).
    fn gc_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        now_ms: i64,
        transcript_absent: &dyn Fn(&str, &str) -> bool,
    ) -> BootScanReport {
        let mut report = BootScanReport::default();
        let marker_ids: Vec<String> = index.pending.keys().cloned().collect();
        for terminal_id in marker_ids {
            // Boot path: `None` disables the orphan rule. At boot the
            // registry is necessarily EMPTY (PTYs die with the process;
            // restore is client-driven and post-serve), so running the
            // orphan rule here would sweep EVERY old marker at EVERY boot.
            self.gc_marker_locked(root, index, &terminal_id, now_ms, None, &mut report);
        }
        let row_keys: Vec<(String, String)> = index.bindings.keys().cloned().collect();
        for key in row_keys {
            self.gc_row_locked(root, index, &key, now_ms, transcript_absent, &mut report);
        }
        report
    }

    /// Aged-marker sweep for ONE marker, under the caller's guard (A8/V7):
    /// part of the periodic subset per the `gc` contract, so a long-running
    /// server bounds leaked-marker lifetime WITHOUT a restart. The TTL case
    /// and the orphan case (P2, gated on `live_terminal_ids` — `None`
    /// disables it) run here — the covered-by-binding case is boot-only
    /// crash-window residue (boot_scan step 2, which also handles the TTL
    /// case at boot, so this finds nothing on the boot path). Re-reads the
    /// marker from the index: one resolved/removed between the snapshot and
    /// this guard acquisition is skipped safely.
    fn gc_marker_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        terminal_id: &str,
        now_ms: i64,
        live_terminal_ids: Option<&HashSet<String>>,
        report: &mut BootScanReport,
    ) {
        let Some(marker) = index.pending.get(terminal_id) else {
            return; // resolved/removed since the snapshot — no longer qualifies
        };
        let aged_out = now_ms - marker.spawned_at > PENDING_MARKER_TTL_MS;
        // Orphan rule (P2, PERIODIC sweep only): the exit hook deletes
        // markers on PTY exit, but a SERVER death orphans them
        // (terminal.rs:1738 never runs). Safe because NO production reader
        // of pending markers exists (pane_ledger.rs:779-794 read APIs have
        // zero non-test callers -- A11); the live-set guard does real work
        // only here, protecting a live-but-unresolved pane (e.g. census
        // starvation, Task 8). live_terminal_ids is None on the pre-serve
        // boot path (registry empty, main.rs:603-630) -- boot never sweeps
        // by this rule.
        let orphaned = live_terminal_ids.is_some_and(|live| {
            !live.contains(terminal_id) && now_ms - marker.spawned_at > PENDING_MARKER_ORPHAN_TTL_MS
        });
        if !aged_out && !orphaned {
            return;
        }
        match Self::remove_pending(root, index, terminal_id) {
            Ok(()) => {
                tracing::warn!(
                    target: "freshell_ws::pane_ledger",
                    terminal_id = %terminal_id,
                    aged_out = aged_out,
                    orphaned = orphaned,
                    "pane_ledger_stale_marker_swept: aged past TTL or orphaned (periodic GC)"
                );
                report.stale_markers_removed.push(terminal_id.to_string());
            }
            Err(err) => {
                // Fail loud, never silent: the marker stays; the
                // next GC pass retries naturally.
                tracing::warn!(
                    target: "freshell_ws::pane_ledger",
                    terminal_id = %terminal_id,
                    error = %err,
                    "pane_ledger_stale_marker_sweep_failed: marker removal failed; will retry next pass"
                );
            }
        }
    }

    /// GC for ONE binding row, under the caller's guard. Re-reads the row
    /// from the index: one rewritten/removed between the snapshot and this
    /// guard acquisition is re-evaluated against its CURRENT state (e.g. a
    /// re-bound row with a fresh `last_observed_at` no longer qualifies and
    /// is skipped).
    fn gc_row_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        key: &(String, String),
        now_ms: i64,
        transcript_absent: &dyn Fn(&str, &str) -> bool,
        report: &mut BootScanReport,
    ) {
        let Some(mut row) = index.bindings.get(key).cloned() else {
            return; // deleted since the snapshot — no longer qualifies
        };
        let sref = SessionLocator {
            provider: row.provider.clone(),
            session_id: row.session_id.clone(),
        };
        match row.state {
            RowState::Bound => {
                if now_ms - row.last_observed_at > BOUND_GC_TTL_MS {
                    row.state = RowState::Retired;
                    row.retired_reason = Some(RetiredReason::GcExpired);
                    row.updated_at = now_ms;
                    tracing::info!(
                        target: "freshell_ws::pane_ledger",
                        provider = %sref.provider,
                        session_id = %sref.session_id,
                        "pane_ledger_gc_tombstoned: bound row expired to tombstone (never deleted by timer)"
                    );
                    match self.write_binding(root, index, &row) {
                        Ok(()) => report.gc_tombstoned.push(sref),
                        Err(err) => {
                            // Fail loud, never silent: the row stays
                            // bound on disk; the next GC pass retries.
                            tracing::error!(
                                target: "freshell_ws::pane_ledger",
                                provider = %sref.provider,
                                session_id = %sref.session_id,
                                error = %err,
                                "pane_ledger_gc_tombstone_failed: tombstone write failed; row left bound"
                            );
                        }
                    }
                }
            }
            RowState::Retired => {
                let old_enough = now_ms - row.updated_at > TOMBSTONE_GC_TTL_MS;
                if old_enough && transcript_absent(&row.provider, &row.session_id) {
                    let path = Self::binding_path(root, &row.provider, &row.session_id);
                    match std::fs::remove_file(&path) {
                        Ok(()) => {
                            index
                                .bindings
                                .remove(&(row.provider.clone(), row.session_id.clone()));
                            tracing::info!(
                                target: "freshell_ws::pane_ledger",
                                provider = %sref.provider,
                                session_id = %sref.session_id,
                                "pane_ledger_tombstone_deleted: transcript gone (direct stat) and tombstone TTL elapsed"
                            );
                            report.tombstones_deleted.push(sref);
                        }
                        Err(err) => {
                            // Fail loud, never silent: the tombstone
                            // stays; the next GC pass retries naturally.
                            tracing::warn!(
                                target: "freshell_ws::pane_ledger",
                                provider = %sref.provider,
                                session_id = %sref.session_id,
                                error = %err,
                                "pane_ledger_tombstone_delete_failed: tombstone file removal failed; will retry next pass"
                            );
                        }
                    }
                }
            }
        }
    }

    fn quarantine_unparsable(&self, root: &Path, now_ms: i64, report: &mut BootScanReport) {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(providers) = std::fs::read_dir(Self::bindings_dir(root)) {
            for provider in providers.flatten() {
                if let Ok(files) = std::fs::read_dir(provider.path()) {
                    candidates.extend(files.flatten().map(|f| f.path()));
                }
            }
        }
        if let Ok(files) = std::fs::read_dir(Self::pending_dir(root)) {
            candidates.extend(files.flatten().map(|f| f.path()));
        }
        // kata 1wxv: the rollback subtree participates in per-row quarantine.
        // Its payloads are OPAQUE to the ledger (no ledgerVersion gate, no
        // typed-parse check) — the schema is owned by
        // freshell_freshagent::rollback_record and version-gated in that
        // crate's sink layer — so health here is JSON-parseability, nothing
        // more.
        if let Ok(providers) = std::fs::read_dir(Self::rollback_dir(root)) {
            for provider in providers.flatten() {
                if let Ok(files) = std::fs::read_dir(provider.path()) {
                    candidates.extend(files.flatten().map(|f| f.path()));
                }
            }
        }
        let rollback_root = Self::rollback_dir(root);
        for path in candidates {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.contains(".tmp-") {
                // Orphan temp from a crashed write — reap with a WARN (the
                // `sweep_orphan_tmp` discipline).
                tracing::warn!(
                    target: "freshell_ws::pane_ledger",
                    path = %path.display(),
                    "pane_ledger_orphan_tmp_reaped"
                );
                let _ = std::fs::remove_file(&path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue; // prior quarantine residue
            }
            let error = match load_row::<serde_json::Value>(&path) {
                Err(e) => format!("{e}"),
                Ok(value) => {
                    if path.starts_with(&rollback_root) {
                        // Opaque rollback payload: JSON-parse health only (see
                        // the candidate comment above); a parseable row is
                        // healthy here regardless of shape.
                        continue;
                    }
                    let version = value.get("ledgerVersion").and_then(|v| v.as_u64());
                    if version == Some(u64::from(LEDGER_VERSION)) {
                        // Version ok — but does it parse as its row type?
                        let is_pending = path
                            .parent()
                            .map(|p| p.ends_with("pending"))
                            .unwrap_or(false);
                        let typed_ok = if is_pending {
                            serde_json::from_value::<PendingMarker>(value).is_ok()
                        } else {
                            serde_json::from_value::<BindingRow>(value).is_ok()
                        };
                        if typed_ok {
                            continue; // healthy
                        }
                        "row shape does not match its type".to_string()
                    } else {
                        format!("unsupported ledgerVersion {version:?} (gate: {LEDGER_VERSION})")
                    }
                }
            };
            let quarantined_path = path.with_file_name(format!("{name}.quarantined-{now_ms}"));
            match std::fs::rename(&path, &quarantined_path) {
                Ok(()) => {
                    tracing::error!(
                        target: "freshell_ws::pane_ledger",
                        path = %path.display(),
                        quarantined = %quarantined_path.display(),
                        error = %error,
                        "pane_ledger_row_quarantined: unparsable row renamed aside (fail loud per-row, never per-store)"
                    );
                    report.quarantined.push(QuarantinedRow {
                        original_path: path,
                        quarantined_path,
                        error,
                    });
                }
                Err(rename_err) => {
                    // Fail loud, never silent: the bad row stays in place;
                    // the next boot scan retries the quarantine.
                    tracing::error!(
                        target: "freshell_ws::pane_ledger",
                        path = %path.display(),
                        quarantined = %quarantined_path.display(),
                        row_error = %error,
                        error = %rename_err,
                        "pane_ledger_quarantine_rename_failed: unparsable row left in place; will retry next boot"
                    );
                }
            }
        }
    }
}
