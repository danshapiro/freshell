//! A fresh-agent identity sink over a REAL pane ledger, for the integration tests
//! whose sessions must leave and read back durable binding rows.
//!
//! It mirrors `crates/freshell-server/src/identity_sink.rs`'s `LedgerIdentitySink`
//! (the production bridge; the ws-test crate cannot depend on freshell-server, the
//! dependency edge runs the other way): awaited `spawn_blocking` writes, inline
//! memory reads, the same settings gates, the tri-state provenance policy and the
//! claude rollback-row re-key that rides the binding batch. The one omission is the
//! authoritative-write ownership consult (only the handoff runner's own target
//! bindings set `authoritative`, and the production consult's refusal is pinned in
//! freshell-server's own tests).

use std::sync::Arc;

use freshell_freshagent::identity_sink::SinkCloseError;
use freshell_freshagent::{
    BindProvenance, ClaimCommit, FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink,
    ProvenanceUpdate, RollbackRecord, SinkAliasClearWrite, SinkCloseWrite, SinkCommitWrite,
    SinkWrite,
};
use freshell_ws::pane_ledger::{
    ClaimCommitOutcome, CloseEnvelopeError, FreshAgentBindingWrite, PaneLedger, ProvenancePolicy,
    ProvenanceStamps,
};

pub struct LedgerSink {
    pub ledger: Arc<PaneLedger>,
}

impl LedgerSink {
    pub fn new(ledger: Arc<PaneLedger>) -> Self {
        Self { ledger }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn close_error(error: CloseEnvelopeError) -> SinkCloseError {
    match error {
        CloseEnvelopeError::Clean(e) => SinkCloseError::Clean(e),
        CloseEnvelopeError::Persisted(e) => SinkCloseError::Persisted(e),
    }
}

/// Run a blocking ledger write on the blocking pool and await it.
fn blocking<F>(write: F) -> SinkWrite
where
    F: FnOnce() -> std::io::Result<()> + Send + 'static,
{
    Box::pin(async move {
        tokio::task::spawn_blocking(write)
            .await
            .map_err(std::io::Error::other)?
    })
}

impl PaneIdentitySink for LedgerSink {
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, m, c) = (
            placeholder_id.to_string(),
            mode.to_string(),
            cwd.map(str::to_string),
        );
        let now = now_ms();
        blocking(move || {
            ledger.record_pending(&p, &m, c.as_deref(), None, ProvenanceStamps::default(), now)
        })
    }

    fn record_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite {
        let ledger = self.ledger.clone();
        let now = now_ms();
        blocking(move || {
            let provenance = match &upsert.provenance {
                ProvenanceUpdate::Replace(stamps) => ProvenancePolicy::Replace(ProvenanceStamps {
                    client_instance_id: stamps.client_instance_id.as_deref(),
                    device_id: stamps.device_id.as_deref(),
                    tab_key: stamps.tab_key.as_deref(),
                    asserted_at: stamps.asserted_at,
                }),
                ProvenanceUpdate::Inherit => ProvenancePolicy::Inherit,
                ProvenanceUpdate::Clear => ProvenancePolicy::Clear,
            };
            let stored_genesis = upsert.genesis.stored_value();
            ledger.record_fresh_agent_binding(&FreshAgentBindingWrite {
                genesis: freshell_ws::pane_ledger::GenesisWrite::from_update(
                    stored_genesis.as_ref(),
                    upsert.genesis.is_clear(),
                ),
                provider: &upsert.provider,
                session_id: &upsert.session_id,
                mode: &upsert.mode,
                cwd: upsert.settings.cwd.as_deref(),
                create_request_id: upsert.create_request_id.as_deref(),
                model: upsert.settings.model.as_deref(),
                sandbox: upsert.settings.sandbox.as_deref(),
                permission_mode: upsert.settings.permission_mode.as_deref(),
                effort: upsert.settings.effort.as_deref(),
                plugins: upsert.settings.plugins.as_deref(),
                supersedes: upsert.supersedes.as_deref(),
                provenance,
                observed_epoch: upsert.observed_epoch,
                observed_generation: upsert.observed_generation,
                authoritative: upsert.authoritative,
                now_ms: now,
            })?;
            // The claude rollback row follows the pane to the superseding id in the
            // same awaited batch as the binding write.
            if upsert.provider == "claude" {
                if let Some(old_id) = upsert.supersedes.as_deref() {
                    if old_id != upsert.session_id {
                        if let Some(payload) = ledger.load_rollback_row(&upsert.provider, old_id) {
                            ledger.record_rollback_row(
                                &upsert.provider,
                                &upsert.session_id,
                                &payload,
                                now,
                            )?;
                            let _ = ledger.delete_rollback_row(&upsert.provider, old_id);
                        }
                    }
                }
            }
            if let Some(p) = upsert.resolves_pending.as_deref() {
                let _ = ledger.delete_pending(p);
            }
            Ok(())
        })
    }

    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings> {
        let row = self.ledger.load_binding(provider, session_id)?;
        if row.pane_kind.as_deref() != Some("fresh-agent") {
            return None;
        }
        let settings = FreshAgentSettings {
            model: row.model,
            sandbox: row.sandbox,
            permission_mode: row.permission_mode,
            effort: row.effort,
            cwd: row.cwd,
            plugins: row.plugins,
        };
        (settings != FreshAgentSettings::default()).then_some(settings)
    }

    fn load_genesis(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Option<freshell_freshagent::RecordedGenesis> {
        let row = self.ledger.load_binding(provider, session_id)?;
        if row.pane_kind.as_deref() != Some("fresh-agent") {
            return None;
        }
        freshell_freshagent::RecordedGenesis::from_row(
            provider,
            session_id,
            row.genesis.as_ref(),
            row.updated_at,
        )
    }

    fn clear_genesis(&self, provider: &str, session_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        let now = now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                ledger.clear_binding_genesis(&p, &s, now).map(|_| ())
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }

    fn was_recorded(&self, provider: &str, session_id: &str) -> bool {
        self.ledger
            .fresh_agent_settings_recorded(provider, session_id)
    }

    fn load_provenance(&self, provider: &str, session_id: &str) -> Option<BindProvenance> {
        let row = self.ledger.load_binding(provider, session_id)?;
        if row.pane_kind.as_deref() != Some("fresh-agent") {
            return None;
        }
        let provenance = BindProvenance {
            client_instance_id: row.client_instance_id,
            device_id: row.device_id,
            tab_key: row.tab_key,
            asserted_at: row.last_attributed_at.unwrap_or(row.created_at),
        };
        (provenance.client_instance_id.is_some()
            || provenance.device_id.is_some()
            || provenance.tab_key.is_some())
        .then_some(provenance)
    }

    fn record_rollback(
        &self,
        provider: &str,
        session_id: &str,
        record: RollbackRecord,
    ) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        let now = now_ms();
        blocking(move || {
            let payload = serde_json::to_value(&record).map_err(std::io::Error::other)?;
            ledger.record_rollback_row(&p, &s, &payload, now)
        })
    }

    fn load_rollback(&self, provider: &str, session_id: &str) -> Option<RollbackRecord> {
        let payload = self.ledger.load_rollback_row(provider, session_id)?;
        RollbackRecord::from_stored_payload(payload)
    }

    fn delete_rollback(&self, provider: &str, session_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        blocking(move || ledger.delete_rollback_row(&p, &s))
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
        let now = now_ms();
        blocking(move || ledger.repair_failed_transition_binding(&p, &s, epoch, generation, now))
    }

    fn lookup_by_create_request_id(
        &self,
        provider: &str,
        create_request_id: &str,
    ) -> Option<String> {
        self.ledger
            .lookup_by_create_request_id(provider, create_request_id)
            .map(|row| row.session_id)
    }

    fn retire_closed(&self, provider: &str, session_id: &str) -> SinkCloseWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        let now = now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.retire_closed(&p, &s, now))
                .await
                .map_err(|join| SinkCloseError::Clean(std::io::Error::other(join)))?
                .map_err(close_error)
        })
    }

    fn retire_closed_batch(
        &self,
        provider: &str,
        session_ids: &[String],
        pending_ids: &[String],
    ) -> SinkCloseWrite {
        let ledger = self.ledger.clone();
        let p = provider.to_string();
        let (ids, pendings) = (session_ids.to_vec(), pending_ids.to_vec());
        let now = now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.close_identities(&p, &ids, &pendings, now))
                .await
                .map_err(|join| SinkCloseError::Clean(std::io::Error::other(join)))?
                .map_err(close_error)
        })
    }

    fn delete_pending(&self, placeholder_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let p = placeholder_id.to_string();
        blocking(move || ledger.delete_pending(&p))
    }

    fn clear_kill_tombstone(&self, provider: &str, session_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        blocking(move || ledger.clear_kill_tombstone(&p, &s))
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
        let aliases = fence_checked_aliases.to_vec();
        let now = now_ms();
        Box::pin(async move {
            let outcome = tokio::task::spawn_blocking(move || {
                ledger.commit_claim_aliased(&p, &s, expect_killed_at_ms, &aliases, now)
            })
            .await
            .map_err(std::io::Error::other)??;
            Ok(match outcome {
                ClaimCommitOutcome::Committed => ClaimCommit::Committed,
                ClaimCommitOutcome::RefusedStale => ClaimCommit::RefusedStale,
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
        blocking(move || ledger.record_alias_tombstone(&p, &ph, &d, at_ms))
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
