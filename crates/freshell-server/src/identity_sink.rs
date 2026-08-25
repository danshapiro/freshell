//! Server-side implementation of the fresh-agent identity bridge (P1.13):
//! freshell-freshagent cannot see the ledger (crate cycle), so main.rs
//! injects this adapter at wiring time.

use freshell_freshagent::{
    FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink, SinkWrite,
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

    /// Task 3: the sink's placeholder→durable lineage lookup delegates to the
    /// ledger's `lookup_by_create_request_id` (Bound or GcExpired, newest by
    /// updated_at) and answers the durable session id — usable from the REST
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
