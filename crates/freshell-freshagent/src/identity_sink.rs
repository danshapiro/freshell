//! P1.13 crate-boundary bridge: fresh-agent identity events flow OUT of this
//! crate through this trait; `freshell-server` implements it over the pane
//! ledger (this crate must not depend on `freshell-ws`, where the ledger
//! lives — the dependency edge runs the other way).
//!
//! Kata 1wxv: the bridge also carries the durable rollback record
//! (`record_rollback`/`load_rollback`) — the provider handlers AWAIT the write
//! BEFORE mutating provider history (durable-BEFORE-mutation; a pre-write
//! failure refuses the rollback with `LEDGER_WRITE_REFUSAL_COPY`).

use std::sync::Arc;

use crate::rollback_record::RollbackRecord;
#[cfg(test)]
use crate::rollback_record::ROLLBACK_RECORD_VERSION;

/// Resume-invocation record (campaign plan §4.2): exactly what the
/// provider-native resume command needs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FreshAgentSettings {
    pub model: Option<String>,
    pub sandbox: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
    pub cwd: Option<String>,
}

/// D8 (restore-open-sessions-only) bind-lane provenance: WHICH browser client
/// and tab caused a ledger binding write. Connection-scoped lanes stamp it
/// from the WS connection's hello identity (`deviceId`/`clientInstanceId`)
/// plus the create message's `tabId`. What a write DOES with it is the
/// tri-state [`ProvenanceUpdate`] policy (delta-r2 Finding 2): conn-less
/// lanes `Inherit` (re-binds preserve prior stamps, fork chains inherit the
/// superseded parent's), connection-supplied lanes `Replace`, and the
/// explicitly headless REST/MCP lineage lanes `Clear` (a headless re-bind
/// erases stale browser stamps rather than keeping them under a refreshed
/// `updated_at`).
///
/// Focused-ep4-r2 Findings 1+2: the value also carries its own ASSERTION
/// TIME — `asserted_at` is captured ONCE at the WS message receipt that
/// turned connection identity + message `tabId` into this value, and flows
/// immutably through the whole create/respawn/fork/supersede chain (the
/// parked-provenance clones and the fork-lane resolutions carry it
/// unchanged). No post-spawn write, deferred SDK init, or fork completion
/// can manufacture a later attribution time. A `default()`/hollow value
/// carries `0` ("no assertion exists"); the ledger consumes the time only
/// when applying a new attribution — since focused-ep4-r3 Findings 1+2 that
/// means a FULL-triple `Replace` whose `asserted_at` is >= the row's, which
/// [`Self::is_meaningful`] alone does not decide (it is the parking-level
/// hollow guard, not the attribution-advance predicate — see its doc).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BindProvenance {
    pub client_instance_id: Option<String>,
    pub device_id: Option<String>,
    /// `deviceId:tabId` — exactly `src/lib/tab-registry-snapshot.ts`'s record
    /// composition, so the row can rejoin the right restored tab.
    pub tab_key: Option<String>,
    /// The browser's assertion time (ms), captured at message receipt — see
    /// the struct doc. `0` on hollow/default values (never consumed).
    pub asserted_at: i64,
}

impl BindProvenance {
    /// Compose the stamps for one connection-scoped create. `tab_key` exists
    /// only when BOTH halves are known — a half-known tab identity is never
    /// invented on the wire or in the ledger. `asserted_at` is the message's
    /// RECEIPT time — capture it once and pass it unchanged.
    pub fn for_create(
        client_instance_id: Option<&str>,
        device_id: Option<&str>,
        tab_id: Option<&str>,
        asserted_at: i64,
    ) -> Self {
        Self {
            client_instance_id: client_instance_id.map(str::to_string),
            device_id: device_id.map(str::to_string),
            tab_key: match (device_id, tab_id) {
                (Some(d), Some(t)) => Some(format!("{d}:{t}")),
                _ => None,
            },
            asserted_at,
        }
    }

    /// Focused-ep1-r5 Finding 2 — "meaningful" provenance: exactly the fields
    /// the D8 recovery judgment gates on (`d8_parent_relative_keep`,
    /// `crates/freshell-server/src/recovery_inventory.rs`) —
    /// `client_instance_id` AND `device_id`. A partially-initialized client
    /// can send `hello` without device/client fields, producing a HOLLOW
    /// `Some(BindProvenance)` whose fields are all absent; such a value must
    /// behave like `None` on EVERY override/refresh decision (re-park,
    /// refresh-write gate, fork precedence). It is never a usable
    /// attribution, and letting it override would replace parked/row truth
    /// with nothing. `tab_key` is deliberately not required HERE — this is
    /// the parking-level hollow guard, not the ledger's attribution-advance
    /// predicate (since focused-ep4-r3 Finding 2 that one requires the FULL
    /// triple — client+device+tab — plus a monotonicity guard; see
    /// `freshell_ws::pane_ledger::advances_attribution`).
    pub fn is_meaningful(&self) -> bool {
        self.client_instance_id.is_some() && self.device_id.is_some()
    }
}

/// Delta-r2 Finding 2 — the write's provenance POLICY (tri-state), the
/// freshagent-crate mirror of `freshell_ws::pane_ledger::ProvenancePolicy`
/// (this crate cannot see the ledger; the server-side sink maps between
/// them). The bare `Option`-per-field upsert shape it replaces made `None`
/// ambiguous between "assert nothing, keep the stamps" and "headless lane —
/// clear them": a headless REST/MCP lineage re-bind of a browser-stamped row
/// kept the browser's stamps under a refreshed `updated_at`, laundering the
/// row into the D8 recovery offer with a stale parent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum ProvenanceUpdate {
    /// Conn-less SESSION-AFFILIATED lanes (respawn, refresh, attach-resume,
    /// fork chains with no connection-supplied stamps to assert): the ledger
    /// merge keeps every existing stamp.
    #[default]
    Inherit,
    /// Connection-supplied stamps (whole `BindProvenance` values composed
    /// from the connection's hello identity + the message's `tabId`, or
    /// resolved fork provenance): asserted onto the row ATOMICALLY — since
    /// focused-ep4-r3 Findings 1+2 the ledger applies stamps AND the
    /// attribution time as ONE fact, and only from a full
    /// client+device+tab triple whose `asserted_at` is >= the row's current
    /// attribution time (the browser's ASSERTION time, captured at message
    /// receipt — never the possibly much later write's own clock); a weaker
    /// or older `Replace` leaves the row's attribution untouched.
    Replace(BindProvenance),
    /// An explicitly HEADLESS writer (the REST/MCP lineage binder,
    /// `lib.rs`'s materialization write): all stamps are CLEARED — the
    /// rebound row becomes unattributed, so the D8 judgment never offers it.
    Clear,
}

impl From<Option<BindProvenance>> for ProvenanceUpdate {
    /// The provider-lane idiom: lanes holding an `Option<BindProvenance>`
    /// assert it (`Replace`) when Some and assert nothing (`Inherit`) when
    /// None. `Clear` is never produced here — it is spelled out explicitly
    /// at the headless lineage call sites.
    fn from(p: Option<BindProvenance>) -> Self {
        match p {
            Some(p) => Self::Replace(p),
            None => Self::Inherit,
        }
    }
}

/// One fresh-agent identity event. Settings are a FULL snapshot (replace,
/// not merge). `resolves_pending` names a pending marker (placeholder id)
/// this binding supersedes.
#[derive(Debug, Clone, PartialEq)]
pub struct FreshAgentBindingUpsert {
    pub provider: String,
    pub session_id: String,
    pub mode: String,
    pub create_request_id: Option<String>,
    pub resolves_pending: Option<String>,
    /// G3 supersession (V8/A14): OLD session id this binding replaces
    /// (codex crash-respawn passes the old thread id; everyone else None).
    pub supersedes: Option<String>,
    /// D8 provenance write policy (see [`ProvenanceUpdate`]; the ledger's
    /// atomic apply/preserve/clear merge lives in `freshell-ws`'s pane
    /// ledger).
    pub provenance: ProvenanceUpdate,
    pub settings: FreshAgentSettings,
}

impl FreshAgentBindingUpsert {
    /// The D8 stamps this write ASSERTS: the `Replace` payload for a
    /// connection-supplied lane, all-`None` for `Inherit` (asserts nothing —
    /// the ledger keeps prior stamps) and `Clear` (asserts erasure; the
    /// all-`None` answer is read alongside `provenance` in the Clear pins).
    #[cfg(test)]
    pub(crate) fn asserted_stamps(&self) -> BindProvenance {
        match &self.provenance {
            ProvenanceUpdate::Replace(stamps) => stamps.clone(),
            ProvenanceUpdate::Inherit | ProvenanceUpdate::Clear => BindProvenance::default(),
        }
    }
}

/// Write-completion future (see Interfaces block for the style citation:
/// BoxFuture aliases at freshell-opencode/src/serve.rs:44 /
/// freshell-codex/src/app_server.rs:62; no async-trait dep in the workspace).
pub type SinkWrite =
    std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<()>> + Send + 'static>>;

/// AWAITED writes (wave-A durable-before-answer policy, V8/A11): callers
/// `.await` the returned future before replying/broadcasting/proceeding.
/// Implementations run fsync work on `spawn_blocking` and propagate failures
/// as `Err` — call sites surface them user-visibly, then proceed (a write
/// failure never blocks the identity event). Reads are memory-fast + sync.
pub trait PaneIdentitySink: Send + Sync {
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>) -> SinkWrite;
    fn record_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite;
    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings>;
    /// Task 3 semantics change: true iff a SETTINGS-BEARING record was
    /// persisted for this key — a lineage-only binding row (all-blank
    /// settings snapshot, recorded unconditionally at materialization so the
    /// create-requestId lineage survives) must NOT make this true. This is
    /// the SETTINGS_RESET alarm gate (V7/A10): the alarm arms only when a
    /// settings-bearing record provably existed yet no snapshot is
    /// recoverable; lineage-only rows (legitimately-default creates) resume
    /// silently with defaults, never a false alarm. `load_settings` is
    /// unchanged — it returns None for lineage-only rows.
    fn was_recorded(&self, provider: &str, session_id: &str) -> bool;
    /// D8 (focused-ep1-r4 Finding 2 — cold-attach seeding from the durable
    /// row): the binding row's provenance stamps (clientInstanceId / deviceId
    /// / tabKey) as last asserted. A cold CONN-LESS
    /// (re)construction reads this to park the row's stamps on the runtime
    /// session when no CURRENT connection supplied any — the row is the
    /// authoritative record of "where this session last lived", and the fork
    /// child's NEW ledger key is where a `None` park could never be rescued.
    /// A connection-supplied provenance still wins when present (that is the
    /// current-tab truth for a live move). Like `load_settings` this only
    /// serves FRESH-AGENT rows (terminal-lineage rows are not resume records)
    /// and is memory-fast + sync; unlike `load_settings` it is settings-
    /// independent (a stamped lineage-only row still answers). `None` when no
    /// fresh-agent row exists or the row carries NO stamps at all — an
    /// all-`None` answer is information-free, so it is never returned as
    /// `Some(default)` (that would fire `provenance.is_some()` gates
    /// spuriously and park an invention).
    fn load_provenance(&self, provider: &str, session_id: &str) -> Option<BindProvenance>;
    /// kata 1wxv decision 10's durable record: the post-op rollback record,
    /// computed from pre-mutation reads and AWAITED BEFORE the provider
    /// mutation runs (durable-BEFORE-mutation). Same awaited-write
    /// discipline as `record_binding`. Delta-r1 F4: a DISABLED ledger answers
    /// `Err` here (never a false durable `Ok`), which the provider lanes map
    /// to the rollback refusal — the rollback never mutates provider history on
    /// this leg.
    fn record_rollback(
        &self,
        provider: &str,
        session_id: &str,
        record: RollbackRecord,
    ) -> SinkWrite;
    /// The stored rollback record. Memory-fast + sync (the write-through
    /// index). A row stored with a `version` other than
    /// [`ROLLBACK_RECORD_VERSION`] answers `None` — never silently
    /// reinterpreted (the pane-ledger LEDGER_VERSION discipline). Focused
    /// ep1-r1 F3: implementations reading STORED BYTES route through
    /// [`RollbackRecord::from_stored_payload`], so handlers see the uniform
    /// already-migrated record (the legacy epochless union freezes — keyed on
    /// the absence of epoch keys, indifferent to the destroy bit; the disk row
    /// is never lazily rewritten).
    fn load_rollback(&self, provider: &str, session_id: &str) -> Option<RollbackRecord>;
    /// Delete the rollback row (kata 1wxv task 4 review M3): a compensation
    /// whose pre-op state was ABSENT restores "nothing was here" by DELETE —
    /// never by writing a fabricated empty record. Idempotent: deleting an
    /// absent row succeeds (the ledger's `delete_rollback_row` discipline).
    fn delete_rollback(&self, provider: &str, session_id: &str) -> SinkWrite;
    /// Task 3 lineage lookup: resolve a CREATE requestId to the durable
    /// session id recorded on the newest matching binding row (the pane-ledger
    /// `lookup_by_create_request_id` rule: Bound or GcExpired, newest by
    /// updated_at), regardless of whether the row carries a settings snapshot.
    /// Synchronous + memory-fast like `load_settings`/`was_recorded`; the REST
    /// resume path uses it to resolve `freshopencode-<createRequestId>`
    /// placeholders to their materialized `ses_*` session.
    fn lookup_by_create_request_id(
        &self,
        provider: &str,
        create_request_id: &str,
    ) -> Option<String>;
    /// Retire-on-kill (delta-review round 5, restore-open-sessions-only): an
    /// explicit `freshAgent.kill` is an INTENTIONAL session end — the pane's
    /// binding row retires `Closed` on every kill entry point, so the
    /// recovery inventory's `ledgerOnly` pipeline (Bound-only at its
    /// `row_is_bound` pre-filter) can never offer a session the user had just
    /// closed. Without this the kill left a Bound row behind, and a browser
    /// loss inside the 7-second creation-race grace window
    /// (`UNSNAPSHOTTED_BINDING_GRACE_MS`) reproduced exactly the
    /// never-actually-open restore the task exists to kill. Idempotent (an
    /// unknown or already-retired row is a no-op), awaited like every
    /// non-rollback lane (failures surface as `Err` for the caller to
    /// warn-log, never a kill blocker). Same discipline as the WS
    /// `terminal.kill` path's `retire_closed` ("P1.8 trigger (e)").
    fn retire_closed(&self, provider: &str, session_id: &str) -> SinkWrite;
    /// The PENDING companion of [`Self::retire_closed`]: a kill observed
    /// before identity resolution also deletes the pending marker, so a
    /// marker-driven resolution that lands later can never carry evidence
    /// for a pane that provably no longer exists. Idempotent (a missing
    /// marker == `Ok`).
    fn delete_pending(&self, placeholder_id: &str) -> SinkWrite;
}

pub type SharedPaneIdentitySink = Arc<dyn PaneIdentitySink>;

/// In-memory sink for tests, crate-wide. Mutations happen synchronously
/// before the (already-completed) future is returned, so tests can assert
/// immediately after `.await`.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakeIdentitySink {
    pub pendings: std::sync::Mutex<Vec<(String, String, Option<String>)>>,
    pub bindings: std::sync::Mutex<Vec<FreshAgentBindingUpsert>>,
    pub settings: std::sync::Mutex<std::collections::HashMap<(String, String), FreshAgentSettings>>,
    /// Keys with a SETTINGS-BEARING record (Task 3 keying) plus anything
    /// seed_recorded_only marked — backs `was_recorded`. Blank-settings
    /// bindings never enter (and a blank rewrite removes the key, matching
    /// the ledger's full-snapshot replace).
    pub recorded: std::sync::Mutex<std::collections::HashSet<(String, String)>>,
    /// Focused-ep1-r4 Finding 2: the row's CURRENT provenance stamps,
    /// atomically applied/preserved on every `record_binding` — the ledger
    /// merge's (`pane_ledger.rs`) in-memory twin, backing `load_provenance`.
    /// Same-key only (the real ledger additionally inherits from a superseded
    /// PARENT row; no fake consumer needs that — the providers' fork-child
    /// assertions read the child row's upsert off `bindings`, not this map).
    pub provenance:
        std::sync::Mutex<std::collections::HashMap<(String, String), BindProvenance>>,
    /// (provider, sessionId) -> stored rollback record (kata 1wxv).
    pub rollbacks: std::sync::Mutex<std::collections::HashMap<(String, String), RollbackRecord>>,
    /// Retire-on-kill record (delta-review round 5): every `retire_closed`
    /// call, in order — kill-handler tests assert the (provider, sessionId)
    /// batch a kill retires.
    pub retires: std::sync::Mutex<Vec<(String, String)>>,
    /// Focused ep1-r4 F2: (provider, sessionId) -> a row seeded as RAW STORED
    /// BYTES (a pre-epoch-fields legacy payload). `load_rollback` routes these
    /// through [`RollbackRecord::from_stored_payload`] exactly like the real
    /// `LedgerIdentitySink`'s read of stored bytes, so handler tests drive the
    /// in-memory migration itself, never a hand-stamped typed record.
    pub legacy_rollback_payloads:
        std::sync::Mutex<std::collections::HashMap<(String, String), serde_json::Value>>,
    /// When true, write futures resolve to Err — for failure-surfacing tests.
    pub fail_writes: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl FakeIdentitySink {
    #[allow(dead_code)] // used by identity-event tasks (Tasks 4-10 tests)
    pub fn seed(&self, provider: &str, session_id: &str, s: FreshAgentSettings) {
        // A seed mirrors a real binding write: the lineage row lands on the
        // `bindings` log, and the key counts as "recorded" only when the
        // snapshot is settings-bearing (Task 3 keying).
        let settings_bearing = s != FreshAgentSettings::default();
        if settings_bearing {
            self.recorded
                .lock()
                .unwrap()
                .insert((provider.into(), session_id.into()));
            self.settings
                .lock()
                .unwrap()
                .insert((provider.into(), session_id.into()), s.clone());
        }
        self.bindings.lock().unwrap().push(FreshAgentBindingUpsert {
            provider: provider.into(),
            session_id: session_id.into(),
            mode: String::new(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Inherit,
            settings: s,
        });
    }
    /// Mark a key as previously recorded WITHOUT a recoverable snapshot —
    /// the SETTINGS_RESET-alarm-positive fixture (V7/A10 gating): the genuine
    /// "recorded but unrecoverable" anomaly. Stays alarm-positive under the
    /// Task 3 keying (`recorded` membership alone drives `was_recorded`).
    #[allow(dead_code)] // used by identity-event tasks (Tasks 4-10 tests)
    pub fn seed_recorded_only(&self, provider: &str, session_id: &str) {
        self.recorded
            .lock()
            .unwrap()
            .insert((provider.into(), session_id.into()));
    }
    /// Arm the write-failure knob (kata 1wxv refusal-path tests).
    #[allow(dead_code)] // used by the kata 1wxv provider-leg failure tests (Tasks 2-4)
    pub fn set_fail_writes(&self, fail: bool) {
        self.fail_writes
            .store(fail, std::sync::atomic::Ordering::SeqCst);
    }
    /// Focused ep1-r4 F2: seed the rollback row as RAW STORED BYTES (the legacy
    /// pre-epoch payload shape), replacing any typed seed — `load_rollback` then
    /// runs the real read path's migration ([`RollbackRecord::from_stored_payload`])
    /// over them.
    #[allow(dead_code)] // used by the kata 1wxv focused ep1-r4 F2 tests
    pub fn seed_rollback_payload(
        &self,
        provider: &str,
        session_id: &str,
        payload: serde_json::Value,
    ) {
        let key = (provider.into(), session_id.into());
        self.rollbacks.lock().unwrap().remove(&key);
        self.legacy_rollback_payloads
            .lock()
            .unwrap()
            .insert(key, payload);
    }
    fn write_result(&self) -> SinkWrite {
        if self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            Box::pin(std::future::ready(Err(std::io::Error::other(
                "fake write failure",
            ))))
        } else {
            Box::pin(std::future::ready(Ok(())))
        }
    }
}

#[cfg(test)]
impl PaneIdentitySink for FakeIdentitySink {
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>) -> SinkWrite {
        if !self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            self.pendings.lock().unwrap().push((
                placeholder_id.into(),
                mode.into(),
                cwd.map(Into::into),
            ));
        }
        self.write_result()
    }
    fn record_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite {
        if !self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            let key = (upsert.provider.clone(), upsert.session_id.clone());
            // Task 3 keying (mirrors `PaneLedger::fresh_agent_settings_recorded`
            // and the ledger sink's `load_settings` blank guard): settings are
            // a FULL snapshot (replace), so a blank snapshot REPLACES any prior
            // one — the key leaves `settings`/`recorded` again. A lineage-only
            // write therefore still lands on the `bindings` log but never
            // counts as a settings-bearing record.
            let settings_bearing = upsert.settings != FreshAgentSettings::default();
            if settings_bearing {
                self.recorded.lock().unwrap().insert(key.clone());
                self.settings
                    .lock()
                    .unwrap()
                    .insert(key, upsert.settings.clone());
            } else {
                self.recorded.lock().unwrap().remove(&key);
                self.settings.lock().unwrap().remove(&key);
            }
            // Focused-ep1-r4 Finding 2 + delta-r2 Finding 2 + focused-ep4-r3
            // Findings 1+2: track the row's CURRENT provenance stamps with the
            // ledger's merge policy — the attribution fact moves ATOMICALLY:
            // `Replace` applies stamps AND time together, and only from a
            // FULL client+device+tab triple whose assertion time is >= the
            // tracked one (the ledger's `advances_attribution` + monotonicity
            // guard, mirrored); `Inherit` asserts nothing (every stamp
            // survives); `Clear` (explicitly headless lineage) erases them.
            match &upsert.provenance {
                ProvenanceUpdate::Inherit => {}
                ProvenanceUpdate::Replace(stamps) => {
                    let mut provenance = self.provenance.lock().unwrap();
                    // (`key` may have been moved by the settings insert above.)
                    let entry = provenance
                        .entry((upsert.provider.clone(), upsert.session_id.clone()))
                        .or_default();
                    // The ledger's rule (focused-ep4-r3): a weaker (partial/
                    // hollow) `Replace` touches NOTHING — no piecemeal field
                    // merge — and an OLDER full-triple assertion never drags
                    // the stamps+time back. A fresh entry (`0`) is always
                    // superseded, matching the ledger's absent-prior-time
                    // arm; the focused-ep4-r2 rule (the assertion time rides
                    // the value, never a write's own clock) is unchanged.
                    let complete = stamps.client_instance_id.is_some()
                        && stamps.device_id.is_some()
                        && stamps.tab_key.is_some();
                    if complete && stamps.asserted_at >= entry.asserted_at {
                        entry.client_instance_id = stamps.client_instance_id.clone();
                        entry.device_id = stamps.device_id.clone();
                        entry.tab_key = stamps.tab_key.clone();
                        entry.asserted_at = stamps.asserted_at;
                    }
                }
                ProvenanceUpdate::Clear => {
                    // An erased row answers `load_provenance` with absence
                    // (the default-map entry is never a meaningful answer).
                    self.provenance
                        .lock()
                        .unwrap()
                        .remove(&(upsert.provider.clone(), upsert.session_id.clone()));
                }
            }
            // kata 1wxv Task 4 (claude rollback adoption): the rollback-row re-key
            // old→new rides the SAME awaited batch as the binding write — mirrors
            // `freshell-server`'s LedgerIdentitySink (scoped to the claude fork
            // adoption; codex's crash-respawn supersession must NOT move a marker
            // bucket to a memory-less thread).
            if upsert.provider == "claude" {
                if let Some(old_id) = upsert.supersedes.as_deref() {
                    if old_id != upsert.session_id {
                        let mut rollbacks = self.rollbacks.lock().unwrap();
                        if let Some(record) =
                            rollbacks.remove(&(upsert.provider.clone(), old_id.to_string()))
                        {
                            rollbacks.insert(
                                (upsert.provider.clone(), upsert.session_id.clone()),
                                record,
                            );
                        }
                    }
                }
            }
            self.bindings.lock().unwrap().push(upsert);
        }
        self.write_result()
    }
    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings> {
        self.settings
            .lock()
            .unwrap()
            .get(&(provider.into(), session_id.into()))
            .cloned()
    }
    fn was_recorded(&self, provider: &str, session_id: &str) -> bool {
        self.recorded
            .lock()
            .unwrap()
            .contains(&(provider.into(), session_id.into()))
    }
    fn load_provenance(&self, provider: &str, session_id: &str) -> Option<BindProvenance> {
        let p = self
            .provenance
            .lock()
            .unwrap()
            .get(&(provider.into(), session_id.into()))
            .cloned()?;
        // An all-`None` answer is information-free: report absence rather
        // than a default (never park an invention).
        (p != BindProvenance::default()).then_some(p)
    }
    fn record_rollback(
        &self,
        provider: &str,
        session_id: &str,
        record: RollbackRecord,
    ) -> SinkWrite {
        if !self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            self.rollbacks
                .lock()
                .unwrap()
                .insert((provider.into(), session_id.into()), record);
            // A real write supersedes any seeded raw-bytes row (the handler's
            // post-op record carries EXPLICIT epoch keys from here on).
            self.legacy_rollback_payloads
                .lock()
                .unwrap()
                .remove(&(provider.into(), session_id.into()));
        }
        self.write_result()
    }
    fn load_rollback(&self, provider: &str, session_id: &str) -> Option<RollbackRecord> {
        let key = (provider.into(), session_id.into());
        if let Some(record) = self.rollbacks.lock().unwrap().get(&key) {
            return (record.version == ROLLBACK_RECORD_VERSION).then(|| record.clone());
        }
        // Focused ep1-r4 F2: a seeded raw-bytes row reads through the REAL
        // migration reader — never a hand-stamped typed record.
        let payload = self
            .legacy_rollback_payloads
            .lock()
            .unwrap()
            .get(&key)
            .cloned();
        payload.and_then(RollbackRecord::from_stored_payload)
    }
    fn delete_rollback(&self, provider: &str, session_id: &str) -> SinkWrite {
        if !self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            self.rollbacks
                .lock()
                .unwrap()
                .remove(&(provider.into(), session_id.into()));
            self.legacy_rollback_payloads
                .lock()
                .unwrap()
                .remove(&(provider.into(), session_id.into()));
        }
        self.write_result()
    }
    fn retire_closed(&self, provider: &str, session_id: &str) -> SinkWrite {
        if !self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            self.retires
                .lock()
                .unwrap()
                .push((provider.into(), session_id.into()));
        }
        self.write_result()
    }
    fn delete_pending(&self, placeholder_id: &str) -> SinkWrite {
        if !self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            self.pendings
                .lock()
                .unwrap()
                .retain(|(p, _, _)| p.as_str() != placeholder_id);
        }
        self.write_result()
    }
    fn lookup_by_create_request_id(
        &self,
        provider: &str,
        create_request_id: &str,
    ) -> Option<String> {
        // The bindings log is write-ordered; the LAST matching row is the
        // newest (the ledger's newest-by-updated_at rule, minus timestamps).
        self.bindings
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|b| {
                b.provider == provider && b.create_request_id.as_deref() == Some(create_request_id)
            })
            .map(|b| b.session_id.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn fake_sink_records_and_serves_settings() {
        let fake = Arc::new(FakeIdentitySink::default());
        fake.record_pending("freshopencode-r1", "freshopencode", Some("/w"))
            .await
            .expect("pending write ok");
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_1".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("r1".into()),
            resolves_pending: Some("freshopencode-r1".into()),
            supersedes: None,
            provenance: ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings {
                model: Some("m".into()),
                sandbox: None,
                permission_mode: None,
                effort: Some("low".into()),
                cwd: Some("/w".into()),
            },
        })
        .await
        .expect("binding write ok");
        let s = fake.load_settings("opencode", "ses_1").expect("settings");
        assert_eq!(s.model.as_deref(), Some("m"));
        assert_eq!(s.effort.as_deref(), Some("low"));
        assert_eq!(fake.pendings.lock().unwrap().len(), 1);
        assert_eq!(fake.bindings.lock().unwrap().len(), 1);
        assert!(fake.load_settings("opencode", "nope").is_none());
        assert!(fake.was_recorded("opencode", "ses_1"));
        assert!(!fake.was_recorded("opencode", "nope"));
    }

    /// Task 3 semantics: a lineage-only binding (all-blank settings snapshot —
    /// the shape the unconditional REST materialization write produces for a
    /// default create) records LINEAGE but is NOT a "recorded" session: it must
    /// not set `was_recorded` (that would arm a false SETTINGS_RESET on resume —
    /// exactly `was_recorded == true` with `load_settings == None`) and must not
    /// answer a settings snapshot, while the lineage columns themselves are
    /// preserved on the binding log.
    #[tokio::test]
    async fn fake_sink_blank_settings_binding_is_lineage_only() {
        let fake = Arc::new(FakeIdentitySink::default());
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_blank".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-blank".into()),
            resolves_pending: Some("freshopencode-cr-blank".into()),
            supersedes: None,
            provenance: ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("binding write ok");

        // The lineage row was written...
        {
            let bindings = fake.bindings.lock().unwrap();
            let row = bindings
                .iter()
                .find(|b| b.session_id == "ses_blank")
                .expect("lineage row recorded even with blank settings");
            assert_eq!(row.create_request_id.as_deref(), Some("cr-blank"));
        }

        // ...but it is NOT a settings-bearing record: no snapshot answer, no
        // "recorded" flag (Task 3 `was_recorded` keying).
        assert!(
            fake.load_settings("opencode", "ses_blank").is_none(),
            "a lineage-only row must answer no settings snapshot"
        );
        assert!(
            !fake.was_recorded("opencode", "ses_blank"),
            "a lineage-only row must not count as recorded (false SETTINGS_RESET)"
        );
    }

    /// Task 3: the placeholder→durable lineage lookup the REST resume door
    /// needs — resolve a create requestId to the durable session id off the
    /// binding log. A lineage-only row (blank settings) still answers: lineage
    /// is independent of settings recordability.
    #[tokio::test]
    async fn fake_sink_lookup_by_create_request_id_resolves_lineage() {
        let fake = Arc::new(FakeIdentitySink::default());
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_abc".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-1".into()),
            resolves_pending: Some("freshopencode-cr-1".into()),
            supersedes: None,
            provenance: ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("binding write ok");
        assert_eq!(
            fake.lookup_by_create_request_id("opencode", "cr-1")
                .as_deref(),
            Some("ses_abc")
        );
        // Unknown create requestId / other provider miss.
        assert_eq!(
            fake.lookup_by_create_request_id("opencode", "cr-nope"),
            None
        );
        assert_eq!(fake.lookup_by_create_request_id("codex", "cr-1"), None);
    }

    /// Focused-ep1-r5 Finding 2: the "meaningful provenance" definition —
    /// exactly the fields the D8 recovery judgment requires
    /// (`client_instance_id` + `device_id`); `tab_key` is placement-only and
    /// never required. Hollow (all-absent) and half-stamped values are not
    /// meaningful: they must behave like `None` on override/refresh
    /// decisions instead of replacing parked/row truth with nothing.
    #[test]
    fn bind_provenance_meaningfulness_tracks_the_d8_judgment_requirements() {
        assert!(!BindProvenance::default().is_meaningful());
        assert!(!BindProvenance {
            client_instance_id: Some("c".into()),
            ..Default::default()
        }
        .is_meaningful());
        assert!(!BindProvenance {
            device_id: Some("d".into()),
            ..Default::default()
        }
        .is_meaningful());
        assert!(!BindProvenance {
            client_instance_id: None,
            device_id: None,
            tab_key: Some("d:t".into()),
            asserted_at: 0,
        }
        .is_meaningful());
        assert!(BindProvenance {
            client_instance_id: Some("c".into()),
            device_id: Some("d".into()),
            tab_key: None,
            asserted_at: 0,
        }
        .is_meaningful());
        assert!(BindProvenance::for_create(Some("c"), Some("d"), Some("t"), 1).is_meaningful());
    }

    /// Focused-ep4-r2 Findings 1+2: the value CARRIES its assertion time —
    /// `for_create` records the receipt time it was handed, verbatim, on the
    /// exact stamps the D8 judgment consumes (no clock read hides inside).
    #[test]
    fn bind_provenance_carries_its_assertion_time() {
        let p = BindProvenance::for_create(Some("c"), Some("d"), Some("t"), 4242);
        assert_eq!(p.asserted_at, 4242);
        assert_eq!(p.tab_key.as_deref(), Some("d:t"));
        assert_eq!(
            BindProvenance::for_create(None, None, None, 4242),
            BindProvenance {
                client_instance_id: None,
                device_id: None,
                tab_key: None,
                asserted_at: 4242,
            },
            "a hollow value still carries the time (unused, but truthful)"
        );
    }

    #[tokio::test]
    async fn fake_sink_failure_knob_returns_err() {
        let fake = Arc::new(FakeIdentitySink::default());
        fake.fail_writes
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(
            fake.record_pending("p", "freshopencode", None)
                .await
                .is_err(),
            "failure must surface as Err, never be swallowed"
        );
    }

    #[tokio::test]
    async fn fake_sink_records_and_loads_rollback() {
        let fake = std::sync::Arc::new(FakeIdentitySink::default());
        let mut record = crate::rollback_record::RollbackRecord::empty(10);
        record.push_entry(
            crate::rollback_record::RollbackEntry {
                removed_turns: vec![serde_json::json!({"id": "t1"})],
                prompt_text: "p1".into(),
                at_ms: 11,
                epoch: 0,
            },
            12,
        );
        fake.record_rollback("opencode", "ses_1", record.clone())
            .await
            .expect("write ok");
        assert_eq!(fake.load_rollback("opencode", "ses_1"), Some(record));
        assert!(fake.load_rollback("opencode", "nope").is_none());
    }

    /// Focused-ep1-r4 Finding 2 + focused-ep4-r3 Findings 1+2:
    /// `load_provenance` serves the row's CURRENT stamps with the ledger's
    /// merge rule — a stamped LINEAGE-ONLY row (settings blank) answers just
    /// like a settings-bearing one (the read is settings-independent), a
    /// later conn-less write keeps the stamps, a genuinely unattributed row
    /// answers `None` (never `Some(default)` — that would park an invention),
    /// and a missing row answers `None`. The focused-ep4-r3 flip: the
    /// attribution fact moves ATOMICALLY and monotonically — a partial
    /// `Replace` no longer merges its `Some` fields piecemeal (the ledger's
    /// rule, mirrored), and an OLDER full-triple assertion never drags the
    /// stamps+time back.
    #[tokio::test]
    async fn fake_sink_load_provenance_mirrors_the_atomic_monotone_attribution_rule() {
        let fake = Arc::new(FakeIdentitySink::default());
        assert!(
            fake.load_provenance("opencode", "ses_none").is_none(),
            "no row -> None"
        );

        // A stamped lineage-only row (blank settings) still answers.
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_prov".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-x".into()),
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Replace(BindProvenance {
                client_instance_id: Some("client-1".into()),
                device_id: Some("device-1".into()),
                tab_key: Some("device-1:tab-1".into()),
                asserted_at: 111,
            }),
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("binding write ok");
        let p = fake
            .load_provenance("opencode", "ses_prov")
            .expect("the stamped row answers its stamps (settings-independent)");
        assert_eq!(p.client_instance_id.as_deref(), Some("client-1"));
        assert_eq!(p.device_id.as_deref(), Some("device-1"));
        assert_eq!(p.tab_key.as_deref(), Some("device-1:tab-1"));
        assert_eq!(
            p.asserted_at, 111,
            "the assertion time rides the value through the fake merge too"
        );

        // A later conn-less write (all-None stamps) keeps them — and a partial
        // stamp touches NOTHING (the attribution fact is atomic).
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_prov".into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("conn-less refresh ok");
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_prov".into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Replace(BindProvenance {
                client_instance_id: Some("client-2".into()),
                ..Default::default()
            }),
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("partial refresh ok");
        let p = fake
            .load_provenance("opencode", "ses_prov")
            .expect("the atomic rule preserved the stamps");
        assert_eq!(
            p.client_instance_id.as_deref(),
            Some("client-1"),
            "a weaker (partial) Replace no longer piecemeal-merges its field"
        );
        assert_eq!(p.device_id.as_deref(), Some("device-1"));
        assert_eq!(p.tab_key.as_deref(), Some("device-1:tab-1"));
        assert_eq!(
            p.asserted_at, 111,
            "a hollow/partial Replace preserves the assertion time (it is not an attribution)"
        );

        // The monotonic rule (the ledger's `asserted_at >= existing` gate,
        // mirrored): an OLDER full-triple assertion never drags the
        // attribution back; an equal-or-newer one replaces it.
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_prov".into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Replace(BindProvenance {
                client_instance_id: Some("client-3".into()),
                device_id: Some("device-3".into()),
                tab_key: Some("device-3:tab-3".into()),
                asserted_at: 50,
            }),
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("out-of-order write ok");
        let p = fake.load_provenance("opencode", "ses_prov").expect("row");
        assert_eq!(p.client_instance_id.as_deref(), Some("client-1"));
        assert_eq!(p.asserted_at, 111, "the older assertion never applies");
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_prov".into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Replace(BindProvenance {
                client_instance_id: Some("client-4".into()),
                device_id: Some("device-4".into()),
                tab_key: Some("device-4:tab-4".into()),
                asserted_at: 222,
            }),
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("newer write ok");
        let p = fake.load_provenance("opencode", "ses_prov").expect("row");
        assert_eq!(p.client_instance_id.as_deref(), Some("client-4"));
        assert_eq!(p.asserted_at, 222, "the newer assertion advances");

        // A genuinely unattributed row answers None — never Some(default).
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_unstamped".into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("binding write ok");
        assert_eq!(fake.load_provenance("opencode", "ses_unstamped"), None);
    }

    /// Delta-r2 Finding 2: a `Clear` upsert (the explicitly-headless REST/MCP
    /// lineage lanes) ERASES the tracked stamps — the ledger's real merge does
    /// the same, so `load_provenance` answers absence afterwards. Without this,
    /// a headless re-bind of a browser-stamped row would keep the stamps under
    /// a refreshed `updated_at` and launder the row into the D8 offer.
    #[tokio::test]
    async fn fake_sink_clear_provenance_erases_the_tracked_stamps() {
        let fake = Arc::new(FakeIdentitySink::default());
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_clr".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-b".into()),
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Replace(BindProvenance {
                client_instance_id: Some("client-1".into()),
                device_id: Some("device-1".into()),
                tab_key: Some("device-1:tab-1".into()),
                asserted_at: 222,
            }),
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("browser-stamped create write ok");
        assert!(fake.load_provenance("opencode", "ses_clr").is_some());

        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_clr".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-b".into()),
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Clear,
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("headless rebind write ok");
        assert_eq!(
            fake.load_provenance("opencode", "ses_clr"),
            None,
            "a Clear rebind erases the browser's stamps (load_provenance answers absence)"
        );
        // Inherit afterwards has nothing to keep: the stamps stay gone.
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_clr".into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("conn-less refresh ok");
        assert_eq!(fake.load_provenance("opencode", "ses_clr"), None);
    }

    /// A stored row whose version mismatches the schema reads as None — never
    /// reinterpreted across a future schema bump (the version gate is the only
    /// eviction of stale-shape rows).
    #[tokio::test]
    async fn fake_sink_load_rollback_version_gate_returns_none() {
        let fake = std::sync::Arc::new(FakeIdentitySink::default());
        let record = crate::rollback_record::RollbackRecord::empty(10);
        fake.record_rollback("opencode", "ses_v0", record)
            .await
            .expect("write ok");
        {
            let mut rows = fake.rollbacks.lock().unwrap();
            rows.get_mut(&("opencode".to_string(), "ses_v0".to_string()))
                .expect("row present")
                .version = 0;
        }
        assert_eq!(
            fake.load_rollback("opencode", "ses_v0"),
            None,
            "a version-mismatched row reads as absent, not partial"
        );
    }
}
