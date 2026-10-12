//! The pane-ledger identity sink a production server wires into every
//! fresh-agent lane (`freshell-server/src/identity_sink.rs`'s
//! `LedgerIdentitySink`, which `main.rs` installs), mirrored for the ws test
//! crate (which cannot depend on freshell-server): awaited `spawn_blocking`
//! writes and inline memory reads against a REAL `PaneLedger`, so the
//! bindings, closes and claims a lane writes are the production ones. Copied
//! from `freshagent_claude_kill_after_restart.rs`'s `TestLedgerSink`.

use std::sync::Arc;

use freshell_freshagent::{
    ClaimCommit, FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink, RollbackRecord,
    SinkAliasClearWrite, SinkCloseWrite, SinkCommitWrite, SinkWrite,
};
use freshell_ws::pane_ledger::PaneLedger;

/// The ledger-backed identity sink (see the module doc).
pub struct TestLedgerSink {
    pub ledger: Arc<PaneLedger>,
}
impl TestLedgerSink {
    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}
impl PaneIdentitySink for TestLedgerSink {
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, m, c) = (
            placeholder_id.to_string(),
            mode.to_string(),
            cwd.map(str::to_string),
        );
        let now = Self::now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                ledger.record_pending(&p, &m, c.as_deref(), None, Default::default(), now)
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }
    fn record_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite {
        let ledger = self.ledger.clone();
        let now = Self::now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let w = freshell_ws::pane_ledger::FreshAgentBindingWrite {
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
                    provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
                    observed_epoch: None,
                    observed_generation: None,
                    authoritative: upsert.authoritative,
                    now_ms: now,
                };
                ledger.record_fresh_agent_binding(&w)?;
                if let Some(p) = upsert.resolves_pending.as_deref() {
                    let _ = ledger.delete_pending(p);
                }
                Ok(())
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }
    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings> {
        let row = self.ledger.load_binding(provider, session_id)?;
        (row.pane_kind.as_deref() == Some("fresh-agent")).then_some(FreshAgentSettings {
            model: row.model,
            sandbox: row.sandbox,
            permission_mode: row.permission_mode,
            effort: row.effort,
            cwd: row.cwd,
        })
    }
    fn was_recorded(&self, provider: &str, session_id: &str) -> bool {
        self.ledger.load_binding(provider, session_id).is_some()
    }
    fn load_provenance(&self, _: &str, _: &str) -> Option<freshell_freshagent::BindProvenance> {
        None
    }
    fn record_rollback(&self, p: &str, s: &str, record: RollbackRecord) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (p.to_string(), s.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let payload = serde_json::to_value(&record).map_err(std::io::Error::other)?;
                ledger.record_rollback_row(&p, &s, &payload, TestLedgerSink::now_ms())
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }
    fn repair_failed_transition(
        &self,
        provider: &str,
        session_id: &str,
        epoch: u64,
        generation: u64,
    ) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        let now = Self::now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                ledger.repair_failed_transition_binding(&p, &s, epoch, generation, now)
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }
    fn load_rollback(&self, provider: &str, session_id: &str) -> Option<RollbackRecord> {
        let payload = self.ledger.load_rollback_row(provider, session_id)?;
        RollbackRecord::from_stored_payload(payload)
    }
    fn delete_rollback(&self, p: &str, s: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (p.to_string(), s.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.delete_rollback_row(&p, &s))
                .await
                .map_err(std::io::Error::other)?
        })
    }
    fn lookup_by_create_request_id(&self, _: &str, _: &str) -> Option<String> {
        None
    }
    fn retire_closed(&self, provider: &str, session_id: &str) -> SinkCloseWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        Box::pin(async move {
            let result = tokio::task::spawn_blocking(move || {
                ledger.retire_closed(&p, &s, TestLedgerSink::now_ms())
            })
            .await
            .map_err(|join| {
                freshell_freshagent::identity_sink::SinkCloseError::Clean(std::io::Error::other(
                    join,
                ))
            })?;
            result.map_err(|err| match err {
                freshell_ws::pane_ledger::CloseEnvelopeError::Clean(e) => {
                    freshell_freshagent::identity_sink::SinkCloseError::Clean(e)
                }
                freshell_ws::pane_ledger::CloseEnvelopeError::Persisted(e) => {
                    freshell_freshagent::identity_sink::SinkCloseError::Persisted(e)
                }
            })
        })
    }

    /// Delta-r6-r3: the real-ledger delegation mirrors
    /// `freshell-server/src/identity_sink.rs`'s `retire_closed_batch`
    /// (the ledger envelope is the atomicity point; one spawn_blocking hop).
    fn retire_closed_batch(
        &self,
        provider: &str,
        session_ids: &[String],
        pending_ids: &[String],
    ) -> SinkCloseWrite {
        let ledger = self.ledger.clone();
        let p = provider.to_string();
        let ids = session_ids.to_vec();
        let pendings = pending_ids.to_vec();
        Box::pin(async move {
            let result = tokio::task::spawn_blocking(move || {
                ledger.close_identities(&p, &ids, &pendings, TestLedgerSink::now_ms())
            })
            .await
            .map_err(|join| {
                freshell_freshagent::identity_sink::SinkCloseError::Clean(std::io::Error::other(
                    join,
                ))
            })?;
            result.map_err(|err| match err {
                freshell_ws::pane_ledger::CloseEnvelopeError::Clean(e) => {
                    freshell_freshagent::identity_sink::SinkCloseError::Clean(e)
                }
                freshell_ws::pane_ledger::CloseEnvelopeError::Persisted(e) => {
                    freshell_freshagent::identity_sink::SinkCloseError::Persisted(e)
                }
            })
        })
    }
    fn delete_pending(&self, placeholder_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let p = placeholder_id.to_string();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.delete_pending(&p))
                .await
                .map_err(std::io::Error::other)?
        })
    }
    fn clear_kill_tombstone(&self, provider: &str, session_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.clear_kill_tombstone(&p, &s))
                .await
                .map_err(std::io::Error::other)?
        })
    }
    fn kill_tombstone_at_ms(&self, provider: &str, session_id: &str) -> Option<i64> {
        self.ledger.kill_tombstone_at(provider, session_id)
    }
    fn row_is_bound(&self, provider: &str, session_id: &str) -> bool {
        self.ledger.row_is_bound(provider, session_id)
    }
    fn commit_claim(
        &self,
        provider: &str,
        session_id: &str,
        expect_killed_at_ms: Option<i64>,
    ) -> SinkCommitWrite {
        self.commit_claim_aliased(provider, session_id, expect_killed_at_ms, &[])
    }
    fn commit_claim_aliased(
        &self,
        provider: &str,
        session_id: &str,
        expect_killed_at_ms: Option<i64>,
        fence_checked_aliases: &[String],
    ) -> SinkCommitWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        let aliases: Vec<String> = fence_checked_aliases.to_vec();
        Box::pin(async move {
            let outcome = tokio::task::spawn_blocking(move || {
                ledger.commit_claim_aliased(
                    &p,
                    &s,
                    expect_killed_at_ms,
                    &aliases,
                    TestLedgerSink::now_ms(),
                )
            })
            .await
            .map_err(std::io::Error::other)??;
            Ok(match outcome {
                freshell_ws::pane_ledger::ClaimCommitOutcome::Committed => ClaimCommit::Committed,
                freshell_ws::pane_ledger::ClaimCommitOutcome::RefusedStale => {
                    ClaimCommit::RefusedStale
                }
            })
        })
    }
    fn record_alias_tombstone(
        &self,
        provider: &str,
        placeholder: &str,
        durable: &str,
        at_ms: i64,
    ) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, ph, d) = (
            provider.to_string(),
            placeholder.to_string(),
            durable.to_string(),
        );
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.record_alias_tombstone(&p, &ph, &d, at_ms))
                .await
                .map_err(std::io::Error::other)?
        })
    }
    fn alias_tombstone_records(&self, provider: &str, placeholder: &str) -> Vec<(String, i64)> {
        self.ledger.alias_tombstone_records(provider, placeholder)
    }
    fn clear_alias_tombstones_for_durable(
        &self,
        provider: &str,
        durable: &str,
    ) -> SinkAliasClearWrite {
        let ledger = self.ledger.clone();
        let (p, d) = (provider.to_string(), durable.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.clear_alias_tombstones_for_durable(&p, &d))
                .await
                .map_err(std::io::Error::other)?
        })
    }
}
