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
    /// Focused-ep5-r1 Finding 2: expired kill tombstones swept this pass
    /// (finding-4 round-4: also accepted-claim RESIDUE pairs, pruned at any
    /// age — never a DOMINANT pair, whose dominance no TTL may outrun).
    pub kill_tombstones_swept: Vec<SessionLocator>,
    /// Focused-ep5-r2 Finding 1 (retire-on-kill round 3): still-Bound rows a
    /// DOMINANT kill tombstone retired (fresh-or-any-age — the split-write
    /// crash remnant's retirement re-applied durably this pass).
    pub kill_tombstone_enforced_retires: Vec<SessionLocator>,
    /// Focused-ep5-r5 Finding 2 (retire-on-kill round 6): alias-tombstone
    /// records swept this pass (locator `session_id` carries the
    /// PLACEHOLDER). One entry per placeholder whose file changed — a
    /// partial prune (dead-half records dropped, file rewritten) and a whole
    /// sweep (file deleted) both report here. A record drops only past the
    /// TTL and only when the row it resolves to is Retired-or-GC'd (the
    /// round-5 lifetime-is-row-lifetime rule, on durable storage).
    pub alias_tombstones_swept: Vec<SessionLocator>,
    /// Delta-r6-r2 (focused-episode-6 round 1), delta-r6-r4 (round 3): close
    /// records swept this pass (the record keys — `pane:<terminalId>` /
    /// `<provider>:<addressedSessionId>`). A record drops only once its
    /// NEWEST stamp (`closed_at`, every `kills.at_ms`) is past
    /// [`KILL_TOMBSTONE_TTL_MS`] — the same protective horizon as the close
    /// fences it carries.
    pub pane_closes_swept: Vec<String>,
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
        snapshot_refs: Option<&crate::tabs_persist::RetainedSnapshotReferences>,
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
        let gc_report = self.gc_locked(&root, &mut index, now_ms, transcript_absent, snapshot_refs);
        report.gc_tombstoned = gc_report.gc_tombstoned;
        report.tombstones_deleted = gc_report.tombstones_deleted;
        report.kill_tombstones_swept = gc_report.kill_tombstones_swept;
        report.kill_tombstone_enforced_retires = gc_report.kill_tombstone_enforced_retires;
        report.alias_tombstones_swept = gc_report.alias_tombstones_swept;
        report.pane_closes_swept = gc_report.pane_closes_swept;
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
    /// `snapshot_refs` (delta-r6-r4 Finding 2): the pane identities ANY
    /// retained snapshot generation references — the close-evidence
    /// retention gate ([`PaneLedger::gc_pane_close_locked`]). `None` means
    /// UNKNOWN (the reference scan failed): close evidence is never pruned
    /// on doubt.
    pub fn gc(
        &self,
        now_ms: i64,
        transcript_absent: &dyn Fn(&str, &str) -> bool,
        live_terminal_ids: Option<&HashSet<String>>,
        snapshot_refs: Option<&crate::tabs_persist::RetainedSnapshotReferences>,
    ) -> BootScanReport {
        let Some(root) = self.root.clone() else {
            return BootScanReport::default();
        };
        let mut report = BootScanReport::default();
        let (marker_ids, row_keys, tombstone_keys, alias_keys, pane_close_ids) = {
            let index = self.guard();
            (
                index.pending.keys().cloned().collect::<Vec<String>>(),
                index
                    .bindings
                    .keys()
                    .cloned()
                    .collect::<Vec<(String, String)>>(),
                index
                    .kill_tombstones
                    .keys()
                    .cloned()
                    .collect::<Vec<(String, String)>>(),
                index
                    .alias_tombstones
                    .keys()
                    .cloned()
                    .collect::<Vec<(String, String)>>(),
                index
                    .close_envelopes
                    .keys()
                    .cloned()
                    .collect::<Vec<String>>(),
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
        for key in tombstone_keys {
            let mut index = self.guard();
            self.gc_kill_tombstone_locked(&root, &mut index, &key, now_ms, &mut report);
        }
        for key in alias_keys {
            let mut index = self.guard();
            self.gc_alias_tombstone_locked(&root, &mut index, &key, now_ms, &mut report);
        }
        for key in pane_close_ids {
            let mut index = self.guard();
            self.gc_pane_close_locked(&root, &mut index, &key, now_ms, snapshot_refs, &mut report);
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
        snapshot_refs: Option<&crate::tabs_persist::RetainedSnapshotReferences>,
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
        let tombstone_keys: Vec<(String, String)> = index.kill_tombstones.keys().cloned().collect();
        for key in tombstone_keys {
            self.gc_kill_tombstone_locked(root, index, &key, now_ms, &mut report);
        }
        let alias_keys: Vec<(String, String)> = index.alias_tombstones.keys().cloned().collect();
        for key in alias_keys {
            self.gc_alias_tombstone_locked(root, index, &key, now_ms, &mut report);
        }
        let pane_close_ids: Vec<String> = index.close_envelopes.keys().cloned().collect();
        for key in pane_close_ids {
            self.gc_pane_close_locked(root, index, &key, now_ms, snapshot_refs, &mut report);
        }
        report
    }

    /// Retention sweep for ONE close record (delta-r6-r4: the journal
    /// envelopes AND the legacy `close-records/` pane records — both live in
    /// the `close_envelopes` index): the record lives under the SAME
    /// protective horizon as the close fences it carries — it is pruned once
    /// its NEWEST stamp (`closed_at`, every `kills.at_ms`) is past
    /// [`KILL_TOMBSTONE_TTL_MS`]. The record's live purpose is the recovery
    /// evidence window around the close (push-cadence + staleness, far under
    /// six hours); a stale record must not verdict a re-minted pane...
    /// (terminal ids are never re-minted, so this ages out forensic residue,
    /// never live meaning). Fail loud per record, never silent — a failed
    /// delete keeps the record and retries next pass.
    ///
    /// Delete paths: the journal tree (`close-envelopes/<enc(key)>.json`)
    /// and, for pane-linked records, the legacy tree
    /// (`close-records/<enc(terminalId)>.json`) — whichever a record was
    /// loaded from is removed; `NotFound` on either is already-gone.
    /// Un-feeding the fences it carried drops only what NO other durable
    /// source (another standing record, or a legacy per-identity tombstone
    /// file) still carries.
    fn gc_pane_close_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        key: &str,
        now_ms: i64,
        snapshot_refs: Option<&crate::tabs_persist::RetainedSnapshotReferences>,
        report: &mut BootScanReport,
    ) {
        let Some(record) = index.close_envelopes.get(key).cloned() else {
            return; // consumed/removed since the snapshot — no longer qualifies
        };
        let newest = record
            .kills
            .iter()
            .map(|k| k.at_ms)
            .max()
            .unwrap_or(record.closed_at)
            .max(record.closed_at);
        if now_ms - newest < KILL_TOMBSTONE_TTL_MS {
            return;
        }
        // Delta-r6-r4 (focused-episode-6 round 3, Finding 2) — REFERENCE-TIME
        // retention (the alias-tombstones' "lifetime is the referenced row's"
        // discipline, carried to close evidence): a record is prunable only
        // once NO retained snapshot generation can reference its pane
        // identity — by `terminalId`, by `createRequestId`, by a `sessionRef`
        // claim matching one of its kills, or (focused-episode-6 round 4,
        // Finding F3) by a `sessionKeys` rings entry matching one of its
        // kills — the ref-less pre-association payload shape claims its
        // placeholder through nothing else, so its close envelope would
        // otherwise TTL-sweep while the snapshot still stands. Retained
        // generations prune by COUNT caps, never by age, so the pre-fix
        // raw-TTL sweep could delete the only closed verdict while the stale
        // open-pane snapshot still claims it — the exact re-offer the
        // campaign exists to kill. `None` is the UNKNOWN arm (the reference
        // scan failed): never prune on doubt.
        //
        // Focused-episode-7 round 4 (Finding F1): the reference check
        // consults the record's WHOLE carried linkage, not only its top-level
        // fields. A batch close (`pane-detach-batch:<tabId>`) stores every
        // pane identity in `panes` and leaves the top-level `terminal_id` /
        // `create_request_id` None — pre-fix this check was blind to them, so
        // a snapshot-only batch close (no binding row: a plain shell or
        // pre-association pane) pruned past the TTL while a retained
        // generation still referenced its pane, and recovery re-offered the
        // deliberately closed pane. The ROW-side keep below already consults
        // the full carried linkage ([`detach_linkages`]); this arm now does
        // too. Kill-record behavior is untouched: a kill envelope's snapshot
        // linkage is its top-level fields (its `panes` stays empty).
        let referenced = match snapshot_refs {
            None => true,
            Some(refs) => {
                record
                    .terminal_id
                    .as_deref()
                    .is_some_and(|t| refs.terminal_ids.contains(t))
                    || record
                        .create_request_id
                        .as_deref()
                        .is_some_and(|c| refs.create_request_ids.contains(c))
                    || record.panes.iter().any(|linkage| {
                        (!linkage.create_request_id.is_empty()
                            && refs
                                .create_request_ids
                                .contains(linkage.create_request_id.as_str()))
                            || linkage
                                .terminal_id
                                .as_deref()
                                .is_some_and(|t| refs.terminal_ids.contains(t))
                    })
                    || record.kills.iter().any(|k| {
                        refs.claims
                            .contains(&(k.provider.clone(), k.session_id.clone()))
                    })
                    || record.kills.iter().any(|k| {
                        refs.session_keys
                            .contains(&(k.provider.clone(), k.session_id.clone()))
                    })
            }
        };
        if referenced {
            return;
        }
        // Delta-round-7 (Finding F2) — the LEDGER side of reference-time
        // retention: the DETACH close family (`pane-detach:<crid>`,
        // non-retiring, empty kills) exists to cover the row the closed pane
        // created, and the finding's own shape gives it NO snapshot reference
        // (the pane was created AND closed inside the push cadence, so no
        // retained generation ever carries it) and no fences (empty kills —
        // the record is not what makes anything read closed; the row join
        // is). So the record lives while a binding row still carries its
        // createRequestId — the same dominance-keep principle ("a close's
        // evidence plus an unconverged row outlive the TTL") the fence side
        // already applies below. Once the row leaves the ledger (its own GC
        // lifecycle), this keep lapses and the aged record prunes.
        //
        // Focused-episode-7 round 3 (Finding F3) — the keep is judged by the
        // ONE SHARED coverage predicate ([`close_record_covers_row`]), never
        // a re-implemented snapshot of it: pre-fix this consult demanded raw
        // `create_request_id` equality while the recovery verdict ALSO joins
        // the row's ORIGIN lineage key and the lineage-less terminal arm, so
        // a lineage-only in-flight close record pruned past the 6h TTL while
        // its bound row lived on for up to 30 days — the supposedly closed
        // session returned to the offer. The record's OWN carried linkage
        // (crid set; terminal ids only for the detach family — a kill
        // record's terminal id covers PANES, never rows) is the coverage
        // answer the inventory computes wholesale, applied per record here.
        let linkages = detach_linkages(&record);
        let record_crids: Vec<&str> = linkages
            .iter()
            .map(|l| l.create_request_id.as_str())
            .collect();
        let detach_terminal_ids: Vec<&str> = if PaneLedger::is_detach_close_key(key) {
            linkages
                .iter()
                .filter_map(|l| l.terminal_id.as_deref())
                .collect()
        } else {
            Vec::new()
        };
        let row_covered = index.bindings.values().any(|row| {
            close_record_covers_row(row, &|id: &str| record_crids.contains(&id), &|id: &str| {
                detach_terminal_ids.contains(&id)
            })
        });
        if row_covered {
            return;
        }
        // Dominance has no TTL (focused-ep5-r3 Finding 4, carried to the
        // journal record): a fence this record feeds that still DOMINATES a
        // Bound row is unconverged close evidence — the record stays until
        // the row's projection converges (the sweep retires it durably,
        // then a later pass prunes the settled record).
        let still_dominant = record.kills.iter().any(|k| {
            let ikey = (k.provider.clone(), k.session_id.clone());
            let row_view = index.bindings.get(&ikey).map(|r| (r.state, r.updated_at));
            // The fence stamp readers see (max across sources) governs.
            let stamp = index.kill_tombstones.get(&ikey).copied().unwrap_or(k.at_ms);
            classify_kill_tombstone(stamp, row_view, now_ms) == KillTombstoneVerdict::Dominant
        });
        if still_dominant {
            return;
        }
        let mut paths = vec![PaneLedger::close_envelope_path(root, key)];
        if let Some(terminal_id) = &record.terminal_id {
            paths.push(PaneLedger::pane_close_path(root, terminal_id));
        }
        let mut first_err: Option<std::io::Error> = None;
        for path in &paths {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => {
                    if first_err.is_none() {
                        first_err = Some(err);
                    }
                }
            }
        }
        match first_err {
            None => {
                index.close_envelopes.remove(key);
                // Un-feed the fences this record carried — but only where no
                // OTHER durable source stands: another record fencing the
                // same identity, or a legacy per-identity tombstone file.
                for kill in &record.kills {
                    let ikey = (kill.provider.clone(), kill.session_id.clone());
                    if index.legacy_tombstone_keys.contains(&ikey) {
                        continue;
                    }
                    let still_fenced = index.close_envelopes.values().any(|other| {
                        other
                            .kills
                            .iter()
                            .any(|k| k.provider == kill.provider && k.session_id == kill.session_id)
                    });
                    if !still_fenced {
                        index.kill_tombstones.remove(&ikey);
                    }
                }
                tracing::info!(
                    target: "freshell_ws::pane_ledger",
                    key = %key,
                    "pane_ledger_pane_close_swept: protective TTL elapsed"
                );
                report.pane_closes_swept.push(key.to_string());
            }
            Some(err) => {
                tracing::warn!(
                    target: "freshell_ws::pane_ledger",
                    key = %key,
                    error = %err,
                    "pane_ledger_pane_close_sweep_failed: file left behind; will retry next pass"
                );
            }
        }
    }

    /// Expiry sweep for ONE kill tombstone, under the caller's guard
    /// (focused-ep5-r1 Finding 2): the TTL bounds the tombstone's protective
    /// lifetime — its live purpose is the in-flight orphan window around
    /// the kill (milli-seconds scale), never day-old history; and a stale
    /// tombstone must not suppress a legitimate bind forever. Re-reads the
    /// index: one cleared/rewritten between the snapshot and this guard
    /// acquisition is re-evaluated against its CURRENT state (a re-kill at a
    /// newer `killed_at_ms` is FRESH and skipped).
    ///
    /// Focused-ep5-r3 Findings 3+4 (retire-on-kill round 4): the sweep is
    /// verdict-keyed, never raw-TTL-keyed — a DOMINANT tombstone (a Bound
    /// row's liveness predates the close) NEVER expires (the TTL prunes
    /// converged pairs, not unconverged crash evidence); a FRESH one is the
    /// live fence. Pruned here: EXPIRED names over missing/Retired rows, and
    /// CLAIM-RESIDUE pairs (an accepted claim's revived row outranks the
    /// tombstone its own clear failed to delete — inert bookkeeping, pruned
    /// at ANY age). The caller's pass is row-then-tombstone ordered: a
    /// dominant pair's row converges FIRST, so the pair prunes only once the
    /// row no longer reads Bound.
    fn gc_kill_tombstone_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        key: &(String, String),
        now_ms: i64,
        report: &mut BootScanReport,
    ) {
        let Some(killed_at) = index.kill_tombstones.get(key).copied() else {
            return; // cleared since the snapshot — no longer qualifies
        };
        // Delta-r6-r4: a fence a standing close-envelope journal record feeds
        // lives and dies WITH its record (the record's retention sweep is the
        // reference-gated one); the fence sweep never outruns it.
        if any_envelope_fences(index, &key.0, &key.1) {
            return;
        }
        let row_view = index.bindings.get(key).map(|r| (r.state, r.updated_at));
        let prunable = matches!(
            classify_kill_tombstone(killed_at, row_view, now_ms),
            KillTombstoneVerdict::Expired | KillTombstoneVerdict::ClaimResidue
        );
        if !prunable {
            return;
        }
        let sref = SessionLocator {
            provider: key.0.clone(),
            session_id: key.1.clone(),
        };
        match Self::clear_kill_fence_locked(root, index, &key.0, &key.1) {
            Ok(()) => {
                tracing::info!(
                    target: "freshell_ws::pane_ledger",
                    provider = %sref.provider,
                    session_id = %sref.session_id,
                    killed_at_ms = killed_at,
                    "pane_ledger_kill_tombstone_swept: protective TTL elapsed"
                );
                report.kill_tombstones_swept.push(sref);
            }
            Err(err) => {
                // Fail loud, never silent: the tombstone stays; the next GC
                // pass retries naturally.
                tracing::warn!(
                    target: "freshell_ws::pane_ledger",
                    provider = %sref.provider,
                    session_id = %sref.session_id,
                    error = %err,
                    "pane_ledger_kill_tombstone_sweep_failed: file left behind; will retry next pass"
                );
            }
        }
    }

    /// Retention sweep for ONE placeholder's alias records, under the
    /// caller's guard (focused-ep5-r5 Finding 2, retire-on-kill round 6):
    /// the round-5 lifetime rule on durable storage. A record drops only
    /// when its durable row is already Retired-or-GC'd (or never existed)
    /// AND it is past [`ALIAS_TOMBSTONE_TTL_MS`]; a record resolving to a
    /// still-Bound row is kept at ANY age — the alias lifetime is the row
    /// lifetime, so a pane's close by its bare placeholder still resolves
    /// the live row days later. A partial prune REWRITES the file (keeping
    /// the live half); a whole-swept placeholder's file is deleted. Fail
    /// loud per placeholder, never silent — a failed mutation keeps the
    /// file and retries next pass.
    fn gc_alias_tombstone_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        key: &(String, String),
        now_ms: i64,
        report: &mut BootScanReport,
    ) {
        let Some(records) = index.alias_tombstones.get(key).cloned() else {
            return; // consumed since the snapshot — no longer qualifies
        };
        let kept: Vec<(String, i64)> = records
            .iter()
            .filter(|(durable, at_ms)| {
                let row_bound = index
                    .bindings
                    .get(&(key.0.clone(), durable.clone()))
                    .is_some_and(|row| row.state == RowState::Bound);
                row_bound || now_ms - at_ms < ALIAS_TOMBSTONE_TTL_MS
            })
            .cloned()
            .collect();
        if kept.len() == records.len() {
            return;
        }
        let sref = SessionLocator {
            provider: key.0.clone(),
            session_id: key.1.clone(),
        };
        let outcome: std::io::Result<()> = if kept.is_empty() {
            match std::fs::remove_file(Self::alias_tombstone_path(root, &key.0, &key.1)) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e),
            }
        } else {
            let row = AliasTombstoneRecord {
                ledger_version: LEDGER_VERSION,
                provider: key.0.clone(),
                placeholder: key.1.clone(),
                records: kept
                    .iter()
                    .map(|(d, at)| AliasTombstoneEntry {
                        durable: d.clone(),
                        at_ms: *at,
                    })
                    .collect(),
            };
            write_row_atomic(&Self::alias_tombstone_path(root, &key.0, &key.1), &row)
        };
        match outcome {
            Ok(()) => {
                if kept.is_empty() {
                    index.alias_tombstones.remove(key);
                } else {
                    index.alias_tombstones.insert(key.clone(), kept);
                }
                tracing::info!(
                    target: "freshell_ws::pane_ledger",
                    provider = %sref.provider,
                    placeholder = %sref.session_id,
                    "pane_ledger_alias_tombstone_swept: records dropped whose rows are Retired-or-GC'd past the TTL"
                );
                report.alias_tombstones_swept.push(sref);
            }
            Err(err) => {
                // Fail loud, never silent: the file stays; the next GC pass
                // retries naturally.
                tracing::warn!(
                    target: "freshell_ws::pane_ledger",
                    provider = %sref.provider,
                    placeholder = %sref.session_id,
                    error = %err,
                    "pane_ledger_alias_tombstone_sweep_failed: file left behind; will retry next pass"
                );
            }
        }
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
    ///
    /// Focused-ep5-r2 Finding 1 (retire-on-kill round 3): the kill-tombstone
    /// dominance rule's DURABLE convergence lives here (boot scan AND the
    /// periodic pass share this helper): a Bound row whose identity carries a
    /// DOMINANT kill tombstone ([`classify_kill_tombstone`] — the close is as
    /// new as or newer than the row's own liveness stamp) is the split-write
    /// crash remnant (`retire_closed`'s tombstone landed; its row retire
    /// never did) — the tombstone is the author of truth, so the row is
    /// retired Closed NOW, durably. Focused-ep5-r3 Finding 4: dominance has
    /// NO TTL — a tombstone paired with a still-Bound row is the only durable
    /// evidence of the close, and a restart hours past the TTL must still
    /// converge it (the TTL only ever prunes converged/missing-row pairs).
    /// A CLAIM-RESIDUE pair (the row's liveness visibly postdates the
    /// tombstone) is deliberately NOT dominated: that row is an accepted
    /// claim's committed revive whose clear crashed mid-commit, and retiring
    /// it would undo the claim the crash froze half-way. The re-read
    /// discipline covers the live claim-lane interleaving identically: under
    /// THIS guard instant tombstone and row are evaluated together, so a
    /// claim that already cleared the fence misses the check, and a claim
    /// that lands after simply commits.
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
                let dominant = index
                    .kill_tombstones
                    .get(key)
                    .copied()
                    .is_some_and(|killed_at| {
                        classify_kill_tombstone(
                            killed_at,
                            Some((row.state, row.updated_at)),
                            now_ms,
                        ) == KillTombstoneVerdict::Dominant
                    });
                if dominant {
                    let killed_at = index.kill_tombstones.get(key).copied().unwrap_or_default();
                    row.state = RowState::Retired;
                    row.retired_reason = Some(RetiredReason::Closed);
                    row.updated_at = now_ms;
                    match self.write_binding(root, index, &row) {
                        Ok(()) => {
                            tracing::info!(
                                target: "freshell_ws::pane_ledger",
                                provider = %sref.provider,
                                session_id = %sref.session_id,
                                killed_at_ms = killed_at,
                                "pane_ledger_kill_tombstone_dominates_row: re-applied the \
                                 retirement the split-write crash window lost"
                            );
                            report.kill_tombstone_enforced_retires.push(sref);
                        }
                        Err(err) => {
                            // Fail loud, never silent: the row stays
                            // Bound on disk; the next sweep retries.
                            tracing::error!(
                                target: "freshell_ws::pane_ledger",
                                provider = %sref.provider,
                                session_id = %sref.session_id,
                                error = %err,
                                "pane_ledger_kill_tombstone_dominance_failed: retire write failed; row left bound"
                            );
                        }
                    }
                    return;
                }
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
        // Focused-ep5-r1 Finding 2: the kill-tombstone subtree participates
        // in per-row quarantine (typed rows, version-gated like bindings).
        if let Ok(providers) = std::fs::read_dir(Self::kill_tombstone_dir(root)) {
            for provider in providers.flatten() {
                if let Ok(files) = std::fs::read_dir(provider.path()) {
                    candidates.extend(files.flatten().map(|f| f.path()));
                }
            }
        }
        // Focused-ep5-r5 Finding 2: the alias-tombstone subtree participates
        // the same way (typed rows, version-gated).
        if let Ok(providers) = std::fs::read_dir(Self::alias_tombstone_dir(root)) {
            for provider in providers.flatten() {
                if let Ok(files) = std::fs::read_dir(provider.path()) {
                    candidates.extend(files.flatten().map(|f| f.path()));
                }
            }
        }
        // Delta-r6-r2 / delta-r6-r4: BOTH close-record subtrees participate
        // the same way (typed rows, version-gated) — the legacy
        // `close-records/` pane records and the close-envelope journal files.
        if let Ok(files) = std::fs::read_dir(Self::pane_close_dir(root)) {
            candidates.extend(files.flatten().map(|f| f.path()));
        }
        if let Ok(files) = std::fs::read_dir(Self::close_envelope_dir(root)) {
            candidates.extend(files.flatten().map(|f| f.path()));
        }
        let rollback_root = Self::rollback_dir(root);
        let kill_tombstone_root = Self::kill_tombstone_dir(root);
        let alias_tombstone_root = Self::alias_tombstone_dir(root);
        let pane_close_root = Self::pane_close_dir(root);
        let close_envelope_root = Self::close_envelope_dir(root);
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
                        let is_kill_tombstone = path.starts_with(&kill_tombstone_root);
                        let is_alias_tombstone = path.starts_with(&alias_tombstone_root);
                        let is_pane_close = path.starts_with(&pane_close_root);
                        let is_close_envelope = path.starts_with(&close_envelope_root);
                        let typed_ok = if is_pending {
                            serde_json::from_value::<PendingMarker>(value).is_ok()
                        } else if is_kill_tombstone {
                            serde_json::from_value::<KillTombstone>(value).is_ok()
                        } else if is_alias_tombstone {
                            serde_json::from_value::<AliasTombstoneRecord>(value).is_ok()
                        } else if is_pane_close {
                            serde_json::from_value::<PaneCloseRecord>(value).is_ok()
                        } else if is_close_envelope {
                            serde_json::from_value::<CloseEnvelopeRecord>(value).is_ok()
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
