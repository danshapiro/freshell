//! Server-side implementation of the fresh-agent identity bridge (P1.13):
//! freshell-freshagent cannot see the ledger (crate cycle), so main.rs
//! injects this adapter at wiring time.

use freshell_freshagent::{
    FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink, RollbackRecord, SinkWrite,
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
            tokio::task::spawn_blocking(move || ledger.record_pending(&p, &m, c.as_deref(), now))
                .await
                .map_err(std::io::Error::other)? // JoinError (incl. closure panic) surfaces as Err
        })
    }

    fn record_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite {
        let ledger = self.ledger.clone();
        let now = now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
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
