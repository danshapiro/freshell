//! Server-side implementation of the fresh-agent identity bridge (P1.13):
//! freshell-freshagent cannot see the ledger (crate cycle), so main.rs
//! injects this adapter at wiring time.

use freshell_freshagent::{
    BindProvenance, BindingClaim, BindingClaimKind, ClaimCommit, FreshAgentBindingUpsert,
    FreshAgentSettings, PaneIdentitySink, RecordedGenesis, RollbackRecord, SinkAliasClearWrite,
    SinkCloseError, SinkCloseWrite, SinkCommitWrite, SinkMarkTurnInterruptedWrite,
    SinkTakeTurnInterruptedWrite, SinkWrite,
};
use freshell_ws::pane_ledger::{CloseEnvelopeError, FreshAgentBindingWrite, PaneLedger};
use std::sync::Arc;

/// Delta-r6-r4 (focused-episode-6 round 3, Finding 3): the ledger's classed
/// close-envelope error maps onto the fresh-agent crate's mirror type —
/// the kill lanes' [`crate`]-visible contract (`Clean` ⇒ touch nothing;
/// `Persisted` ⇒ the close is durable: end the session, fail visibly).
fn map_close_envelope_error(err: CloseEnvelopeError) -> SinkCloseError {
    match err {
        CloseEnvelopeError::Clean(e) => SinkCloseError::Clean(e),
        CloseEnvelopeError::Persisted(e) => SinkCloseError::Persisted(e),
    }
}

/// b8ke focused ep5 r3 F1: the deterministic park for the
/// canceled-authoritative-write tests. A spawn_blocking closure SURVIVES
/// cancellation of the awaiting task (task abort never cancels a started
/// closure), so the tests park the closure at its entry — with the write
/// already spawned and parked, the test cancels the handoff (the abort
/// cleanup's settled coordinator effect), then RELEASES the closure and
/// asserts the write consults the post-cancel truth and refuses typed.
/// std sync primitives only: the closure runs on the blocking pool (no
/// tokio context to await inside).
#[cfg(test)]
pub(crate) struct AuthoritativeWritePark {
    reached: std::sync::atomic::AtomicBool,
    released: std::sync::Mutex<bool>,
    cv: std::sync::Condvar,
}

#[cfg(test)]
impl AuthoritativeWritePark {
    pub(crate) fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            reached: std::sync::atomic::AtomicBool::new(false),
            released: std::sync::Mutex::new(false),
            cv: std::sync::Condvar::new(),
        })
    }

    /// The closure side: announce arrival, then block until released.
    fn wait_for_release(&self) {
        self.reached
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let mut guard = self.released.lock().expect("park lock");
        while !*guard {
            guard = self.cv.wait(guard).expect("park condvar");
        }
    }

    /// The test side: release the parked closure (idempotent).
    pub(crate) fn release(&self) {
        let mut guard = self.released.lock().expect("park lock");
        *guard = true;
        self.cv.notify_all();
    }

    /// The test side: has the closure reached the park?
    pub(crate) fn reached(&self) -> bool {
        self.reached.load(std::sync::atomic::Ordering::SeqCst)
    }
}

pub struct LedgerIdentitySink {
    ledger: Arc<PaneLedger>,
    /// b8ke focused ep5 r3 F1: the ONE server-wide runtime-ownership
    /// coordinator (main.rs mints it and shares it with every lane). The
    /// authoritative binding write's ownership re-validation consults it
    /// INSIDE the spawn_blocking closure — at the moment the closure
    /// executes, which is the exact truth a closure surviving its
    /// awaiting task's cancellation faces.
    ownership: Option<std::sync::Arc<freshell_ownership::RuntimeOwnershipRegistry>>,
    /// b8ke focused ep5 r3 F1: the deterministic park (test-only — never
    /// armed in production). Parks the AUTHORITATIVE closure BEFORE the
    /// ownership consult — the canceled-ARRIVAL cells.
    #[cfg(test)]
    authoritative_park: Option<std::sync::Arc<AuthoritativeWritePark>>,
    /// b8ke focused ep5 r4 F1: the deterministic POST-VALIDATION park
    /// (test-only): parks the authoritative closure AFTER the ownership
    /// consult passed and BEFORE the ledger mutation — the
    /// VALIDATED-THEN-CANCELED ordering the round-4 reviewer demanded the
    /// tests exercise (the consult passed; the cancel lands; the repair
    /// fences; only then does the mutation run).
    #[cfg(test)]
    authoritative_park_after_validation: Option<std::sync::Arc<AuthoritativeWritePark>>,
}

impl LedgerIdentitySink {
    pub fn new(
        ledger: Arc<PaneLedger>,
        ownership: Option<std::sync::Arc<freshell_ownership::RuntimeOwnershipRegistry>>,
    ) -> Self {
        Self {
            ledger,
            ownership,
            #[cfg(test)]
            authoritative_park: None,
            #[cfg(test)]
            authoritative_park_after_validation: None,
        }
    }

    /// b8ke focused ep5 r3 F1 (test-only): arm the deterministic
    /// canceled-write park. Every AUTHORITATIVE record_binding closure
    /// parks at entry until released — the canceled-write tests use it to
    /// prove the consult reads the coordinator state as it stands AFTER
    /// the abort cleanup settled, not a pre-cancel snapshot.
    #[cfg(test)]
    pub(crate) fn with_authoritative_park(
        mut self,
        park: std::sync::Arc<AuthoritativeWritePark>,
    ) -> Self {
        self.authoritative_park = Some(park);
        self
    }

    /// b8ke focused ep5 r4 F1 (test-only): arm the POST-VALIDATION park —
    /// the closure parks between the ownership consult and the ledger
    /// mutation.
    #[cfg(test)]
    pub(crate) fn with_authoritative_park_after_validation(
        mut self,
        park: std::sync::Arc<AuthoritativeWritePark>,
    ) -> Self {
        self.authoritative_park_after_validation = Some(park);
        self
    }

    /// Staging shares the exact authority and destination-write rules with
    /// publication, but source links and pending/rollback cleanup wait for
    /// the caller's final write under the committed replacement owner.
    fn record_binding_inner(
        &self,
        upsert: FreshAgentBindingUpsert,
        publish_source: bool,
    ) -> SinkWrite {
        let ledger = self.ledger.clone();
        let ownership = self.ownership.clone();
        #[cfg(test)]
        let authoritative_park = self.authoritative_park.clone();
        #[cfg(test)]
        let authoritative_park_after_validation = self.authoritative_park_after_validation.clone();
        let now = now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                // b8ke focused ep5 r3 F1 + ep5 r4 F1 (the round-4
                // reviewer rejected the r3 "accepted residual" — the
                // consult ALONE left a time-of-check/time-of-use window,
                // and the abort cleanup had no ledger visibility): the
                // authoritative write's ownership re-validation is now the
                // FIRST of TWO serialized layers, and neither layer leaves
                // an unaccepted window.
                //
                // LAYER 1 — THIS consult (execution-time truth): refuses
                // every claim whose exact Starting, Handoff, or Live owner
                // no longer owns this provider/key. The captured operation
                // id and key are immutable; the sink never promotes a later
                // owner into authority for an old write.
                //
                // LAYER 2 — the failed-transition repair (the runner's
                // abort/failure cleanup, `repair_failed_transition` on this
                // same sink): when the transition fails, its cleanup lands
                // the durable tombstone fence + the conditional retire of
                // the transition's own orphaned row. The fence closes THIS
                // consult's remaining interleaving — a write whose consult
                // passed BEFORE the cancel is suppressed wholesale at the
                // ledger's tombstone consult, whichever arrival order its
                // late mutation takes; the revert closes the
                // completed-then-canceled ordering — a write that fully
                // landed while the handoff was live is retired typed, and
                // the coordinator and the recovery registry re-converge.
                // A later legitimate claim clears the tombstone through
                // its `commit_claim`, so the fence never wedges the
                // session.
                //
                let claim = upsert.claim.as_ref();
                if let Some(claim) = claim {
                    #[cfg(test)]
                    if let Some(park) = authoritative_park.as_ref() {
                        park.wait_for_release();
                    }
                    let stale_transition = || {
                        std::io::Error::other(
                            "STALE_TRANSITION_BINDING: the exact binding claim no \
                             longer owns its provider/key operation (canceled, \
                             superseded, restored, \
                             vacated, or a new boot epoch) — the write is refused \
                             (kata b8ke focused ep5 r3 F1)",
                        )
                    };
                    if claim.provider != upsert.provider || claim.session_id != upsert.session_id {
                        return Err(std::io::Error::other(
                            "STALE_TRANSITION_BINDING: claim provider/session key does not \
                             match the binding upsert",
                        ));
                    }
                    let (w_epoch, w_generation) = (claim.epoch, claim.generation);
                    if upsert.observed_epoch != Some(w_epoch)
                        || upsert.observed_generation != Some(w_generation)
                    {
                        return Err(stale_transition());
                    }
                    let Some(registry) = ownership.as_ref() else {
                        return Err(std::io::Error::other(
                            "STALE_TRANSITION_BINDING: an authoritative write \
                             arrived at a bridge with no ownership coordinator \
                             wired — authoritative markers are minted only by \
                             coordinator-driven handoff lanes (kata b8ke focused \
                             ep5 r3 F1)",
                        ));
                    };
                    let snap = registry.observe(&upsert.provider, &upsert.session_id);
                    let transition_owned = claim.matches_snapshot(&snap);
                    if !transition_owned {
                        tracing::warn!(target: "invariant",
                            provider = %upsert.provider,
                            session_id = %upsert.session_id,
                            write_epoch = w_epoch,
                            write_generation = w_generation,
                            write_operation_id = %claim.operation_id,
                            snapshot_epoch = snap.epoch,
                            snapshot_generation = snap.generation,
                            "identity_sink.authoritative_binding_refused_stale_transition: \
                             the handoff operation no longer owns the key's transition \
                             — the canceled/superseded write is refused (kata b8ke \
                             focused ep5 r3 F1)"
                        );
                        return Err(stale_transition());
                    }
                    #[cfg(test)]
                    if let Some(park) = authoritative_park_after_validation.as_ref() {
                        park.wait_for_release();
                    }
                }
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
                let stored_genesis = upsert.genesis.stored_value();
                let settings = match &upsert.settings {
                    freshell_freshagent::SettingsUpdate::Keep => None,
                    freshell_freshagent::SettingsUpdate::Replace(settings) => Some(settings),
                };
                let w = FreshAgentBindingWrite {
                    collaboration_mode: settings.and_then(|s| s.collaboration_mode.as_deref()),
                    genesis: freshell_ws::pane_ledger::GenesisWrite::from_update(
                        stored_genesis.as_ref(),
                        upsert.genesis.is_clear(),
                    ),
                    provider: &upsert.provider,
                    session_id: &upsert.session_id,
                    mode: &upsert.mode,
                    cwd: settings.and_then(|s| s.cwd.as_deref()),
                    create_request_id: upsert.create_request_id.as_deref(),
                    model: settings.and_then(|s| s.model.as_deref()),
                    sandbox: settings.and_then(|s| s.sandbox.as_deref()),
                    permission_mode: settings.and_then(|s| s.permission_mode.as_deref()),
                    effort: settings.and_then(|s| s.effort.as_deref()),
                    plugins: settings.and_then(|s| s.plugins.as_deref()),
                    supersedes: upsert.supersedes.as_deref(),
                    provenance,
                    // b8ke ext r22 F2: the upsert's observed (epoch,
                    // generation) pair threads into the ledger write —
                    // the delayed-write fence (the write path refuses
                    // typed on a stale pair).
                    observed_epoch: claim.map(|claim| claim.epoch).or(upsert.observed_epoch),
                    observed_generation: claim
                        .map(|claim| claim.generation)
                        .or(upsert.observed_generation),
                    now_ms: now,
                };
                if publish_source {
                    ledger.record_fresh_agent_binding_claimed(&w, claim, &upsert.settings)?;
                } else {
                    ledger.stage_fresh_agent_replacement_binding_claimed(
                        &w,
                        claim,
                        &upsert.settings,
                    )?;
                }
                // kata 1wxv Task 4 (r1 discipline): on the CLAUDE fork-adoption
                // leg (`supersedes` = the pre-rollback durable id) the rollback
                // row re-keys old→new inside the SAME awaited batch as the
                // binding write — so the record follows the pane atomically and
                // the handler's pre-fork write stays the ONLY
                // rollback-record-specific write. Scoped to provider "claude":
                // codex's crash-respawn supersession must NOT move a marker
                // bucket onto a memory-less mint-new thread.
                if publish_source && upsert.provider == "claude" {
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
                if let Some(p) = upsert.resolves_pending.as_deref().filter(|_| publish_source) {
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
                    None,
                    freshell_ws::pane_ledger::ProvenanceStamps::default(),
                    now,
                )
            })
            .await
            .map_err(std::io::Error::other)? // JoinError (incl. closure panic) surfaces as Err
        })
    }

    fn record_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite {
        self.record_binding_inner(upsert, true)
    }

    fn stage_replacement_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite {
        self.record_binding_inner(upsert, false)
    }

    fn mark_turn_interrupted(
        &self,
        provider: &str,
        session_id: &str,
        at_ms: i64,
    ) -> SinkMarkTurnInterruptedWrite {
        let ledger = self.ledger.clone();
        let (provider, session_id) = (provider.to_string(), session_id.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                ledger.mark_fresh_agent_turn_interrupted(&provider, &session_id, at_ms)
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }

    fn take_turn_interrupted(
        &self,
        provider: &str,
        session_id: &str,
    ) -> SinkTakeTurnInterruptedWrite {
        let ledger = self.ledger.clone();
        let (provider, session_id) = (provider.to_string(), session_id.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                ledger.take_fresh_agent_turn_interrupted(&provider, &session_id)
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
            collaboration_mode: row.collaboration_mode,
            model: row.model,
            sandbox: row.sandbox,
            permission_mode: row.permission_mode,
            effort: row.effort,
            cwd: row.cwd,
            plugins: row.plugins,
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

    fn load_settings_for_recovery_claim(&self, claim: &BindingClaim) -> Option<FreshAgentSettings> {
        if !matches!(
            claim.kind,
            BindingClaimKind::Starting | BindingClaimKind::Handoff
        ) {
            return None;
        }

        let registry = self.ownership.as_ref()?;
        let snapshot = registry.observe(&claim.provider, &claim.session_id);
        let is_current_claim = snapshot.epoch == claim.epoch
            && match (claim.kind, &snapshot.state) {
                (
                    BindingClaimKind::Starting,
                    freshell_ownership::OwnershipState::Starting {
                        kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                        operation_id,
                        generation,
                        ..
                    },
                ) => operation_id == &claim.operation_id && *generation == claim.generation,
                (
                    BindingClaimKind::Handoff,
                    freshell_ownership::OwnershipState::Handoff {
                        to_kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                        operation_id,
                        generation,
                        ..
                    },
                ) => operation_id == &claim.operation_id && *generation == claim.generation,
                _ => false,
            };
        if !is_current_claim {
            return None;
        }

        // Keep the ordinary FreshAgent settings path, but never return those
        // values for a stale claim. The legacy fallback below is only for a
        // historical terminal row after this exact transition claim is proven.
        if let Some(settings) = self.load_settings(&claim.provider, &claim.session_id) {
            return Some(settings);
        }

        let row = self
            .ledger
            .load_binding(&claim.provider, &claim.session_id)?;
        if row.state != freshell_ws::pane_ledger::RowState::Bound
            || row.live_terminal_id.is_none()
            || row.pane_kind.as_deref() == Some("fresh-agent")
        {
            return None;
        }

        let settings = FreshAgentSettings {
            collaboration_mode: row.collaboration_mode,
            model: row.model,
            sandbox: row.sandbox,
            permission_mode: row.permission_mode,
            effort: row.effort,
            cwd: row.cwd,
            plugins: row.plugins,
        };
        (settings != FreshAgentSettings::default()).then_some(settings)
    }

    fn load_genesis(&self, provider: &str, session_id: &str) -> Option<RecordedGenesis> {
        // Memory-only against the write-through index, gated like
        // `load_settings` (only fresh-agent rows carry a genesis).
        let row = self.ledger.load_binding(provider, session_id)?;
        if row.pane_kind.as_deref() != Some("fresh-agent") {
            return None;
        }
        RecordedGenesis::from_row(provider, session_id, row.genesis.as_ref(), row.updated_at)
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

    fn chain_terminus(&self, provider: &str, session_id: &str) -> Option<String> {
        // Memory-only chain walk (`supersededBy` links to the live terminus).
        self.ledger
            .lookup_by_session(provider, session_id)
            .filter(|resolution| resolution.corrected)
            .map(|resolution| resolution.row.session_id)
    }

    /// Retire-on-kill (delta-review round 5, restore-open-sessions-only): the
    /// kill handlers' awaited retire batch — the same awaited-spawn_blocking
    /// discipline as `record_binding`. Delta-r6-r4 (focused-episode-6 round
    /// 3, Finding 3): the ledger's close is ONE journal record and its error
    /// is CLASSED — `Clean` (nothing durable; the caller fails the kill and
    /// touches nothing) vs `Persisted` (the close IS durable despite the
    /// reported error; the caller ends the session and fails visibly). The
    /// pre-journal model's tombstone/retire split pair and its compensation
    /// machinery are gone — there is no second write to fail past the first.
    /// The class maps through to the lanes unchanged.
    fn retire_closed(&self, provider: &str, session_id: &str) -> SinkCloseWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        let now = now_ms();
        Box::pin(async move {
            let result = tokio::task::spawn_blocking(move || ledger.retire_closed(&p, &s, now))
                .await
                .map_err(|join| {
                    freshell_freshagent::identity_sink::SinkCloseError::Clean(
                        std::io::Error::other(join),
                    )
                })?;
            result.map_err(map_close_envelope_error)
        })
    }

    /// Delta-r6-r3 (focused-episode-6 round 2, Findings 4+5), re-durabled by
    /// delta-r6-r4 (round 3, Finding 3): the batched close every fresh-agent
    /// kill lane uses — the whole identity set (plus the pending markers,
    /// last) journals into the ledger's ONE close-envelope record (see the
    /// trait doc; the wire id — the caller's first id — addresses it). Same
    /// awaited-spawn_blocking + class-mapping discipline as `retire_closed`.
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
        let now = now_ms();
        Box::pin(async move {
            let result = tokio::task::spawn_blocking(move || {
                ledger.close_identities(&p, &ids, &pendings, now)
            })
            .await
            .map_err(|join| {
                freshell_freshagent::identity_sink::SinkCloseError::Clean(std::io::Error::other(
                    join,
                ))
            })?;
            result.map_err(map_close_envelope_error)
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
    /// tombstone is the ledger's own `Ok` idempotence. Round 4 callership:
    /// the claude claim lane's consumed placeholder-alias fences only (the
    /// claimed durable's own fence moved into `commit_claim`).
    fn clear_kill_tombstone(&self, provider: &str, session_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.clear_kill_tombstone(&p, &s))
                .await
                .map_err(std::io::Error::other)?
        })
    }

    /// The claim attempt's dead-state snapshot (focused-ep5-r3 Finding 1) —
    /// read inline against the write-through index, like `load_settings`.
    fn kill_tombstone_at_ms(&self, provider: &str, session_id: &str) -> Option<i64> {
        self.ledger.kill_tombstone_at(provider, session_id)
    }

    /// Retire-on-kill round 5 (focused-ep5-r4 Finding 2): the alias-tombstone
    /// retention probe — the row's raw Bound state, read inline against the
    /// write-through index like [`Self::kill_tombstone_at_ms`].
    fn row_is_bound(&self, provider: &str, session_id: &str) -> bool {
        self.ledger.row_is_bound(provider, session_id)
    }

    /// The claim commit (focused-ep5-r3 Findings 1+3): ONE conditional
    /// durable transition — clear + revive atomically, refused wholesale
    /// (no side effects) when the identity's dead-state advanced past the
    /// claim-start snapshot. Same awaited-spawn_blocking discipline as every
    /// write lane; the conditional semantics and the commit ordering live
    /// entirely in the ledger.
    fn commit_claim(
        &self,
        provider: &str,
        session_id: &str,
        expect_killed_at_ms: Option<i64>,
    ) -> SinkCommitWrite {
        self.commit_claim_aliased(provider, session_id, expect_killed_at_ms, &[])
    }

    /// Focused-ep5-r5 Finding 2 (retire-on-kill round 6): pass-through like
    /// [`Self::commit_claim`] — the alias-existence gate and the conditional
    /// transition both live atomically inside the ledger's guarded section.
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
        let now = now_ms();
        Box::pin(async move {
            let outcome = tokio::task::spawn_blocking(move || {
                ledger.commit_claim_aliased(&p, &s, expect_killed_at_ms, &aliases, now)
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

    /// Focused-ep5-r5 Finding 2: the durable alias record — same
    /// awaited-spawn_blocking discipline as `retire_closed`.
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

    /// The kill consult's sync read — memory-only inline pass-through like
    /// [`Self::kill_tombstone_at_ms`].
    fn alias_tombstone_records(&self, provider: &str, placeholder: &str) -> Vec<(String, i64)> {
        self.ledger.alias_tombstone_records(provider, placeholder)
    }

    /// The claim consumption's awaited pass-through (the durable half of
    /// clear-for-durable).
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

    /// b8ke focused ep5 r4 F1: the failed-transition repair — same
    /// awaited-spawn_blocking discipline as every write lane. A failure
    /// maps to the caller's warn path (the cleanup never blocks its
    /// coordinator fail on a ledger hiccup, but it logs LOUD).
    fn repair_failed_transition(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        epoch: u64,
        generation: u64,
    ) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s, op) = (
            provider.to_string(),
            session_id.to_string(),
            operation_id.to_string(),
        );
        let now = now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                ledger.repair_failed_transition_binding(&p, &s, &op, epoch, generation, now)
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
    use freshell_freshagent::{
        BindingClaim, BindingClaimKind, FreshAgentBindingUpsert, FreshAgentSettings,
        PaneIdentitySink, SettingsUpdate,
    };
    use std::sync::Arc;

    fn seed_historical_terminal_binding(
        root: &std::path::Path,
        provider: &str,
        session_id: &str,
        settings: &FreshAgentSettings,
    ) -> Arc<freshell_ws::pane_ledger::PaneLedger> {
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            root.to_path_buf(),
        )));
        ledger
            .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                provider,
                session_id,
                terminal_id: "historical-terminal",
                mode: provider,
                cwd: settings.cwd.as_deref(),
                create_request_id: None,
                origin_create_request_id: None,
                provenance: freshell_ws::pane_ledger::ProvenancePolicy::Clear,
                observed_epoch: None,
                observed_generation: None,
                now_ms: 100,
            })
            .expect("historical terminal binding seeds");
        let row_path = root
            .join("bindings")
            .join(provider)
            .join(format!("{session_id}.json"));
        let mut row: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&row_path).unwrap()).unwrap();
        row["collaborationMode"] = serde_json::json!(settings.collaboration_mode);
        row["model"] = serde_json::json!(settings.model);
        row["sandbox"] = serde_json::json!(settings.sandbox);
        row["permissionMode"] = serde_json::json!(settings.permission_mode);
        row["effort"] = serde_json::json!(settings.effort);
        row["cwd"] = serde_json::json!(settings.cwd);
        row["plugins"] = serde_json::json!(settings.plugins);
        std::fs::write(&row_path, serde_json::to_vec(&row).unwrap()).unwrap();
        drop(ledger);
        Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            root.to_path_buf(),
        )))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn starting_claim_recovers_and_rebinds_settings_from_a_dead_terminal_row() {
        use freshell_ownership::{
            BeginOutcome, CommitOutcome, OwnerIdentity, RuntimeOwnerKind, RuntimeOwnershipRegistry,
        };

        let root = tempfile::tempdir().unwrap();
        let settings = FreshAgentSettings {
            model: Some("remembered-model".into()),
            effort: Some("low".into()),
            cwd: Some("/workspace".into()),
            ..FreshAgentSettings::default()
        };
        let ledger = seed_historical_terminal_binding(
            root.path(),
            "opencode",
            "ses-dead-terminal-settings",
            &settings,
        );
        let registry = Arc::new(RuntimeOwnershipRegistry::new());
        let sink = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()));
        assert!(sink
            .load_settings("opencode", "ses-dead-terminal-settings")
            .is_none());
        assert!(!sink.was_recorded("opencode", "ses-dead-terminal-settings"));

        let operation_id = "recover-dead-terminal-settings";
        let generation = match registry.begin_start(
            "opencode",
            "ses-dead-terminal-settings",
            RuntimeOwnerKind::FreshAgent,
            operation_id,
            None,
            "dead-terminal-settings-recovery",
            0,
        ) {
            BeginOutcome::Granted { generation } => generation,
            other => panic!(
                "the dead terminal binding is recoverable after the liveness check: {other:?}"
            ),
        };
        let claim = BindingClaim {
            provider: "opencode".into(),
            session_id: "ses-dead-terminal-settings".into(),
            operation_id: operation_id.into(),
            epoch: registry.boot_epoch(),
            generation,
            kind: BindingClaimKind::Starting,
        };
        let stale_claim = BindingClaim {
            operation_id: "another-start".into(),
            ..claim.clone()
        };
        assert!(
            sink.load_settings_for_recovery_claim(&stale_claim)
                .is_none(),
            "a stale operation cannot read terminal-row settings"
        );
        let recovered = sink.load_settings_for_recovery_claim(&claim).expect(
            "the current Starting claim reads the historical settings after liveness proof",
        );
        assert_eq!(recovered, settings);

        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: claim.provider.clone(),
            session_id: claim.session_id.clone(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: Some(claim.epoch),
            observed_generation: Some(claim.generation),
            claim: Some(claim.clone()),
            settings: SettingsUpdate::Replace(recovered.clone()),
        })
        .await
        .expect("the exact Starting claim rebinds the terminal row");
        let row = ledger
            .load_binding(&claim.provider, &claim.session_id)
            .expect("the recovered row remains durable");
        assert_eq!(row.state, freshell_ws::pane_ledger::RowState::Bound);
        assert_eq!(row.pane_kind.as_deref(), Some("fresh-agent"));
        assert_eq!(row.live_terminal_id, None);
        assert_eq!(row.model.as_deref(), Some("remembered-model"));
        assert_eq!(row.effort.as_deref(), Some("low"));
        assert!(
            sink.load_settings_for_recovery_claim(&stale_claim)
                .is_none(),
            "a stale Starting claim cannot read settings even after the row becomes FreshAgent"
        );
        assert_eq!(
            sink.load_settings(&claim.provider, &claim.session_id),
            Some(settings)
        );
        assert!(sink.was_recorded(&claim.provider, &claim.session_id));
        assert_eq!(
            registry.commit_live(
                &claim.provider,
                &claim.session_id,
                operation_id,
                generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some(claim.session_id.clone()),
                    pid: None,
                    ownership_id: Some(operation_id.into()),
                },
            ),
            CommitOutcome::Committed
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn handoff_claim_recovers_settings_from_a_dead_terminal_row() {
        use freshell_ownership::{
            BeginOutcome, ObservedFence, OwnerIdentity, RuntimeOwnerKind, RuntimeOwnershipRegistry,
        };

        let root = tempfile::tempdir().unwrap();
        let settings = FreshAgentSettings {
            model: Some("handoff-model".into()),
            effort: Some("high".into()),
            ..FreshAgentSettings::default()
        };
        let provider = "opencode";
        let session_id = "ses-dead-terminal-handoff-settings";
        let ledger = seed_historical_terminal_binding(root.path(), provider, session_id, &settings);
        let registry = Arc::new(RuntimeOwnershipRegistry::new());
        let terminal_operation = "dead-terminal-handoff-source";
        let terminal_generation = match registry.begin_start(
            provider,
            session_id,
            RuntimeOwnerKind::Terminal,
            terminal_operation,
            None,
            "dead-terminal-handoff-source",
            0,
        ) {
            BeginOutcome::Granted { generation } => generation,
            other => panic!("terminal owner starts: {other:?}"),
        };
        assert_eq!(
            registry.commit_live(
                provider,
                session_id,
                terminal_operation,
                terminal_generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("historical-terminal".into()),
                    live_session_key: None,
                    pid: Some(42002),
                    ownership_id: None,
                },
            ),
            freshell_ownership::CommitOutcome::Committed
        );
        let before_handoff = registry.observe(provider, session_id);
        let handoff_operation = "recover-terminal-settings-handoff";
        let handoff_generation = match registry.begin_handoff(
            provider,
            session_id,
            RuntimeOwnerKind::FreshAgent,
            handoff_operation,
            Some(ObservedFence {
                epoch: before_handoff.epoch,
                generation: before_handoff.generation,
            }),
            "dead-terminal-settings-recovery",
            0,
        ) {
            BeginOutcome::Granted { generation } => generation,
            other => panic!("verified dead terminal enters FreshAgent handoff: {other:?}"),
        };
        let claim = BindingClaim::handoff(
            provider,
            session_id,
            handoff_operation,
            registry.boot_epoch(),
            handoff_generation,
        );
        let sink = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()));

        assert_eq!(
            sink.load_settings_for_recovery_claim(&claim),
            Some(settings),
            "the exact current Handoff claim also recovers historical terminal settings"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn starting_claim_does_not_recover_settings_from_a_live_terminal_binding() {
        use freshell_ownership::{
            BeginOutcome, CommitOutcome, OwnerIdentity, RuntimeOwnerKind, RuntimeOwnershipRegistry,
        };

        let root = tempfile::tempdir().unwrap();
        let settings = FreshAgentSettings {
            model: Some("remembered-model".into()),
            effort: Some("low".into()),
            ..FreshAgentSettings::default()
        };
        let ledger = seed_historical_terminal_binding(
            root.path(),
            "opencode",
            "ses-live-terminal-settings",
            &settings,
        );
        let registry = Arc::new(RuntimeOwnershipRegistry::new());
        let terminal_operation = "still-live-terminal";
        let terminal_generation = match registry.begin_start(
            "opencode",
            "ses-live-terminal-settings",
            RuntimeOwnerKind::Terminal,
            terminal_operation,
            None,
            "live-terminal-binding",
            0,
        ) {
            BeginOutcome::Granted { generation } => generation,
            other => panic!("terminal owner starts: {other:?}"),
        };
        assert_eq!(
            registry.commit_live(
                "opencode",
                "ses-live-terminal-settings",
                terminal_operation,
                terminal_generation,
                OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some("historical-terminal".into()),
                    live_session_key: None,
                    pid: Some(42001),
                    ownership_id: None,
                },
            ),
            CommitOutcome::Committed
        );
        let sink = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()));
        let false_start_claim = BindingClaim {
            provider: "opencode".into(),
            session_id: "ses-live-terminal-settings".into(),
            operation_id: "unauthorized-recovery".into(),
            epoch: registry.boot_epoch(),
            generation: terminal_generation + 1,
            kind: BindingClaimKind::Starting,
        };
        assert!(sink
            .load_settings_for_recovery_claim(&false_start_claim)
            .is_none());
        assert!(matches!(
            registry.begin_start(
                "opencode",
                "ses-live-terminal-settings",
                RuntimeOwnerKind::FreshAgent,
                "freshagent-takeover",
                None,
                "active-terminal-refusal",
                0,
            ),
            BeginOutcome::OwnedByOtherKind { .. }
        ));
        let row = ledger
            .load_binding("opencode", "ses-live-terminal-settings")
            .expect("the terminal row remains authoritative");
        assert_eq!(row.pane_kind, None);
        assert_eq!(row.live_terminal_id.as_deref(), Some("historical-terminal"));
        assert_eq!(row.model.as_deref(), Some("remembered-model"));
        assert_eq!(row.effort.as_deref(), Some("low"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn valid_starting_claim_replaces_dead_terminal_bindings_and_preserves_settings() {
        use freshell_ownership::{BeginOutcome, RuntimeOwnerKind, RuntimeOwnershipRegistry};

        let root = tempfile::tempdir().unwrap();
        let registry = Arc::new(RuntimeOwnershipRegistry::new());
        let epoch = registry.boot_epoch();

        for (session_id, prior_pair) in [
            ("dead-terminal-unstamped", None),
            ("dead-terminal-stamped", Some((epoch, 0))),
        ] {
            let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
                root.path().into(),
            )));
            ledger
                .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                    provider: "claude",
                    session_id,
                    terminal_id: "dead-terminal-process",
                    mode: "claude",
                    cwd: Some("/workspace"),
                    create_request_id: None,
                    origin_create_request_id: None,
                    provenance: freshell_ws::pane_ledger::ProvenancePolicy::Clear,
                    observed_epoch: prior_pair.map(|pair| pair.0),
                    observed_generation: prior_pair.map(|pair| pair.1),
                    now_ms: 100,
                })
                .expect("historical terminal row seeds");

            // Historical terminal-shaped rows can still carry settings from
            // an earlier fresh-agent binding. Reopen the ledger after editing
            // the on-disk fixture so the test exercises its normal load path.
            let row_path = root
                .path()
                .join("bindings/claude")
                .join(format!("{session_id}.json"));
            let mut row: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&row_path).unwrap()).unwrap();
            row["model"] = serde_json::Value::String("remembered-model".into());
            std::fs::write(&row_path, serde_json::to_vec(&row).unwrap()).unwrap();
            drop(ledger);

            let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
                root.path().into(),
            )));
            let operation_id = format!("recover-{session_id}");
            let generation = match registry.begin_start(
                "claude",
                session_id,
                RuntimeOwnerKind::FreshAgent,
                &operation_id,
                None,
                "test-dead-binding-recovery",
                0,
            ) {
                BeginOutcome::Granted { generation } => generation,
                other => panic!("dead terminal binding should be claimable: {other:?}"),
            };
            let sink = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()));
            sink.record_binding(FreshAgentBindingUpsert {
                genesis: freshell_freshagent::GenesisUpdate::Keep,
                name_transition: None,
                provider: "claude".into(),
                session_id: session_id.into(),
                mode: "freshclaude".into(),
                create_request_id: None,
                resolves_pending: None,
                supersedes: None,
                provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
                observed_epoch: Some(epoch),
                observed_generation: Some(generation),
                claim: Some(BindingClaim {
                    provider: "claude".into(),
                    session_id: session_id.into(),
                    operation_id,
                    epoch,
                    generation,
                    kind: BindingClaimKind::Starting,
                }),
                settings: SettingsUpdate::Keep,
            })
            .await
            .expect("the current Starting claim heals a dead terminal row");

            let row = ledger
                .load_binding("claude", session_id)
                .expect("the recovered identity row remains durable");
            assert_eq!(row.state, freshell_ws::pane_ledger::RowState::Bound);
            assert_eq!(row.pane_kind.as_deref(), Some("fresh-agent"));
            assert_eq!(row.live_terminal_id, None);
            assert_eq!(
                (row.owner_epoch, row.owner_generation),
                (Some(epoch), Some(generation))
            );
            assert_eq!(row.model.as_deref(), Some("remembered-model"));
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn task008_settings_complete_codex_defaults_survive_the_actual_ledger_restart() {
        let root = tempfile::tempdir().unwrap();
        let settings = FreshAgentSettings {
            model: Some("provider-current".into()),
            effort: None,
            sandbox: Some("read-only".into()),
            permission_mode: Some("untrusted".into()),
            cwd: Some("/workspace/project".into()),
            collaboration_mode: Some("plan".into()),
            plugins: None,
        };
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            root.path().into(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "codex".into(),
            session_id: "settings-ledger".into(),
            mode: "freshcodex".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: Some(11),
            observed_generation: Some(3),
            claim: None,
            settings: SettingsUpdate::Replace(settings.clone()),
        })
        .await
        .unwrap();
        assert_eq!(
            sink.load_settings("codex", "settings-ledger"),
            Some(settings.clone())
        );
        drop(sink);
        drop(ledger);
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            root.path().into(),
        )));
        let recovered = LedgerIdentitySink::new(ledger.clone(), None);
        assert_eq!(
            recovered.load_settings("codex", "settings-ledger"),
            Some(settings)
        );
        let row = ledger.load_binding("codex", "settings-ledger").unwrap();
        assert_eq!((row.owner_epoch, row.owner_generation), (Some(11), Some(3)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn task008_settings_a_work_mode_only_record_is_recoverable() {
        let root = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            root.path().into(),
        )));
        let sink = LedgerIdentitySink::new(ledger, None);
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "codex".into(),
            session_id: "mode-only".into(),
            mode: "freshcodex".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,
            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                collaboration_mode: Some("plan".into()),
                ..Default::default()
            }),
        })
        .await
        .unwrap();
        assert!(sink.was_recorded("codex", "mode-only"));
        assert_eq!(
            sink.load_settings("codex", "mode-only")
                .unwrap()
                .collaboration_mode
                .as_deref(),
            Some("plan")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn writes_through_to_ledger_and_reads_back() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "codex".into(),
            session_id: "t1".into(),
            mode: "freshcodex".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                collaboration_mode: None,
                model: Some("gpt-5.3-codex-spark".into()),
                sandbox: Some("workspace-write".into()),
                permission_mode: Some("on-request".into()),
                effort: None,
                cwd: Some("/w".into()),
                plugins: None,
            }),
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
    async fn fresh_agent_restart_marker_survives_reload_and_is_consumed_once() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        assert!(!sink
            .mark_turn_interrupted("claude", "missing", 1_000)
            .await
            .expect("marking a missing row is a no-op"));
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "claude".into(),
            session_id: "session-restart".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,
            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings::default()),
        })
        .await
        .expect("binding write succeeds");
        let updated_at = ledger
            .load_binding("claude", "session-restart")
            .expect("binding exists")
            .updated_at;
        assert!(sink
            .mark_turn_interrupted("claude", "session-restart", 2_000)
            .await
            .expect("marker write succeeds"));

        let restarted = LedgerIdentitySink::new(
            Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
                tmp.path().to_path_buf(),
            ))),
            None,
        );
        let marked = restarted
            .ledger
            .load_binding("claude", "session-restart")
            .expect("binding survives reload");
        assert_eq!(marked.turn_interrupted_at, Some(2_000));
        assert_eq!(marked.updated_at, updated_at);
        assert_eq!(
            restarted
                .take_turn_interrupted("claude", "session-restart")
                .await
                .expect("consume succeeds"),
            Some(2_000)
        );
        assert_eq!(
            restarted
                .take_turn_interrupted("claude", "session-restart")
                .await
                .expect("second consume succeeds"),
            None
        );
        let after_consume = LedgerIdentitySink::new(
            Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
                tmp.path().to_path_buf(),
            ))),
            None,
        );
        assert_eq!(
            after_consume
                .ledger
                .load_binding("claude", "session-restart")
                .expect("binding remains")
                .turn_interrupted_at,
            None
        );
    }

    /// G15: the claude pane's plugins are part of the resume record — written
    /// with the binding and served back by `load_settings`, also after a
    /// restart, so a resume can hand them to the sidecar again.
    #[tokio::test(flavor = "multi_thread")]
    async fn plugins_write_through_and_read_back_after_a_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let plugins = vec!["/workspace/.claude/plugins/local".to_string()];
        let sink = LedgerIdentitySink::new(ledger, None);
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "claude".into(),
            session_id: "s1".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,
            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                plugins: Some(plugins.clone()),
                ..FreshAgentSettings::default()
            }),
        })
        .await
        .expect("awaited write succeeds");
        assert_eq!(
            sink.load_settings("claude", "s1")
                .expect("a plugins-only row is a settings record")
                .plugins,
            Some(plugins.clone())
        );
        assert!(sink.was_recorded("claude", "s1"));

        let restarted = LedgerIdentitySink::new(
            Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
                tmp.path().to_path_buf(),
            ))),
            None,
        );
        assert_eq!(
            restarted
                .load_settings("claude", "s1")
                .expect("the row survives the restart")
                .plugins,
            Some(plugins)
        );
    }

    /// Claude core design §4.5 (C13): a send that waited behind an undo
    /// finds the replacement through the durable supersession chain. The
    /// chain follows every hop to the live end, survives a restart (it is
    /// the ledger's), and names nothing for an id nothing superseded.
    #[tokio::test]
    async fn the_supersession_chain_leads_to_the_live_replacement() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger, None);
        let upsert = |session_id: &str, supersedes: Option<&str>| FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "claude".into(),
            session_id: session_id.into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: supersedes.map(str::to_string),
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,
            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            }),
        };
        for (id, supersedes) in [("s-a", None), ("s-c", Some("s-a")), ("s-d", Some("s-c"))] {
            sink.record_binding(upsert(id, supersedes))
                .await
                .expect("awaited write succeeds");
        }
        assert_eq!(sink.chain_terminus("claude", "s-a").as_deref(), Some("s-d"));
        assert_eq!(sink.chain_terminus("claude", "s-c").as_deref(), Some("s-d"));
        assert_eq!(sink.chain_terminus("claude", "s-d"), None, "the live end");
        assert_eq!(sink.chain_terminus("claude", "s-unknown"), None);
        let restarted = LedgerIdentitySink::new(
            Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
                tmp.path().to_path_buf(),
            ))),
            None,
        );
        assert_eq!(
            restarted.chain_terminus("claude", "s-a").as_deref(),
            Some("s-d")
        );
    }

    mod replacement_binding_publication {
        use super::*;
        use freshell_ownership::{
            BeginOutcome, CommitOutcome, OwnerIdentity, RuntimeOwnerKind, RuntimeOwnershipRegistry,
        };
        use freshell_ws::pane_ledger::{BindingRow, RetiredReason, RowState};

        const OLD: &str = "replacement-source";
        const NEW: &str = "replacement-target";

        struct Fixture {
            directory: tempfile::TempDir,
            ledger: Arc<PaneLedger>,
            registry: Arc<RuntimeOwnershipRegistry>,
            sink: LedgerIdentitySink,
            source: BindingRow,
            source_claim: BindingClaim,
            target_claim: BindingClaim,
            replacement: FreshAgentBindingUpsert,
        }

        fn claim(registry: &RuntimeOwnershipRegistry, id: &str) -> BindingClaim {
            let BeginOutcome::Granted { generation } = registry.begin_start(
                "codex",
                id,
                RuntimeOwnerKind::FreshAgent,
                id,
                None,
                "test",
                1,
            ) else {
                panic!("the fixture must own its real Starting claim");
            };
            BindingClaim {
                provider: "codex".into(),
                session_id: id.into(),
                operation_id: id.into(),
                epoch: registry.boot_epoch(),
                generation,
                kind: BindingClaimKind::Starting,
            }
        }

        async fn fixture() -> Fixture {
            let directory = tempfile::tempdir().unwrap();
            let ledger = Arc::new(PaneLedger::new(Some(directory.path().to_path_buf())));
            let registry = Arc::new(RuntimeOwnershipRegistry::new());
            let sink = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()));
            let source_claim = claim(&registry, OLD);
            let source = FreshAgentBindingUpsert {
                provider: "codex".into(),
                session_id: OLD.into(),
                mode: "freshcodex".into(),
                create_request_id: Some("source-create".into()),
                resolves_pending: None,
                supersedes: None,
                name_transition: None,
                provenance: freshell_freshagent::ProvenanceUpdate::Replace(BindProvenance {
                    client_instance_id: Some("client".into()),
                    device_id: Some("device".into()),
                    tab_key: Some("tab".into()),
                    asserted_at: 123,
                }),
                observed_epoch: Some(source_claim.epoch),
                observed_generation: Some(source_claim.generation),
                claim: Some(source_claim.clone()),
                settings: SettingsUpdate::Replace(FreshAgentSettings {
                    model: Some("source-model".into()),
                    ..Default::default()
                }),
                genesis: freshell_freshagent::GenesisUpdate::Keep,
            };
            sink.record_binding(source).await.unwrap();
            sink.record_pending("replacement-pending", "freshcodex", None)
                .await
                .unwrap();
            let source = ledger.load_binding("codex", OLD).unwrap();
            let target_claim = claim(&registry, NEW);
            let replacement = FreshAgentBindingUpsert {
                provider: "codex".into(),
                session_id: NEW.into(),
                mode: "freshcodex".into(),
                create_request_id: None,
                resolves_pending: Some("replacement-pending".into()),
                supersedes: Some(OLD.into()),
                name_transition: None,
                provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
                observed_epoch: Some(target_claim.epoch),
                observed_generation: Some(target_claim.generation),
                claim: Some(target_claim.clone()),
                settings: SettingsUpdate::Replace(FreshAgentSettings {
                    model: Some("native-model".into()),
                    cwd: Some("/native-workspace".into()),
                    ..Default::default()
                }),
                genesis: freshell_freshagent::GenesisUpdate::Keep,
            };
            Fixture {
                directory,
                ledger,
                registry,
                sink,
                source,
                source_claim,
                target_claim,
                replacement,
            }
        }

        fn terminal_takeover(registry: &RuntimeOwnershipRegistry, claim: &BindingClaim) {
            registry.fail(
                "codex",
                &claim.session_id,
                &claim.operation_id,
                claim.generation,
                false,
            );
            let BeginOutcome::Granted { generation } = registry.begin_start(
                "codex",
                &claim.session_id,
                RuntimeOwnerKind::Terminal,
                "terminal-takeover",
                None,
                "test",
                2,
            ) else {
                panic!("terminal takeover must acquire the released claim");
            };
            assert_eq!(
                registry.commit_live(
                    "codex",
                    &claim.session_id,
                    "terminal-takeover",
                    generation,
                    OwnerIdentity {
                        kind: RuntimeOwnerKind::Terminal,
                        terminal_id: Some("terminal".into()),
                        live_session_key: None,
                        pid: None,
                        ownership_id: None
                    },
                ),
                CommitOutcome::Committed
            );
        }

        fn assert_source_unpublished(fixture: &Fixture) {
            assert_eq!(
                fixture.sink.chain_terminus("codex", OLD),
                None,
                "staging must not redirect recovery from the source"
            );
            assert_eq!(
                fixture.ledger.load_binding("codex", OLD).unwrap(),
                fixture.source,
                "staging and target cleanup must leave every source-row field unchanged"
            );
            let restarted = Arc::new(PaneLedger::new(Some(
                fixture.directory.path().to_path_buf(),
            )));
            let sink = LedgerIdentitySink::new(restarted.clone(), None);
            assert_eq!(sink.chain_terminus("codex", OLD), None);
            assert_eq!(
                restarted.load_binding("codex", OLD).unwrap(),
                fixture.source
            );
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn staged_replacement_binding_keeps_source_after_takeover_and_repair() {
            let fixture = fixture().await;
            fixture
                .sink
                .stage_replacement_binding(fixture.replacement.clone())
                .await
                .unwrap();
            terminal_takeover(&fixture.registry, &fixture.source_claim);
            let owner = fixture.registry.observe("codex", OLD);
            fixture
                .sink
                .repair_failed_transition(
                    "codex",
                    NEW,
                    &fixture.target_claim.operation_id,
                    fixture.target_claim.epoch,
                    fixture.target_claim.generation,
                )
                .await
                .unwrap();
            fixture.registry.fail(
                "codex",
                NEW,
                &fixture.target_claim.operation_id,
                fixture.target_claim.generation,
                false,
            );
            assert_source_unpublished(&fixture);
            assert_eq!(fixture.registry.observe("codex", OLD), owner);
            let target = fixture.ledger.load_binding("codex", NEW).unwrap();
            assert_eq!(target.state, RowState::Retired);
            assert_eq!(target.retired_reason, Some(RetiredReason::FailedTransition));
            assert!(fixture
                .ledger
                .pending_for_terminal("replacement-pending")
                .is_some());
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn staged_replacement_binding_publishes_live_target_with_inheritance_after_restart() {
            let fixture = fixture().await;
            fixture
                .sink
                .stage_replacement_binding(fixture.replacement.clone())
                .await
                .unwrap();
            assert_source_unpublished(&fixture);
            assert!(fixture
                .ledger
                .pending_for_terminal("replacement-pending")
                .is_some());
            let staged = fixture.ledger.load_binding("codex", NEW).unwrap();
            assert_eq!(staged.create_request_id, fixture.source.create_request_id);
            assert_eq!(
                staged.origin_create_request_id,
                fixture.source.origin_create_request_id
            );
            assert_eq!(staged.client_instance_id, fixture.source.client_instance_id);
            assert_eq!(staged.device_id, fixture.source.device_id);
            assert_eq!(staged.tab_key, fixture.source.tab_key);
            assert_eq!(staged.last_attributed_at, fixture.source.last_attributed_at);
            assert_eq!(staged.model.as_deref(), Some("native-model"));
            let claim = &fixture.target_claim;
            assert_eq!(
                fixture.registry.commit_live(
                    "codex",
                    NEW,
                    &claim.operation_id,
                    claim.generation,
                    OwnerIdentity {
                        kind: RuntimeOwnerKind::FreshAgent,
                        terminal_id: None,
                        live_session_key: Some(NEW.into()),
                        pid: None,
                        ownership_id: Some(claim.operation_id.clone())
                    }
                ),
                CommitOutcome::Committed
            );
            let mut publish = fixture.replacement.clone();
            publish.claim.as_mut().unwrap().kind = BindingClaimKind::LiveFreshAgent;
            publish.settings = SettingsUpdate::Keep;
            fixture.sink.record_binding(publish).await.unwrap();
            assert_eq!(
                fixture.sink.chain_terminus("codex", OLD).as_deref(),
                Some(NEW)
            );
            assert!(fixture
                .ledger
                .pending_for_terminal("replacement-pending")
                .is_none());
            let restarted = Arc::new(PaneLedger::new(Some(
                fixture.directory.path().to_path_buf(),
            )));
            let sink = LedgerIdentitySink::new(restarted.clone(), None);
            assert_eq!(sink.chain_terminus("codex", OLD).as_deref(), Some(NEW));
            let published = restarted.load_binding("codex", NEW).unwrap();
            assert_eq!(published.state, RowState::Bound);
            assert_eq!(published.create_request_id, staged.create_request_id);
            assert_eq!(
                published.origin_create_request_id,
                staged.origin_create_request_id
            );
            assert_eq!(published.client_instance_id, staged.client_instance_id);
            assert_eq!(published.device_id, staged.device_id);
            assert_eq!(published.tab_key, staged.tab_key);
            assert_eq!(published.last_attributed_at, staged.last_attributed_at);
            assert_eq!(published.model, staged.model);
            assert_eq!(published.cwd, staged.cwd);
            assert_eq!(
                restarted.load_binding("codex", OLD).unwrap().retired_reason,
                Some(RetiredReason::Superseded)
            );
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn staged_replacement_binding_stale_final_publish_keeps_source_unchanged() {
            let fixture = fixture().await;
            fixture
                .sink
                .stage_replacement_binding(fixture.replacement.clone())
                .await
                .unwrap();
            terminal_takeover(&fixture.registry, &fixture.target_claim);
            let owner = fixture.registry.observe("codex", NEW);
            let mut publish = fixture.replacement.clone();
            publish.claim.as_mut().unwrap().kind = BindingClaimKind::LiveFreshAgent;
            let error = fixture.sink.record_binding(publish).await.unwrap_err();
            assert!(
                error.to_string().contains("STALE_TRANSITION_BINDING"),
                "{error}"
            );
            assert_source_unpublished(&fixture);
            assert_eq!(fixture.registry.observe("codex", NEW), owner);
        }

        // This exercises the real registry and ledger publication boundary.
        // Codex's inline orchestration is private to another crate; its own
        // native-recovery tests must additionally prove it retains these guards.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn staged_replacement_publication_holds_source_after_waiter_cancellation() {
            use freshell_ownership::{ObservedFence, OperationTicket, OwnershipState};
            use std::time::Duration;

            // A failed assertion must also unblock the spawn_blocking closure,
            // so this fixture cannot strand runtime shutdown at its park.
            struct ReleaseParkOnDrop(Arc<AuthoritativeWritePark>);
            impl Drop for ReleaseParkOnDrop {
                fn drop(&mut self) {
                    self.0.release();
                }
            }

            let fixture = fixture().await;
            fixture
                .sink
                .stage_replacement_binding(fixture.replacement.clone())
                .await
                .unwrap();
            fixture.registry.fail(
                "codex",
                OLD,
                &fixture.source_claim.operation_id,
                fixture.source_claim.generation,
                false,
            );
            let source = fixture.registry.observe("codex", OLD);
            assert!(matches!(source.state, OwnershipState::Vacant));
            let operation_id = "source-publication";
            let BeginOutcome::Granted { generation } = fixture.registry.begin_start(
                "codex",
                OLD,
                RuntimeOwnerKind::FreshAgent,
                operation_id,
                Some(ObservedFence {
                    epoch: source.epoch,
                    generation: source.generation,
                }),
                "test",
                2,
            ) else {
                panic!("publication must acquire the exact observed source generation");
            };
            let source_ticket = OperationTicket::new(
                fixture.registry.clone(),
                "codex",
                OLD,
                operation_id,
                RuntimeOwnerKind::FreshAgent,
                generation,
                "test",
            );
            let source_hold = source_ticket
                .hold_binding_write()
                .expect("the source publication holds its exact Starting claim");
            let held_source = fixture.registry.observe("codex", OLD);
            let target = &fixture.target_claim;
            assert_eq!(
                fixture.registry.commit_live(
                    "codex",
                    NEW,
                    &target.operation_id,
                    target.generation,
                    OwnerIdentity {
                        kind: RuntimeOwnerKind::FreshAgent,
                        terminal_id: None,
                        live_session_key: Some(NEW.into()),
                        pid: None,
                        ownership_id: Some(target.operation_id.clone())
                    },
                ),
                CommitOutcome::Committed
            );
            let live_target = fixture.registry.observe("codex", NEW);
            let mut publish = fixture.replacement.clone();
            publish.claim.as_mut().unwrap().kind = BindingClaimKind::LiveFreshAgent;
            publish.settings = SettingsUpdate::Keep;
            let park = AuthoritativeWritePark::new();
            let _release_on_drop = ReleaseParkOnDrop(park.clone());
            let publisher =
                LedgerIdentitySink::new(fixture.ledger.clone(), Some(fixture.registry.clone()))
                    .with_authoritative_park_after_validation(park.clone());
            let (completed_tx, mut completed_rx) = tokio::sync::oneshot::channel();
            let publication = tokio::spawn(async move {
                let result = publisher.record_binding(publish).await;
                // Preserve the source fence until the durable write settles,
                // including when the task awaiting this owned work is canceled.
                drop(source_ticket);
                drop(source_hold);
                let _ = completed_tx.send(result);
            });
            let waiter = tokio::spawn(publication);
            tokio::time::timeout(Duration::from_secs(5), async {
                while !park.reached() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("the final Live-claim write reaches the real sink's publication boundary");

            assert_source_unpublished(&fixture);
            assert_eq!(fixture.registry.observe("codex", NEW), live_target);
            assert!(matches!(fixture.registry.begin_start(
                "codex", OLD, RuntimeOwnerKind::Terminal, "competing-terminal-before-cancel",
                None, "test", 3,
            ), BeginOutcome::Blocked { state: OwnershipState::Starting { operation_id: held, generation: held_generation, .. }, .. }
                if held == operation_id && held_generation == generation));
            waiter.abort();
            let canceled = tokio::time::timeout(Duration::from_secs(5), waiter)
                .await
                .unwrap()
                .unwrap_err();
            assert!(canceled.is_cancelled());
            assert!(
                matches!(
                    completed_rx.try_recv(),
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty)
                ),
                "the owned publication is still pending after its waiter is gone"
            );
            assert!(
                fixture
                    .registry
                    .recover_stale_starts(u64::MAX, 0)
                    .is_empty(),
                "the pending binding hold also prevents watchdog recovery of the source"
            );
            assert_eq!(fixture.registry.observe("codex", OLD), held_source);
            assert!(matches!(fixture.registry.begin_start(
                "codex", OLD, RuntimeOwnerKind::Terminal, "competing-terminal-after-cancel",
                None, "test", 4,
            ), BeginOutcome::Blocked { state: OwnershipState::Starting { operation_id: held, generation: held_generation, .. }, .. }
                if held == operation_id && held_generation == generation));
            assert_source_unpublished(&fixture);

            park.release();
            tokio::time::timeout(Duration::from_secs(5), completed_rx)
                .await
                .expect("publication survives waiter cancellation")
                .expect("the owned publisher reports completion")
                .expect("the final binding publishes successfully");
            assert_eq!(
                fixture.sink.chain_terminus("codex", OLD).as_deref(),
                Some(NEW)
            );
            assert_eq!(fixture.registry.observe("codex", NEW), live_target);
            assert!(
                matches!(
                    fixture.registry.observe("codex", OLD).state,
                    OwnershipState::Vacant
                ),
                "the source claim releases only after publication completes"
            );
            assert_eq!(
                fixture
                    .ledger
                    .load_binding("codex", OLD)
                    .unwrap()
                    .retired_reason,
                Some(RetiredReason::Superseded)
            );
            assert_eq!(
                fixture.ledger.load_binding("codex", NEW).unwrap().state,
                RowState::Bound
            );
            let restarted = LedgerIdentitySink::new(
                Arc::new(PaneLedger::new(Some(
                    fixture.directory.path().to_path_buf(),
                ))),
                None,
            );
            assert_eq!(restarted.chain_terminus("codex", OLD).as_deref(), Some(NEW));
        }
    }

    /// Claude core design §4.1: the genesis rides the binding write, survives
    /// a restart, is kept by a later settings write, and is dropped by the
    /// lazy clear once the transcript is on disk.
    #[tokio::test(flavor = "multi_thread")]
    async fn genesis_writes_through_reads_back_and_clears() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger, None);
        let fork = freshell_freshagent::ClaudeGenesis::Fork {
            parent: "p-1".into(),
            at: Some("a-1".into()),
            drops_turn: Some("u-2".into()),
        };
        let upsert = |genesis, model: Option<&str>| FreshAgentBindingUpsert {
            genesis,
            name_transition: None,
            provider: "claude".into(),
            session_id: "s-pending".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,
            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                model: model.map(str::to_string),
                ..FreshAgentSettings::default()
            }),
        };
        sink.record_binding(upsert(
            freshell_freshagent::GenesisUpdate::Set(fork.clone()),
            None,
        ))
        .await
        .expect("awaited write succeeds");
        let recorded = sink
            .load_genesis("claude", "s-pending")
            .expect("the genesis is recorded");
        assert_eq!(recorded.genesis, fork);

        // A settings write (a model change before the first send) keeps it.
        sink.record_binding(upsert(
            freshell_freshagent::GenesisUpdate::Keep,
            Some("sonnet"),
        ))
        .await
        .expect("awaited write succeeds");
        let restarted = LedgerIdentitySink::new(
            Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
                tmp.path().to_path_buf(),
            ))),
            None,
        );
        let kept = restarted
            .load_genesis("claude", "s-pending")
            .expect("the genesis survives a settings write and a restart");
        assert_eq!(kept.genesis, fork);
        assert!(kept.updated_at_ms >= recorded.updated_at_ms);

        restarted
            .clear_genesis("claude", "s-pending")
            .await
            .expect("awaited clear succeeds");
        assert_eq!(restarted.load_genesis("claude", "s-pending"), None);
        assert_eq!(
            restarted
                .load_settings("claude", "s-pending")
                .and_then(|s| s.model)
                .as_deref(),
            Some("sonnet"),
            "the clear keeps the rest of the row"
        );
        // Clearing an identity with no row is a no-op.
        restarted
            .clear_genesis("claude", "s-none")
            .await
            .expect("a no-op clear succeeds");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rollback_record_writes_through_and_reads_back() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger, None);
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
        let sink = LedgerIdentitySink::new(ledger, None);
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
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "claude".into(),
            session_id: "s".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings::default()),
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
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
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
            collaboration_mode: None,
            model: None,
            sandbox: None,
            permission_mode: None,
            effort: None,
            cwd: Some("/w".into()),
            plugins: None,
        };
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "claude".into(),
            session_id: "fork-new-uuid".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: Some("old-uuid".into()),
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(settings.clone()),
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
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "codex".into(),
            session_id: "new-thread".into(),
            mode: "freshcodex".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: Some("old-thread".into()),
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            settings: SettingsUpdate::Replace(settings),
            observed_epoch: None,
            observed_generation: None,

            claim: None,
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

    /// b8ke ext r27 F2: the delayed-prior-generation rejection, END-TO-END
    /// through the production sink bridge + the real PaneLedger (the
    /// OpenCode target arm's shape): a handoff target's binding write
    /// stamped with the SUPPLIED handoff (epoch, generation) pair advances
    /// the row's delayed-write fence baseline, so a delayed write from the
    /// PRIOR generation (the old writer's in-flight upsert) is refused
    /// typed and the new owner's recovery row survives untouched.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_handoff_generation_binding_rejects_a_delayed_prior_generation_write() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        const EPOCH: u64 = 4_242;
        const SESSION: &str = "ses_r27_e2e";

        // The pre-handoff fresh-agent row (the old owner's pair: gen 3).
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "opencode".into(),
            session_id: SESSION.into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: Some(EPOCH),
            observed_generation: Some(3),

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                model: Some("old-model".into()),
                ..Default::default()
            }),
        })
        .await
        .expect("the pre-handoff row writes");

        // The handoff target's binding write carries the SUPPLIED handoff
        // pair (the new owner: gen 4) — the row's fence baseline advances.
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "opencode".into(),
            session_id: SESSION.into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: Some(EPOCH),
            observed_generation: Some(4),

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                model: Some("new-owner-model".into()),
                ..Default::default()
            }),
        })
        .await
        .expect("the handoff target's stamped write lands");

        // THE DELAYED PRIOR-GENERATION WRITE (the old writer's in-flight
        // upsert, carrying its PRE-handoff pair) — refused typed.
        let err = sink
            .record_binding(FreshAgentBindingUpsert {
                genesis: freshell_freshagent::GenesisUpdate::Keep,
                name_transition: None,
                provider: "opencode".into(),
                session_id: SESSION.into(),
                mode: "freshopencode".into(),
                create_request_id: None,
                resolves_pending: None,
                supersedes: None,
                provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
                observed_epoch: Some(EPOCH),
                observed_generation: Some(3),

                claim: None,
                settings: SettingsUpdate::Replace(FreshAgentSettings {
                    model: Some("stale-writer-model".into()),
                    ..Default::default()
                }),
            })
            .await
            .expect_err("the delayed prior-generation write is refused typed");
        assert!(
            err.to_string().contains("STALE_BINDING_PAIR"),
            "the refusal is typed: {err}"
        );

        // The new owner's row survived: the handoff pair + the new owner's
        // settings, never the stale writer's.
        let row = ledger
            .load_binding("opencode", SESSION)
            .expect("the row survives");
        assert_eq!(row.owner_epoch, Some(EPOCH));
        assert_eq!(row.owner_generation, Some(4));
        assert_eq!(row.model.as_deref(), Some("new-owner-model"));
        assert_eq!(row.pane_kind.as_deref(), Some("fresh-agent"));
    }

    /// b8ke ext r27 F1: a stale FENCED fresh-agent compensation cannot
    /// overwrite the new TERMINAL owner's authoritative recovery row.
    /// The exact race the in-memory OpenCode create/resume path leaves
    /// behind when a handoff commits while its binding write is stalled:
    /// the compensation now carries the OBSERVED (pre-handoff) pair, so
    /// the real ledger's delayed-write fence REFUSES it typed — the
    /// terminal owner's runtime kind AND terminal identity survive
    /// (pre-r27 the unfenced compensation replaced the shared row with
    /// live_terminal_id: None and pane_kind: "fresh-agent").
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stale_fenced_compensation_cannot_overwrite_the_terminal_owners_recovery_row() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        const EPOCH: u64 = 9_191;
        const SESSION: &str = "ses_r27_f1_race";

        // The pre-handoff fresh-agent row (the old owner's pair: gen 3).
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "opencode".into(),
            session_id: SESSION.into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: Some(EPOCH),
            observed_generation: Some(3),

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings::default()),
        })
        .await
        .expect("the pre-handoff row writes");

        // THE HANDOFF COMMITS mid-write: the terminal target's row write
        // (stamped with the handoff's newer pair) lands while the stale
        // create's binding write is still stalled.
        ledger
            .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                provider: "opencode",
                session_id: SESSION,
                terminal_id: "t-mid-await",
                mode: "opencode",
                cwd: Some("/w"),
                create_request_id: None,
                origin_create_request_id: None,
                provenance: freshell_ws::pane_ledger::ProvenancePolicy::Clear,
                observed_epoch: Some(EPOCH),
                observed_generation: Some(4),
                now_ms: 1_200,
            })
            .expect("the handoff's terminal-side row write lands");

        // THE STALE COMPENSATION (the delayed create's rollback upsert,
        // carrying its OBSERVED pre-handoff pair) — refused typed.
        let err = sink
            .record_binding(FreshAgentBindingUpsert {
                genesis: freshell_freshagent::GenesisUpdate::Keep,
                name_transition: None,
                provider: "opencode".into(),
                session_id: SESSION.into(),
                mode: "freshopencode".into(),
                create_request_id: None,
                resolves_pending: None,
                supersedes: None,
                // keep-when-None provenance — the compensating rollback's
                // shape.
                provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
                observed_epoch: Some(EPOCH),
                observed_generation: Some(3),

                claim: None,
                settings: SettingsUpdate::Replace(FreshAgentSettings::default()),
            })
            .await
            .expect_err("the stale fenced compensation is refused typed");
        assert!(
            err.to_string().contains("STALE_BINDING_PAIR"),
            "the refusal is typed: {err}"
        );

        // The TERMINAL owner's authoritative recovery row SURVIVED: its
        // runtime kind (a terminal row — pane_kind None, live_terminal_id
        // set) AND its terminal identity, with the handoff's fence pair.
        let row = ledger
            .load_binding("opencode", SESSION)
            .expect("the row survives");
        assert_eq!(row.pane_kind, None, "the terminal row's kind stands");
        assert_eq!(
            row.live_terminal_id.as_deref(),
            Some("t-mid-await"),
            "the terminal owner's identity stands — the stale fresh-agent \
             compensation did not erase it"
        );
        assert_eq!(row.owner_epoch, Some(EPOCH));
        assert_eq!(row.owner_generation, Some(4));
    }

    // ── kata b8ke focused ep5 r3 F1: the authoritative write's ownership
    // re-validation — the canceled/superseded handoff's orphaned
    // spawn_blocking closure refuses typed against the coordinator's
    // EXECUTION-TIME truth. ─────────────────────────────────────────────
    //
    // The shared rig: a real tempdir-rooted PaneLedger + the REAL
    // runtime-ownership coordinator, driven through its public
    // begin/commit/fail transitions exactly the way the runner and the
    // abort cleanup drive it. The park proves the consult reads the
    // POST-CANCEL state: the write is spawned and PARKED at the closure's
    // entry, the handoff is then canceled (the settled coordinator
    // effect of the abort cleanup's reap + fail), and only then is the
    // closure RELEASED — the exact surviving-closure shape the finding
    // names.
    mod ep5_r3_authoritative_revalidation {
        use super::*;
        use freshell_ownership::{
            BeginOutcome, CommitOutcome, FailOutcome, ObservedFence, OwnerIdentity,
            RuntimeOwnerKind, RuntimeOwnershipRegistry,
        };

        const SID: &str = "ses-ep5-r3";
        const EPOCH_MS: u64 = 0;

        fn terminal_owner(terminal_id: &str) -> OwnerIdentity {
            OwnerIdentity {
                kind: RuntimeOwnerKind::Terminal,
                terminal_id: Some(terminal_id.to_string()),
                live_session_key: None,
                pid: Some(40_000),
                ownership_id: None,
            }
        }

        fn fresh_agent_owner() -> OwnerIdentity {
            OwnerIdentity {
                kind: RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: Some("fake-claude-session-x".into()),
                pid: Some(41_000),
                ownership_id: Some("own-x".into()),
            }
        }

        /// The ordinary TERMINAL recovery row — the NORMAL production
        /// shape (unstamped: ordinary WS/REST/MCP terminal binding writes
        /// stamp nothing).
        fn seed_terminal_row(ledger: &Arc<PaneLedger>, terminal_id: &str) {
            ledger
                .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                    provider: "claude",
                    session_id: SID,
                    terminal_id,
                    mode: "claude",
                    cwd: Some("/w"),
                    create_request_id: None,
                    origin_create_request_id: None,
                    provenance: freshell_ws::pane_ledger::ProvenancePolicy::Clear,
                    observed_epoch: None,
                    observed_generation: None,
                    now_ms: 100,
                })
                .expect("the terminal recovery row seeds");
        }

        fn authoritative_upsert(
            epoch: u64,
            generation: u64,
            operation_id: Option<&str>,
        ) -> FreshAgentBindingUpsert {
            FreshAgentBindingUpsert {
                genesis: freshell_freshagent::GenesisUpdate::Keep,
                name_transition: None,
                provider: "claude".into(),
                session_id: SID.into(),
                mode: "freshclaude".into(),
                create_request_id: None,
                resolves_pending: None,
                supersedes: None,
                provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
                observed_epoch: Some(epoch),
                observed_generation: Some(generation),
                claim: operation_id.map(|operation_id| {
                    BindingClaim::handoff("claude", SID, operation_id, epoch, generation)
                }),
                settings: SettingsUpdate::Replace(FreshAgentSettings {
                    model: Some("stale-or-current".into()),
                    ..Default::default()
                }),
            }
        }

        fn starting_upsert(
            epoch: u64,
            generation: u64,
            operation_id: &str,
        ) -> FreshAgentBindingUpsert {
            FreshAgentBindingUpsert {
                genesis: freshell_freshagent::GenesisUpdate::Keep,
                name_transition: None,
                provider: "claude".into(),
                session_id: SID.into(),
                mode: "freshclaude".into(),
                create_request_id: None,
                resolves_pending: None,
                supersedes: None,
                provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
                observed_epoch: Some(epoch),
                observed_generation: Some(generation),
                claim: Some(BindingClaim {
                    provider: "claude".into(),
                    session_id: SID.into(),
                    operation_id: operation_id.into(),
                    epoch,
                    generation,
                    kind: BindingClaimKind::Starting,
                }),
                settings: SettingsUpdate::Keep,
            }
        }

        /// Drive the coordinator to `Live{Terminal}` at generation 1 — the
        /// pre-handoff world.
        fn drive_terminal_live(registry: &RuntimeOwnershipRegistry) {
            match registry.begin_start(
                "claude",
                SID,
                RuntimeOwnerKind::Terminal,
                "op-term-1",
                None,
                "test",
                EPOCH_MS,
            ) {
                BeginOutcome::Granted { generation } => {
                    assert_eq!(
                        registry.commit_live(
                            "claude",
                            SID,
                            "op-term-1",
                            generation,
                            terminal_owner("t-old"),
                        ),
                        CommitOutcome::Committed
                    );
                }
                other => panic!("the terminal start must be granted: {other:?}"),
            }
        }

        /// Drive the coordinator into the handoff's window (the runner's
        /// `begin_handoff`) and answer the granted generation.
        fn drive_handoff_window(registry: &RuntimeOwnershipRegistry, operation_id: &str) -> u64 {
            match registry.begin_handoff(
                "claude",
                SID,
                RuntimeOwnerKind::FreshAgent,
                operation_id,
                None,
                "test",
                EPOCH_MS,
            ) {
                BeginOutcome::Granted { generation } => generation,
                other => panic!("the handoff must be granted: {other:?}"),
            }
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn the_canceled_handoffs_orphaned_write_is_refused_over_the_restored_prior_terminal_row(
        ) {
            let tmp = tempfile::tempdir().unwrap();
            let ledger = Arc::new(PaneLedger::new(Some(tmp.path().to_path_buf())));
            let registry = Arc::new(RuntimeOwnershipRegistry::new());
            drive_terminal_live(&registry);
            let generation = drive_handoff_window(&registry, "op-handoff-1");
            seed_terminal_row(&ledger, "t-old");

            // The write is spawned and PARKED at the closure's entry — the
            // handoff is still live, the write is legitimate SO FAR.
            let park = AuthoritativeWritePark::new();
            let sink = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .with_authoritative_park(park.clone());
            let write_epoch = registry.boot_epoch();
            let write = tokio::spawn(async move {
                sink.record_binding(authoritative_upsert(
                    write_epoch,
                    generation,
                    Some("op-handoff-1"),
                ))
                .await
            });
            while !park.reached() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }

            // THE CANCEL (the abort cleanup's settled effect): the handoff
            // operation fails, restoring the confirmed-live prior owner.
            assert_eq!(
                registry.fail("claude", SID, "op-handoff-1", generation, true),
                FailOutcome::RestoredPriorOwner
            );

            // RELEASE the surviving closure: the consult must read the
            // post-cancel truth and refuse typed.
            park.release();
            let err = write
                .await
                .expect("the write task joins")
                .expect_err("the orphaned authoritative write is refused typed");
            assert!(
                err.to_string().contains("STALE_TRANSITION_BINDING"),
                "the refusal is the ownership consult's typed error: {err}"
            );

            // The restored terminal's recovery row SURVIVED: still the
            // terminal's ordinary unstamped shape — never the reaped
            // target's fresh-agent metadata.
            let row = ledger
                .load_binding("claude", SID)
                .expect("the row survives");
            assert_eq!(row.pane_kind, None, "the terminal row's kind stands");
            assert_eq!(
                row.live_terminal_id.as_deref(),
                Some("t-old"),
                "the restored prior terminal's identity stands"
            );
            assert_eq!(
                (row.owner_epoch, row.owner_generation),
                (None, None),
                "the ordinary terminal row stays unstamped: {row:?}"
            );
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn the_canceled_handoffs_orphaned_write_is_refused_over_a_newly_attached_terminals_row(
        ) {
            let tmp = tempfile::tempdir().unwrap();
            let ledger = Arc::new(PaneLedger::new(Some(tmp.path().to_path_buf())));
            let registry = Arc::new(RuntimeOwnershipRegistry::new());
            drive_terminal_live(&registry);
            let generation = drive_handoff_window(&registry, "op-handoff-1");
            seed_terminal_row(&ledger, "t-old");

            // The orphaned write, parked in flight.
            let park = AuthoritativeWritePark::new();
            let sink = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .with_authoritative_park(park.clone());
            let write_epoch = registry.boot_epoch();
            let write = tokio::spawn(async move {
                sink.record_binding(authoritative_upsert(
                    write_epoch,
                    generation,
                    Some("op-handoff-1"),
                ))
                .await
            });
            while !park.reached() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }

            // THE CANCEL: the prior was reaped (dead) — the key ends Vacant.
            assert_eq!(
                registry.fail("claude", SID, "op-handoff-1", generation, false),
                FailOutcome::Vacant {
                    reason: freshell_ownership::FailVacantReason::PriorNotLive
                }
            );

            // A NEW terminal attaches (the ordinary claim path) and writes
            // its ordinary UNSTAMPED recovery row over the session.
            match registry.begin_start(
                "claude",
                SID,
                RuntimeOwnerKind::Terminal,
                "op-term-2",
                Some(ObservedFence {
                    epoch: registry.boot_epoch(),
                    generation,
                }),
                "test",
                EPOCH_MS,
            ) {
                BeginOutcome::Granted { generation } => {
                    assert_eq!(
                        registry.commit_live(
                            "claude",
                            SID,
                            "op-term-2",
                            generation,
                            terminal_owner("t-new"),
                        ),
                        CommitOutcome::Committed
                    );
                }
                other => panic!("the new terminal's start must be granted: {other:?}"),
            }
            ledger
                .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                    provider: "claude",
                    session_id: SID,
                    terminal_id: "t-new",
                    mode: "claude",
                    cwd: Some("/w"),
                    create_request_id: None,
                    origin_create_request_id: None,
                    provenance: freshell_ws::pane_ledger::ProvenancePolicy::Clear,
                    observed_epoch: None,
                    observed_generation: None,
                    now_ms: 200,
                })
                .expect("the new terminal's ordinary row lands");

            // RELEASE the surviving closure — the consult sees the NEW
            // terminal's Live record (a terminal owner, a newer
            // generation): refused typed, the new terminal's row intact.
            park.release();
            let err = write
                .await
                .expect("the write task joins")
                .expect_err("the orphaned authoritative write is refused typed");
            assert!(
                err.to_string().contains("STALE_TRANSITION_BINDING"),
                "the refusal is the ownership consult's typed error: {err}"
            );
            let row = ledger
                .load_binding("claude", SID)
                .expect("the row survives");
            assert_eq!(row.pane_kind, None, "the new terminal's row kind stands");
            assert_eq!(
                row.live_terminal_id.as_deref(),
                Some("t-new"),
                "the newly attached terminal's identity stands — the stale \
                 fresh-agent metadata never replaced it"
            );
            assert_eq!(
                (row.owner_epoch, row.owner_generation),
                (None, None),
                "the ordinary attach stays unstamped: {row:?}"
            );
        }

        /// The SUCCESS arms: the consult passes while the write's own
        /// handoff owns the transition — the runner's Handoff window (the
        /// codex/opencode in-flight shape) AND the committed Live{FreshAgent}
        /// (the claude post-commit shape) — and the write LANDS over the
        /// ordinary unstamped terminal row (the r2 exception's purpose).
        #[tokio::test(flavor = "multi_thread")]
        async fn the_authoritative_write_lands_while_its_handoff_owns_the_transition() {
            let tmp = tempfile::tempdir().unwrap();
            let ledger = Arc::new(PaneLedger::new(Some(tmp.path().to_path_buf())));
            let registry = Arc::new(RuntimeOwnershipRegistry::new());
            drive_terminal_live(&registry);
            let generation = drive_handoff_window(&registry, "op-handoff-1");
            seed_terminal_row(&ledger, "t-old");

            // IN-WINDOW (Handoff{generation}): the parked write is
            // released while the runner's operation still holds the key —
            // the consult passes, the row flips to the fresh-agent
            // target's.
            let park = AuthoritativeWritePark::new();
            let sink = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .with_authoritative_park(park.clone());
            let write_epoch = registry.boot_epoch();
            let write = tokio::spawn(async move {
                sink.record_binding(authoritative_upsert(
                    write_epoch,
                    generation,
                    Some("op-handoff-1"),
                ))
                .await
            });
            while !park.reached() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            park.release();
            write
                .await
                .expect("the write task joins")
                .expect("the in-window authoritative write lands");
            let row = ledger.load_binding("claude", SID).expect("the row");
            assert_eq!(row.pane_kind.as_deref(), Some("fresh-agent"));
            assert_eq!(row.live_terminal_id, None);

            // The in-window handoff completes (the runner's commit).
            assert_eq!(
                registry.commit_live(
                    "claude",
                    SID,
                    "op-handoff-1",
                    generation,
                    fresh_agent_owner(),
                ),
                CommitOutcome::Committed
            );

            // POST-COMMIT (Live{FreshAgent, generation}): a second
            // handoff's committed target write also lands (the claude
            // under-ticket shape).
            let generation_2 = drive_handoff_window(&registry, "op-handoff-2");
            assert_eq!(
                registry.commit_live(
                    "claude",
                    SID,
                    "op-handoff-2",
                    generation_2,
                    fresh_agent_owner(),
                ),
                CommitOutcome::Committed
            );
            LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .record_binding({
                    let epoch = registry.boot_epoch();
                    let mut upsert =
                        authoritative_upsert(epoch, generation_2, Some("op-handoff-2"));
                    upsert.claim = Some(BindingClaim::live_fresh_agent(
                        "claude",
                        SID,
                        "own-x",
                        epoch,
                        generation_2,
                    ));
                    upsert
                })
                .await
                .expect("the post-commit authoritative write lands");
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn live_binding_claim_and_sink_accept_different_or_absent_runtime_keys() {
            for live_session_key in [None, Some("provider-runtime-key".to_string())] {
                let tmp = tempfile::tempdir().unwrap();
                let ledger = Arc::new(PaneLedger::new(Some(tmp.path().to_path_buf())));
                let registry = Arc::new(RuntimeOwnershipRegistry::new());
                drive_terminal_live(&registry);
                let generation = drive_handoff_window(&registry, "claim-predicate-handoff");
                seed_terminal_row(&ledger, "t-old");
                LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                    .record_binding(authoritative_upsert(
                        registry.boot_epoch(),
                        generation,
                        Some("claim-predicate-handoff"),
                    ))
                    .await
                    .expect("the handoff establishes the fresh-agent row before a live refresh");
                let mut owner = fresh_agent_owner();
                owner.live_session_key = live_session_key;
                assert_eq!(
                    registry.commit_live(
                        "claude",
                        SID,
                        "claim-predicate-handoff",
                        generation,
                        owner
                    ),
                    CommitOutcome::Committed
                );
                let claim = BindingClaim::live_fresh_agent(
                    "claude",
                    SID,
                    "own-x",
                    registry.boot_epoch(),
                    generation,
                );
                let mut upsert = authoritative_upsert(registry.boot_epoch(), generation, None);
                upsert.claim = Some(claim.clone());
                LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                    .record_binding(upsert)
                    .await
                    .expect("the exact settled owner may persist regardless of runtime lookup key");
                assert_eq!(
                    ledger
                        .load_binding("claude", SID)
                        .unwrap()
                        .pane_kind
                        .as_deref(),
                    Some("fresh-agent")
                );
                assert!(
                    claim.is_current(&registry),
                    "recovery classification must agree with the sink's accepted exact owner"
                );
                let mut foreign = claim.clone();
                foreign.operation_id = "different-owner".into();
                assert!(!foreign.is_current(&registry));
            }
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn live_owner_settings_refresh_survives_another_operations_same_generation_fence() {
            let tmp = tempfile::tempdir().unwrap();
            let ledger = Arc::new(PaneLedger::new(Some(tmp.path().to_path_buf())));
            let registry = Arc::new(RuntimeOwnershipRegistry::new());
            let epoch = registry.boot_epoch();
            let operation_id = "restored-live-owner";
            let generation = match registry.begin_start(
                "claude",
                SID,
                RuntimeOwnerKind::FreshAgent,
                operation_id,
                None,
                "test-live-settings-refresh",
                EPOCH_MS,
            ) {
                BeginOutcome::Granted { generation } => generation,
                other => panic!("the fresh-agent owner start must be granted: {other:?}"),
            };
            assert_eq!(
                registry.commit_live(
                    "claude",
                    SID,
                    operation_id,
                    generation,
                    OwnerIdentity {
                        kind: RuntimeOwnerKind::FreshAgent,
                        terminal_id: None,
                        live_session_key: Some(SID.into()),
                        pid: Some(42_000),
                        ownership_id: Some(operation_id.into()),
                    },
                ),
                CommitOutcome::Committed
            );
            let current_claim = BindingClaim::current_live_fresh_agent(&registry, "claude", SID)
                .expect("the registry supplies the exact current live owner");
            assert_eq!(current_claim.operation_id, operation_id);
            assert_eq!(
                (current_claim.epoch, current_claim.generation),
                (epoch, generation)
            );

            let sink = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()));
            let upsert = |settings: FreshAgentSettings| FreshAgentBindingUpsert {
                genesis: freshell_freshagent::GenesisUpdate::Keep,
                name_transition: None,
                provider: "claude".into(),
                session_id: SID.into(),
                mode: "freshclaude".into(),
                create_request_id: None,
                resolves_pending: None,
                supersedes: None,
                provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
                observed_epoch: Some(epoch),
                observed_generation: Some(generation),
                claim: Some(current_claim.clone()),
                settings: SettingsUpdate::Replace(settings),
            };
            sink.record_binding(upsert(FreshAgentSettings {
                model: Some("remembered-model".into()),
                ..Default::default()
            }))
            .await
            .expect("the exact live owner seeds its durable settings row");

            // A failed sibling operation at this pair installs a scoped
            // tombstone. Its row projection must preserve the restored live
            // owner's exact operation identity and settings.
            sink.repair_failed_transition(
                "claude",
                SID,
                "failed-sibling-operation",
                epoch,
                generation,
            )
            .await
            .expect("the failed sibling operation's durable fence lands");
            let preserved = ledger
                .load_binding("claude", SID)
                .expect("the current owner's row survives repair");
            assert_eq!(preserved.state, freshell_ws::pane_ledger::RowState::Bound);
            assert_eq!(preserved.owner_operation_id.as_deref(), Some(operation_id));
            assert_eq!(preserved.model.as_deref(), Some("remembered-model"));

            // An already-validated write from the failed operation remains
            // suppressed by the precise operation fence, even at the same
            // ownership pair as the restored live row.
            let failed_claim = BindingClaim {
                provider: "claude".into(),
                session_id: SID.into(),
                operation_id: "failed-sibling-operation".into(),
                epoch,
                generation,
                kind: BindingClaimKind::Handoff,
            };
            ledger
                .record_fresh_agent_binding_claimed(
                    &freshell_ws::pane_ledger::FreshAgentBindingWrite {
                        collaboration_mode: None,
                        provider: "claude",
                        session_id: SID,
                        mode: "freshclaude",
                        cwd: None,
                        create_request_id: None,
                        model: Some("failed-operation-model"),
                        sandbox: None,
                        permission_mode: None,
                        effort: None,
                        plugins: None,
                        genesis: freshell_ws::pane_ledger::GenesisWrite::Keep,
                        supersedes: None,
                        provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
                        observed_epoch: Some(epoch),
                        observed_generation: Some(generation),
                        now_ms: 200,
                    },
                    Some(&failed_claim),
                    &SettingsUpdate::Replace(FreshAgentSettings {
                        model: Some("failed-operation-model".into()),
                        ..Default::default()
                    }),
                )
                .expect("the exact failed-operation write is harmlessly suppressed");
            assert_eq!(
                ledger.load_binding("claude", SID).unwrap().model.as_deref(),
                Some("remembered-model"),
                "the delayed failed operation cannot overwrite current-owner settings"
            );

            // A claimless refresh is deliberately refused by the same-generation
            // failed-operation fence, even when the observed pair belongs to a
            // restored owner. The provider must carry an exact current-owner
            // claim; silently inferring one here would let delayed old writes
            // borrow the newer owner's authority.
            let mut refresh = upsert(FreshAgentSettings {
                model: Some("refreshed-model".into()),
                effort: Some("high".into()),
                ..Default::default()
            });
            refresh.claim = None;
            sink.record_binding(refresh)
                .await
                .expect("the claimless stale refresh is harmlessly suppressed");
            let restarted = PaneLedger::new(Some(tmp.path().to_path_buf()));
            let durable = restarted
                .load_binding("claude", SID)
                .expect("the current owner's row survives ledger reload");
            assert_eq!(durable.state, freshell_ws::pane_ledger::RowState::Bound);
            assert_eq!(durable.owner_operation_id.as_deref(), Some(operation_id));
            assert_eq!(durable.model.as_deref(), Some("remembered-model"));
            assert_eq!(durable.effort, None);

            // A LiveFreshAgent claim is not takeover authority for a durable
            // active-terminal recovery row, even when it names the exact live
            // coordinator owner and pair.
            let terminal_session = "ses-active-terminal";
            let terminal_registry = Arc::new(RuntimeOwnershipRegistry::new());
            let terminal_epoch = terminal_registry.boot_epoch();
            let terminal_owner_id = "live-agent-over-terminal-row";
            let terminal_generation = match terminal_registry.begin_start(
                "claude",
                terminal_session,
                RuntimeOwnerKind::FreshAgent,
                terminal_owner_id,
                None,
                "test-active-terminal-row",
                EPOCH_MS,
            ) {
                BeginOutcome::Granted { generation } => generation,
                other => panic!("the owner start must be granted: {other:?}"),
            };
            assert_eq!(
                terminal_registry.commit_live(
                    "claude",
                    terminal_session,
                    terminal_owner_id,
                    terminal_generation,
                    OwnerIdentity {
                        kind: RuntimeOwnerKind::FreshAgent,
                        terminal_id: None,
                        live_session_key: Some(terminal_session.into()),
                        pid: Some(42_001),
                        ownership_id: Some(terminal_owner_id.into()),
                    },
                ),
                CommitOutcome::Committed
            );
            ledger
                .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                    provider: "claude",
                    session_id: terminal_session,
                    terminal_id: "active-terminal",
                    mode: "claude",
                    cwd: Some("/w"),
                    create_request_id: None,
                    origin_create_request_id: None,
                    provenance: freshell_ws::pane_ledger::ProvenancePolicy::Clear,
                    observed_epoch: None,
                    observed_generation: None,
                    now_ms: 201,
                })
                .expect("the active terminal row seeds");
            let terminal_claim = BindingClaim::current_live_fresh_agent(
                &terminal_registry,
                "claude",
                terminal_session,
            )
            .expect("the exact live agent owner is current");
            let terminal_attempt = LedgerIdentitySink::new(ledger.clone(), Some(terminal_registry))
                .record_binding(FreshAgentBindingUpsert {
                    genesis: freshell_freshagent::GenesisUpdate::Keep,
                    name_transition: None,
                    provider: "claude".into(),
                    session_id: terminal_session.into(),
                    mode: "freshclaude".into(),
                    create_request_id: None,
                    resolves_pending: None,
                    supersedes: None,
                    provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
                    observed_epoch: Some(terminal_epoch),
                    observed_generation: Some(terminal_generation),
                    claim: Some(terminal_claim),
                    settings: SettingsUpdate::Replace(FreshAgentSettings {
                        model: Some("must-not-take-over-terminal".into()),
                        ..Default::default()
                    }),
                })
                .await
                .expect_err("a live-agent refresh cannot take over an active terminal row");
            assert!(
                terminal_attempt
                    .to_string()
                    .contains("NOT_NEWER_BINDING_OVER_TERMINAL"),
                "active-terminal refusal remains the ledger's typed outcome: {terminal_attempt}"
            );
            let terminal_row = ledger
                .load_binding("claude", terminal_session)
                .expect("the terminal recovery row remains");
            assert_eq!(
                terminal_row.live_terminal_id.as_deref(),
                Some("active-terminal")
            );
            assert_eq!(terminal_row.pane_kind, None);
        }

        /// A SUPERSEDED handoff's stale authoritative write (a later
        /// transition moved the key to a NEWER generation) is refused —
        /// the delayed write can never clobber the newer owner's row.
        #[tokio::test(flavor = "multi_thread")]
        async fn a_superseded_handoffs_stale_authoritative_write_is_refused() {
            let tmp = tempfile::tempdir().unwrap();
            let ledger = Arc::new(PaneLedger::new(Some(tmp.path().to_path_buf())));
            let registry = Arc::new(RuntimeOwnershipRegistry::new());
            drive_terminal_live(&registry);
            let generation = drive_handoff_window(&registry, "op-handoff-1");

            // The key moved on: the later handoff committed gen 2 → then a
            // THIRD transition (gen 3) committed a newer fresh-agent
            // owner.
            assert_eq!(
                registry.commit_live(
                    "claude",
                    SID,
                    "op-handoff-1",
                    generation,
                    fresh_agent_owner(),
                ),
                CommitOutcome::Committed
            );
            let generation_2 = drive_handoff_window(&registry, "op-handoff-2");
            assert_eq!(
                registry.commit_live(
                    "claude",
                    SID,
                    "op-handoff-2",
                    generation_2,
                    fresh_agent_owner(),
                ),
                CommitOutcome::Committed
            );

            // The stale write still carries the FIRST handoff's pair —
            // refused typed at the consult.
            let err = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .record_binding(authoritative_upsert(
                    registry.boot_epoch(),
                    generation,
                    Some("op-handoff-1"),
                ))
                .await
                .expect_err("the superseded handoff's stale write is refused");
            assert!(
                err.to_string().contains("STALE_TRANSITION_BINDING"),
                "the refusal is the ownership consult's typed error: {err}"
            );
        }

        /// The remaining refusal cells: Vacant, a foreign Handoff
        /// generation, an epoch mismatch, a missing observed pair, and a
        /// bridge with no coordinator wired — every one fails closed.
        #[tokio::test(flavor = "multi_thread")]
        async fn vacant_foreign_epoch_and_malformed_authoritative_writes_all_refuse() {
            let tmp = tempfile::tempdir().unwrap();
            let ledger = Arc::new(PaneLedger::new(Some(tmp.path().to_path_buf())));
            let registry = Arc::new(RuntimeOwnershipRegistry::new());
            let epoch = registry.boot_epoch();

            // VACANT (no record at all): refused.
            LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .record_binding(authoritative_upsert(epoch, 2, Some("never-started")))
                .await
                .expect_err("an authoritative write over a vacant key is refused");

            // A FOREIGN handoff generation (the write's pair names a
            // transition that never was): drive Handoff at gen 1, write
            // carrying gen 2 — refused.
            let generation = drive_handoff_window(&registry, "op-handoff-x");
            assert_eq!(generation, 1);
            LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .record_binding(authoritative_upsert(epoch, 2, Some("op-handoff-x")))
                .await
                .expect_err("an authoritative write naming a foreign generation is refused");

            // EPOCH MISMATCH (a pre-restart pair against this boot's
            // registry): refused.
            LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .record_binding(authoritative_upsert(
                    epoch + 1,
                    generation,
                    Some("op-handoff-x"),
                ))
                .await
                .expect_err("an authoritative write from a foreign boot epoch is refused");

            // MISSING PAIR: an authoritative write without its observed
            // (epoch, generation) cannot re-validate — refused.
            LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .record_binding({
                    let mut u = authoritative_upsert(epoch, generation, Some("op-handoff-x"));
                    u.observed_generation = None;
                    u
                })
                .await
                .expect_err("an authoritative write without its observed pair is refused");

            // NO COORDINATOR WIRED (a bridge that could not re-validate at
            // all): an authoritative marker only ever comes from
            // coordinator-driven handoff lanes — fail closed.
            LedgerIdentitySink::new(ledger.clone(), None)
                .record_binding(authoritative_upsert(
                    epoch,
                    generation,
                    Some("op-handoff-x"),
                ))
                .await
                .expect_err("an authoritative write over an unwired bridge is refused");

            assert!(
                ledger.load_binding("claude", SID).is_none(),
                "no refused write ever created a row: {:?}",
                ledger.load_binding("claude", SID)
            );
        }

        /// NON-AUTHORITATIVE writes bypass the consult entirely: the r2
        /// ledger matrix governs them unchanged — a lane write over a
        /// FRESH row lands with the coordinator in ANY state (Vacant
        /// here), and a non-authoritative write over a terminal-bound row
        /// still gets the LEDGER's typed refusal (NOT_NEWER — not the
        /// consult's).
        #[tokio::test(flavor = "multi_thread")]
        async fn non_authoritative_writes_bypass_the_transition_consult() {
            let tmp = tempfile::tempdir().unwrap();
            let ledger = Arc::new(PaneLedger::new(Some(tmp.path().to_path_buf())));
            let registry = Arc::new(RuntimeOwnershipRegistry::new());
            let epoch = registry.boot_epoch();

            // Fresh row, coordinator Vacant: the ordinary lane write lands
            // (the consult never fires for authoritative: false).
            LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .record_binding(authoritative_upsert(epoch, 0, None))
                .await
                .expect("the non-authoritative write lands over a fresh row");
            assert!(ledger.load_binding("claude", SID).is_some());

            // Over a terminal-bound row: the LEDGER's r2 guard refuses it
            // with its own typed error — proving the consult did not
            // intervene (a fresh sink row for the terminal shape).
            let ledger2 = Arc::new(PaneLedger::new(Some(
                tempfile::tempdir().unwrap().path().to_path_buf(),
            )));
            seed_terminal_row(&ledger2, "t-plain");
            let err = LedgerIdentitySink::new(ledger2.clone(), Some(registry.clone()))
                .record_binding(authoritative_upsert(epoch, 0, None))
                .await
                .expect_err("the ledger's own terminal-row guard refuses it");
            assert!(
                err.to_string().contains("NOT_NEWER_BINDING_OVER_TERMINAL"),
                "the refusal is the LEDGER's r2 typed error, not the consult's: {err}"
            );
        }

        /// b8ke focused ep5 r4 F1 — the VALIDATED-THEN-CANCELED ordering
        /// (the round-4 reviewer's first named ordering): the write's
        /// ownership consult PASSES (the handoff owns the transition),
        /// the closure parks BETWEEN the consult and the ledger mutation,
        /// the handoff then fails (the abort cleanup's settled effect:
        /// repair-then-fail, the runner's exact order), and only then is
        /// the closure released. The repair's durable tombstone fence
        /// suppresses the late mutation — the row NEVER becomes the
        /// reaped target's fresh-agent row.
        #[tokio::test(flavor = "multi_thread")]
        async fn the_validated_then_canceled_write_is_fenced_and_the_row_stays_consistent() {
            let tmp = tempfile::tempdir().unwrap();
            let ledger = Arc::new(PaneLedger::new(Some(tmp.path().to_path_buf())));
            let registry = Arc::new(RuntimeOwnershipRegistry::new());
            drive_terminal_live(&registry);
            let generation = drive_handoff_window(&registry, "op-handoff-vc");
            seed_terminal_row(&ledger, "t-old");

            // The write consults (Handoff owns the transition at gen 2) and
            // parks AFTER validation — before the ledger mutation.
            let park = AuthoritativeWritePark::new();
            let sink = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .with_authoritative_park_after_validation(park.clone());
            let write_epoch = registry.boot_epoch();
            let write = tokio::spawn(async move {
                sink.record_binding(authoritative_upsert(
                    write_epoch,
                    generation,
                    Some("op-handoff-vc"),
                ))
                .await
            });
            while !park.reached() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }

            // THE CANCEL (the abort cleanup's exact order): the repair
            // lands (the reap's ledger act), then the coordinator entry
            // fails with the restore.
            let repair_sink = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()));
            repair_sink
                .repair_failed_transition("claude", SID, "op-handoff-vc", write_epoch, generation)
                .await
                .expect("the cleanup's repair lands");
            assert_eq!(
                registry.fail("claude", SID, "op-handoff-vc", generation, true),
                FailOutcome::RestoredPriorOwner
            );

            // RELEASE the validated closure: the ledger's tombstone consult
            // suppresses the mutation wholesale (Ok — never an error, never
            // a row).
            park.release();
            let outcome = write.await.expect("the write task joins");
            assert!(
                outcome.is_ok(),
                "the suppressed write answers Ok (suppression, not error): {:?}",
                outcome.err()
            );
            let row = ledger.load_binding("claude", SID).expect("the row");
            assert_eq!(
                row.state,
                freshell_ws::pane_ledger::RowState::Bound,
                "the restored terminal remains recoverable after the canceled write: {row:?}"
            );
            assert_eq!(
                row.pane_kind, None,
                "the reaped target's fresh-agent metadata never landed: {row:?}"
            );
            assert_eq!(
                row.live_terminal_id.as_deref(),
                Some("t-old"),
                "the restored terminal's identity survives: {row:?}"
            );
            // The durable fence is fed (a still-in-flight sibling closure
            // from the same transition would face it too).
            assert!(ledger.kill_tombstone_at("claude", SID).is_some());
        }

        /// The same validated-then-canceled race applies to a lane-owned
        /// Starting claim. Its repair must land before the claim is released:
        /// a terminal can then take ownership, and the old already-validated
        /// closure is suppressed by the scoped tombstone instead of replacing
        /// an unstamped terminal row.
        #[tokio::test(flavor = "multi_thread")]
        async fn validated_starting_write_is_repaired_before_terminal_owner_can_take_over() {
            use freshell_ownership::{BeginOutcome, FailOutcome};

            let tmp = tempfile::tempdir().unwrap();
            let ledger = Arc::new(PaneLedger::new(Some(tmp.path().to_path_buf())));
            let registry = Arc::new(RuntimeOwnershipRegistry::new());
            seed_terminal_row(&ledger, "t-original");
            let epoch = registry.boot_epoch();
            let operation_id = "op-start-canceled";
            let generation = match registry.begin_start(
                "claude",
                SID,
                RuntimeOwnerKind::FreshAgent,
                operation_id,
                None,
                "test-start-cancellation",
                EPOCH_MS,
            ) {
                BeginOutcome::Granted { generation } => generation,
                other => panic!("the start claim must be granted: {other:?}"),
            };

            let park = AuthoritativeWritePark::new();
            let sink = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .with_authoritative_park_after_validation(park.clone());
            let write = tokio::spawn(async move {
                sink.record_binding(starting_upsert(epoch, generation, operation_id))
                    .await
            });
            while !park.reached() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }

            LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .repair_failed_transition("claude", SID, operation_id, epoch, generation)
                .await
                .expect("the canceled start's durable repair lands before release");
            assert_eq!(
                registry.fail("claude", SID, operation_id, generation, false),
                FailOutcome::Released,
                "the Starting ticket releases only after the durable fence is installed"
            );

            let terminal_generation = match registry.begin_start(
                "claude",
                SID,
                RuntimeOwnerKind::Terminal,
                "op-terminal-after-start",
                None,
                "test-terminal-attach",
                EPOCH_MS + 1,
            ) {
                BeginOutcome::Granted { generation } => generation,
                other => panic!("the terminal may claim after repair: {other:?}"),
            };
            assert_eq!(
                registry.commit_live(
                    "claude",
                    SID,
                    "op-terminal-after-start",
                    terminal_generation,
                    terminal_owner("t-new"),
                ),
                CommitOutcome::Committed
            );
            ledger
                .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                    provider: "claude",
                    session_id: SID,
                    terminal_id: "t-new",
                    mode: "claude",
                    cwd: Some("/w-new"),
                    create_request_id: None,
                    origin_create_request_id: None,
                    provenance: freshell_ws::pane_ledger::ProvenancePolicy::Clear,
                    observed_epoch: Some(epoch),
                    observed_generation: Some(terminal_generation),
                    now_ms: 200,
                })
                .expect("the terminal owner writes its newer recovery row");

            park.release();
            write
                .await
                .expect("the delayed write task joins")
                .expect("the tombstone suppresses the already-validated old write without error");
            let row = ledger
                .load_binding("claude", SID)
                .expect("terminal row remains");
            assert_eq!(
                row.state,
                freshell_ws::pane_ledger::RowState::Bound,
                "the new terminal remains recoverable after the canceled write: {row:?}"
            );
            assert_eq!(row.pane_kind, None, "no stale FreshAgent row: {row:?}");
            assert_eq!(row.live_terminal_id.as_deref(), Some("t-new"), "{row:?}");
            assert_eq!(row.cwd.as_deref(), Some("/w-new"), "{row:?}");
            assert!(ledger.kill_tombstone_at("claude", SID).is_some());
        }

        /// If durable repair itself fails after the old Starting commit has
        /// already gone stale, the ledger keeps an exact process-local fence
        /// for that operation. It suppresses the parked old closure while a
        /// newer terminal owner writes normally.
        #[tokio::test(flavor = "multi_thread")]
        async fn failed_repair_after_stale_start_commit_keeps_exact_late_write_fence() {
            use freshell_ownership::{BeginOutcome, CommitOutcome, FailOutcome};

            let tmp = tempfile::tempdir().unwrap();
            let ledger = Arc::new(PaneLedger::new(Some(tmp.path().to_path_buf())));
            let registry = Arc::new(RuntimeOwnershipRegistry::new());
            seed_terminal_row(&ledger, "t-original");
            let epoch = registry.boot_epoch();
            let operation_id = "op-start-stale-commit";
            let generation = match registry.begin_start(
                "claude",
                SID,
                RuntimeOwnerKind::FreshAgent,
                operation_id,
                None,
                "test-start-stale-commit",
                EPOCH_MS,
            ) {
                BeginOutcome::Granted { generation } => generation,
                other => panic!("the start claim must be granted: {other:?}"),
            };

            let park = AuthoritativeWritePark::new();
            let sink = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .with_authoritative_park_after_validation(park.clone());
            let write = tokio::spawn(async move {
                sink.record_binding(starting_upsert(epoch, generation, operation_id))
                    .await
            });
            while !park.reached() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }

            assert_eq!(
                registry.fail("claude", SID, operation_id, generation, false),
                FailOutcome::Released
            );
            assert_eq!(
                registry.commit_live(
                    "claude",
                    SID,
                    operation_id,
                    generation,
                    OwnerIdentity {
                        kind: RuntimeOwnerKind::FreshAgent,
                        terminal_id: None,
                        live_session_key: Some(SID.into()),
                        pid: None,
                        ownership_id: Some(operation_id.into()),
                    },
                ),
                CommitOutcome::ForeignOperation,
                "the old Starting commit is stale after cancellation"
            );

            // Force the durable close-envelope write to fail: atomic rename
            // cannot replace a directory at the exact encoded journal path.
            let blocked_envelope = tmp
                .path()
                .join("close-envelopes")
                .join("claude%3Ases-ep5-r3.json");
            std::fs::create_dir_all(&blocked_envelope).unwrap();
            LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .repair_failed_transition("claude", SID, operation_id, epoch, generation)
                .await
                .expect_err("the obstructed durable repair must fail");

            // The failed start no longer owns the registry, so a terminal is
            // admitted. Its newer recovery row must survive the old closure.
            let terminal_generation = match registry.begin_start(
                "claude",
                SID,
                RuntimeOwnerKind::Terminal,
                "op-terminal-after-repair-error",
                None,
                "test-terminal-attach",
                EPOCH_MS + 1,
            ) {
                BeginOutcome::Granted { generation } => generation,
                other => panic!("the terminal start must be granted: {other:?}"),
            };
            assert_eq!(
                registry.commit_live(
                    "claude",
                    SID,
                    "op-terminal-after-repair-error",
                    terminal_generation,
                    terminal_owner("t-after-repair-error"),
                ),
                CommitOutcome::Committed
            );
            ledger
                .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                    provider: "claude",
                    session_id: SID,
                    terminal_id: "t-after-repair-error",
                    mode: "claude",
                    cwd: Some("/terminal-after-repair-error"),
                    create_request_id: None,
                    origin_create_request_id: None,
                    provenance: freshell_ws::pane_ledger::ProvenancePolicy::Clear,
                    observed_epoch: Some(epoch),
                    observed_generation: Some(terminal_generation),
                    now_ms: 300,
                })
                .expect("the newer terminal row writes despite the repair failure");

            park.release();
            write
                .await
                .expect("the delayed write task joins")
                .expect("the exact failed-operation fence suppresses its late mutation");
            let row = ledger
                .load_binding("claude", SID)
                .expect("terminal row remains");
            assert_eq!(row.pane_kind, None, "no old fresh-agent row: {row:?}");
            assert_eq!(
                row.live_terminal_id.as_deref(),
                Some("t-after-repair-error"),
                "a repair failure leaves the newer owner untouched: {row:?}"
            );
            assert_eq!(row.cwd.as_deref(), Some("/terminal-after-repair-error"));
        }

        /// b8ke focused ep5 r4 F1 — the COMPLETED-THEN-CANCELED ordering
        /// (the round-4 reviewer's second named ordering): the write
        /// fully COMPLETES while the handoff is genuinely live (the row
        /// legitimately becomes the target's fresh-agent row), the
        /// handoff then fails and its cleanup reaps the uncommitted
        /// target — the repair's conditional revert retires the
        /// transition's own orphaned row, and the coordinator and the
        /// recovery registry re-converge.
        #[tokio::test(flavor = "multi_thread")]
        async fn the_completed_then_canceled_write_is_reverted_and_the_row_stays_consistent() {
            let tmp = tempfile::tempdir().unwrap();
            let ledger = Arc::new(PaneLedger::new(Some(tmp.path().to_path_buf())));
            let registry = Arc::new(RuntimeOwnershipRegistry::new());
            drive_terminal_live(&registry);
            let generation = drive_handoff_window(&registry, "op-handoff-cc");
            seed_terminal_row(&ledger, "t-old");
            let epoch = registry.boot_epoch();

            // The write completes, live handoff — the row becomes the
            // target's (legitimate AT THIS MOMENT).
            LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .record_binding(authoritative_upsert(
                    epoch,
                    generation,
                    Some("op-handoff-cc"),
                ))
                .await
                .expect("the in-window write completes");
            let row = ledger.load_binding("claude", SID).expect("the row");
            assert_eq!(row.pane_kind.as_deref(), Some("fresh-agent"));

            // THE CANCEL (the abort cleanup's order): the repair, then the
            // restore-fail.
            LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .repair_failed_transition("claude", SID, "op-handoff-cc", epoch, generation)
                .await
                .expect("the cleanup's repair lands");
            assert_eq!(
                registry.fail("claude", SID, "op-handoff-cc", generation, true),
                FailOutcome::RestoredPriorOwner
            );

            // The orphaned row is REVERTED: retired typed FailedTransition,
            // never an authoritative Bound fresh-agent claim beside a
            // Terminal-owned coordinator record.
            let row = ledger.load_binding("claude", SID).expect("the row");
            assert_eq!(
                row.state,
                freshell_ws::pane_ledger::RowState::Retired,
                "the row: {row:?}"
            );
            assert_eq!(
                row.retired_reason,
                Some(freshell_ws::pane_ledger::RetiredReason::FailedTransition)
            );
            assert!(
                ledger.kill_tombstone_at("claude", SID).is_some(),
                "the fence still guards any other in-flight sibling write"
            );
        }

        /// LAYERING: an authoritative write whose consult PASSES (the
        /// handoff owns the transition) is still subject to the ledger's
        /// strictly-newer arithmetic over a STAMPED row — the consult
        /// never bypasses the row's fence baseline (the ep5-r2
        /// stamped-row trap stays closed through the production bridge).
        #[tokio::test(flavor = "multi_thread")]
        async fn a_consult_passing_authoritative_write_still_proves_strictly_newer_over_stamped_rows(
        ) {
            let tmp = tempfile::tempdir().unwrap();
            let ledger = Arc::new(PaneLedger::new(Some(tmp.path().to_path_buf())));
            let registry = Arc::new(RuntimeOwnershipRegistry::new());
            drive_terminal_live(&registry);
            let generation = drive_handoff_window(&registry, "op-handoff-1");

            // The row is STAMPED at the handoff's own generation (the
            // terminal-side commit's fence baseline) — an authoritative
            // write carrying the SAME pair is not strictly newer.
            ledger
                .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                    provider: "claude",
                    session_id: SID,
                    terminal_id: "t-old",
                    mode: "claude",
                    cwd: Some("/w"),
                    create_request_id: None,
                    origin_create_request_id: None,
                    provenance: freshell_ws::pane_ledger::ProvenancePolicy::Clear,
                    observed_epoch: Some(registry.boot_epoch()),
                    observed_generation: Some(generation),
                    now_ms: 100,
                })
                .expect("the stamped terminal row seeds");

            let err = LedgerIdentitySink::new(ledger.clone(), Some(registry.clone()))
                .record_binding(authoritative_upsert(
                    registry.boot_epoch(),
                    generation,
                    Some("op-handoff-1"),
                ))
                .await
                .expect_err("the equal-pair authoritative write is refused by the ledger");
            assert!(
                err.to_string().contains("NOT_NEWER_BINDING_OVER_TERMINAL"),
                "the refusal is the LEDGER's arithmetic (the consult passed): {err}"
            );
        }
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
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
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
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
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
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
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
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            }),
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
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        let asserted = now_ms() - 30_000; // "provenance captured 30s before the write"
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
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
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            }),
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
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        assert!(
            sink.load_provenance("opencode", "nope").is_none(),
            "no row -> None"
        );

        // A stamped LINEAGE-ONLY row (blank settings) answers its stamps.
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
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
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings::default()),
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
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "opencode".into(),
            session_id: "ses_prov".into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings::default()),
        })
        .await
        .expect("awaited conn-less refresh succeeds");
        let p = sink
            .load_provenance("opencode", "ses_prov")
            .expect("the conn-less preserve kept the stamps");
        assert_eq!(p.client_instance_id.as_deref(), Some("client-1"));

        // A genuinely unattributed row answers None — never Some(default).
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "opencode".into(),
            session_id: "ses_unstamped".into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            }),
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
                origin_create_request_id: None,
                provenance: freshell_ws::pane_ledger::ProvenancePolicy::Replace(
                    freshell_ws::pane_ledger::ProvenanceStamps {
                        client_instance_id: Some("client-term"),
                        device_id: Some("device-term"),
                        tab_key: Some("device-term:tab-term"),
                        asserted_at: 7_777,
                    },
                ),
                now_ms: 42,
                observed_epoch: None,
                observed_generation: None,
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
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        let upsert = |provenance: freshell_freshagent::ProvenanceUpdate| FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "opencode".into(),
            session_id: "ses_clr".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-b".into()),
            resolves_pending: None,
            supersedes: None,
            provenance,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            }),
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
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "opencode".into(),
            session_id: "ses_lookup".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-1".into()),
            resolves_pending: Some("freshopencode-cr-1".into()),
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            // Blank settings on purpose: lineage must resolve even for
            // lineage-only rows (settings-bearing-ness is unrelated).
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings::default()),
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
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "claude".into(),
            session_id: "ses-to-kill".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            }),
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

    /// Delta-r6-r3 (focused-episode-6 round 2, Findings 4+5): the kill lanes'
    /// ONE close envelope rides `retire_closed_batch` — SUCCESS: every id
    /// ends tombstoned + Retired(Closed) and the pending markers delete, all
    /// durable across a restart; FAILURE anywhere rolls the envelope's own
    /// writes back (no partial closes survive to suppress a still-live
    /// session) and the markers stand.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn retire_closed_batch_closes_the_whole_envelope_or_nothing() {
        use freshell_freshagent::PaneIdentitySink;
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        let bind = |id: &str, cr: &str| FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "opencode".into(),
            session_id: id.into(),
            mode: "freshopencode".into(),
            create_request_id: Some(cr.into()),
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            }),
        };
        sink.record_binding(bind("ses_x", "cr-x"))
            .await
            .expect("seed x");
        sink.record_binding(bind("ses_y", "cr-y"))
            .await
            .expect("seed y");
        sink.record_pending("ph-batch-sink", "freshopencode", Some("/w"))
            .await
            .expect("pending write ok");

        // SUCCESS: the whole envelope closes in one call.
        sink.retire_closed_batch(
            "opencode",
            &["ses_x".to_string(), "ses_y".to_string()],
            &["ph-batch-sink".to_string()],
        )
        .await
        .expect("the batch close succeeds");
        for id in ["ses_x", "ses_y"] {
            let row = ledger.load_binding("opencode", id).expect("row");
            assert_eq!(row.state, freshell_ws::pane_ledger::RowState::Retired);
            assert_eq!(
                row.retired_reason,
                Some(freshell_ws::pane_ledger::RetiredReason::Closed)
            );
            assert!(ledger.kill_tombstone_at("opencode", id).is_some());
        }
        assert!(
            ledger.pending_for_terminal("ph-batch-sink").is_none(),
            "the marker deleted with the close"
        );
        let disk = freshell_ws::pane_ledger::PaneLedger::new(Some(tmp.path().to_path_buf()));
        assert_eq!(
            disk.load_binding("opencode", "ses_x").expect("row").state,
            freshell_ws::pane_ledger::RowState::Retired,
            "durable across restart"
        );
        assert!(disk.kill_tombstone_at("opencode", "ses_y").is_some());

        // FAILURE: re-seed two Bound rows, then break the ledger's
        // close-envelope subtree (delta-r6-r4: THE durable act of the batch)
        // — the batch must Err CLEAN (nothing durable of its own survives).
        sink.record_binding(bind("ses_p", "cr-p"))
            .await
            .expect("seed p");
        sink.record_binding(bind("ses_q", "cr-q"))
            .await
            .expect("seed q");
        sink.record_pending("ph-batch-sink-2", "freshopencode", Some("/w"))
            .await
            .expect("pending write ok");
        let env_dir = tmp.path().join("close-envelopes");
        std::fs::create_dir_all(&env_dir).unwrap();
        std::fs::set_permissions(&env_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let err = sink
            .retire_closed_batch(
                "opencode",
                &["ses_p".to_string(), "ses_q".to_string()],
                &["ph-batch-sink-2".to_string()],
            )
            .await
            .expect_err("the broken close-envelope subtree fails the batch");
        assert!(
            !err.is_persisted(),
            "the record provably never landed: a CLEAN failure (nothing durable)"
        );
        assert!(!err.to_string().is_empty());
        std::fs::set_permissions(&env_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        for id in ["ses_p", "ses_q"] {
            let row = ledger.load_binding("opencode", id).expect("row");
            assert_eq!(
                row.state,
                freshell_ws::pane_ledger::RowState::Bound,
                "clean failure: {id}'s row is untouched by the failed close"
            );
            assert_eq!(
                ledger.kill_tombstone_at("opencode", id),
                None,
                "clean failure: no fence residue for {id}"
            );
        }
        assert!(
            ledger.pending_for_terminal("ph-batch-sink-2").is_some(),
            "markers delete only on a COMPLETE close"
        );
        // Healed retry: lands idempotently.
        sink.retire_closed_batch(
            "opencode",
            &["ses_p".to_string(), "ses_q".to_string()],
            &["ph-batch-sink-2".to_string()],
        )
        .await
        .expect("the retried close lands");
        for id in ["ses_p", "ses_q"] {
            assert!(ledger.kill_tombstone_at("opencode", id).is_some());
        }
    }

    /// Retire-on-kill round 5 (focused-ep5-r4 Finding 2): `row_is_bound`
    /// through the real ledger — the claude alias-tombstone retention probe.
    /// Bound rows answer true; retired/unknown ids false.
    #[tokio::test(flavor = "multi_thread")]
    async fn row_is_bound_answers_the_ledgers_raw_row_state() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger, None);
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "claude".into(),
            session_id: "ses-rb".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            }),
        })
        .await
        .expect("awaited write succeeds");
        assert!(
            sink.row_is_bound("claude", "ses-rb"),
            "a Bound row answers true"
        );
        sink.retire_closed("claude", "ses-rb")
            .await
            .expect("retire");
        assert!(
            !sink.row_is_bound("claude", "ses-rb"),
            "a retired row answers false"
        );
        assert!(!sink.row_is_bound("claude", "never-written"));
    }

    /// Delta-r6-r4 (focused-episode-6 round 3, Finding 3) through the sink
    /// seam: only the row's bindings dir is read-only, so the ROW
    /// PROJECTION cannot land while the journal record can. The close is the
    /// record: the sink answers `Ok`, the fence stands durable (fed by the
    /// record), and the Bound row reads dominated (never offered) until a
    /// healed sweep converges it — the pre-journal model's compensated
    /// split-pair cannot exist.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_retire_whose_row_projection_fails_still_closes_through_the_sink() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "claude".into(),
            session_id: "ses-comp".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            }),
        })
        .await
        .expect("seed write");

        // Only the row's bindings dir goes read-only (the projection's
        // rename needs dir-write); the close-envelope tree stays writable.
        let bindings_dir = tmp.path().join("bindings").join("claude");
        std::fs::set_permissions(&bindings_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        sink.retire_closed("claude", "ses-comp")
            .await
            .expect("the journal record lands; the projection is hygiene");
        std::fs::set_permissions(&bindings_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            ledger.load_binding("claude", "ses-comp").unwrap().state,
            freshell_ws::pane_ledger::RowState::Bound,
            "the projection never landed: raw Bound, masked by dominance (never offered)"
        );
        assert!(
            ledger.kill_tombstone_at("claude", "ses-comp").is_some(),
            "the close fence stands (fed by the journal record)"
        );
        assert!(
            ledger
                .dominant_kill_tombstone_keys()
                .contains(&("claude".to_string(), "ses-comp".to_string())),
            "the Bound row reads closed at every offer boundary"
        );
        let disk = freshell_ws::pane_ledger::PaneLedger::new(Some(tmp.path().to_path_buf()));
        assert!(
            disk.kill_tombstone_at("claude", "ses-comp").is_some(),
            "the fence is durable on disk (record-fed, restart-proof)"
        );
        // Healed sweep convergence is pinned at the ledger level
        // (`a_close_is_one_record_and_a_failed_row_projection_is_dominance_covered_hygiene`).
    }

    /// Focused-ep5-r5 Finding 2 (retire-on-kill round 6) over the REAL
    /// ledger, through the sink seam the claude lanes use: the alias record
    /// writes round-trip durably (a fresh `PaneLedger` — the restart —
    /// answers the consult), the claim consumption deletes per-durable
    /// across placeholders, and `commit_claim_aliased`'s placeholder-fence
    /// gate refuses under a fenced seat and commits over a clean one (with
    /// the durable revive landing for real).
    #[tokio::test(flavor = "multi_thread")]
    async fn alias_tombstones_and_the_aliased_commit_round_trip_through_the_real_ledger() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "claude".into(),
            session_id: "d-alias".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            }),
        })
        .await
        .expect("row write");
        sink.record_alias_tombstone("claude", "ph-a", "d-alias", 1_000)
            .await
            .expect("alias write a");
        sink.record_alias_tombstone("claude", "ph-b", "d-alias", 2_000)
            .await
            .expect("alias write b");

        // The restart boundary: a fresh ledger (and sink) over the same root
        // answers the kill consult.
        let ledger2 = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink2 = LedgerIdentitySink::new(ledger2.clone(), None);
        let mut records = sink2.alias_tombstone_records("claude", "ph-a");
        records.sort();
        assert_eq!(
            records,
            vec![("d-alias".to_string(), 1_000)],
            "the persisted record answers across the scripted restart"
        );

        // The placeholder-fence gate: the pane seat's close blocks the commit.
        sink2
            .retire_closed("claude", "ph-seat")
            .await
            .expect("seat fence");
        let outcome = sink2
            .commit_claim_aliased("claude", "d-alias", None, &["ph-seat".to_string()])
            .await
            .expect("the commit answers");
        assert_eq!(outcome, ClaimCommit::RefusedStale);
        assert!(
            ledger2.load_binding("claude", "d-alias").unwrap().state
                == freshell_ws::pane_ledger::RowState::Bound,
            "the refusal never touched the row"
        );

        // The clean-seat claim commits (durable closed first — the genuine
        // reopen), and the consumption sweeps both placeholders.
        sink2
            .retire_closed("claude", "d-alias")
            .await
            .expect("close");
        let fence = ledger2.kill_tombstone_at("claude", "d-alias");
        let outcome = sink2
            .commit_claim_aliased("claude", "d-alias", fence, &["ph-clean".to_string()])
            .await
            .expect("commit answers");
        assert_eq!(outcome, ClaimCommit::Committed);
        let cleared = sink2
            .clear_alias_tombstones_for_durable("claude", "d-alias")
            .await
            .expect("consumption");
        assert_eq!(cleared, vec!["ph-a".to_string(), "ph-b".to_string()]);
        assert!(sink2.alias_tombstone_records("claude", "ph-a").is_empty());
        assert!(sink2.alias_tombstone_records("claude", "ph-b").is_empty());
        assert_eq!(
            ledger2.load_binding("claude", "d-alias").unwrap().state,
            freshell_ws::pane_ledger::RowState::Bound,
            "the committed reopen revived the row for real"
        );
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
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        let upsert = |session_id: &str| FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "claude".into(),
            session_id: session_id.into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            }),
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
            let write_sink = LedgerIdentitySink::new(ledger.clone(), None);
            let kill_sink = LedgerIdentitySink::new(ledger.clone(), None);
            let (w, k) = if i % 2 == 0 {
                let (w, k) = tokio::join!(
                    write_sink.record_binding(upsert(&session_id)),
                    kill_sink.retire_closed("claude", &session_id)
                );
                (w, k)
            } else {
                let (k, w) = tokio::join!(
                    kill_sink.retire_closed("claude", &session_id),
                    write_sink.record_binding(upsert(&session_id))
                );
                (w, k)
            };
            w.expect("write ok");
            k.expect("retire ok");
            let state = ledger.load_binding("claude", &session_id).map(|r| r.state);
            assert!(
                state != Some(freshell_ws::pane_ledger::RowState::Bound),
                "iteration {i}: a killed identity converged to not-Bound, got {state:?}"
            );
        }
    }

    /// Focused-ep5-r2 Finding 4 (retire-on-kill round 3), carried into round
    /// 4's conditional single transition (focused-ep5-r3 Findings 1+3) over
    /// the REAL ledger, through the sink seam the claim lanes use: the kill
    /// closes (and fences) the row; `commit_claim` with the claim-START
    /// snapshot (`kill_tombstone_at_ms`) returns it to Bound AND clears the
    /// fence in one durable transition (a fresh ledger over the same root
    /// agrees) — and the binding write the claim then lands is never
    /// suppressed. A commit whose snapshot the dead-state has advanced past
    /// REFUSES wholesale (no clear, no revive). The narrow cases: committing
    /// over a never-fenced Bound row is a no-op (no timestamp churn), and an
    /// unknown id gains no row (the V7 no-laundering discipline holds
    /// through the new lane).
    #[tokio::test(flavor = "multi_thread")]
    async fn commit_claim_restores_a_killed_row_through_the_real_ledger() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        let upsert = |session_id: &str| FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "claude".into(),
            session_id: session_id.into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            }),
        };

        sink.record_binding(upsert("revive-1"))
            .await
            .expect("seed write");
        sink.retire_closed("claude", "revive-1")
            .await
            .expect("kill closes");
        assert_eq!(
            ledger.load_binding("claude", "revive-1").unwrap().state,
            freshell_ws::pane_ledger::RowState::Retired,
            "the kill closed the row"
        );

        // The claim's exact sequence: snapshot at claim start, then the ONE
        // conditional commit — the fence clears AND the row revives together.
        let snapshot = sink.kill_tombstone_at_ms("claude", "revive-1");
        assert!(snapshot.is_some(), "the kill's fence is durable");
        let outcome = sink
            .commit_claim("claude", "revive-1", snapshot)
            .await
            .expect("claim commit ok");
        assert_eq!(outcome, freshell_freshagent::ClaimCommit::Committed);
        let row = ledger.load_binding("claude", "revive-1").unwrap();
        assert_eq!(row.state, freshell_ws::pane_ledger::RowState::Bound);
        assert_eq!(row.retired_reason, None);
        assert_eq!(
            sink.kill_tombstone_at_ms("claude", "revive-1"),
            None,
            "the fence cleared in the same transition"
        );
        let ledger2 = freshell_ws::pane_ledger::PaneLedger::new(Some(tmp.path().to_path_buf()));
        assert_eq!(
            ledger2.load_binding("claude", "revive-1").unwrap().state,
            freshell_ws::pane_ledger::RowState::Bound,
            "the committed reopen is durable on disk"
        );
        // And the claim's own binding write is never fenced afterwards.
        sink.record_binding(upsert("revive-1"))
            .await
            .expect("claim write");
        assert_eq!(
            ledger.load_binding("claude", "revive-1").unwrap().state,
            freshell_ws::pane_ledger::RowState::Bound,
            "the claim's write landed Bound"
        );

        // Narrow cases: a plain Bound row with NO fence is untouched
        // (updated_at frozen), and an unknown id gains no row.
        let before = ledger
            .load_binding("claude", "revive-1")
            .unwrap()
            .updated_at;
        std::thread::sleep(std::time::Duration::from_millis(2));
        let outcome = sink
            .commit_claim("claude", "revive-1", None)
            .await
            .expect("noop commit ok");
        assert_eq!(outcome, freshell_freshagent::ClaimCommit::Committed);
        assert_eq!(
            ledger
                .load_binding("claude", "revive-1")
                .unwrap()
                .updated_at,
            before,
            "an unfenced re-claim is a true no-op"
        );
        let outcome = sink
            .commit_claim("claude", "never-existed", None)
            .await
            .expect("unknown commit ok");
        assert_eq!(outcome, freshell_freshagent::ClaimCommit::Committed);
        assert!(
            ledger.load_binding("claude", "never-existed").is_none(),
            "a never-recorded identity gains no row from a claim commit"
        );

        // The CONDITION (Finding 1): a newer close mid-claim refuses the
        // commit wholesale — no clear, no revive, the row stays Retired.
        sink.retire_closed("claude", "refuse-1")
            .await
            .expect("kill #1");
        let stale_snapshot = None; // the claim believed the identity untouched
        let outcome = sink
            .commit_claim("claude", "refuse-1", stale_snapshot)
            .await
            .expect("refusal surfaces as an outcome, never an error");
        assert_eq!(outcome, freshell_freshagent::ClaimCommit::RefusedStale);
        assert!(
            sink.kill_tombstone_at_ms("claude", "refuse-1").is_some(),
            "the refusal never clears the newer fence"
        );
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
        let sink = LedgerIdentitySink::new(ledger.clone(), None);
        sink.record_binding(FreshAgentBindingUpsert {
            genesis: freshell_freshagent::GenesisUpdate::Keep,
            name_transition: None,
            provider: "opencode".into(),
            session_id: "ses_lineage".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-9".into()),
            resolves_pending: Some("freshopencode-cr-9".into()),
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            claim: None,
            settings: SettingsUpdate::Replace(FreshAgentSettings::default()),
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
