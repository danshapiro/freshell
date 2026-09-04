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

/// The claim commit's outcome (focused-ep5-r3 Finding 1, retire-on-kill
/// round 4) — the freshagent-crate mirror of `freshell_ws::pane_ledger`'s
/// `ClaimCommitOutcome` (this crate cannot see the ledger; the server-side
/// sink maps between them).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimCommit {
    /// The identity's dead-state was unchanged (or absent, or older) since
    /// the claim-start snapshot: the durable kill fence is cleared AND a
    /// kill-closed row is back to Bound, as ONE durable transition.
    Committed,
    /// A NEWER close landed mid-claim (the tombstone stamp advanced past the
    /// claim-start snapshot — the user closed the pane while the provider
    /// resume was still awaiting). NOTHING was cleared, revived, or mutated
    /// durably: the identity stays durably closed and the caller MUST tear
    /// its just-built session down (kill the sidecar, drop the session,
    /// fail the lease) and leave the ledger row Retired.
    RefusedStale,
}

/// The claim commit's completion future — the [`SinkWrite`] discipline with
/// a payload: awaited at every claim lane before its binding writes.
pub type SinkCommitWrite =
    std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<ClaimCommit>> + Send + 'static>>;

/// The alias-tombstone consumption's completion future (focused-ep5-r5
/// Finding 2, retire-on-kill round 6) — the [`SinkWrite`] discipline whose
/// payload is the placeholder keys whose records were consumed (the claim
/// clears their LEDGER kill fences next — the reopened identity's every
/// known alias reopens together).
pub type SinkAliasClearWrite = std::pin::Pin<
    Box<dyn std::future::Future<Output = std::io::Result<Vec<String>>> + Send + 'static>,
>;

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
    ///
    /// Focused-ep5-r1 Finding 2 (retire-on-kill round 2): ledger-side this
    /// ALSO records the durable KILL TOMBSTONE for the identity (same
    /// awaited batch), which the ledger's `record_fresh_agent_binding`
    /// consults before writing — so a binding write already in flight when
    /// the kill landed (an aborted consumer's orphaned spawn_blocking
    /// closure) suppresses itself instead of restoring Bound after the
    /// retire. See [`Self::clear_kill_tombstone`] for the lifecycle exit.
    fn retire_closed(&self, provider: &str, session_id: &str) -> SinkWrite;
    /// The PENDING companion of [`Self::retire_closed`]: a kill observed
    /// before identity resolution also deletes the pending marker, so a
    /// marker-driven resolution that lands later can never carry evidence
    /// for a pane that provably no longer exists. Idempotent (a missing
    /// marker == `Ok`).
    fn delete_pending(&self, placeholder_id: &str) -> SinkWrite;
    /// The tombstone lifecycle transition (focused-ep5-r1 Finding 2): a NEW
    /// pane/session GENUINELY CLAIMING the identity — an explicit
    /// resume/attach of a killed session — clears the kill tombstone the
    /// close recorded, so the claim's own binding write is never mistaken
    /// for the killed session's orphaned write and suppressed. Claims call
    /// it BEFORE their binding write (unconditionally — it is idempotent, a
    /// never-killed identity clears to `Ok`), awaited like every
    /// non-rollback lane (failures surface as `Err` for the caller to
    /// warn-log, never a resume blocker).
    /// Round 4 (focused-ep5-r3) narrowed the callers: the claimed DURABLE's
    /// own fence now moves inside [`Self::commit_claim`]'s conditional
    /// transition; this lane remains for the claude claim's consumed
    /// PLACEHOLDER-alias fences (secondary identities, cleared only after
    /// the durable's commit accepted).
    fn clear_kill_tombstone(&self, provider: &str, session_id: &str) -> SinkWrite;
    /// Focused-ep5-r3 Finding 1 (retire-on-kill round 4): the claim attempt's
    /// dead-state SNAPSHOT — the identity's durable kill-tombstone stamp
    /// (TTL-agnostic), read at claim START (before the provider spawn/resume
    /// awaits). Memory-fast + sync like `load_settings`; `None` = no durable
    /// close on record. The claim's [`Self::commit_claim`] compares the
    /// CURRENT stamp against this snapshot: any advance means a close landed
    /// mid-claim.
    fn kill_tombstone_at_ms(&self, provider: &str, session_id: &str) -> Option<i64>;
    /// Retire-on-kill round 5 (focused-ep5-r4 Finding 2): the raw row-state
    /// read the claude ALIAS-tombstone retention consults — true iff the
    /// identity's binding row exists and is currently Bound. Alias records
    /// (placeholder→durable) must live as long as the row they can resolve
    /// to: a close issued days after a pane's exit-eviction still needs the
    /// mapping to find the durable row, so TTL/cap eviction may only discard
    /// a record whose target row is already Retired-or-GC'd (unrecoverable —
    /// the mapping can no longer miss a live close). Memory-fast + sync like
    /// [`Self::kill_tombstone_at_ms`]. This is the RAW state (a tombstone-
    /// dominated-but-unconverged Bound row still answers true — retaining
    /// that alias is harmless: its kills retire the row anyway).
    fn row_is_bound(&self, provider: &str, session_id: &str) -> bool;
    /// Focused-ep5-r3 Findings 1+3 (retire-on-kill round 4) — the claim
    /// lifecycle's COMMIT, superseding round 3's separate
    /// `clear_kill_tombstone` + `revive_closed` pair. ONE conditional durable
    /// transition run ONLY after the replacement session is established
    /// (sidecar answered / thread resumed / session rebuilt):
    /// - The durable kill fence clears AND a kill-closed row revives to
    ///   Bound in one crash-atomic step (no split-write intermediate ever
    ///   reads as "cleared but still Closed" or "Bound but still fenced").
    /// - The transition runs ONLY when the identity's durable dead-state
    ///   is unchanged since the claim-start snapshot
    ///   (`expect_killed_at_ms`, from [`Self::kill_tombstone_at_ms`]): a
    ///   NEWER close mid-claim refuses the commit with NO durable side
    ///   effects ([`ClaimCommit::RefusedStale`]) — the resumed session is an
    ///   orphan of the pane the user already closed, and the caller tears
    ///   it down. The reviving claim must never undo a newer close.
    ///
    /// Awaited like every non-rollback lane. Round 5 (focused-ep5-r4
    /// Finding 5) supersedes the round-3 `Err` policy ("ambiguous — proceed
    /// as committed"): the ledger's commit is constructed so an `Err` leaves
    /// the close UNTOUCHED (the fence stands, a Closed row stays Closed —
    /// only the cleanup-phase tombstone delete can fail past the durable
    /// transition, and that failure is reported `Committed`, never `Err`).
    /// Continuing past an `Err` therefore registers a live session against a
    /// durably-closed row — exactly the live/Closed orphan this state
    /// machine exists to prevent. Callers treat `Err` like a refusal: tear
    /// the would-be session down and leave the row Closed (kill wins).
    fn commit_claim(
        &self,
        provider: &str,
        session_id: &str,
        expect_killed_at_ms: Option<i64>,
    ) -> SinkCommitWrite;
    /// Focused-ep5-r5 Finding 2 (retire-on-kill round 6): the claim commit
    /// with the PLACEHOLDER-fence consult. `fence_checked_aliases` are the
    /// one-shot pane-seat placeholders the claim's identity resolves through
    /// (the claude attach lane's attaching seat; the create lane's
    /// just-minted one). A close fence recorded under ANY of them blocks the
    /// commit exactly like one recorded under the durable id — same
    /// side-effect-free [`ClaimCommit::RefusedStale`] — with one deliberate
    /// simplification over the durable compare: the alias check is
    /// EXISTENCE-based, not snapshot-based. A durable id supports the
    /// genuine reopen (a resume the user meant), but a placeholder seat
    /// never does: it is one-shot by construction, and a fence under it
    /// means THAT seat's pane was closed — a later claim riding it is the
    /// finding's disconnected late attach regardless of WHEN the fence
    /// landed. The durable's own snapshot compare stands verbatim.
    fn commit_claim_aliased(
        &self,
        provider: &str,
        session_id: &str,
        expect_killed_at_ms: Option<i64>,
        fence_checked_aliases: &[String],
    ) -> SinkCommitWrite;
    /// Focused-ep5-r5 Finding 2, the durable half of the claude lane's alias
    /// tombstones: persist (or refresh — repeat mint/demotion re-stamps) the
    /// placeholder→durable mapping the kill consult resolves across a
    /// restart. Awaited like every non-rollback lane (failures surface as
    /// `Err` for the caller to warn-log, never a lane blocker — the
    /// in-memory store still answers this process's consults; the missed
    /// file is the restart-boundary hole the lane logs loudly). The
    /// record's retention (drop only once its row is Retired-or-GC'd and
    /// past the TTL) is the store's own sweep, never the writer's call.
    fn record_alias_tombstone(
        &self,
        provider: &str,
        placeholder: &str,
        durable: &str,
        at_ms: i64,
    ) -> SinkWrite;
    /// The placeholder's persisted durable ids (TTL-agnostic — the claude
    /// kill consult applies the row-state retention rule). Memory-fast +
    /// sync like [`Self::kill_tombstone_at_ms`]: the kill's single
    /// critical-section consult calls it under held guards.
    fn alias_tombstone_records(&self, provider: &str, placeholder: &str) -> Vec<(String, i64)>;
    /// The claim lifecycle's consumption of the DURABLE store: every alias
    /// record pointing at the claimed durable is consumed (the in-memory
    /// store's `clear_for_durable` twin), returning the placeholder keys
    /// whose records were consumed — the claim then clears their LEDGER
    /// kill fences (the reopened identity's every known alias reopens
    /// together). Awaited; failures warn at the caller, never block the
    /// commit that already accepted.
    fn clear_alias_tombstones_for_durable(
        &self,
        provider: &str,
        durable: &str,
    ) -> SinkAliasClearWrite;
}

pub type SharedPaneIdentitySink = Arc<dyn PaneIdentitySink>;

/// The alias-tombstone map shape (focused-ep5-r5 Finding 2): (provider,
/// placeholder) -> [(durable, at_ms)]. Factored for readability (and the
/// type-complexity lint) at the fake store below.
#[cfg(test)]
pub(crate) type AliasRecordMap = std::collections::HashMap<(String, String), Vec<(String, i64)>>;

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
    /// Focused-ep5-r1 Finding 2 (round-4 amended): the fake mirror of the
    /// ledger's kill tombstones, stamped by `kill_clock` — a deterministic
    /// monotone counter standing in for the real ledger's wall-clock
    /// `killed_at_ms` (every `retire_closed` re-stamps strictly forward, the
    /// same refresh the real tombstone write performs). `retire_closed`
    /// folds the tombstone in (exactly like the real
    /// `PaneLedger::retire_closed`), and `record_binding`'s apply consults
    /// it: a tombstoned identity's binding write is SUPPRESSED (recorded in
    /// `suppressed`, never appended to `bindings` — the fake's observable
    /// twin of "writes nothing"). TTL + dominance-vs-claim-residue niceties
    /// are deliberately NOT modeled (the fake's rows carry no liveness
    /// stamps); what IS modeled faithfully is the round-4 claim
    /// CONDITION: `commit_claim` compares the current stamp against the
    /// claim-start snapshot and refuses on any advance.
    pub kill_tombstones:
        std::sync::Mutex<std::collections::HashMap<(String, String), i64>>,
    /// The stamp source for [`Self::kill_tombstones`] (see its doc).
    kill_clock: std::sync::Mutex<i64>,
    /// Every `clear_kill_tombstone` call (the genuine-claim lanes' lifecycle
    /// transition), in order, whether or not a tombstone existed.
    pub tombstone_clears: std::sync::Mutex<Vec<(String, String)>>,
    /// Every ACCEPTED `commit_claim` (the round-4 conditional commit;
    /// supersedes the round-3 `revives` log — a commit IS the claim's
    /// revive+clear transition), in order.
    pub claim_commits: std::sync::Mutex<Vec<(String, String)>>,
    /// Every REFUSED `commit_claim` (Finding 1's stale-dead-state refusal),
    /// in order — the positive assertion surface for "no commit side effect
    /// ran" (paired with the tombstone/state maps staying put).
    pub claim_refusals: std::sync::Mutex<Vec<(String, String)>>,
    /// Finding 1 test hook — see [`Self::arm_claim_commit_gate`].
    claim_gate: std::sync::Mutex<Option<ClaimCommitGate>>,
    /// Binding writes SUPPRESSED by a kill tombstone (the round-2 fence) —
    /// recorded here (never in `bindings`) so tests assert the suppression
    /// positively instead of inferring it from absence.
    pub suppressed: std::sync::Mutex<Vec<(String, String)>>,
    /// Retire-on-kill round 3: the row's CURRENT state per identity (see
    /// [`FakeRowState`]). Keyed only by identities a binding write ever
    /// landed for — the real "missing row" answer for anything else.
    pub states:
        std::sync::Mutex<std::collections::HashMap<(String, String), FakeRowState>>,
    /// Focused ep1-r4 F2: (provider, sessionId) -> a row seeded as RAW STORED
    /// BYTES (a pre-epoch-fields legacy payload). `load_rollback` routes these
    /// through [`RollbackRecord::from_stored_payload`] exactly like the real
    /// `LedgerIdentitySink`'s read of stored bytes, so handler tests drive the
    /// in-memory migration itself, never a hand-stamped typed record.
    pub legacy_rollback_payloads:
        std::sync::Mutex<std::collections::HashMap<(String, String), serde_json::Value>>,
    /// When true, write futures resolve to Err — for failure-surfacing tests.
    pub fail_writes: std::sync::atomic::AtomicBool,
    /// Retire-on-kill round 5 (focused-ep5-r4 Finding 1) test hook — see
    /// [`Self::arm_post_commit_stall`].
    post_commit_stall: std::sync::Mutex<Option<PostCommitStallGate>>,
    /// Retire-on-kill round 6 (focused-ep5-r5 Finding 1) test hook — see
    /// [`Self::arm_retire_stall`].
    retire_stall: std::sync::Mutex<Option<RetireStallGate>>,
    /// Focused-ep5-r5 Finding 2: the fake mirror of the ledger's durable
    /// alias tombstones — (provider, placeholder) -> [(durable, at_ms)],
    /// written by `record_alias_tombstone`, consulted by
    /// `alias_tombstone_records`, consumed by
    /// `clear_alias_tombstones_for_durable`. The
    /// lifetime-is-the-row's discipline is the PROVIDER-side store's concern
    /// (its row-state probe consults [`Self::states`]); the fake keeps the
    /// verbatim record set like the ledger's write-through index does.
    pub alias_records: std::sync::Mutex<AliasRecordMap>,
    /// Every `record_alias_tombstone` call's (provider, placeholder, durable), in order.
    pub alias_record_writes: std::sync::Mutex<Vec<(String, String, String)>>,
    /// Every `clear_alias_tombstones_for_durable` call's (provider, durable), in order.
    pub alias_clears: std::sync::Mutex<Vec<(String, String)>>,
    /// Focused-ep5-r1 Finding 2 test hook — see [`Self::arm_orphan_binding_gate`].
    orphan_gate: std::sync::Mutex<Option<OrphanBindingGate>>,
    /// Weak self-handle so the orphan gate's detached apply task can reach
    /// the fake after the caller's await was cancelled (set by
    /// [`Self::arm_orphan_binding_gate`]).
    self_weak: std::sync::Mutex<std::sync::Weak<FakeIdentitySink>>,
}

    /// Retire-on-kill round 3: the fake's ROW-STATE model (the in-memory twin
    /// of the real ledger's `state`/`retired_reason` columns), so kill/claim
    /// lanes can be pinned on "the row ends Retired(Closed), never Bound"
    /// instead of on call traces. `record_binding` produces a Bound row;
    /// `retire_closed` flips a Bound row to Closed (a missing or
    /// already-retired row is unaffected — the real retire's no-op shape).
    #[cfg(test)]
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum FakeRowState {
        Bound,
        Closed,
    }

    /// Focused-ep5-r1 Finding 2 test hook: the armed orphan gate's state.
    #[cfg(test)]
    struct OrphanBindingGate {
    /// The (provider, session_id) key this gate intercepts.
    key: (String, String),
    /// Signaled when `record_binding` was INVOKED for the key (the
    /// production "spawn_blocking launched" moment).
    entered_tx: std::sync::mpsc::Sender<()>,
    /// The test's release: the detached apply runs only after this resolves.
    release_rx: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    /// Signaled when the detached apply RAN (post-release), so the test's
    /// assertions are deterministic (no sleep-and-hope).
    applied_tx: std::sync::mpsc::Sender<()>,
}

/// Focused-ep5-r1 Finding 2 test hook: the handles
/// [`FakeIdentitySink::arm_orphan_binding_gate`] hands the test. `entered`
/// fires at invocation (production's spawn-launch point); `release` lets the
/// in-flight write land; `applied` fires when the detached apply actually
/// ran.
#[cfg(test)]
pub(crate) struct OrphanGateHandles {
    pub entered: std::sync::mpsc::Receiver<()>,
    pub release: tokio::sync::oneshot::Sender<()>,
    pub applied: std::sync::mpsc::Receiver<()>,
}

/// Focused-ep5-r3 Finding 1 test hook: the armed claim-commit gate's state.
#[cfg(test)]
struct ClaimCommitGate {
    /// The (provider, session_id) key this gate intercepts.
    key: (String, String),
    /// Signaled when `commit_claim` was INVOKED for the key (the claim has
    /// reached its commit — in production terms, the provider resume
    /// succeeded and the lane is committing).
    entered_tx: std::sync::mpsc::Sender<()>,
    /// The test's release: the conditional decide+apply runs only after this
    /// resolves (the claim-commit twin of the orphan gate's detached apply —
    /// the decision consults the tombstone state AT DECIDE TIME, so a kill
    /// the test runs while the gate is held is exactly Finding 1's
    /// kill-during-the-resume-await).
    release_rx: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    /// Signaled when the decide+apply RAN (post-release), so the test's
    /// assertions are deterministic (no sleep-and-hope).
    decided_tx: std::sync::mpsc::Sender<()>,
}

/// Focused-ep5-r3 Finding 1 test hook: the handles
/// [`FakeIdentitySink::arm_claim_commit_gate`] hands the test.
/// `entered` fires when the claim reached its commit; `release` lets the
/// conditional decide+apply run; `decided` fires when it actually ran.
#[cfg(test)]
pub(crate) struct ClaimGateHandles {
    pub entered: std::sync::mpsc::Receiver<()>,
    pub release: tokio::sync::oneshot::Sender<()>,
    pub decided: std::sync::mpsc::Receiver<()>,
}

/// Retire-on-kill round 5 (focused-ep5-r4 Finding 1) test hook: the armed
/// post-commit stall gate's state. The commit DECIDES+APPLIES inline (the
/// durable transition has LANDED — fence cleared, row revived) but the
/// returned future stalls behind the test's release — the deterministic
/// model of Finding 1's shape: a kill QUEUED behind the commit (the
/// commit's decision pre-dates it) whose retire lands while the claimant is
/// between its completed commit and its session registration.
#[cfg(test)]
struct PostCommitStallGate {
    /// The (provider, session_id) key this gate intercepts.
    key: (String, String),
    /// Signaled when the commit APPLIED (the durable transition landed) and
    /// the lane is now parked pre-registration.
    applied_tx: std::sync::mpsc::Sender<()>,
    /// The test's release: the stalled future resolves only after this.
    release_rx: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

/// Retire-on-kill round 5 (focused-ep5-r4 Finding 1) test hook: the handles
/// [`FakeIdentitySink::arm_post_commit_stall`] hands the test. `applied`
/// fires when the commit LANDED and the lane parked pre-registration;
/// `release` lets the stalled lane proceed (to its registration and, on the
/// fixed lanes, its post-registration dead-state re-check).
#[cfg(test)]
pub(crate) struct PostCommitStallHandles {
    pub applied: std::sync::mpsc::Receiver<()>,
    pub release: tokio::sync::oneshot::Sender<()>,
}

/// Retire-on-kill round 6 (focused-ep5-r5 Finding 1) test hook: the armed
/// retire stall's state. The close's mutations (the `retires` log, the
/// kill-tombstone fold, the row-state flip) land EAGERLY at call time —
/// exactly like the real ledger's `retire_closed`, which records the close
/// durably inside the call — and only the returned FUTURE parks behind the
/// test's release, so the test can hold the kill lane between its completed
/// durable close and its teardown awaits (the deterministic mid-lane stop
/// the round-6 lock-order pins stage around).
#[cfg(test)]
struct RetireStallGate {
    /// The (provider, session_id) key this gate intercepts.
    key: (String, String),
    /// Signaled when the stalled `retire_closed` was INVOKED (its mutations
    /// already applied — the close is on record and only the answer stalls).
    entered_tx: std::sync::mpsc::Sender<()>,
    /// The test's release: the returned future resolves only after this.
    release_rx: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

/// Retire-on-kill round 6 test hook: the handles
/// [`FakeIdentitySink::arm_retire_stall`] hands the test. `entered` fires
/// when the stalled retire's mutations LANDED (close recorded, answer
/// parked); `release` lets the stalled answer resolve.
#[cfg(test)]
pub(crate) struct RetireStallHandles {
    pub entered: std::sync::mpsc::Receiver<()>,
    pub release: tokio::sync::oneshot::Sender<()>,
}

#[cfg(test)]
impl FakeIdentitySink {
    #[allow(dead_code)] // used by identity-event tasks (Tasks 4-10 tests)
    pub fn seed(&self, provider: &str, session_id: &str, s: FreshAgentSettings) {
        // A seed mirrors a real binding write: the row is Bound (the round-3
        // states map gets the same answer `apply_binding_mutations` gives).
        self.states
            .lock()
            .unwrap()
            .insert((provider.into(), session_id.into()), FakeRowState::Bound);
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
    /// Focused-ep5-r1 Finding 2: arm the ORPHAN gate for one identity key.
    /// The next `record_binding` for exactly that key models the production
    /// spawn_blocking orphan FAITHFULLY: the mutation decision is NOT made at
    /// invocation or await time — it is DETACHED and made when the test
    /// releases the gate, even if the caller's await was cancelled (an
    /// aborted consumer), exactly like a `spawn_blocking` closure that
    /// outlives its awaiting task. The tombstone consult therefore happens at
    /// apply time, which is what lets a test stage "the binding write was in
    /// flight when the kill landed" WITHOUT a synchronous-install shortcut.
    pub(crate) fn arm_orphan_binding_gate(
        self: &std::sync::Arc<Self>,
        provider: &str,
        session_id: &str,
    ) -> OrphanGateHandles {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (applied_tx, applied_rx) = std::sync::mpsc::channel();
        *self.self_weak.lock().unwrap() = std::sync::Arc::downgrade(self);
        *self.orphan_gate.lock().unwrap() = Some(OrphanBindingGate {
            key: (provider.into(), session_id.into()),
            entered_tx,
            release_rx: std::sync::Mutex::new(Some(release_rx)),
            applied_tx,
        });
        OrphanGateHandles {
            entered: entered_rx,
            release: release_tx,
            applied: applied_rx,
        }
    }
    /// Focused-ep5-r3 Finding 1 test hook: arm the CLAIM-COMMIT gate for one
    /// identity key. The next `commit_claim` for exactly that key holds the
    /// conditional decide+apply behind the test's release — the exact
    /// scheduling twin of the orphan binding gate, so a test can land a REAL
    /// kill (`handle_kill`) BETWEEN the claim's commit point and its durable
    /// decision, deterministically reproducing the report's
    /// kill-during-the-provider-resume-await interleaving. The decision
    /// outcome still flows back to the awaiting caller (the lane's teardown
    /// arm runs on it), exactly like a ledger commit that took the guard
    /// late. One-shot: later commits proceed inline.
    pub(crate) fn arm_claim_commit_gate(
        self: &std::sync::Arc<Self>,
        provider: &str,
        session_id: &str,
    ) -> ClaimGateHandles {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (decided_tx, decided_rx) = std::sync::mpsc::channel();
        *self.self_weak.lock().unwrap() = std::sync::Arc::downgrade(self);
        *self.claim_gate.lock().unwrap() = Some(ClaimCommitGate {
            key: (provider.into(), session_id.into()),
            entered_tx,
            release_rx: std::sync::Mutex::new(Some(release_rx)),
            decided_tx,
        });
        ClaimGateHandles {
            entered: entered_rx,
            release: release_tx,
            decided: decided_rx,
        }
    }
    /// Retire-on-kill round 5 (focused-ep5-r4 Finding 1) test hook: arm the
    /// post-commit stall for one identity key. The next `commit_claim` for
    /// exactly that key DECIDES+APPLIES inline (the durable transition lands
    /// — tombstone cleared, kill-closed row revived, exactly like the real
    /// [`PaneLedger::commit_claim`]'s committed arm) and then parks the lane
    /// behind the test's release BEFORE resolving — so the test can land a
    /// REAL `handle_kill` (whose retire re-stamps the fence and re-retires
    /// the row) in the window between the completed commit and the claim
    /// lane's session registration, the finding's "kill queued while the
    /// commit owns the ledger lock" interleaving. One-shot: later commits
    /// proceed inline.
    pub(crate) fn arm_post_commit_stall(
        self: &std::sync::Arc<Self>,
        provider: &str,
        session_id: &str,
    ) -> PostCommitStallHandles {
        let (applied_tx, applied_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        *self.self_weak.lock().unwrap() = std::sync::Arc::downgrade(self);
        *self.post_commit_stall.lock().unwrap() = Some(PostCommitStallGate {
            key: (provider.into(), session_id.into()),
            applied_tx,
            release_rx: std::sync::Mutex::new(Some(release_rx)),
        });
        PostCommitStallHandles {
            applied: applied_rx,
            release: release_tx,
        }
    }
    /// Retire-on-kill round 6 (focused-ep5-r5 Finding 1) test hook: arm the
    /// RETIRE stall for one identity key. The next `retire_closed` for
    /// exactly that key applies its mutations INLINE (the retires log, the
    /// kill-tombstone fold, the row-state flip — the durable close is
    /// recorded) and then parks the returned future behind the test's
    /// release — so a kill lane sits between its completed close and its
    /// teardown while the test holds whichever lock the teardown must wait
    /// on. One-shot: later retires proceed inline.
    pub(crate) fn arm_retire_stall(
        self: &std::sync::Arc<Self>,
        provider: &str,
        session_id: &str,
    ) -> RetireStallHandles {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        *self.self_weak.lock().unwrap() = std::sync::Arc::downgrade(self);
        *self.retire_stall.lock().unwrap() = Some(RetireStallGate {
            key: (provider.into(), session_id.into()),
            entered_tx,
            release_rx: std::sync::Mutex::new(Some(release_rx)),
        });
        RetireStallHandles {
            entered: entered_rx,
            release: release_tx,
        }
    }
    /// The shared claim-commit decide+apply (the direct path AND the claim
    /// gate's + stall's tasks): EXACTLY `PaneLedger::commit_claim`'s
    /// conditional-transition contract against the fake's state. Refusal
    /// mutates NOTHING (no clear, no revive, no row flip); a commit clears
    /// the fence and flips a Closed row to Bound in the same breath. The
    /// round-6 form (focused-ep5-r5 Finding 2): the
    /// alias-existence consult mirrors the ledger's
    /// `commit_claim_aliased` — a fence under ANY placeholder the claim
    /// rides refuses first (snapshots never consulted for seats; see the
    /// trait doc), before the durable's own snapshot compare runs.
    /// alias-existence consult mirrors the ledger's
    /// `commit_claim_aliased` — a fence under ANY placeholder the claim
    /// rides refuses first (snapshots never consulted for seats; see the
    /// trait doc), before the durable's own snapshot compare runs.
    #[cfg(test)]
    fn apply_claim_commit_aliased(
        &self,
        provider: &str,
        session_id: &str,
        expect_killed_at_ms: Option<i64>,
        fence_checked_aliases: &[String],
    ) -> ClaimCommit {
        for alias in fence_checked_aliases {
            let alias_key = (provider.to_string(), alias.clone());
            if self.kill_tombstones.lock().unwrap().contains_key(&alias_key) {
                self.claim_refusals
                    .lock()
                    .unwrap()
                    .push((provider.to_string(), session_id.to_string()));
                return ClaimCommit::RefusedStale;
            }
        }
        let key = (provider.to_string(), session_id.to_string());
        let current = self.kill_tombstones.lock().unwrap().get(&key).copied();
        let advanced = match (current, expect_killed_at_ms) {
            (Some(cur), Some(exp)) => cur > exp,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if advanced {
            self.claim_refusals.lock().unwrap().push(key);
            return ClaimCommit::RefusedStale;
        }
        self.kill_tombstones.lock().unwrap().remove(&key);
        self.claim_commits.lock().unwrap().push(key.clone());
        let mut states = self.states.lock().unwrap();
        if states.get(&key) == Some(&FakeRowState::Closed) {
            states.insert(key, FakeRowState::Bound);
        }
        ClaimCommit::Committed
    }
    /// The shared binding-write apply (the normal path AND the orphan gate's
    /// detached task): mutations only — the caller owns the SinkWrite knob.
    /// The kill-tombstone consult lives HERE so both paths fence identically.
    #[cfg(test)]
    fn apply_binding(&self, upsert: FreshAgentBindingUpsert) {
        // Focused-ep5-r1 Finding 2 mirror: a tombstoned identity writes
        // NOTHING (the ledger's `record_fresh_agent_binding` suppression).
        let key0 = (upsert.provider.clone(), upsert.session_id.clone());
        if self.kill_tombstones.lock().unwrap().contains_key(&key0) {
            self.suppressed.lock().unwrap().push(key0);
            return;
        }
        // ...delegated to the existing mutation body below
        self.apply_binding_mutations(upsert);
    }
    /// The mutation body of `record_binding`, minus the tombstone consult.
    #[cfg(test)]
    fn apply_binding_mutations(&self, upsert: FreshAgentBindingUpsert) {
        let key = (upsert.provider.clone(), upsert.session_id.clone());
        // Retire-on-kill round 3 row-state mirror: the ledger's fresh-agent
        // upsert is unconditionally Bound — a landed write resurrects the row.
        self.states
            .lock()
            .unwrap()
            .insert(key.clone(), FakeRowState::Bound);
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
            // Focused-ep5-r1 Finding 2 orphan-gate arm: an armed gate for this
            // EXACT key DETACHES the apply — it runs when the test releases
            // the gate (tombstone consult at apply time), exactly like the
            // production spawn_blocking closure that survives its awaiting
            // task's abort. The returned future resolves immediately: the
            // write landing is decoupled from any await.
            let gate_arm = {
                let gate = self.orphan_gate.lock().unwrap();
                gate.as_ref().and_then(|g| {
                    if g.key == (upsert.provider.clone(), upsert.session_id.clone()) {
                        let release_rx = g.release_rx.lock().unwrap().take();
                        release_rx.map(|rx| (g.entered_tx.clone(), rx, g.applied_tx.clone()))
                    } else {
                        None
                    }
                })
            };
            if let Some((entered_tx, release_rx, applied_tx)) = gate_arm {
                // One-shot: disarm so later writes for the key apply inline.
                *self.orphan_gate.lock().unwrap() = None;
                let _ = entered_tx.send(());
                let me = self.self_weak.lock().unwrap().clone();
                tokio::spawn(async move {
                    let _ = release_rx.await;
                    if let Some(me) = me.upgrade() {
                        me.apply_binding(upsert);
                    }
                    let _ = applied_tx.send(());
                });
                return Box::pin(std::future::ready(Ok(())));
            }
            self.apply_binding(upsert);
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
            // Focused-ep5-r1 Finding 2 mirror: retire_closed folds the kill
            // tombstone in (the real `PaneLedger::retire_closed` discipline),
            // re-stamped strictly forward (the kill clock), exactly like the
            // real tombstone write's `killed_at_ms` refresh.
            let stamp = {
                let mut clock = self.kill_clock.lock().unwrap();
                *clock += 1;
                *clock
            };
            self.kill_tombstones
                .lock()
                .unwrap()
                .insert((provider.into(), session_id.into()), stamp);
            // Retire-on-kill round 3 row-state mirror: a Bound row retires
            // Closed; a missing or already-retired row is unaffected.
            let mut states = self.states.lock().unwrap();
            if states.get(&(provider.into(), session_id.into())) == Some(&FakeRowState::Bound) {
                states.insert((provider.into(), session_id.into()), FakeRowState::Closed);
            }
        }
        // Retire-on-kill round 6 (Finding 1) stall arm: the close's mutations
        // landed INLINE above (the durable record of the close); only the
        // ANSWER parks behind the test's release — the kill lane sits
        // between its completed close and its teardown, deterministically.
        // Never engages on the failure knob (a failed retire is no stall).
        if self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            return self.write_result();
        }
        let stall_arm = {
            let gate = self.retire_stall.lock().unwrap();
            gate.as_ref().and_then(|g| {
                if g.key == (provider.to_string(), session_id.to_string()) {
                    let release_rx = g.release_rx.lock().unwrap().take();
                    release_rx.map(|rx| (g.entered_tx.clone(), rx))
                } else {
                    None
                }
            })
        };
        if let Some((entered_tx, release_rx)) = stall_arm {
            // One-shot: disarm so later retires proceed inline.
            *self.retire_stall.lock().unwrap() = None;
            let _ = entered_tx.send(());
            return Box::pin(async move {
                let _ = release_rx.await;
                Ok(())
            });
        }
        self.write_result()
    }
    fn clear_kill_tombstone(&self, provider: &str, session_id: &str) -> SinkWrite {
        if !self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            self.tombstone_clears
                .lock()
                .unwrap()
                .push((provider.into(), session_id.into()));
            self.kill_tombstones
                .lock()
                .unwrap()
                .remove(&(provider.into(), session_id.into()));
        }
        self.write_result()
    }
    fn kill_tombstone_at_ms(&self, provider: &str, session_id: &str) -> Option<i64> {
        self.kill_tombstones
            .lock()
            .unwrap()
            .get(&(provider.into(), session_id.into()))
            .copied()
    }
    fn row_is_bound(&self, provider: &str, session_id: &str) -> bool {
        // Retire-on-kill round 5 (F2): the fake's row-state mirror answers —
        // a Bound row retains the aliases that can resolve to it.
        self.states
            .lock()
            .unwrap()
            .get(&(provider.into(), session_id.into()))
            == Some(&FakeRowState::Bound)
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
        if self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            return Box::pin(std::future::ready(Err(std::io::Error::other(
                "fake write failure",
            ))));
        }
        let aliases: Vec<String> = fence_checked_aliases.to_vec();
        // Finding 1 claim-gate arm (the orphan-gate twin): an armed gate for
        // this EXACT key holds the decide+apply behind the test's release;
        // the awaiting claimant's future resolves with the decided outcome.
        let gate_arm = {
            let gate = self.claim_gate.lock().unwrap();
            gate.as_ref().and_then(|g| {
                if g.key == (provider.to_string(), session_id.to_string()) {
                    let release_rx = g.release_rx.lock().unwrap().take();
                    release_rx.map(|rx| (g.entered_tx.clone(), rx, g.decided_tx.clone()))
                } else {
                    None
                }
            })
        };
        if let Some((entered_tx, release_rx, decided_tx)) = gate_arm {
            *self.claim_gate.lock().unwrap() = None;
            let _ = entered_tx.send(());
            let me = self.self_weak.lock().unwrap().clone();
            let (outcome_tx, outcome_rx) = tokio::sync::oneshot::channel();
            let (p, s) = (provider.to_string(), session_id.to_string());
            tokio::spawn(async move {
                let _ = release_rx.await;
                let outcome = if let Some(me) = me.upgrade() {
                    me.apply_claim_commit_aliased(&p, &s, expect_killed_at_ms, &aliases)
                } else {
                    // The fake outlived the test's reference cycle: decide
                    // nothing, report refusal-safe stale. Never reached in
                    // practice (the state holds the sink through the lane).
                    ClaimCommit::RefusedStale
                };
                let _ = decided_tx.send(());
                let _ = outcome_tx.send(outcome);
            });
            return Box::pin(async move {
                outcome_rx
                    .await
                    .map_err(std::io::Error::other)
            });
        }
        // Retire-on-kill round 5 (focused-ep5-r4 Finding 1) stall arm: the
        // decide+apply runs INLINE (the durable transition has landed), then
        // the future parks behind the test's release — the claimant sits
        // between its completed commit and its registration while the test
        // lands the kill that the commit's decision pre-dated.
        let stall_arm = {
            let gate = self.post_commit_stall.lock().unwrap();
            gate.as_ref().and_then(|g| {
                if g.key == (provider.to_string(), session_id.to_string()) {
                    let release_rx = g.release_rx.lock().unwrap().take();
                    release_rx.map(|rx| (g.applied_tx.clone(), rx))
                } else {
                    None
                }
            })
        };
        if let Some((applied_tx, release_rx)) = stall_arm {
            // One-shot: disarm so later commits proceed inline.
            *self.post_commit_stall.lock().unwrap() = None;
            let outcome =
                self.apply_claim_commit_aliased(provider, session_id, expect_killed_at_ms, &aliases);
            let _ = applied_tx.send(());
            return Box::pin(async move {
                let _ = release_rx.await;
                Ok(outcome)
            });
        }
        let outcome =
            self.apply_claim_commit_aliased(provider, session_id, expect_killed_at_ms, &aliases);
        Box::pin(std::future::ready(Ok(outcome)))
    }
    fn record_alias_tombstone(
        &self,
        provider: &str,
        placeholder: &str,
        durable: &str,
        at_ms: i64,
    ) -> SinkWrite {
        if !self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            self.alias_record_writes.lock().unwrap().push((
                provider.into(),
                placeholder.into(),
                durable.into(),
            ));
            let key = (provider.to_string(), placeholder.to_string());
            let mut records = self.alias_records.lock().unwrap();
            let entries = records.entry(key).or_default();
            if let Some(existing) = entries.iter_mut().find(|(d, _)| d == durable) {
                existing.1 = at_ms;
            } else {
                entries.push((durable.to_string(), at_ms));
            }
        }
        self.write_result()
    }
    fn alias_tombstone_records(&self, provider: &str, placeholder: &str) -> Vec<(String, i64)> {
        self.alias_records
            .lock()
            .unwrap()
            .get(&(provider.to_string(), placeholder.to_string()))
            .cloned()
            .unwrap_or_default()
    }
    fn clear_alias_tombstones_for_durable(
        &self,
        provider: &str,
        durable: &str,
    ) -> SinkAliasClearWrite {
        if self.fail_writes.load(std::sync::atomic::Ordering::SeqCst) {
            return Box::pin(std::future::ready(Err(std::io::Error::other(
                "fake write failure",
            ))));
        }
        self.alias_clears
            .lock()
            .unwrap()
            .push((provider.into(), durable.into()));
        let mut records = self.alias_records.lock().unwrap();
        let mut cleared: Vec<String> = Vec::new();
        records.retain(|(p, placeholder), entries| {
            if p != provider {
                return true;
            }
            let before = entries.len();
            entries.retain(|(d, _)| d != durable);
            if entries.len() != before {
                cleared.push(placeholder.clone());
            }
            !entries.is_empty()
        });
        cleared.sort();
        Box::pin(std::future::ready(Ok(cleared)))
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

    /// Focused-ep5-r1 Finding 2 (fake mirror): `retire_closed` folds the kill
    /// tombstone in, `record_binding`'s apply consults it (the tombstoned
    /// identity's write is SUPPRESSED — never appended to `bindings`), and
    /// `clear_kill_tombstone` is the genuine-claim lifecycle exit (the next
    /// write lands again).
    #[tokio::test]
    async fn fake_sink_mirrors_the_kill_tombstone_fence_and_the_claim_clear() {
        let fake = Arc::new(FakeIdentitySink::default());
        let upsert = || FreshAgentBindingUpsert {
            provider: "claude".into(),
            session_id: "durable-m".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings::default(),
        };
        fake.retire_closed("claude", "durable-m")
            .await
            .expect("retire ok");
        fake.record_binding(upsert()).await.expect("write ok");
        assert!(
            fake.bindings.lock().unwrap().is_empty(),
            "a tombstoned identity's binding write is suppressed"
        );
        assert_eq!(
            fake.suppressed.lock().unwrap().as_slice(),
            &[("claude".to_string(), "durable-m".to_string())],
            "the suppression is positively observable"
        );

        fake.clear_kill_tombstone("claude", "durable-m")
            .await
            .expect("clear ok");
        assert_eq!(
            fake.tombstone_clears.lock().unwrap().as_slice(),
            &[("claude".to_string(), "durable-m".to_string())]
        );
        fake.record_binding(upsert()).await.expect("write ok");
        assert_eq!(
            fake.bindings.lock().unwrap().len(),
            1,
            "post-clear the genuine claim's write lands"
        );
    }

    /// Focused-ep5-r3 Finding 1 (fake mirror): the conditional commit is
    /// faithful to `PaneLedger::commit_claim` — an unchanged dead-state
    /// commits (fence clear + row revive in one step, positively logged); an
    /// ADVANCED dead-state refuses wholesale: no clear, no revive, and the
    /// fence keeps fencing (a follow-up write still suppresses).
    #[tokio::test]
    async fn fake_commit_claim_is_conditional_like_the_real_ledger() {
        let fake = Arc::new(FakeIdentitySink::default());
        fake.seed(
            "claude",
            "durable-cc",
            FreshAgentSettings {
                cwd: Some("/w".into()),
                ..FreshAgentSettings::default()
            },
        );
        fake.retire_closed("claude", "durable-cc").await.expect("kill");
        let snap = fake.kill_tombstone_at_ms("claude", "durable-cc");
        assert!(snap.is_some(), "the fence answers the snapshot read");

        let outcome = fake
            .commit_claim("claude", "durable-cc", snap)
            .await
            .expect("commit ok");
        assert_eq!(outcome, ClaimCommit::Committed);
        assert_eq!(
            fake.claim_commits.lock().unwrap().as_slice(),
            &[("claude".to_string(), "durable-cc".to_string())]
        );
        assert!(fake.kill_tombstone_at_ms("claude", "durable-cc").is_none());
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), "durable-cc".to_string()))
                .copied(),
            Some(FakeRowState::Bound),
            "the Closed row revived in the same step"
        );

        // A NEWER close re-fences (stamp advances); a claim holding the
        // stale (now-absent) snapshot is refused — and the fence stands.
        fake.retire_closed("claude", "durable-cc").await.expect("re-kill");
        let outcome = fake
            .commit_claim("claude", "durable-cc", None)
            .await
            .expect("refusal ok");
        assert_eq!(outcome, ClaimCommit::RefusedStale);
        assert_eq!(
            fake.claim_refusals.lock().unwrap().as_slice(),
            &[("claude".to_string(), "durable-cc".to_string())]
        );
        assert!(
            fake.kill_tombstone_at_ms("claude", "durable-cc").is_some(),
            "the refusal never cleared the newer fence"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), "durable-cc".to_string()))
                .copied(),
            Some(FakeRowState::Closed),
            "the refusal never revived"
        );
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "claude".into(),
            session_id: "durable-cc".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings::default(),
        })
        .await
        .expect("write ok");
        assert!(
            fake.suppressed
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), "durable-cc".to_string())),
            "the surviving fence still fences"
        );
    }

    /// Focused-ep5-r1 Finding 2 (fake's faithful orphan model): the armed
    /// orphan gate DETACHES the binding write's apply from the caller's await
    /// — the mutation decision happens at gate-release, so a kill folded
    /// in-between suppresses an already-invoked write, and without the kill
    /// the same release lets it land (the gate discriminates).
    /// (multi_thread: the orphan gate's detached apply task must progress
    /// while the test thread blocks on the `applied` rendezvous — a
    /// current_thread runtime would starve it.)
    #[tokio::test(flavor = "multi_thread")]
    async fn fake_orphan_gate_applies_at_release_against_the_tombstone_state() {
        let upsert = || FreshAgentBindingUpsert {
            provider: "claude".into(),
            session_id: "durable-g".into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: ProvenanceUpdate::Inherit,
            settings: FreshAgentSettings::default(),
        };
        // Arm + invoke + KILL + release: suppressed.
        let fake = Arc::new(FakeIdentitySink::default());
        let gate = fake.arm_orphan_binding_gate("claude", "durable-g");
        fake.record_binding(upsert()).await.expect("invoke ok");
        gate.entered
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the gate observed the invocation");
        assert!(fake.bindings.lock().unwrap().is_empty());
        // The caller's await is dropped here — modelling the aborted consumer.
        fake.retire_closed("claude", "durable-g")
            .await
            .expect("kill tombstone");
        gate.release.send(()).expect("release");
        gate.applied
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the detached apply ran");
        assert!(
            fake.bindings.lock().unwrap().is_empty(),
            "a write in flight at kill time must never land"
        );
        assert_eq!(
            fake.suppressed.lock().unwrap().as_slice(),
            &[("claude".to_string(), "durable-g".to_string())]
        );

        // Arm + invoke + NO kill + release (a FRESH, never-killed key): lands
        // — the gate proves the write would have applied but for the tombstone.
        let gate = fake.arm_orphan_binding_gate("claude", "durable-h");
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "claude".into(),
            session_id: "durable-h".into(),
            ..upsert()
        })
        .await
        .expect("invoke ok");
        gate.entered
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the gate observed the invocation");
        gate.release.send(()).expect("release");
        gate.applied
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the detached apply ran");
        assert_eq!(
            fake.bindings.lock().unwrap().len(),
            1,
            "without the tombstone the released write applies"
        );
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
