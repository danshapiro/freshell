//! Server-side implementation of the fresh-agent identity bridge (P1.13):
//! freshell-freshagent cannot see the ledger (crate cycle), so main.rs
//! injects this adapter at wiring time.

use freshell_freshagent::{
    BindProvenance, FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink, RollbackRecord,
    SinkWrite,
};
use freshell_ws::pane_ledger::{FreshAgentBindingWrite, PaneLedger};
use std::sync::Arc;

pub struct LedgerIdentitySink {
    ledger: Arc<PaneLedger>,
}

impl LedgerIdentitySink {
    pub fn new(ledger: Arc<PaneLedger>) -> Self {
        Self { ledger }
    }
}

fn now_ms() -> i64 {
    // Match the timestamp convention main.rs already uses for ledger writes
    // (see the boot-scan / record_binding call sites in main.rs).
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl PaneIdentitySink for LedgerIdentitySink {
    // Writes are AWAITED spawn_blocking (durable-before-answer, V8/A11) —
    // exactly the shape terminal.rs:1589 already ships. Timestamps are taken
    // at EVENT time (before the hop), so `updated_at` reflects event order
    // (V8's out-of-order aggravator).
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, m, c) = (
            placeholder_id.to_string(),
            mode.to_string(),
            cwd.map(str::to_string),
        );
        let now = now_ms();
        Box::pin(async move {
            // Delta-r3 Finding 2: fresh-agent markers carry NO spawn-time
            // provenance. Their identity resolves through
            // `record_fresh_agent_binding` + `delete_pending(resolves_pending)`
            // (the upsert's own tri-state provenance, parked from the create)
            // — never through `resolve_pending`, whose marker-stamp sourcing
            // exists for the terminal-lineage locator/candidate lanes. Stamps
            // here would be dead data.
            tokio::task::spawn_blocking(move || {
                ledger.record_pending(
                    &p,
                    &m,
                    c.as_deref(),
                    freshell_ws::pane_ledger::ProvenanceStamps::default(),
                    now,
                )
            })
            .await
            .map_err(std::io::Error::other)? // JoinError (incl. closure panic) surfaces as Err
        })
    }

    fn record_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite {
        let ledger = self.ledger.clone();
        let now = now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                // Delta-r2 Finding 2: the upsert's tri-state provenance policy
                // maps verbatim onto the ledger's own tri-state; the merge
                // (Replace per-field / Inherit keep / Clear erase) lives in
                // the ledger itself.
                let provenance = match &upsert.provenance {
                    freshell_freshagent::ProvenanceUpdate::Replace(stamps) => {
                        // Focused-ep4-r2 Findings 1+2: the assertion time
                        // rides the value across the crate boundary — the
                        // ledger records `asserted_at` (captured at WS message
                        // receipt), never this write's own `now_ms`.
                        freshell_ws::pane_ledger::ProvenancePolicy::Replace(
                            freshell_ws::pane_ledger::ProvenanceStamps {
                                client_instance_id: stamps.client_instance_id.as_deref(),
                                device_id: stamps.device_id.as_deref(),
                                tab_key: stamps.tab_key.as_deref(),
                                asserted_at: stamps.asserted_at,
                            },
                        )
                    }
                    freshell_freshagent::ProvenanceUpdate::Inherit => {
                        freshell_ws::pane_ledger::ProvenancePolicy::Inherit
                    }
                    freshell_freshagent::ProvenanceUpdate::Clear => {
                        freshell_ws::pane_ledger::ProvenancePolicy::Clear
                    }
                };
                let w = FreshAgentBindingWrite {
                    provider: &upsert.provider,
                    session_id: &upsert.session_id,
                    mode: &upsert.mode,
                    cwd: upsert.settings.cwd.as_deref(),
                    create_request_id: upsert.create_request_id.as_deref(),
                    model: upsert.settings.model.as_deref(),
                    sandbox: upsert.settings.sandbox.as_deref(),
                    permission_mode: upsert.settings.permission_mode.as_deref(),
                    effort: upsert.settings.effort.as_deref(),
                    supersedes: upsert.supersedes.as_deref(),
                    provenance,
                    now_ms: now,
                };
                ledger.record_fresh_agent_binding(&w)?; // binding-write failure propagates
                // kata 1wxv Task 4 (r1 discipline): on the CLAUDE fork-adoption
                // leg (`supersedes` = the pre-rollback durable id) the rollback
                // row re-keys old→new inside the SAME awaited batch as the
                // binding write — so the record follows the pane atomically and
                // the handler's pre-fork write stays the ONLY
                // rollback-record-specific write. Scoped to provider "claude":
                // codex's crash-respawn supersession must NOT move a marker
                // bucket onto a memory-less mint-new thread.
                if upsert.provider == "claude" {
                    if let Some(old_id) = upsert.supersedes.as_deref() {
                        if old_id != upsert.session_id {
                            if let Some(payload) =
                                ledger.load_rollback_row(&upsert.provider, old_id)
                            {
                                ledger.record_rollback_row(
                                    &upsert.provider,
                                    &upsert.session_id,
                                    &payload,
                                    now,
                                )?;
                                // Cosmetic on failure (a stale old-row is
                                // unreachable through the new id) — warn, do not
                                // fail the identity event (the delete_pending
                                // precedent below).
                                if let Err(e) =
                                    ledger.delete_rollback_row(&upsert.provider, old_id)
                                {
                                    tracing::warn!(error = %e, session = %old_id, "pane_ledger.claude_adoption.rollback_old_row_delete_failed");
                                }
                            }
                            // Missing old row: silent no-op.
                        }
                    }
                }
                if let Some(p) = upsert.resolves_pending.as_deref() {
                    // Cosmetic on failure: an orphaned marker is TTL-swept at 30d
                    // (V6/A15) — warn, do not fail the identity event over it.
                    if let Err(e) = ledger.delete_pending(p) {
                        tracing::warn!(error = %e, placeholder = %p, "pane_ledger.fresh_agent.pending_delete_failed");
                    }
                }
                Ok(())
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }

    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings> {
        // Reads are memory-only against the write-through index — safe inline.
        let row = self.ledger.load_binding(provider, session_id)?;
        // Terminal-lineage rows (wave-A codex_candidate etc.) are NOT resume
        // records — only fresh-agent rows serve settings (V7/A10 gating).
        if row.pane_kind.as_deref() != Some("fresh-agent") {
            return None;
        }
        let s = FreshAgentSettings {
            model: row.model,
            sandbox: row.sandbox,
            permission_mode: row.permission_mode,
            effort: row.effort,
            cwd: row.cwd,
        };
        // A fully blank snapshot (a lineage-only row, Task 3) is "nothing
        // recoverable". Under the Task 3 `was_recorded` rekeying such a row
        // answers was_recorded()==false, so the V7/A10 SETTINGS_RESET alarm
        // (was_recorded()==true while load_settings returns None) never arms
        // for it — the genuine recorded-but-unrecoverable anomaly is exactly
        // what remains alarm-positive.
        if s == FreshAgentSettings::default() {
            return None;
        }
        Some(s)
    }

    fn load_provenance(&self, provider: &str, session_id: &str) -> Option<BindProvenance> {
        // Focused-ep1-r4 Finding 2: the row's CURRENT stamps, memory-only via
        // the same write-through read + fresh-agent gate as `load_settings`
        // (terminal-lineage rows are not resume records). Unlike
        // `load_settings` this is settings-INDEPENDENT — a stamped row answers
        // even when its settings snapshot is blank (lineage-only): provenance
        // lives on the row, not on the settings columns. An all-`None` answer
        // is reported as absence (never `Some(default)`).
        let row = self.ledger.load_binding(provider, session_id)?;
        if row.pane_kind.as_deref() != Some("fresh-agent") {
            return None;
        }
        let p = BindProvenance {
            client_instance_id: row.client_instance_id,
            device_id: row.device_id,
            tab_key: row.tab_key,
            // Focused-ep4-r2 Findings 1+2: the row read re-arms the value with
            // its row-recorded assertion time so a re-parked/fork-resolved
            // value keeps the ROW's attribution (`last_attributed_at`;
            // `created_at` only when the field is absent — defensive coverage
            // for intermediate-branch-build rows, since the D8 judgment
            // (focused-ep4-r4 Finding 1) has no `created_at` fallback and
            // never offers such a row as-is), never this read's wall clock.
            asserted_at: row.last_attributed_at.unwrap_or(row.created_at),
        };
        // An all-`None` STAMPS answer is information-free — never returned as
        // `Some(..)` (the check is stamp-fields only: the asserted_at fallback
        // above is nonzero for any real row and must not synthesize
        // provenance out of an unstamped one).
        (p.client_instance_id.is_some() || p.device_id.is_some() || p.tab_key.is_some())
            .then_some(p)
    }

    fn was_recorded(&self, provider: &str, session_id: &str) -> bool {
        // Task 3 rekeying: "recorded" now means a SETTINGS-BEARING fresh-agent
        // row (the ledger predicate `fresh_agent_settings_recorded`), NOT just
        // any fresh-agent row — lineage-only rows (all-blank settings, written
        // unconditionally at materialization so create-requestId lineage
        // survives) must not arm the SETTINGS_RESET gate. State-agnostic as
        // before (`load_binding` serves Retired/GcExpired rows too, V6/A9).
        // Schema-compatible, no migration: historical blank rows flip to false
        // (forward-looking tradeoff, accepted by the campaign plan).
        self.ledger
            .fresh_agent_settings_recorded(provider, session_id)
    }

    fn lookup_by_create_request_id(
        &self,
        provider: &str,
        create_request_id: &str,
    ) -> Option<String> {
        // Memory-only delegation (the ledger's Bound-or-GcExpired,
        // newest-by-updated_at rule) — usable inline from the REST resume path.
        self.ledger
            .lookup_by_create_request_id(provider, create_request_id)
            .map(|row| row.session_id)
    }

    /// Retire-on-kill (delta-review round 5, restore-open-sessions-only): the
    /// kill handlers' awaited retire batch — the same awaited-spawn_blocking
    /// discipline as `record_binding`. Best-effort like every non-rollback
    /// lane: the caller warn-logs `Err`, never block the kill.
    fn retire_closed(&self, provider: &str, session_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        let now = now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.retire_closed(&p, &s, now))
                .await
                .map_err(std::io::Error::other)?
        })
    }

    /// The PENDING companion of [`Self::retire_closed`]: delete the pending
    /// marker. Same awaited-write discipline; a missing marker is `Ok` (the
    /// ledger's own idempotence).
    fn delete_pending(&self, placeholder_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let p = placeholder_id.to_string();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.delete_pending(&p))
                .await
                .map_err(std::io::Error::other)?
        })
    }

    /// The tombstone lifecycle transition (focused-ep5-r1 Finding 2): a
    /// genuine claim (explicit resume/attach) clears the kill tombstone so
    /// the claim's own binding write is never suppressed. Same
    /// awaited-spawn_blocking discipline as `retire_closed`; a missing
    /// tombstone is the ledger's own `Ok` idempotence.
    fn clear_kill_tombstone(&self, provider: &str, session_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.clear_kill_tombstone(&p, &s))
                .await
                .map_err(std::io::Error::other)?
        })
    }

    /// kata 1wxv: await the rollback-record row write BEFORE the provider
    /// mutation runs (durable-BEFORE-mutation; a pre-write failure refuses
    /// the rollback with `LEDGER_WRITE_REFUSAL_COPY`).
    fn record_rollback(
        &self,
        provider: &str,
        session_id: &str,
        record: RollbackRecord,
    ) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        let now = now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let payload = serde_json::to_value(&record).map_err(std::io::Error::other)?;
                ledger.record_rollback_row(&p, &s, &payload, now)
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }

    fn load_rollback(&self, provider: &str, session_id: &str) -> Option<RollbackRecord> {
        // Reads are memory-only against the write-through index — safe inline.
        // The ledger is payload-opaque; `RollbackRecord::from_stored_payload`
        // owns the schema-side concerns (the version gate AND the legacy
        // epochless-union migration — absence-keyed, indifferent to the
        // destroy bit (focused ep1-r1 F3, tightened ep1-r2 F1) — handlers
        // always see the already-migrated record; the disk row is never
        // lazily rewritten).
        let payload = self.ledger.load_rollback_row(provider, session_id)?;
        RollbackRecord::from_stored_payload(payload)
    }

    /// kata 1wxv task 4 review (M3): compensate-by-delete when the pre-op state
    /// was ABSENT — the ledger row is deleted outright (never a fabricated
    /// empty record). Same awaited-write discipline as `record_rollback`.
    fn delete_rollback(&self, provider: &str, session_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.delete_rollback_row(&p, &s))
                .await
                .map_err(std::io::Error::other)?
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_freshagent::{FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink};
    use std::sync::Arc;

    #[tokio::test(flavor = "multi_thread")]
    async fn writes_through_to_ledger_and_reads_back() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone());
        sink.record_binding(FreshAgentBindingUpsert {
            provider: "codex".into(),
            session_id: "t1".into(),
            mode: "freshcodex".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings {
                model: Some("gpt-5.3-codex-spark".into()),
                sandbox: Some("workspace-write".into()),
                permission_mode: Some("on-request".into()),
                effort: None,
                cwd: Some("/w".into()),
            },
        })
        .await
        .expect("awaited write succeeds");
        // Awaited write => durable and readable IMMEDIATELY, no polling.
        let s = sink
            .load_settings("codex", "t1")
            .expect("binding visible after await");
        assert_eq!(s.model.as_deref(), Some("gpt-5.3-codex-spark"));
        assert_eq!(s.sandbox.as_deref(), Some("workspace-write"));
        assert!(sink.was_recorded("codex", "t1"));
        assert!(!sink.was_recorded("codex", "nope"));
        let row = ledger.load_binding("codex", "t1").unwrap();
        assert_eq!(row.pane_kind.as_deref(), Some("fresh-agent"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rollback_record_writes_through_and_reads_back() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger);
        let mut record = freshell_freshagent::RollbackRecord::empty(100);
        record.push_entry(
            freshell_freshagent::RollbackEntry {
                removed_turns: vec![serde_json::json!({"id": "t1", "turnId": "t1"})],
                prompt_text: "second prompt".into(),
                at_ms: 101,
                epoch: 0,
            },
            102,
        );
        sink.record_rollback("codex", "thr-1", record.clone())
            .await
            .expect("awaited write");
        assert_eq!(
            sink.load_rollback("codex", "thr-1"),
            Some(record),
            "awaited write => readable immediately"
        );
        // A fresh ledger over the same root sees the row (durable, not just memory):
        let ledger2 = freshell_ws::pane_ledger::PaneLedger::new(Some(tmp.path().to_path_buf()));
        assert!(
            ledger2.load_rollback_row("codex", "thr-1").is_some(),
            "boot scan indexes rollback rows"
        );
    }

    /// kata 1wxv delta-r1 F4 (disabled-mode honesty): over a DISABLED ledger the
    /// rollback write propagates Err — never a false "durable" `Ok` that would
    /// authorize a destructive provider rollback with no surviving record. Every
    /// OTHER write lane keeps its existing silent-degrade policy (identity events
    /// must never hard-fail a disabled store).
    #[tokio::test(flavor = "multi_thread")]
    async fn rollback_record_write_over_a_disabled_ledger_reports_the_failure() {
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled());
        let sink = LedgerIdentitySink::new(ledger);
        let mut record = freshell_freshagent::RollbackRecord::empty(100);
        record.push_entry(
            freshell_freshagent::RollbackEntry {
                removed_turns: vec![serde_json::json!({"id": "t1", "turnId": "t1"})],
                prompt_text: "p".into(),
                at_ms: 101,
                epoch: 0,
            },
            102,
        );
        let err = sink
            .record_rollback("codex", "thr-x", record)
            .await
            .expect_err("a disabled ledger propagates the rollback-write failure");
        assert!(
            err.to_string().contains("DISABLED"),
            "the propagated error names the disabled mode: {err}"
        );
        assert!(
            sink.load_rollback("codex", "thr-x").is_none(),
            "nothing was recorded anywhere"
        );
        // The identity lanes keep their silent-degrade policy on a disabled store.
        sink.record_binding(FreshAgentBindingUpsert {
            provider: "claude".into(),
            session_id: "s".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("binding writes keep their existing disabled-ledger policy");
    }

    /// kata 1wxv Task 4 (r1 discipline): the claude fork-adoption's binding write
    /// (`supersedes` = pre-rollback id) re-keys the rollback row old→new inside the
    /// SAME awaited batch — the record follows the pane atomically and the old id
    /// holds nothing. Scoped to provider "claude": a CODEX supersession (the
    /// crash-respawn mint-new path) leaves the old thread's rollback row untouched.
    #[tokio::test(flavor = "multi_thread")]
    async fn claude_supersession_binding_rekeys_the_rollback_row_codex_does_not() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone());
        let mut record = freshell_freshagent::RollbackRecord::empty(100);
        record.original_session_id = Some("orig".into());
        record.original_tip_uuid = Some("a2".into());
        record.set_can_redo(true, 101);
        sink.record_rollback("claude", "old-uuid", record.clone())
            .await
            .expect("seed write");
        sink.record_rollback("codex", "old-thread", record.clone())
            .await
            .expect("seed write (codex)");

        let settings = FreshAgentSettings {
            model: None,
            sandbox: None,
            permission_mode: None,
            effort: None,
            cwd: Some("/w".into()),
        };
        sink.record_binding(FreshAgentBindingUpsert {
            provider: "claude".into(),
            session_id: "fork-new-uuid".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: Some("old-uuid".into()),
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            settings: settings.clone(),
        })
        .await
        .expect("claude adoption binding write");
        assert_eq!(
            sink.load_rollback("claude", "fork-new-uuid"),
            Some(record.clone()),
            "the record followed the pane (same awaited batch)"
        );
        assert!(
            sink.load_rollback("claude", "old-uuid").is_none(),
            "the re-key MOVED the row — the superseded id describes rollback state no longer"
        );

        sink.record_binding(FreshAgentBindingUpsert {
            provider: "codex".into(),
            session_id: "new-thread".into(),
            mode: "freshcodex".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: Some("old-thread".into()),
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            settings,
        })
        .await
        .expect("codex crash-respawn binding write");
        assert!(
            sink.load_rollback("codex", "new-thread").is_none(),
            "codex supersession NEVER moves markers onto a memory-less mint-new thread"
        );
        assert!(
            sink.load_rollback("codex", "old-thread").is_some(),
            "the codex old-thread row stays put"
        );
    }

    /// Focused-review ep1-r1 F3: a PERSISTED pre-F8 record whose entries lack
    /// the epoch fields and whose `redoDestroyed` bit is set (a legacy record
    /// with a destroy mid-history — the undo → … → send durable shapes the
    /// reviewed base wrote) loads through the sink ALREADY migrated in memory:
    /// every legacy entry frozen, `current_epoch` bumped beyond (the frozen
    /// boundary is `entries.len()`), the destroyed bit honored as-is. The disk
    /// row is NEVER lazily rewritten — only the next op's write persists the
    /// migrated shape.
    #[tokio::test(flavor = "multi_thread")]
    async fn legacy_destroyed_epochless_record_loads_migrated_and_the_row_stays_lazy() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone());
        // The exact bytes a pre-F8 server wrote (no epoch fields anywhere).
        let legacy_payload = serde_json::json!({
            "version": 1,
            "lastOpAtMs": 70,
            "redoDestroyed": true,
            "canRedo": false,
            "entries": [
                { "removedTurns": [{ "id": "t1", "turnId": "t1", "role": "user" }], "promptText": "p1", "atMs": 40 },
                { "removedTurns": [{ "id": "t2", "turnId": "t2", "role": "user" }], "promptText": "p2", "atMs": 50 },
            ],
        });
        ledger
            .record_rollback_row("codex", "thr-legacy", &legacy_payload, 70)
            .expect("row write ok");

        let loaded = sink
            .load_rollback("codex", "thr-legacy")
            .expect("the row parses at the current version");
        assert!(loaded.redo_destroyed, "the destroyed bit is honored as-is");
        assert!(
            loaded
                .entries
                .iter()
                .all(|e| e.epoch < loaded.current_epoch),
            "every legacy entry FROZEN — frozen markers must never regain \
             'Redo to here' from the epoch-0 alias: {loaded:?}"
        );
        assert!(
            loaded.current_epoch > 0,
            "the counter bumped beyond the frozen prefix: {loaded:?}"
        );

        // Never lazily rewritten: the STORED row stays byte-shape legacy.
        let stored = ledger
            .load_rollback_row("codex", "thr-legacy")
            .expect("row still stored");
        assert_eq!(stored, legacy_payload, "no lazy rewrite on load");
        assert!(stored.get("currentEpoch").is_none());
        assert!(
            stored["entries"]
                .as_array()
                .expect("entries")
                .iter()
                .all(|e| e.get("epoch").is_none()),
            "the on-disk row keeps its epoch-free legacy shape until an op writes"
        );

        // The next op's write persists the migrated shape (handler discipline:
        // record the record the handler ACTUALLY evolved).
        let mut next = loaded.clone();
        next.redo_destroyed = false;
        next.begin_new_epoch();
        sink.record_rollback("codex", "thr-legacy", next)
            .await
            .expect("op write ok");
        let stored = ledger
            .load_rollback_row("codex", "thr-legacy")
            .expect("row still stored");
        assert!(
            stored.get("currentEpoch").is_some()
                && stored["entries"]
                    .as_array()
                    .expect("entries")
                    .iter()
                    .all(|e| e.get("epoch").is_some()),
            "the next op's write persists the epoch-stamped shape"
        );
    }

    /// Version gate on the durable read path: a stored row whose version does
    /// not match `ROLLBACK_RECORD_VERSION` deserializes to absent, never to a
    /// reinterpreted stale shape (the gate is the schema-eviction contract the
    /// handlers across restarts depend on).
    #[tokio::test(flavor = "multi_thread")]
    async fn rollback_record_version_gate_reads_none() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone());
        let mut tampered = freshell_freshagent::RollbackRecord::empty(100);
        tampered.version = 0;
        let payload = serde_json::to_value(&tampered).expect("serialize");
        ledger
            .record_rollback_row("codex", "thr-v0", &payload, 100)
            .expect("row write ok");
        assert_eq!(
            sink.load_rollback("codex", "thr-v0"),
            None,
            "version-mismatched durable row reads as absent"
        );
    }

    /// D8 (restore-open-sessions-only): the adapter must carry the upsert's
    /// provenance through to the ledger row — a dropped mapping at this seam
    /// would silently orphan the parent-relative recovery judgment's inputs.
    #[tokio::test(flavor = "multi_thread")]
    async fn record_binding_maps_provenance_into_the_ledger_row() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone());
        sink.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_prov".into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Replace(
                freshell_freshagent::BindProvenance {
                    client_instance_id: Some("client-1".into()),
                    device_id: Some("device-1".into()),
                    tab_key: Some("device-1:tab-1".into()),
                    asserted_at: 7_777,
                },
            ),
            settings: FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            },
        })
        .await
        .expect("awaited write succeeds");
        let row = ledger.load_binding("opencode", "ses_prov").expect("row");
        assert_eq!(row.client_instance_id.as_deref(), Some("client-1"));
        assert_eq!(row.device_id.as_deref(), Some("device-1"));
        assert_eq!(row.tab_key.as_deref(), Some("device-1:tab-1"));
    }

    /// Focused-ep4-r2 Findings 1+2 (the seam the WS fresh-agent create lanes
    /// write through): the provenance VALUE carries its assertion time across
    /// the crate boundary — even when the sink's write lands 30s later than
    /// the value's capture (a fresh-agent create whose slow spawn/SDK init
    /// completes after the pane's tab state moved on), the row attributes at
    /// `asserted_at`, never at the write.
    #[tokio::test(flavor = "multi_thread")]
    async fn record_binding_attributes_at_the_values_assertion_time_not_the_writes() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone());
        let asserted = now_ms() - 30_000; // "provenance captured 30s before the write"
        sink.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_late".into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Replace(
                freshell_freshagent::BindProvenance {
                    client_instance_id: Some("client-1".into()),
                    device_id: Some("device-1".into()),
                    tab_key: Some("device-1:tab-1".into()),
                    asserted_at: asserted,
                },
            ),
            settings: FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            },
        })
        .await
        .expect("awaited write succeeds");
        let row = ledger.load_binding("opencode", "ses_late").expect("row");
        assert_eq!(
            row.last_attributed_at,
            Some(asserted),
            "the value's assertion time, not the sink's write clock"
        );
        assert!(
            row.updated_at > asserted,
            "the write itself still lands at write time ({})",
            row.updated_at
        );
    }

    /// Focused-ep1-r4 Finding 2 (the seam the cold-attach seeding reads
    /// through): `load_provenance` over the REAL pane ledger — the row's
    /// stamps round-trip (settings-independently: even a stamped lineage-only
    /// row), a later conn-less (all-`None`/`Inherit`) write keeps them via
    /// the ledger's OWN preserve rule (not a fake mirror), a genuinely
    /// unattributed row answers `None`, and a terminal-pane row (no
    /// `pane_kind`) is gated out exactly like `load_settings`.
    #[tokio::test(flavor = "multi_thread")]
    async fn load_provenance_round_trips_stamps_through_the_real_ledger_merge() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone());
        assert!(
            sink.load_provenance("opencode", "nope").is_none(),
            "no row -> None"
        );

        // A stamped LINEAGE-ONLY row (blank settings) answers its stamps.
        sink.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_prov".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-x".into()),
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Replace(
                freshell_freshagent::BindProvenance {
                    client_instance_id: Some("client-1".into()),
                    device_id: Some("device-1".into()),
                    tab_key: Some("device-1:tab-1".into()),
                    asserted_at: 7_777,
                },
            ),
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("awaited write succeeds");
        let p = sink
            .load_provenance("opencode", "ses_prov")
            .expect("the stamped row answers (settings-independent)");
        assert_eq!(p.client_instance_id.as_deref(), Some("client-1"));
        assert_eq!(p.device_id.as_deref(), Some("device-1"));
        assert_eq!(p.tab_key.as_deref(), Some("device-1:tab-1"));

        // A conn-less refresh (all-`None` stamps) keeps them — the REAL
        // ledger's `Inherit` preserve, end to end.
        sink.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_prov".into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("awaited conn-less refresh succeeds");
        let p = sink
            .load_provenance("opencode", "ses_prov")
            .expect("the conn-less preserve kept the stamps");
        assert_eq!(p.client_instance_id.as_deref(), Some("client-1"));

        // A genuinely unattributed row answers None — never Some(default).
        sink.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_unstamped".into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            },
        })
        .await
        .expect("awaited write succeeds");
        assert_eq!(sink.load_provenance("opencode", "ses_unstamped"), None);

        // A terminal-pane row (no `pane_kind`) is NOT a resume record even
        // when stamped — the same gate `load_settings` applies.
        ledger
            .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                provider: "opencode",
                session_id: "ses_terminal",
                mode: "shell",
                terminal_id: "term-1",
                cwd: Some("/w"),
                create_request_id: None,
                provenance: freshell_ws::pane_ledger::ProvenancePolicy::Replace(
                    freshell_ws::pane_ledger::ProvenanceStamps {
                        client_instance_id: Some("client-term"),
                        device_id: Some("device-term"),
                        tab_key: Some("device-term:tab-term"),
                        asserted_at: 7_777,
                    },
                ),
                now_ms: 42,
            })
            .expect("terminal binding write ok");
        assert_eq!(
            sink.load_provenance("opencode", "ses_terminal"),
            None,
            "terminal-lineage rows are gated out (the load_settings gate's twin)"
        );
    }

    /// Delta-r2 Finding 2 (seam test): a freshagent-side `Clear` upsert (the
    /// explicitly-headless REST/MCP lineage lanes) must reach the REAL ledger
    /// as an ERASE — the browser stamps on the row are wiped, `updated_at`
    /// still refreshes, and `created_at` is preserved. Without the mapping a
    /// headless re-bind would keep the browser's attribution under a
    /// refreshed timestamp and launder the row into the D8 offer.
    #[tokio::test(flavor = "multi_thread")]
    async fn provenance_clear_reaches_the_ledger_and_erases_the_stamps() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone());
        let upsert = |provenance: freshell_freshagent::ProvenanceUpdate| FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_clr".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-b".into()),
            resolves_pending: None,
            supersedes: None,
            provenance,
            settings: FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            },
        };
        sink.record_binding(upsert(freshell_freshagent::ProvenanceUpdate::Replace(
            freshell_freshagent::BindProvenance {
                client_instance_id: Some("client-1".into()),
                device_id: Some("device-1".into()),
                tab_key: Some("device-1:tab-1".into()),
                asserted_at: 7_777,
            },
        )))
        .await
        .expect("browser-stamped write succeeds");
        let stamped = ledger.load_binding("opencode", "ses_clr").expect("row");
        assert_eq!(stamped.client_instance_id.as_deref(), Some("client-1"));

        std::thread::sleep(std::time::Duration::from_millis(2)); // distinct updated_at
        sink.record_binding(upsert(freshell_freshagent::ProvenanceUpdate::Clear))
            .await
            .expect("headless Clear rebind succeeds");
        let cleared = ledger.load_binding("opencode", "ses_clr").expect("row");
        assert_eq!(cleared.client_instance_id, None);
        assert_eq!(cleared.device_id, None);
        assert_eq!(cleared.tab_key, None);
        assert_eq!(cleared.created_at, stamped.created_at);
        assert!(
            cleared.updated_at > stamped.updated_at,
            "the row IS rewritten (updated_at refreshes), just unattributed"
        );
        assert_eq!(
            sink.load_provenance("opencode", "ses_clr"),
            None,
            "the cleared row answers no provenance"
        );
    }

    /// resume path (sync, memory-only read).
    #[tokio::test(flavor = "multi_thread")]
    async fn lookup_by_create_request_id_resolves_the_durable_session() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone());
        sink.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_lookup".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-1".into()),
            resolves_pending: Some("freshopencode-cr-1".into()),
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            // Blank settings on purpose: lineage must resolve even for
            // lineage-only rows (settings-bearing-ness is unrelated).
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("awaited write succeeds");

        assert_eq!(
            sink.lookup_by_create_request_id("opencode", "cr-1")
                .as_deref(),
            Some("ses_lookup")
        );
        assert_eq!(
            sink.lookup_by_create_request_id("opencode", "cr-nope"),
            None
        );
        assert_eq!(sink.lookup_by_create_request_id("codex", "cr-1"), None);
    }

    /// Retire-on-kill (delta-review round 5): the WS `freshAgent.kill`
    /// handler body calls `sink.retire_closed` for every durable id the kill
    /// covers; the sink must reach the REAL pane ledger — a Bound row ends
    /// Retired with reason `closed` (durable on disk), an unknown or
    /// already-retired row is an idempotent no-op, and `delete_pending`
    /// removes a live marker (a kill observed before identity resolution must
    /// not leave marker-driven evidence behind).
    #[tokio::test(flavor = "multi_thread")]
    async fn retire_closed_retires_the_row_and_delete_pending_clears_the_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone());
        sink.record_binding(FreshAgentBindingUpsert {
            provider: "claude".into(),
            session_id: "ses-to-kill".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            },
        })
        .await
        .expect("awaited write succeeds");
        sink.record_pending("freshopencode-cr-kill", "freshopencode", Some("/w"))
            .await
            .expect("pending write ok");
        assert!(
            ledger
                .pending_for_terminal("freshopencode-cr-kill")
                .is_some(),
            "marker present before the kill"
        );

        sink.retire_closed("claude", "ses-to-kill")
            .await
            .expect("awaited retire succeeds");
        let row = ledger.load_binding("claude", "ses-to-kill").expect("row");
        assert_eq!(row.state, freshell_ws::pane_ledger::RowState::Retired);
        assert_eq!(
            row.retired_reason,
            Some(freshell_ws::pane_ledger::RetiredReason::Closed)
        );
        // A fresh ledger over the same root sees the retirement (durable, not
        // just memory) — the recovery inventory reads files at boot.
        let ledger2 = freshell_ws::pane_ledger::PaneLedger::new(Some(tmp.path().to_path_buf()));
        assert_eq!(
            ledger2
                .load_binding("claude", "ses-to-kill")
                .expect("row")
                .state,
            freshell_ws::pane_ledger::RowState::Retired,
            "the retirement is durable on disk"
        );

        // Idempotent: an already-retired row re-retires to Ok, and an unknown
        // row retires to Ok (a kill for an evicted session still lands).
        sink.retire_closed("claude", "ses-to-kill")
            .await
            .expect("re-retire is an idempotent no-op");
        sink.retire_closed("claude", "never-existed")
            .await
            .expect("unknown id retires to Ok");

        sink.delete_pending("freshopencode-cr-kill")
            .await
            .expect("awaited marker delete succeeds");
        assert!(
            ledger
                .pending_for_terminal("freshopencode-cr-kill")
                .is_none(),
            "the kill cleared the pending marker"
        );
        sink.delete_pending("never-recorded")
            .await
            .expect("missing marker deletes to Ok");
    }

    /// Focused-ep5-r1 Finding 2 (retire-on-kill round 2) over the REAL ledger,
    /// through the sink seam the providers use: the kill's `retire_closed`
    /// records the durable tombstone; a late in-flight `record_binding` (the
    /// aborted-consumer orphan shape) is SUPPRESSED by it (no row appears —
    /// and this holds under REAL CONCURRENCY: the kill and the write run on
    /// parallel spawn_blocking tasks here, never a synchronous install); and
    /// the genuine-claim `clear_kill_tombstone` reopens the identity so its
    /// binding lands Bound again.
    #[tokio::test(flavor = "multi_thread")]
    async fn kill_tombstone_fences_late_bindings_and_the_genuine_claim_reopens() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone());
        let upsert = |session_id: &str| FreshAgentBindingUpsert {
            provider: "claude".into(),
            session_id: session_id.into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            },
        };

        // Sequential sanity: kill first (no row yet — the finding's shape),
        // the late write suppressed.
        sink.retire_closed("claude", "durable-fence")
            .await
            .expect("retire ok");
        sink.record_binding(upsert("durable-fence"))
            .await
            .expect("write ok");
        assert!(
            ledger.load_binding("claude", "durable-fence").is_none(),
            "the tombstoned identity never gains a Bound row from a late write"
        );

        // The genuine claim reopens: clear, then the write lands Bound.
        sink.clear_kill_tombstone("claude", "durable-fence")
            .await
            .expect("clear ok");
        sink.record_binding(upsert("durable-fence"))
            .await
            .expect("claim write ok");
        let row = ledger
            .load_binding("claude", "durable-fence")
            .expect("the claim's row exists");
        assert_eq!(row.state, freshell_ws::pane_ledger::RowState::Bound);

        // REAL CONCURRENCY: the write and the kill launched together through
        // the sink's own spawn_blocking hop — repeated, both start orders —
        // must converge to not-Bound every time (the ledger's under-lock
        // consult makes ordering the only variable, and both orders are safe).
        for i in 0..32 {
            let session_id = format!("durable-race-{i}");
            // A second sink over the same ledger (the orphan's write path is
            // the same choke point the kill consults).
            let write_sink = LedgerIdentitySink::new(ledger.clone());
            let kill_sink = LedgerIdentitySink::new(ledger.clone());
            let (w, k) = if i % 2 == 0 {
                tokio::join!(
                    write_sink.record_binding(upsert(&session_id)),
                    kill_sink.retire_closed("claude", &session_id)
                )
            } else {
                tokio::join!(
                    kill_sink.retire_closed("claude", &session_id),
                    write_sink.record_binding(upsert(&session_id))
                )
            };
            w.expect("write ok");
            k.expect("retire ok");
            let state = ledger
                .load_binding("claude", &session_id)
                .map(|r| r.state);
            assert!(
                state != Some(freshell_ws::pane_ledger::RowState::Bound),
                "iteration {i}: a killed identity converged to not-Bound, got {state:?}"
            );
        }
    }

    /// Task 3 semantics change (`was_recorded` rekeying): a lineage-only
    /// fresh-agent row (all-blank settings snapshot — the shape the
    /// now-unconditional REST/WS materialization lineage writes produce for a
    /// default create) is NOT a "recorded" session. `was_recorded` keys off
    /// settings-bearing rows so unconditional lineage can never arm a FALSE
    /// SETTINGS_RESET (the `was_recorded == true` + `load_settings == None`
    /// pair) on resume. `load_settings` is unchanged: still None for these rows.
    #[tokio::test(flavor = "multi_thread")]
    async fn lineage_only_row_does_not_count_as_recorded() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone());
        sink.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_lineage".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-9".into()),
            resolves_pending: Some("freshopencode-cr-9".into()),
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("awaited write succeeds");

        let row = ledger
            .load_binding("opencode", "ses_lineage")
            .expect("the lineage row itself IS recorded");
        assert_eq!(row.pane_kind.as_deref(), Some("fresh-agent"));
        assert!(
            sink.load_settings("opencode", "ses_lineage").is_none(),
            "a lineage-only row answers no settings snapshot"
        );
        assert!(
            !sink.was_recorded("opencode", "ses_lineage"),
            "a lineage-only row must not count as recorded (false SETTINGS_RESET)"
        );
    }
}
